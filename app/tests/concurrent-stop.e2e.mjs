import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>并发停止测试</title><input id="name">');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-concurrent-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-concurrent-extension-"));
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
  await page.locator("#name").fill("停止前数据");
  await worker.evaluate(() => {
    const sendMessage = chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.restoreTestSendMessage = () => { chrome.tabs.sendMessage = sendMessage; };
    chrome.tabs.sendMessage = async (...args) => {
      if (args[1]?.type === "FLUSH") {
        globalThis.testFlushStarted = true;
        await new Promise((resolve) => { globalThis.releaseTestFlush = resolve; });
      }
      return sendMessage(...args);
    };
  });
  const firstStop = panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && !await worker.evaluate(() => !!globalThis.testFlushStarted))
    await page.waitForTimeout(25);
  assert.ok(await worker.evaluate(() => !!globalThis.testFlushStarted), "第一次停止未开始收尾");
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  const during = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await worker.evaluate(() => globalThis.releaseTestFlush());
  const firstResult = await firstStop;
  assert.equal(secondStop.ok, false, "重复停止应返回等待提示");
  assert.match(secondStop.error, /正在停止/);
  assert.equal(during.value.active?.id, started.value.id, "重复停止不能中断正在收尾的任务");
  assert.equal(during.value.active?.status, "stopping");
  assert.equal(firstResult.ok, true, "第一次停止应正常完成");
  assert.equal(firstResult.value.status, "ready");
  const final = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(final.value.active, null);
  assert.equal(final.value.sessions.find((session) => session.id === started.value.id)?.status, "ready");
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
  }, started.value.id);
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "停止前数据"));
  assert.ok(events.some((event) => event.kind === "session.stop"));
  await worker.evaluate(() => globalThis.restoreTestSendMessage());
  const next = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(next.ok, true);
  await worker.evaluate(() => {
    const set = chrome.storage.session.set.bind(chrome.storage.session);
    chrome.storage.session.set = async (values) => {
      if (values.active?.status === "stopping") throw new Error("模拟收尾存储失败");
      return set(values);
    };
  });
  const failed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /模拟收尾存储失败/);
  const recovered = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(recovered.value.active, null);
  const interrupted = recovered.value.sessions.find((session) => session.id === next.value.id);
  assert.equal(interrupted?.status, "interrupted");
  assert.ok(interrupted.notice);
  console.log("并发停止不影响正常收尾，真正的收尾失败仍标记为中断");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
