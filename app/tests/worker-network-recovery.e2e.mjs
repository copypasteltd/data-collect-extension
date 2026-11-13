import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

let slowResponse;
let postResponse;
const server = http.createServer((request, response) => {
  if (request.url === "/slow") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    slowResponse = response;
  } else if (request.url === "/post") {
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.flushHeaders();
    postResponse = response;
  } else if (request.url === "/after") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"result":"后台恢复后"}');
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>后台请求恢复测试</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-worker-network-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-worker-network-extension-"));
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
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await worker.evaluate(() => {
    const command = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => args[1] === "Network.getRequestPostData"
      ? new Promise(() => {}) : command(...args);
  });
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
  await page.evaluate(() => { window.pendingTestRequest = fetch("/slow").then((response) => response.text()); });
  await page.evaluate(() => {
    window.pendingTestPost = fetch("/post", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "x".repeat(70000),
    }).then((response) => response.text());
  });
  let requestId;
  let postId;
  const beforeDeadline = Date.now() + 5000;
  while (Date.now() < beforeDeadline) {
    const events = await readEvents(started.value.id);
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/slow"));
    const post = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/post"));
    if (request && post?.payload.postData?.status === "pending" &&
        events.some((event) => event.kind === "network.response" && event.payload.requestId === request.payload.requestId) &&
        events.some((event) => event.kind === "network.response" && event.payload.requestId === post.payload.requestId)) {
      requestId = request.payload.requestId;
      postId = post.payload.requestId;
      break;
    }
    await page.waitForTimeout(50);
  }
  assert.ok(requestId && postId && slowResponse && postResponse, "重启前未记录请求及响应头");
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(state.value.active?.status, "recording");
  const target = await panel.evaluate(async (tabId) =>
    (await chrome.debugger.getTargets()).find((item) => item.tabId === tabId), tab.id);
  assert.equal(target?.attached, true, "测试中的调试连接未保持");
  slowResponse.end('{"result":"重启前发起的请求"}');
  postResponse.end('{"result":"提交已响应"}');
  assert.equal(await page.evaluate(() => window.pendingTestRequest), '{"result":"重启前发起的请求"}');
  assert.equal(await page.evaluate(() => window.pendingTestPost), '{"result":"提交已响应"}');
  await page.evaluate(() => fetch("/after").then((response) => response.text()));
  const afterDeadline = Date.now() + 5000;
  let finalEvents = [];
  while (Date.now() < afterDeadline) {
    finalEvents = await readEvents(started.value.id);
    if ([requestId, postId].every((id) => finalEvents.some((event) => event.kind === "network.finished" && event.payload.requestId === id))) break;
    await page.waitForTimeout(50);
  }
  const finished = finalEvents.find((event) => event.kind === "network.finished" && event.payload.requestId === requestId);
  assert.equal(finished?.payload.body?.value, '{"result":"重启前发起的请求"}',
    "后台重启后未关联进行中的响应");
  const posted = finalEvents.find((event) => event.kind === "network.finished" && event.payload.requestId === postId);
  assert.equal(posted?.payload.body?.value, '{"result":"提交已响应"}');
  const missingBody = finalEvents.find((event) => event.kind === "network.requestBody" && event.payload.requestId === postId);
  assert.equal(missingBody?.payload.body?.status, "unavailable");
  assert.match(missingBody.payload.body.reason, /后台重启/);
  const later = finalEvents.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/after"));
  assert.ok(later, "后台重启后的新请求未记录");
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  assert.ok(stopped.value.coverage.warnings > 0);
  await panel.reload();
  await panel.getByRole("radio").first().waitFor({ timeout: 15000 });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "recovery.zip");
  await download.saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const exported = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(exported.some((event) => event.kind === "network.finished" && event.payload.requestId === requestId &&
    event.payload.body?.value === '{"result":"重启前发起的请求"}'));
  assert.ok(exported.some((event) => event.kind === "network.requestBody" && event.payload.requestId === postId &&
    event.payload.body?.status === "unavailable"));
  assert.ok(archiveManifest.session.coverage.warnings > 0);
  console.log("后台重启后进行中的请求及后续请求采集通过");
} finally {
  if (slowResponse && !slowResponse.writableEnded) slowResponse.end();
  if (postResponse && !postResponse.writableEnded) postResponse.end();
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
