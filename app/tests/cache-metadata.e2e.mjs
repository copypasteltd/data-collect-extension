import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

let cachedUrlRequests = 0;
const server = http.createServer((request, response) => {
  if (/^\/(api\/orders|asset-|new-result|long\?)/.test(request.url)) cachedUrlRequests++;
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>缓存请求测试</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-cache-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-cache-extension-"));
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
  await page.evaluate(async () => {
    const cache = await caches.open("business-cache");
    await cache.put("/api/orders?token=private-cache-token&view=list", new Response("private-cache-body"));
    for (let i = 0; i < 50; i++) await cache.put(`/asset-${i}`, new Response("asset"));
    const large = await caches.open("large-url-cache");
    await large.put(`/long?data=${"x".repeat(10010)}`, new Response("asset"));
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  const deadline = Date.now() + 5000;
  let initialCaptured = false;
  while (Date.now() < deadline && !initialCaptured) {
    initialCaptured = await panel.evaluate(async (id) => {
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
      return events.some((event) => event.kind === "cache.snapshot" &&
        event.payload.reason === "initial" && event.payload.name === "large-url-cache");
    }, started.value.id);
    if (!initialCaptured) await page.waitForTimeout(50);
  }
  assert.ok(initialCaptured, "未完成缓存初始采样");
  await page.evaluate(async () => {
    const cache = await caches.open("business-cache");
    await cache.put("/new-result", new Response("new content"));
  });
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  assert.equal(cachedUrlRequests, 0, "读取缓存清单不应重新请求网站");
  assert.ok(stopped.value.coverage.cacheGaps > 0, "缓存超限未计入采集提示");
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "缓存请求测试" });
  await record.getByText("完成（有采集提示）").waitFor();
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "cache.zip");
  await download.saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse),
  );
  const initial = events.find((event) => event.kind === "cache.snapshot" &&
    event.payload.reason === "initial" && event.payload.name === "business-cache");
  const final = events.find((event) => event.kind === "cache.snapshot" &&
    event.payload.reason === "stop" && event.payload.name === "business-cache");
  assert.equal(initial?.payload.status, "metadata_only");
  assert.equal(initial.payload.total, 51);
  assert.equal(initial.payload.entries.length, 50);
  assert.equal(initial.payload.omitted, 1);
  assert.equal(final?.payload.total, 52);
  assert.equal(final.payload.omitted, 2);
  const longUrl = events.find((event) => event.kind === "cache.snapshot" &&
    event.payload.reason === "stop" && event.payload.name === "large-url-cache");
  assert.equal(longUrl?.payload.entries[0].url, null);
  assert.equal(longUrl.payload.entries[0].urlStatus, "omitted_size");
  assert.equal(longUrl.payload.unavailableUrls, 1);
  const api = initial.payload.entries.find((entry) => entry.url.includes("/api/orders"));
  assert.equal(api?.method, "GET");
  assert.ok(api.url.includes("view=list"));
  assert.ok(!JSON.stringify(events).includes("private-cache-token"));
  assert.ok(!JSON.stringify(events).includes("private-cache-body"));
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("缓存请求数量超过采集上限").first().waitFor();
  await panel.getByText("缓存请求地址无法读取或超过采集上限").first().waitFor();
  await panel.evaluate((tabId) => chrome.scripting.executeScript({
    target: { tabId },
    func: () => Object.defineProperty(caches, "keys", {
      configurable: true,
      value: async () => { throw new Error("模拟缓存不可读取"); },
    }),
  }), tab.id);
  const second = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab: { ...tab, title: "缓存不可读取测试" },
    options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(second.ok, true);
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(secondStop.ok, true);
  assert.ok(secondStop.value.coverage.cacheGaps > 0);
  await panel.reload();
  const unavailable = panel.locator(".record").filter({ hasText: "缓存不可读取测试" });
  await unavailable.getByText("完成（有采集提示）").waitFor();
  await unavailable.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("缓存请求清单无法读取").first().waitFor();
  await panel.evaluate((tabId) => chrome.scripting.executeScript({
    target: { tabId },
    func: () => Object.defineProperty(caches, "keys", {
      configurable: true,
      value: () => new Promise(() => {}),
    }),
  }), tab.id);
  const timedStart = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab: { ...tab, title: "缓存超时测试" },
    options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(timedStart.ok, true);
  const timedStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(timedStop.ok, true);
  assert.ok(timedStop.value.coverage.cacheGaps > 0);
  await panel.reload();
  const timedRecord = panel.locator(".record").filter({ hasText: "缓存超时测试" });
  await timedRecord.getByText("完成（有采集提示）").waitFor();
  await timedRecord.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("缓存请求清单采集超时").first().waitFor();
  console.log("缓存请求清单、敏感参数和超限提示通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
