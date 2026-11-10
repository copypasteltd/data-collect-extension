import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { strFromU8, unzipSync } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>片段参数测试</title><video id="video"></video>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-fragment-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-fragment-extension-"));
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
  await page.evaluate(() => { location.hash = "/customer?name=ok"; });
  await page.waitForTimeout(180);
  await page.evaluate(() => {
    document.querySelector("#video").setAttribute("poster", "/image#/detail?session%5Fid=private-poster");
    location.hash = "/customer?api%5Fkey=private-route";
  });
  await page.waitForTimeout(750);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  const events = await panel.evaluate(async (id) => {
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
  }, stopped.value.id);
  assert.ok(events.some((event) => event.kind === "navigation.hash"));
  assert.ok(events.some((event) => event.kind === "navigation.hash" && event.payload.url.includes("#/customer?name=ok")));
  assert.ok(events.some((event) => event.kind === "page.mutation"));
  assert.ok(events.some((event) => event.kind === "page.snapshot" && event.payload.reason === "stop"));
  const recorded = JSON.stringify(events);
  assert.ok(recorded.includes("private-route"), "页面网址片段未保留原值");
  assert.ok(recorded.includes("private-poster"), "资源网址片段未保留原值");
  await panel.reload();
  const pendingDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.locator(".record").filter({ hasText: "片段参数测试" }).getByTitle("下载记录包").click();
  const download = await pendingDownload;
  assert.equal(await download.failure(), null);
  const archivePath = path.join(profile, "recording.zip");
  await download.saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const text = Object.entries(files)
    .filter(([name]) => name.endsWith(".json") || name.endsWith(".jsonl"))
    .map(([, bytes]) => strFromU8(bytes)).join("\n");
  assert.ok(text.includes("private-route"), "导出包缺少页面网址片段原值");
  assert.ok(text.includes("private-poster"), "导出包缺少资源网址片段原值");
  console.log("页面和资源网址片段保留原值");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
