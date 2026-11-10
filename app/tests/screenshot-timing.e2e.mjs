import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { findReplayOutcome } from "../src/replay-outcome.js";

const server = http.createServer((req, res) => {
  if (req.url === "/new-tab") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>新标签结果</title><div id="new-result">新标签已打开</div>');
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end('<!doctype html><title>截图时序</title><button id="first">第一次</button><button id="second" onclick="document.querySelector(\'#result\').textContent=\'保存成功\'">第二次</button><button id="open-tab" onclick="window.open(\'/new-tab\',\'_blank\')">打开新标签</button><p id="result">等待</p><input type="password" value="private-value">');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-screenshot-timing-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-screenshot-timing-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["<all_urls>"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    viewport: null,
    args: ["--window-size=1000,700", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  await page.bringToFront();
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: true, scope: "site" } }), tab);
  if (!started.ok) throw new Error("截图录制未启动");
  async function events() {
    return panel.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open("logic-recorder");
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction("events").objectStore("events").getAll();
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    }));
  }
  async function waitForShot(selector, sessionId = started.value.id) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const all = await events();
      const click = all.find((event) => event.sessionId === sessionId && event.kind === "interaction.click" && event.payload?.target?.selector === selector);
      const shot = all.find((event) => event.kind === "screenshot" && event.payload?.eventIds?.includes(click?.id));
      if (shot) return { click, shot };
      await page.waitForTimeout(100);
    }
    throw new Error(`${selector} 的截图未记录`);
  }
  await page.waitForTimeout(700);
  await page.locator("#first").click();
  const first = await waitForShot("#first");
  await page.locator("#second").click();
  const second = await waitForShot("#second");
  for (const item of [first, second]) {
    if (!item.shot.payload.assetId || !Number.isFinite(item.shot.payload.captureStartedAt) ||
        item.shot.payload.captureStartedAt < item.click.time || item.shot.payload.capturedAt < item.shot.payload.captureStartedAt)
      throw new Error(`截图的操作关联或捕获时序不正确：${JSON.stringify({ clickTime: item.click.time, screenshot: item.shot.payload })}`);
  }
  if (first.shot.payload.assetId === second.shot.payload.assetId) throw new Error("分开完成的两次操作错误共用截图");
  const password = await page.locator('input[type="password"]').boundingBox();
  const pixel = await panel.evaluate(async ({ assetId, password, viewport }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const asset = await new Promise((resolve, reject) => {
      const request = db.transaction("assets").objectStore("assets").get(assetId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    const bitmap = await createImageBitmap(asset.blob), canvas = new OffscreenCanvas(bitmap.width, bitmap.height), drawing = canvas.getContext("2d");
    drawing.drawImage(bitmap, 0, 0);
    const x = Math.floor((password.x + password.width / 2) * bitmap.width / viewport.width);
    const y = Math.floor((password.y + password.height / 2) * bitmap.height / viewport.height);
    const rgba = [...drawing.getImageData(x, y, 1, 1).data];
    bitmap.close();
    return rgba;
  }, { assetId: first.shot.payload.assetId, password, viewport: first.shot.payload.viewport });
  if (pixel.slice(0, 3).every((channel) => channel <= 12)) throw new Error("截图中的密码区域被遮挡");
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  if (!stopped.ok) throw new Error("截图录制未能停止");
  const recorded = await events();
  const finalClick = recorded.find((event) => event.kind === "interaction.click" && event.payload?.target?.selector === "#second");
  const outcome = findReplayOutcome(recorded, finalClick);
  if (outcome?.event.payload.reason !== "stop" || !outcome.event.payload.html.includes("保存成功")) throw new Error("未记录最后操作后的停止快照");
  const record = panel.locator(".record").filter({ hasText: "截图时序" });
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const replay = panel.frameLocator('iframe[title="逐步复现页面"]');
  await replay.locator("#first").click();
  await replay.locator("#second").click();
  await panel.getByText("录制停止时的页面状态").waitFor();
  await replay.locator("#result").getByText("保存成功").waitFor();
  await page.bringToFront();
  const secondStart = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: false, scope: "site" } }), tab);
  if (!secondStart.ok) throw new Error("新标签录制未启动");
  const opened = context.waitForEvent("page");
  await page.locator("#open-tab").click();
  const newTab = await opened;
  await newTab.waitForLoadState("load");
  await newTab.waitForTimeout(1200);
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  if (!secondStop.ok) throw new Error("新标签录制未能停止");
  const newEvents = (await events()).filter((event) => event.sessionId === secondStart.value.id);
  const openingClick = newEvents.find((event) => event.kind === "interaction.click" && event.payload?.target?.selector === "#open-tab");
  const newTabOutcome = findReplayOutcome(newEvents, openingClick);
  if (newTabOutcome?.label !== "后续激活的新标签页状态（按时间关联）" || !newTabOutcome.event.payload.html.includes("新标签已打开"))
    throw new Error(`未关联实际打开的新标签页：${JSON.stringify(newEvents.filter((event) => ["tab.created", "tab.activated", "page.snapshot"].includes(event.kind)).map((event) => ({ kind: event.kind, time: event.time, tabId: event.tabId, payload: { tabId: event.payload?.tabId, openerTabId: event.payload?.openerTabId, url: event.payload?.url } })))}`);
  await page.bringToFront();
  const thirdStart = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: true, scope: "site" } }), tab);
  if (!thirdStart.ok) throw new Error("标签切换截图录制未启动");
  const readyDeadline = Date.now() + 10000;
  let initialShot;
  while (Date.now() < readyDeadline) {
    const all = (await events()).filter((event) => event.sessionId === thirdStart.value.id);
    const ready = all.find((event) => event.kind === "session.ready");
    initialShot = all.find((event) => event.kind === "screenshot" && event.payload?.eventIds?.includes(ready?.id));
    if (initialShot) break;
    await page.waitForTimeout(50);
  }
  if (!initialShot) throw new Error("录制开始截图未完成");
  await worker.evaluate(() => {
    const command = chrome.debugger.sendCommand.bind(chrome.debugger);
    let armed = true;
    chrome.debugger.sendCommand = async (...args) => {
      const result = await command(...args);
      if (armed && args[1] === "Page.captureScreenshot") {
        armed = false;
        await new Promise((resolve) => { globalThis.releaseSwitchScreenshot = resolve; });
      }
      return result;
    };
  });
  await page.locator("#first").click();
  const gateDeadline = Date.now() + 10000;
  while (Date.now() < gateDeadline && !(await worker.evaluate(() => !!globalThis.releaseSwitchScreenshot)))
    await page.waitForTimeout(50);
  if (!(await worker.evaluate(() => !!globalThis.releaseSwitchScreenshot))) throw new Error("未能控制截图时序");
  await panel.bringToFront();
  await page.bringToFront();
  await page.waitForTimeout(100);
  await worker.evaluate(() => globalThis.releaseSwitchScreenshot());
  const switched = await waitForShot("#first", thirdStart.value.id);
  if (switched.shot.payload.status !== "unavailable" || switched.shot.payload.assetId ||
      !switched.shot.payload.reason.includes("截图期间标签曾切换"))
    throw new Error(`切走又切回后的截图未标记为不可用：${JSON.stringify(switched.shot.payload)}`);
  const thirdStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  if (!thirdStop.ok) throw new Error("标签切换截图录制未能停止");
  await worker.evaluate(() => {
    chrome.debugger.attach = async () => { throw new Error("模拟调试连接不可用"); };
  });
  const fourthStart = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: true, scope: "site" } }), tab);
  if (!fourthStart.ok) throw new Error("备用截图录制未启动");
  const fallbackReadyDeadline = Date.now() + 10000;
  let fallbackInitial;
  while (Date.now() < fallbackReadyDeadline) {
    const all = (await events()).filter((event) => event.sessionId === fourthStart.value.id);
    const ready = all.find((event) => event.kind === "session.ready");
    fallbackInitial = all.find((event) => event.kind === "screenshot" && event.payload?.eventIds?.includes(ready?.id));
    if (fallbackInitial) break;
    await page.waitForTimeout(50);
  }
  if (!fallbackInitial?.payload.assetId) throw new Error(`备用截图未准备就绪：${JSON.stringify(fallbackInitial?.payload)}`);
  await worker.evaluate(() => {
    const capture = chrome.tabs.captureVisibleTab.bind(chrome.tabs);
    chrome.tabs.captureVisibleTab = (...args) => new Promise((resolve, reject) => {
      globalThis.takeSwitchedScreenshot = async () => {
        try {
          const data = await capture(...args);
          globalThis.finishSwitchedScreenshot = () => resolve(data);
        } catch (error) { reject(error); }
      };
    });
  });
  await page.locator("#first").click();
  const fallbackGateDeadline = Date.now() + 10000;
  while (Date.now() < fallbackGateDeadline && !(await worker.evaluate(() => !!globalThis.takeSwitchedScreenshot)))
    await page.waitForTimeout(50);
  if (!(await worker.evaluate(() => !!globalThis.takeSwitchedScreenshot))) throw new Error("未能控制备用截图时序");
  await panel.bringToFront();
  await worker.evaluate(() => globalThis.takeSwitchedScreenshot());
  await page.bringToFront();
  await page.waitForTimeout(100);
  await worker.evaluate(() => globalThis.finishSwitchedScreenshot());
  const fallbackSwitched = await waitForShot("#first", fourthStart.value.id);
  if (fallbackSwitched.shot.payload.status !== "unavailable" || fallbackSwitched.shot.payload.assetId ||
      !fallbackSwitched.shot.payload.reason.includes("截图期间标签曾切换"))
    throw new Error(`备用截图未识别切走又切回：${JSON.stringify(fallbackSwitched.shot.payload)}`);
  const fourthStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  if (!fourthStop.ok) throw new Error("备用截图录制未能停止");
  console.log("连续操作的独立截图与捕获时序通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
