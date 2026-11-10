import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>Startup tab</title><button id="action">Action</button>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-startup-tabs-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-startup-tabs-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    viewport: null,
    args: ["--window-size=1000,700", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const firstPage = await context.newPage();
  await firstPage.goto(`http://127.0.0.1:${server.address().port}/first`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [firstTab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  await worker.evaluate(() => {
    const attach = chrome.debugger.attach.bind(chrome.debugger);
    let waiting = true;
    chrome.debugger.attach = async (...args) => {
      if (waiting) {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseStartup = resolve; });
      }
      return attach(...args);
    };
  });
  await panel.evaluate((tab) => {
    globalThis.startResult = chrome.runtime.sendMessage({
      type: "START", tab, options: { screenshots: false, canvasSnapshots: true, scope: "browser" },
    });
  }, firstTab);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(await worker.evaluate(() => !!globalThis.releaseStartup)))
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseStartup), "function");
  const opened = await context.newPage();
  await opened.goto(`http://127.0.0.1:${server.address().port}/during-start`);
  await worker.evaluate(() => globalThis.releaseStartup());
  const result = await panel.evaluate(() => globalThis.startResult);
  assert.equal(result.ok, true, result.error);
  await opened.locator("#action").click();
  await opened.evaluate(() => fetch("/during-start-api"));
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true, stopped.error);
  const events = await panel.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open("logic-recorder");
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const request = db.transaction("events").objectStore("events").getAll();
      request.onsuccess = () => { db.close(); resolve(request.result); };
      request.onerror = () => { db.close(); reject(request.error); };
    };
  }));
  assert.ok(events.some((event) => event.kind === "interaction.click" && event.payload?.url?.endsWith("/during-start")),
    "未记录准备期间打开的标签页中的操作");
  assert.ok(events.some((event) => event.kind === "network.request" && event.payload?.url?.endsWith("/during-start-api")),
    "未记录准备期间打开的标签页中的请求");
  console.log("准备期间打开的标签页已纳入录制");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
