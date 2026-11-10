import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end("<!doctype html><title>Debugger lifecycle</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-attach-stop-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-attach-stop-extension-"));
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
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/first`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "browser" },
  }), tab);
  assert.equal(started.ok, true, started.error);
  await worker.evaluate(() => {
    const attach = chrome.debugger.attach.bind(chrome.debugger);
    let delayed = false;
    chrome.debugger.attach = async (...args) => {
      await attach(...args);
      if (!delayed) {
        delayed = true;
        await new Promise((resolve) => { globalThis.releaseAttach = resolve; });
      }
    };
  });
  const latePage = await context.newPage();
  await latePage.goto(`http://127.0.0.1:${server.address().port}/late`);
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && !(await worker.evaluate(() => !!globalThis.releaseAttach)))
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseAttach), "function");
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true, stopped.error);
  const lateTab = (await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" })))
    .find((item) => item.url.endsWith("/late"));
  assert.ok(lateTab, "找不到测试标签页");
  await panel.evaluate((tab) => {
    globalThis.restartResult = chrome.runtime.sendMessage({
      type: "START", tab, options: { screenshots: false, scope: "browser" },
    });
  }, tab);
  const restartDeadline = Date.now() + 10000;
  let waitingForPrevious = false;
  while (Date.now() < restartDeadline && !waitingForPrevious) {
    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    waitingForPrevious = !!state.value.active?.tabs?.[lateTab.id]?.attaching;
    if (!waitingForPrevious) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(waitingForPrevious, true, "新录制未等待旧调试连接");
  await worker.evaluate(() => globalThis.releaseAttach());
  const restarted = await panel.evaluate(() => globalThis.restartResult);
  assert.equal(restarted.ok, true, restarted.error);
  assert.equal(restarted.value.tabs[lateTab.id]?.debuggerAttached, true, "新录制未连接新标签页");
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(secondStop.ok, true, secondStop.error);
  const attached = await worker.evaluate(async (tabId) => {
    try { await chrome.debugger.sendCommand({ tabId }, "Page.getFrameTree"); return true; }
    catch { return false; }
  }, lateTab.id);
  assert.equal(attached, false, "停止后迟到的调试连接未关闭");
  console.log("停止后迟到的调试连接已关闭");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
