import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { WebSocketServer } from "ws";

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    response.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    response.end(JSON.stringify({ path: request.url }));
  } else if (request.url === "/frame") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>跨进程框架</title>");
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>框架恢复测试</title><iframe src="http://localhost:${server.address().port}/frame"></iframe>`);
  }
});
const sockets = new WebSocketServer({ server });
sockets.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const frameUrl = `http://localhost:${server.address().port}/frame`;
const profile = await fs.mkdtemp(path.resolve("test-worker-frame-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-worker-frame-extension-"));
let context, browser;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension, ["--site-per-process"]);
  context = browser.context;
  const page = await context.newPage();
  await page.goto(origin);
  const frame = page.frame({ url: frameUrl });
  assert.ok(frame);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${browser.id}/`)) ||
    await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${browser.id}/`), timeout: 15000 });
  const [tab] = await worker.evaluate((url) => chrome.tabs.query({ url: `${url}/*` }), origin);
  const readEvents = (id) => panel.evaluate(async (id) => {
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
  }, id);
  const start = (scope) => panel.evaluate(({ tab, scope }) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope },
  }), { tab, scope });
  const stop = () => panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  const started = await start("browser");
  assert.equal(started.ok, true);
  await frame.evaluate(() => fetch("/api/before").then((response) => response.json()));
  const deadline = Date.now() + 5000;
  let prior;
  while (Date.now() < deadline) {
    prior = (await readEvents(started.value.id)).find((event) =>
      event.kind === "network.request" && event.payload.url.endsWith("/api/before"));
    if (prior) break;
    await page.waitForTimeout(50);
  }
  assert.ok(prior, "重启前未取得框架请求");
  const prefix = `${tab.id}:`;
  assert.ok(prior.payload.requestId.startsWith(prefix));
  const childSession = prior.payload.requestId.slice(prefix.length).split(":")[0];
  assert.notEqual(childSession, "root", "测试页面没有运行在跨进程框架中");
  await panel.waitForFunction(async ({ owner, sessionId, tabId }) => {
    const state = await chrome.storage.session.get("recorderFrames");
    return state.recorderFrames?.owner === owner && state.recorderFrames.entries?.some(
      (entry) => entry[0] === sessionId && entry[1] === tabId);
  }, { owner: started.value.id, sessionId: childSession, tabId: tab.id });
  const target = await worker.evaluate(({ tabId, sessionId }) =>
    chrome.debugger.sendCommand({ tabId, sessionId }, "Target.getTargetInfo"),
  { tabId: tab.id, sessionId: childSession });
  assert.equal(target.targetInfo.type, "iframe");
  assert.equal(target.targetInfo.url, frameUrl);
  const tree = await worker.evaluate(({ tabId, sessionId }) =>
    chrome.debugger.sendCommand({ tabId, sessionId }, "Page.getFrameTree"),
  { tabId: tab.id, sessionId: childSession });
  assert.ok(tree.frameTree.frame.loaderId, "无法确认框架页面实例");
  await frame.evaluate(() => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${location.port}/socket`);
    window.liveSocket = socket;
    socket.onopen = () => { socket.send("child-before-restart"); resolve(); };
    socket.onerror = reject;
  }));
  const socketDeadline = Date.now() + 5000;
  let socketId;
  while (Date.now() < socketDeadline) {
    const events = await readEvents(started.value.id);
    const created = events.find((event) => event.kind === "network.websocket" &&
      event.payload.type === "webSocketCreated" && event.payload.requestId.startsWith(`${tab.id}:${childSession}:`));
    if (created?.payload.frameLoaderId && events.some((event) => event.kind === "network.websocketFrame" &&
      event.payload.requestId === created.payload.requestId && event.payload.data?.value === "child-before-restart")) {
      socketId = created.payload.requestId;
      assert.equal(created.payload.frameLoaderId, tree.frameTree.frame.loaderId);
      break;
    }
    await page.waitForTimeout(50);
  }
  assert.ok(socketId, "连接的框架页面实例未保存");
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(state.value.active?.status, "recording");
  await frame.evaluate(() => window.liveSocket.send("child-after-restart"));
  await frame.evaluate(() => fetch("/api/after").then((response) => response.json()));
  const afterDeadline = Date.now() + 5000;
  let after;
  let afterFinished;
  while (Date.now() < afterDeadline) {
    const events = await readEvents(started.value.id);
    after = events.find((event) =>
      event.kind === "network.request" && event.payload.url.endsWith("/api/after"));
    afterFinished = events.find((event) => event.kind === "network.finished" &&
      event.payload.requestId === after?.payload.requestId);
    if (after && afterFinished) break;
    await page.waitForTimeout(50);
  }
  assert.ok(after, "后台重启后未记录跨进程框架请求");
  assert.ok(after.payload.requestId.startsWith(`${tab.id}:${childSession}:`));
  assert.ok(afterFinished, "后台重启后未记录跨进程框架响应");
  assert.equal(JSON.parse(afterFinished.payload.body.value).path, "/api/after");
  const frameDeadline = Date.now() + 5000;
  let recoveredFrames = [];
  while (Date.now() < frameDeadline) {
    recoveredFrames = (await readEvents(started.value.id)).filter((event) =>
      event.kind === "network.websocketFrame" && event.payload.requestId === socketId &&
      event.payload.data?.value === "child-after-restart");
    if (recoveredFrames.length >= 2) break;
    await page.waitForTimeout(50);
  }
  assert.deepEqual(recoveredFrames.map((event) => event.payload.direction).sort(), ["received", "sent"]);
  await panel.evaluate(({ owner, tabId }) => chrome.storage.session.set({
    recorderFrames: { owner, entries: [["invalid-session-id", tabId]] },
  }), { owner: started.value.id, tabId: tab.id });
  await cdp.send("ServiceWorker.stopAllWorkers");
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await frame.evaluate(() => fetch("/api/after-invalid").then((response) => response.json()));
  await frame.evaluate(() => window.liveSocket.send("invalid-frame-socket"));
  await page.waitForTimeout(500);
  assert.ok(!(await readEvents(started.value.id)).some((event) =>
    event.kind === "network.request" && event.payload.url.endsWith("/api/after-invalid")), "无效框架连接被错误恢复");
  assert.ok(!JSON.stringify(await readEvents(started.value.id)).includes("invalid-frame-socket"));
  const stopped = await stop();
  assert.equal(stopped.ok, true);
  assert.equal((await panel.evaluate(() => chrome.storage.session.get("recorderFrames"))).recorderFrames, undefined);
  await panel.reload();
  await panel.getByRole("radio").first().waitFor({ timeout: 15000 });
  const pendingDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await pendingDownload;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "frames.zip");
  await download.saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(archiveManifest.session.recorderFrames, undefined);
  const exported = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(exported.some((event) => event.kind === "network.finished" &&
    event.payload.requestId === after.payload.requestId && JSON.parse(event.payload.body.value).path === "/api/after"));
  assert.equal(exported.filter((event) => event.kind === "network.websocketFrame" &&
    event.payload.requestId === socketId && event.payload.data?.value === "child-after-restart").length, 2);
  assert.ok(!exported.some((event) => event.kind === "network.request" && event.payload.url.endsWith("/api/after-invalid")));
  await panel.evaluate(() => {
    window.observedFrameTargets = [];
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (method === "Target.attachedToTarget" && params.targetInfo?.type === "iframe")
        window.observedFrameTargets.push({ tabId: source.tabId, sessionId: params.sessionId, url: params.targetInfo.url });
    });
  });
  const site = await start("site");
  assert.equal(site.ok, true);
  await panel.waitForFunction((url) => window.observedFrameTargets.some((item) => item.url === url), frameUrl);
  const excludedSession = await panel.evaluate((url) => window.observedFrameTargets.find((item) => item.url === url), frameUrl);
  await panel.evaluate(async ({ owner, tabId, sessionId }) => {
    await chrome.debugger.sendCommand({ tabId, sessionId }, "Network.enable");
    await chrome.storage.session.set({ recorderFrames: { owner, entries: [[sessionId, tabId]] } });
  }, { owner: site.value.id, tabId: tab.id, sessionId: excludedSession.sessionId });
  await cdp.send("ServiceWorker.stopAllWorkers");
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await frame.evaluate(() => fetch("/api/excluded").then((response) => response.json()));
  await frame.evaluate(() => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://localhost:${location.port}/excluded`);
    socket.onopen = () => socket.send("outside-frame-socket");
    socket.onmessage = () => { socket.close(); resolve(); };
    socket.onerror = reject;
  }));
  await page.waitForTimeout(500);
  const siteStop = await stop();
  assert.equal(siteStop.ok, true);
  assert.equal((await panel.evaluate(() => chrome.storage.session.get("recorderFrames"))).recorderFrames, undefined);
  assert.ok(!(await readEvents(site.value.id)).some((event) =>
    event.kind === "network.request" && event.payload.url.endsWith("/api/excluded")), "范围外框架请求被记录");
  assert.ok(!JSON.stringify(await readEvents(site.value.id)).includes("outside-frame-socket"));
  console.log("后台重启后的跨进程框架采集和授权范围通过");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => sockets.close(resolve));
  await new Promise((resolve) => server.close(resolve));
  await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
