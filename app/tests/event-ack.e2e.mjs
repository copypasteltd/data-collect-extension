import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>采集确认测试</title><button id="good-a">甲</button><button id="bad">乙</button><button id="good-b">丙</button>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-event-ack-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-event-ack-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const start = () => panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  const readEvents = (id) => panel.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const events = await new Promise((resolve, reject) => {
      const request = db.transaction("events").objectStore("events").index("session").getAll(id);
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    db.close(); return events;
  }, id);
  const first = await start();
  assert.equal(first.ok, true);
  await page.waitForTimeout(600);
  await worker.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    globalThis.restoreEventTestPut = () => { IDBObjectStore.prototype.put = original; };
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value?.kind === "interaction.click" && value.payload?.target?.selector === "#bad")
        throw new Error("模拟单条事件写入失败");
      return original.call(this, value, ...args);
    };
  });
  await page.evaluate(() => {
    document.querySelector("#good-a").click();
    document.querySelector("#bad").click();
    document.querySelector("#good-b").click();
  });
  await page.waitForTimeout(600);
  await worker.evaluate(() => globalThis.restoreEventTestPut());
  await worker.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let duplicateId;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value?.payload?.target?.selector === "#async-first") duplicateId = value.id;
      if (value?.payload?.target?.selector === "#async-bad") return this.add({ ...value, id: duplicateId });
      return original.call(this, value, ...args);
    };
    globalThis.restoreAsyncTestPut = () => { IDBObjectStore.prototype.put = original; };
  });
  const partial = await panel.evaluate(({ tabId, sessionId }) => chrome.scripting.executeScript({
    target: { tabId }, args: [sessionId], func: (sessionId) => chrome.runtime.sendMessage({
      type: "EVENTS", sessionId, batchId: crypto.randomUUID(), events: ["#async-first", "#async-bad", "#async-last"].map((selector) => ({
        kind: "interaction.click", time: Date.now(), payload: { url: location.href, target: { selector } },
      })),
    }),
  }), { tabId: tab.id, sessionId: first.value.id });
  assert.deepEqual(partial[0].result.value, { accepted: 2, failed: 1 });
  await worker.evaluate(() => globalThis.restoreAsyncTestPut());
  await worker.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value?.payload?.target?.selector === "#abort") this.transaction.abort();
      return original.call(this, value, ...args);
    };
    globalThis.restoreAbortTestPut = () => { IDBObjectStore.prototype.put = original; };
  });
  const aborted = await panel.evaluate(({ tabId, sessionId }) => chrome.scripting.executeScript({
    target: { tabId }, args: [sessionId], func: (sessionId) => chrome.runtime.sendMessage({
      type: "EVENTS", sessionId, batchId: crypto.randomUUID(), events: ["#abort-before", "#abort", "#abort-after"].map((selector) => ({
        kind: "interaction.click", time: Date.now(), payload: { url: location.href, target: { selector } },
      })),
    }),
  }), { tabId: tab.id, sessionId: first.value.id });
  assert.deepEqual(aborted[0].result.value, { accepted: 0, failed: 3 });
  await worker.evaluate(() => globalThis.restoreAbortTestPut());
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.status, "interrupted");
  const firstEvents = await readEvents(first.value.id);
  const targets = firstEvents.filter((event) => event.kind === "interaction.click").map((event) => event.payload.target?.selector);
  assert.ok(targets.includes("#good-a") && targets.includes("#good-b"));
  assert.ok(!targets.includes("#bad"));
  assert.ok(targets.includes("#async-first") && targets.includes("#async-last") && !targets.includes("#async-bad"));
  assert.ok(!targets.some((target) => target?.startsWith("#abort")), "事务回滚后不能确认任何事件");
  assert.ok(firstEvents.some((event) => event.kind === "warning" && /未确认：1 条/.test(event.payload.error || "")));
  const second = await start();
  assert.equal(second.ok, true);
  await page.waitForTimeout(400);
  await worker.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    globalThis.testBatchTransactions = new Set();
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (value?.payload?.target?.selector?.startsWith("#bulk-")) globalThis.testBatchTransactions.add(this.transaction);
      return original.call(this, value, ...args);
    };
    globalThis.restoreBatchTestPut = () => { IDBObjectStore.prototype.put = original; };
  });
  const responses = await panel.evaluate(({ tabId, oldId, newId }) => chrome.scripting.executeScript({
    target: { tabId }, args: [oldId, newId], func: async (oldId, newId) => {
      const event = (name) => ({ kind: "interaction.click", time: Date.now(), payload: { url: location.href, target: { selector: name } } });
      const stale = await chrome.runtime.sendMessage({ type: "EVENTS", sessionId: oldId, events: [event("#stale")] });
      const missing = await chrome.runtime.sendMessage({ type: "EVENTS", events: [event("#missing")] });
      const current = await chrome.runtime.sendMessage({ type: "EVENTS", sessionId: newId, events: [event("#current")] });
      const batch = await chrome.runtime.sendMessage({ type: "EVENTS", sessionId: newId, batchId: crypto.randomUUID(),
        events: Array.from({ length: 20 }, (_, index) => event(`#bulk-${index}`)) });
      return { stale, missing, current, batch };
    },
  }), { tabId: tab.id, oldId: first.value.id, newId: second.value.id });
  assert.equal(responses[0].result.stale.value, false);
  assert.equal(responses[0].result.missing.value, false);
  assert.deepEqual(responses[0].result.current.value, { accepted: 1, failed: 0 });
  assert.deepEqual(responses[0].result.batch.value, { accepted: 20, failed: 0 });
  assert.equal(await worker.evaluate(() => globalThis.testBatchTransactions.size), 1, "同一批事件应在单个事务中写入");
  await worker.evaluate(() => globalThis.restoreBatchTestPut());
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(secondStop.ok, true);
  const secondEvents = await readEvents(second.value.id);
  const secondTargets = secondEvents.filter((event) => event.kind === "interaction.click").map((event) => event.payload.target?.selector);
  assert.ok(secondTargets.includes("#current"));
  assert.equal(secondTargets.filter((target) => target?.startsWith("#bulk-")).length, 20);
  assert.ok(!secondTargets.includes("#stale") && !secondTargets.includes("#missing"));
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    globalThis.restoreAckTestSend = () => { chrome.runtime.sendMessage = original; };
    chrome.runtime.sendMessage = function (message, ...args) {
      if (message?.type === "CANVAS_OPTIONS") return new Promise((resolve, reject) => {
        globalThis.releaseAckTestSettings = () => original.call(chrome.runtime, message, ...args).then(resolve, reject);
      });
      return original.call(chrome.runtime, message, ...args);
    };
  } }), tab.id);
  const third = await start();
  assert.equal(third.ok, true);
  await worker.evaluate((tabId) => chrome.tabs.sendMessage(tabId, { type: "STOP_CAPTURE" }), tab.id);
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    globalThis.restoreAckTestSend();
    globalThis.releaseAckTestSettings();
  } }), tab.id);
  await page.waitForTimeout(400);
  assert.ok(!(await readEvents(third.value.id)).some((event) => event.kind === "page.snapshot"), "关闭的采集器不能继续发送排队事件");
  assert.equal((await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }))).ok, true);
  console.log("部分事件持久化确认、失败提示和跨录制消息隔离通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
