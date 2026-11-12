import { launchExtension } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";
import { unzipSync, strFromU8 } from "fflate";

function createServer(handler) {
  const server = http.createServer(handler);
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => socket.on("message", (data, binary) => socket.send(data, { binary })));
  return { server, sockets };
}
const outside = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>其他来源</title>");
});
await new Promise((resolve) => outside.server.listen(0, "127.0.0.1", resolve));
const outsideOrigin = `http://127.0.0.1:${outside.server.address().port}`;
const inside = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>连接恢复测试</title><iframe src="${outsideOrigin}/frame"></iframe>`);
});
await new Promise((resolve) => inside.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${inside.server.address().port}`;
const profile = await fs.mkdtemp(path.resolve("test-worker-socket-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-worker-socket-extension-"));
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
  const frame = page.frame({ url: `${outsideOrigin}/frame` });
  assert.ok(frame);
  const openSocket = (target, port, name) => target.evaluate(({ port, name }) => new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    window[name] = socket;
    socket.onopen = resolve;
    socket.onerror = reject;
  }), { port, name });
  await openSocket(page, inside.server.address().port, "preexisting");
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${browser.id}/`)) ||
    await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${browser.id}/`), timeout: 15000 });
  const [tab] = await worker.evaluate((url) => chrome.tabs.query({ url: `${url}/*` }), origin);
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
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
  const snapshotDeadline = Date.now() + 5000;
  let initialSnapshot = false;
  while (Date.now() < snapshotDeadline && !initialSnapshot) {
    initialSnapshot = (await readEvents(started.value.id)).some((event) =>
      event.kind === "page.snapshot" && event.frameId === 0 && event.documentId);
    if (!initialSnapshot) await page.waitForTimeout(50);
  }
  assert.ok(initialSnapshot, "未记录连接前的页面实例");
  await openSocket(page, inside.server.address().port, "recorded");
  await openSocket(frame, outside.server.address().port, "outOfScope");
  await page.evaluate(() => window.recorded.send("inside-before-restart"));
  await frame.evaluate(() => window.outOfScope.send("outside-before-restart"));
  const beforeDeadline = Date.now() + 5000;
  let before = [];
  while (Date.now() < beforeDeadline) {
    before = await readEvents(started.value.id);
    if (before.some((event) => event.kind === "network.websocketFrame" &&
      event.payload.data?.value === "inside-before-restart") &&
      before.some((event) => event.kind === "page.snapshot" && event.frameId === 0 && event.documentId)) break;
    await page.waitForTimeout(50);
  }
  assert.ok(before.some((event) => event.kind === "network.websocketFrame" && event.payload.data?.value === "inside-before-restart"));
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(state.value.active?.status, "recording");
  await page.evaluate(() => {
    window.recorded.send("inside-after-restart");
    window.preexisting.send("unverified-after-restart");
  });
  await frame.evaluate(() => window.outOfScope.send("outside-after-restart"));
  const afterDeadline = Date.now() + 5000;
  let after = [];
  while (Date.now() < afterDeadline) {
    after = await readEvents(started.value.id);
    if (after.filter((event) => event.kind === "network.websocketFrame" &&
      event.payload.data?.value === "inside-after-restart").length >= 2) break;
    await page.waitForTimeout(50);
  }
  const frames = after.filter((event) => event.kind === "network.websocketFrame" &&
    event.payload.data?.value === "inside-after-restart");
  assert.deepEqual(frames.map((event) => event.payload.direction).sort(), ["received", "sent"]);
  const text = JSON.stringify(after);
  assert.ok(!text.includes("outside-before-restart") && !text.includes("outside-after-restart"));
  assert.ok(!text.includes("unverified-after-restart"));
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  await panel.getByRole("radio").first().waitFor({ timeout: 15000 });
  const pendingDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await pendingDownload;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "sockets.zip");
  await download.saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const exported = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  const recorded = exported.filter((event) => event.kind === "network.websocketFrame" &&
    event.payload.data?.value === "inside-after-restart");
  assert.deepEqual(recorded.map((event) => event.payload.direction).sort(), ["received", "sent"]);
  assert.ok(!JSON.stringify(exported).includes("outside-after-restart"));
  assert.ok(!JSON.stringify(exported).includes("unverified-after-restart"));
  console.log("后台重启后已确认连接恢复，范围外和来源未知连接未采集");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => inside.sockets.close(resolve));
  await new Promise((resolve) => outside.sockets.close(resolve));
  await new Promise((resolve) => inside.server.close(resolve));
  await new Promise((resolve) => outside.server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
