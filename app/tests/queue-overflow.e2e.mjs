import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>高频操作测试</title><button id="action">操作</button>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-queue-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-queue-extension-"));
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
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await page.waitForTimeout(800);
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    const original = chrome.runtime.sendMessage;
    let blocked = false;
    chrome.runtime.sendMessage = function (message, ...args) {
      if (message?.type === "EVENTS" && !blocked) {
        blocked = true;
        return new Promise((resolve, reject) => {
          globalThis.releaseQueueTest = () => original.call(chrome.runtime, message, ...args).then(resolve, reject);
        });
      }
      return original.call(chrome.runtime, message, ...args);
    };
    globalThis.restoreQueueTest = () => { chrome.runtime.sendMessage = original; };
  } }), tab.id);
  await page.evaluate(() => {
    const button = document.querySelector("#action");
    for (let i = 0; i < 2200; i++) button.click();
  });
  const warningDeadline = Date.now() + 10000;
  let during;
  do {
    during = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    if (during.value?.active?.collectorQueueOverflow && /发送队列已满/.test(during.value.active.notice || "")) break;
    await page.waitForTimeout(50);
  } while (Date.now() < warningDeadline);
  assert.equal(during.value.active.collectorQueueOverflow, true);
  assert.match(during.value.active.notice, /发送队列已满/);
  assert.equal(during.value.active.incomplete, true);
  await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
    globalThis.restoreQueueTest();
    globalThis.releaseQueueTest();
  } }), tab.id);
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
  const deadline = Date.now() + 15000;
  let events;
  do {
    events = await readEvents(started.value.id);
    if (events.filter((event) => event.kind === "interaction.click").length >= 2000) break;
    await page.waitForTimeout(100);
  } while (Date.now() < deadline);
  assert.equal(events.filter((event) => event.kind === "interaction.click").length, 2000);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.status, "interrupted");
  events = await readEvents(started.value.id);
  assert.ok(events.some((event) => event.kind === "warning" && /发送队列已满/.test(event.payload.message)));
  assert.ok(events.some((event) => event.kind === "warning" && /未确认：200 条/.test(event.payload.error || "")));
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "高频操作测试" });
  await record.getByText("异常中断（可导出部分记录）").waitFor();
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("页面事件发送队列已满，部分事件未保存").first().waitFor();
  console.log("高频事件队列上限、即时提示、已保存事件和收尾报告通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
