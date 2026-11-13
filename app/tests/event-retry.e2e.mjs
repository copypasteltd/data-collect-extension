import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>消息重试测试</title><button id="retry">操作</button>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-event-retry-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-event-retry-extension-"));
let context, browser;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension);
  context = browser.context;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${browser.id}/`)) ||
    await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${browser.id}/`), timeout: 15000 });
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: true, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await page.waitForTimeout(600);
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    let first = true;
    chrome.runtime.sendMessage = function (message, ...args) {
      if (message?.type === "EVENTS" && message.events.some((event) => event.payload?.target?.selector === "#retry")) {
        globalThis.retryTestIds ||= [];
        globalThis.retryTestIds.push(message.batchId);
        if (first) {
          first = false;
          return original.call(chrome.runtime, message, ...args).then((result) => new Promise((_resolve, reject) => {
            globalThis.retryTestSaved = result;
            globalThis.releaseRetryTest = () => reject(new Error("模拟确认丢失"));
          }));
        }
        return original.call(chrome.runtime, message, ...args).then((result) => {
          globalThis.retryTestResult = result;
          return result;
        });
      }
      return original.call(chrome.runtime, message, ...args);
    };
    globalThis.restoreRetryTest = () => { chrome.runtime.sendMessage = original; };
  } }), tab.id);
  await page.evaluate(() => document.querySelector("#retry").click());
  const inspect = (func) => panel.evaluate(({ tabId, func }) => chrome.scripting.executeScript({
    target: { tabId }, func: (name) => globalThis[name], args: [func],
  }).then((items) => items[0].result), { tabId: tab.id, func });
  const waitFor = async (name) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = await inspect(name);
      if (value) return value;
      await page.waitForTimeout(50);
    }
    throw new Error(`等待 ${name} 超时`);
  };
  const saved = await waitFor("retryTestSaved");
  assert.equal(saved.value.failed, 0);
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
  const before = (await readEvents(started.value.id)).filter((event) => event.payload?.target?.selector === "#retry");
  assert.equal(before.length, 1);
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const targets = await cdp.send("Target.getTargets");
  assert.ok(!targets.targetInfos.some((target) => target.type === "service_worker"));
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.releaseRetryTest() }), tab.id);
  const retried = await waitFor("retryTestResult");
  assert.equal(retried.ok, true);
  assert.equal(retried.value.failed, 0);
  const ids = await inspect("retryTestIds");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  let events = await readEvents(started.value.id);
  const after = events.filter((event) => event.payload?.target?.selector === "#retry");
  assert.equal(after.length, 1);
  assert.equal(after[0].id, before[0].id);
  assert.equal(after[0].seq, before[0].seq);
  const warningDeadline = Date.now() + 5000;
  while (!events.some((event) => event.kind === "warning" && /可能缺少截图/.test(event.payload.message)) && Date.now() < warningDeadline) {
    await page.waitForTimeout(50);
    events = await readEvents(started.value.id);
  }
  assert.ok(events.some((event) => event.kind === "warning" && /可能缺少截图/.test(event.payload.message)));
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => globalThis.restoreRetryTest() }), tab.id);
  const conflict = await panel.evaluate(({ tabId, sessionId }) => chrome.scripting.executeScript({
    target: { tabId }, args: [sessionId], func: async (sessionId) => {
      const batchId = crypto.randomUUID(), time = Date.now();
      const make = (selector) => ({ kind: "interaction.click", time, payload: { url: location.href, target: { selector } } });
      const message = (selector) => ({ type: "EVENTS", sessionId, batchId, events: [make(selector)] });
      const [first, duplicate] = await Promise.all([chrome.runtime.sendMessage(message("#same")), chrome.runtime.sendMessage(message("#same"))]);
      const changed = await chrome.runtime.sendMessage(message("#different"));
      const extended = await chrome.runtime.sendMessage({ type: "EVENTS", sessionId, batchId, events: [make("#same"), make("#extra")] });
      return { first, duplicate, changed, extended };
    },
  }), { tabId: tab.id, sessionId: started.value.id });
  assert.deepEqual(conflict[0].result.first.value, { accepted: 1, failed: 0 });
  assert.deepEqual(conflict[0].result.duplicate.value, { accepted: 1, failed: 0 });
  assert.deepEqual(conflict[0].result.changed.value, { accepted: 0, failed: 1 });
  assert.deepEqual(conflict[0].result.extended.value, { accepted: 0, failed: 2 });
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  events = await readEvents(started.value.id);
  assert.equal(events.filter((event) => event.payload?.target?.selector === "#same").length, 1);
  assert.equal(events.filter((event) => event.payload?.target?.selector === "#different").length, 0);
  assert.equal(events.filter((event) => event.payload?.target?.selector === "#extra").length, 0);
  console.log("确认丢失、后台重启、并发重试、标识冲突与截图提示通过");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
