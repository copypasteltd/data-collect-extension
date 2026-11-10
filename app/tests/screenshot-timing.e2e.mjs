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
  manifest.host_permissions = ["http://*/*", "https://*/*"];
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
      const open = indexedDB.open("logic-recorder", 2);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction("events").objectStore("events").getAll();
        read.onsuccess = () => { db.close(); resolve(read.result); };
        read.onerror = () => { db.close(); reject(read.error); };
      };
    }));
  }
  async function waitForShot(selector) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const all = await events();
      const click = all.find((event) => event.kind === "interaction.click" && event.payload?.target?.selector === selector);
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
      const request = indexedDB.open("logic-recorder", 2);
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
  if (pixel.slice(0, 3).some((channel) => channel > 12)) throw new Error("截图中的密码区域未遮挡");
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
  console.log("连续操作的独立截图与捕获时序通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
