import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>消息超时测试</title><button id="one">单次超时</button><button id="stuck">持续超时</button><button id="after">恢复后操作</button>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-event-timeout-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-event-timeout-extension-"));
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
  const start = () => panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab,
    options: { screenshots: false, scope: "site" } }), tab);
  const invoke = (func, args = []) => panel.evaluate(({ tabId, func, args }) => chrome.scripting.executeScript({
    target: { tabId }, func: (name, values) => globalThis[name](...values), args: [func, args],
  }).then((items) => items[0].result), { tabId: tab.id, func, args });
  const inspect = (name) => panel.evaluate(({ tabId, name }) => chrome.scripting.executeScript({
    target: { tabId }, func: (key) => globalThis[key], args: [name],
  }).then((items) => items[0].result), { tabId: tab.id, name });
  const waitFor = async (name, condition = Boolean) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      const value = await inspect(name);
      if (condition(value)) return value;
      await page.waitForTimeout(50);
    }
    throw new Error(`等待 ${name} 超时`);
  };
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
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    let first = true;
    globalThis.timeoutOneIds = [];
    chrome.runtime.sendMessage = function (message, ...args) {
      if (message?.type === "EVENTS" && message.events.some((event) => event.payload?.target?.selector === "#one")) {
        globalThis.timeoutOneIds.push(message.batchId);
        if (first) {
          first = false;
          return original.call(chrome.runtime, message, ...args).then((result) => new Promise((resolve) => {
            globalThis.releaseTimeoutOne = () => resolve(result);
          }));
        }
        return original.call(chrome.runtime, message, ...args).then((result) => { globalThis.timeoutOneRetried = result; return result; });
      }
      return original.call(chrome.runtime, message, ...args);
    };
    globalThis.restoreTimeoutSend = () => { chrome.runtime.sendMessage = original; };
  } }), tab.id);
  await page.evaluate(() => document.querySelector("#one").click());
  const retried = await waitFor("timeoutOneRetried");
  assert.deepEqual(retried.value, { accepted: 1, failed: 0 });
  const ids = await inspect("timeoutOneIds");
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1]);
  await invoke("releaseTimeoutOne");
  await invoke("restoreTimeoutSend");
  const firstStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(firstStop.ok, true);
  assert.equal(firstStop.value.status, "ready");
  assert.equal((await readEvents(first.value.id)).filter((event) => event.payload?.target?.selector === "#one").length, 1);

  const second = await start();
  assert.equal(second.ok, true);
  await page.waitForTimeout(600);
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    globalThis.timeoutStuckIds = [];
    globalThis.timeoutStuckResolvers = [];
    globalThis.timeoutStuckCount = 0;
    chrome.runtime.sendMessage = function (message, ...args) {
      if (message?.type === "EVENTS" && message.events.some((event) => event.payload?.target?.selector === "#stuck")) {
        globalThis.timeoutStuckIds.push(message.batchId);
        return original.call(chrome.runtime, message, ...args).then((result) => new Promise((resolve) => {
          globalThis.timeoutStuckResolvers.push(() => resolve(result));
          globalThis.timeoutStuckCount++;
        }));
      }
      return original.call(chrome.runtime, message, ...args);
    };
    globalThis.releaseTimeoutStuck = (index) => globalThis.timeoutStuckResolvers[index]();
    globalThis.restoreTimeoutSend = () => { chrome.runtime.sendMessage = original; };
  } }), tab.id);
  await page.evaluate(() => document.querySelector("#stuck").click());
  await waitFor("timeoutStuckIds", (value) => value?.length === 3);
  const warningDeadline = Date.now() + 12000;
  let state;
  do {
    state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    if (state.value?.active?.collectorUnresponsive && /通信未确认/.test(state.value.active.notice || "")) break;
    await page.waitForTimeout(50);
  } while (Date.now() < warningDeadline);
  assert.equal(state.value.active.collectorUnresponsive, true);
  assert.match(state.value.active.notice, /通信未确认/);
  assert.equal(new Set(await inspect("timeoutStuckIds")).size, 1);
  await waitFor("timeoutStuckCount", (value) => value === 3);
  await invoke("releaseTimeoutStuck", [0]);
  await page.waitForTimeout(100);
  await page.evaluate(() => document.querySelector("#after").click());
  const deadline = Date.now() + 8000;
  let events;
  do {
    events = await readEvents(second.value.id);
    if (events.some((event) => event.payload?.target?.selector === "#after")) break;
    await page.waitForTimeout(50);
  } while (Date.now() < deadline);
  assert.ok(events.some((event) => event.payload?.target?.selector === "#after"));
  await invoke("releaseTimeoutStuck", [1]);
  await invoke("releaseTimeoutStuck", [2]);
  await invoke("restoreTimeoutSend");
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(secondStop.ok, true);
  assert.equal(secondStop.value.status, "interrupted");
  events = await readEvents(second.value.id);
  assert.equal(events.filter((event) => event.payload?.target?.selector === "#stuck").length, 1);
  assert.ok(events.some((event) => event.kind === "warning" && /通信未确认/.test(event.payload.message)));

  const third = await start();
  assert.equal(third.ok, true);
  await page.waitForTimeout(600);
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    globalThis.stopTimeoutIds = [];
    chrome.runtime.sendMessage = function (message, ...args) {
      if (message?.type === "EVENTS" && message.events.some((event) => event.payload?.target?.selector === "#stuck")) {
        globalThis.stopTimeoutIds.push(message.batchId);
        return original.call(chrome.runtime, message, ...args).then(() => new Promise(() => {}));
      }
      return original.call(chrome.runtime, message, ...args);
    };
    globalThis.restoreStopTimeout = () => { chrome.runtime.sendMessage = original; };
  } }), tab.id);
  await page.evaluate(() => document.querySelector("#stuck").click());
  await waitFor("stopTimeoutIds", (value) => value?.length >= 1);
  const stopStarted = Date.now();
  const thirdStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(thirdStop.ok, true);
  assert.equal(thirdStop.value.status, "interrupted");
  assert.ok(Date.now() - stopStarted < 15000, "持续无响应时停止不能无限等待");
  assert.equal((await inspect("stopTimeoutIds")).length, 3);
  events = await readEvents(third.value.id);
  assert.equal(events.filter((event) => event.payload?.target?.selector === "#stuck").length, 1);
  assert.ok(events.some((event) => event.kind === "warning" && /通信未确认/.test(event.payload.message)));
  await invoke("restoreStopTimeout");
  console.log("单次和持续无响应、去重重试、通信恢复与收尾提示通过");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
