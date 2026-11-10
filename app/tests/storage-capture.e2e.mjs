import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>存储采集测试</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-storage-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-storage-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => {
    for (let i = 0; i < 205; i++) localStorage.setItem(`item-${i}`, String(i));
    sessionStorage.setItem("customer", "C001");
    sessionStorage.setItem("token", "private-token-value");
    sessionStorage.setItem("huge", "x".repeat(4001));
    sessionStorage.setItem("__proto__", "normal-key");
  });
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "http://127.0.0.1/*" }),
  );
  const started = await panel.evaluate(
    (tab) =>
      chrome.runtime.sendMessage({
        type: "START",
        tab,
        options: { screenshots: false, scope: "site" },
      }),
    tab,
  );
  assert.equal(started.ok, true);
  const [result] = await panel.evaluate(
    (tabId) =>
      chrome.scripting.executeScript({
        target: { tabId },
        func: async () => {
          Object.defineProperty(window, "localStorage", {
            configurable: true,
            get() {
              throw new Error("storage unavailable");
            },
          });
          sessionStorage.setItem(
            "final-state",
            "updated-immediately-before-stop",
          );
          return chrome.runtime.sendMessage({ type: "STOP" });
        },
      }),
    tab.id,
  );
  assert.equal(result.result.ok, true);
  const session = result.result.value;
  const events = await panel.evaluate(async (sessionId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = await new Promise((resolve, reject) => {
      const request = db
        .transaction("events")
        .objectStore("events")
        .index("session")
        .getAll(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return result;
  }, session.id);
  const snapshots = events.filter((event) => event.kind === "storage.snapshot");
  const initial = snapshots.find(
    (event) => event.payload.coverage?.localStorage?.status === "partial",
  );
  assert.equal(initial?.payload.coverage.localStorage.omittedKeys, 5);
  assert.equal(initial?.payload.coverage.sessionStorage.oversizedValues, 1);
  const final = snapshots.find((event) => event.payload.method === "stop");
  assert.equal(final?.payload.coverage.localStorage.status, "unavailable");
  assert.equal(
    final?.payload.stores.sessionStorage["final-state"],
    "updated-immediately-before-stop",
  );
  assert.equal(final.payload.stores.sessionStorage.customer, "C001");
  assert.equal(final.payload.stores.sessionStorage.token, "[已隐藏]");
  assert.equal(final.payload.stores.sessionStorage.huge, "[超过大小限制]");
  assert.deepEqual(
    final.payload.specialEntries.find(
      (entry) =>
        entry.storage === "sessionStorage" && entry.key === "__proto__",
    ),
    { storage: "sessionStorage", key: "__proto__", value: "normal-key" },
  );
  assert.ok(session.coverage.storageGaps >= 1);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "存储采集测试" });
  await record.getByText("完成（有采集提示）").waitFor();
  const downloadPromise = panel.waitForEvent("download");
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  const archivePath = path.join(profile, "storage.zip");
  await download.saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const exportedEvents = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse),
  );
  const exportedFinal = exportedEvents.find(
    (event) =>
      event.kind === "storage.snapshot" && event.payload.method === "stop",
  );
  assert.equal(
    exportedFinal?.payload.stores.sessionStorage["final-state"],
    "updated-immediately-before-stop",
  );
  assert.equal(exportedFinal.payload.stores.sessionStorage.token, "[已隐藏]");
  assert.ok(!JSON.stringify(exportedEvents).includes("private-token-value"));
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles(archivePath);
  await panel.getByRole("heading", { name: "存储采集测试" }).waitFor();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel
    .getByText("站点存储部分内容未取得或超过采集上限")
    .first()
    .waitFor();
  console.log("存储末次采样、独立失败、敏感值与超限提示通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
  await fs.rm(extension, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
