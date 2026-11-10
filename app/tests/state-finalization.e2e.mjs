import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>状态收尾测试</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-state-finalization-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-state-finalization-extension-"));
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
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const readEvents = (id) => panel.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const events = await new Promise((resolve, reject) => {
      const request = db.transaction("events").objectStore("events").index("session").getAll(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return events;
  }, id);
  for (const [phase, hangingCall] of [["initial", 1], ["stop", 2]]) {
    await panel.evaluate(({ tabId, hangingCall }) => chrome.scripting.executeScript({
      target: { tabId }, args: [hangingCall], func: (call) => {
        let calls = 0;
        Object.defineProperty(indexedDB, "databases", { configurable: true, value: () => {
          if (++calls === call) return new Promise((resolve) => { globalThis.releaseStateTest = resolve; });
          return Promise.resolve([]);
        } });
        Object.defineProperty(caches, "keys", { configurable: true, value: () => Promise.resolve([]) });
      },
    }), { tabId: tab.id, hangingCall });
    const started = await panel.evaluate(({ tab, phase }) => chrome.runtime.sendMessage({
      type: "START", tab: { ...tab, title: `状态收尾测试 ${phase}` }, options: { screenshots: false, scope: "site" },
    }), { tab, phase });
    assert.equal(started.ok, true);
    await page.waitForTimeout(400);
    const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
    assert.equal(stopped.ok, true);
    assert.equal(stopped.value.coverage.stateCaptureGaps, 1);
    const events = await readEvents(started.value.id);
    const states = events.filter((event) => event.kind === "state.capture");
    assert.equal(states.length, 4);
    for (const source of ["database", "cache"]) for (const reason of ["initial", "stop"]) {
      const state = states.find((event) => event.payload.source === source && event.payload.reason === reason);
      assert.equal(state?.payload.status, source === "database" && reason === phase ? "timeout" : "completed");
    }
    assert.ok(!events.some((event) => event.kind === "database.snapshot" && event.payload.status === "timeout"));
    await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.releaseStateTest([]) }), tab.id);
    await page.waitForTimeout(200);
    assert.equal((await readEvents(started.value.id)).filter((event) => event.kind === "state.capture").length, 4);
    await panel.reload();
    const record = panel.locator(".record").filter({ hasText: `状态收尾测试 ${phase}` });
    await record.getByText("完成（有采集提示）").waitFor();
    if (phase === "stop") {
      const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
      await record.getByTitle("下载记录包").click();
      const file = path.join(profile, "state.zip");
      await (await downloadPromise).saveAs(file);
      await panel.getByRole("button", { name: "导入记录包" }).click();
      await panel.locator('input[type="file"]').first().setInputFiles(file);
      await panel.getByRole("heading", { name: `状态收尾测试 ${phase}` }).waitFor();
    } else await record.getByTitle("查看记录").click();
    await panel.getByRole("button", { name: "报告", exact: true }).click();
    await panel.getByText(`${phase === "initial" ? "开始" : "结束"}时数据库采集超时`).waitFor();
    await panel.reload();
  }
  console.log("数据库与缓存空状态、分阶段超时、报告及迟到结果隔离通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
