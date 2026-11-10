import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>关闭标签复现测试</title><button id="done">完成业务</button>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-closed-tab-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-closed-tab-extension-"));
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
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await page.bringToFront();
  await page.locator("#done").click();
  await page.waitForTimeout(500);
  await page.close();
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
  const deadline = Date.now() + 5000;
  let events;
  do {
    events = await readEvents(started.value.id);
    if (events.some((event) => event.kind === "tab.closed" && event.payload.tabId === tab.id)) break;
    await panel.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert.ok(events.some((event) => event.kind === "interaction.click" && event.payload.target?.selector === "#done"));
  assert.ok(events.some((event) => event.kind === "tab.closed" && event.payload.tabId === tab.id));
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "关闭标签复现测试" });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  const file = path.join(profile, "closed.zip");
  await download.saveAs(file);
  const files = unzipSync(await fs.readFile(file));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const exported = archive.eventChunks.flatMap((name) =>
    strFromU8(files[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(exported.some((event) => event.kind === "tab.closed" && event.payload.tabId === tab.id));
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles(file);
  await panel.getByRole("heading", { name: "关闭标签复现测试" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const frame = panel.frameLocator('iframe[title="逐步复现页面"]');
  await frame.locator("#done").click();
  await panel.getByText("未取得最后操作后的页面状态").waitFor();
  assert.equal(await panel.locator('iframe[title="逐步复现页面"]').count(), 0);
  console.log("真实录制的标签关闭事件、记录包导入和最终页面提示通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
