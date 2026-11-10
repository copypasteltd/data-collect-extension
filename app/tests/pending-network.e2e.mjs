import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const held = new Map();
const server = http.createServer((request, response) => {
  if (["/with-headers", "/without-headers"].includes(request.url)) {
    held.set(request.url, response);
    if (request.url === "/with-headers") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.flushHeaders();
    }
  } else if (request.url === "/completed") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  } else if (request.url === "/failed") {
    request.socket.destroy();
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>未完成请求测试</title>");
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-pending-network-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-pending-network-extension-"));
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
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await page.evaluate(() => {
    window.pendingRequests = ["/with-headers", "/without-headers"].map((url) =>
      fetch(url).then((response) => response.text()).catch(() => null));
  });
  await page.evaluate(() => fetch("/completed").then((response) => response.text()));
  await page.evaluate(() => fetch("/failed").catch(() => null));
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
  const deadline = Date.now() + 10000;
  let events, ids;
  while (Date.now() < deadline) {
    events = await readEvents(started.value.id);
    ids = Object.fromEntries(["/with-headers", "/without-headers", "/completed", "/failed"].map((url) =>
      [url, events.find((event) => event.kind === "network.request" && event.payload.url.endsWith(url))?.payload.requestId]));
    if (Object.values(ids).every(Boolean) &&
        events.some((event) => event.kind === "network.response" && event.payload.requestId === ids["/with-headers"]) &&
        events.some((event) => event.kind === "network.finished" && event.payload.requestId === ids["/completed"]) &&
        events.some((event) => event.kind === "network.failed" && event.payload.requestId === ids["/failed"])) break;
    await page.waitForTimeout(50);
  }
  assert.ok(Object.values(ids).every(Boolean), "测试请求未全部记录");
  assert.ok(events.some((event) => event.kind === "network.finished" && event.payload.requestId === ids["/completed"]));
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  assert.equal(stopped.value.status, "ready");
  assert.ok(stopped.value.coverage.pendingRequests >= 2);
  for (const response of held.values()) response.end('{"late":true}');
  await page.evaluate(() => Promise.all(window.pendingRequests));
  events = await readEvents(started.value.id);
  for (const [url, hadHeaders] of [["/with-headers", true], ["/without-headers", false]]) {
    const terminal = events.filter((event) => ["network.finished", "network.failed", "network.incomplete"].includes(event.kind) && event.payload.requestId === ids[url]);
    assert.equal(terminal.length, 1, `${url} 应有且仅有一个结束状态`);
    assert.equal(terminal[0].kind, "network.incomplete");
    assert.equal(terminal[0].payload.reason, "recording_stopped");
    assert.equal(terminal[0].payload.responseReceived, hadHeaders);
  }
  assert.ok(!events.some((event) => event.kind === "network.incomplete" && event.payload.requestId === ids["/completed"]));
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "未完成请求测试" });
  await record.getByText("完成（有采集提示）").waitFor();
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "pending.zip");
  await download.saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const exported = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(exported.some((event) => event.kind === "network.incomplete" && event.payload.requestId === ids["/with-headers"]));
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  assert.ok(await panel.getByText("录制结束时请求仍在进行，响应可能不完整").count() >= 2);
  await panel.getByRole("button", { name: /^接口 \d+$/ }).click();
  const specPromise = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出接口规范草稿" }).click();
  const specDownload = await specPromise;
  const specPath = path.join(profile, "openapi.zip");
  await specDownload.saveAs(specPath);
  const specFiles = unzipSync(await fs.readFile(specPath));
  const specIndex = JSON.parse(strFromU8(specFiles["index.json"]));
  const specEntry = specIndex.find((entry) => entry.origin === `http://127.0.0.1:${server.address().port}`);
  assert.ok(specEntry, "接口草稿缺少录制站点");
  const spec = JSON.parse(strFromU8(specFiles[specEntry.file]));
  for (const [url, outcome, status] of [["/completed", "finished", "200"], ["/failed", "failed", "default"],
    ["/with-headers", "incomplete", "200"], ["/without-headers", "incomplete", "default"]]) {
    const operation = spec.paths[url]?.get;
    assert.ok(operation?.responses?.[status], `${url} 缺少正确的响应记录`);
    assert.equal(operation["x-logic-recorder-evidence"][0].outcome, outcome);
    if (outcome === "incomplete") assert.equal(operation["x-logic-recorder-evidence"][0].outcomeReason, "recording_stopped");
  }
  const second = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(second.ok, true);
  await worker.evaluate(() => {
    const command = chrome.debugger.sendCommand.bind(chrome.debugger);
    chrome.debugger.sendCommand = (...args) => args[1] === "Network.getResponseBody"
      ? command(...args).then((result) => new Promise((resolve) => {
          globalThis.releaseDelayedBody = () => resolve(result);
        }))
      : command(...args);
  });
  await page.evaluate(() => fetch("/completed").then((response) => response.text()));
  const bodyDeadline = Date.now() + 5000;
  while (Date.now() < bodyDeadline && !(await worker.evaluate(() => !!globalThis.releaseDelayedBody)))
    await page.waitForTimeout(50);
  assert.ok(await worker.evaluate(() => !!globalThis.releaseDelayedBody), "未能延迟响应体读取");
  const delayed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(delayed.ok, true);
  assert.equal(delayed.value.status, "interrupted");
  let delayedEvents = await readEvents(second.value.id);
  const delayedRequest = delayedEvents.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/completed"));
  assert.ok(delayedRequest);
  let terminal = delayedEvents.filter((event) => ["network.finished", "network.failed", "network.incomplete"].includes(event.kind) && event.payload.requestId === delayedRequest.payload.requestId);
  assert.equal(terminal.length, 1);
  assert.equal(terminal[0].kind, "network.incomplete");
  assert.equal(terminal[0].payload.reason, "response_capture_incomplete");
  await worker.evaluate(() => globalThis.releaseDelayedBody());
  await page.waitForTimeout(300);
  delayedEvents = await readEvents(second.value.id);
  terminal = delayedEvents.filter((event) => ["network.finished", "network.failed", "network.incomplete"].includes(event.kind) && event.payload.requestId === delayedRequest.payload.requestId);
  assert.equal(terminal.length, 1, "迟到的响应体不得覆盖或重复记录结束状态");
  console.log("停止时进行中的请求、完成请求、侧边栏报告和 ZIP 记录通过");
} finally {
  for (const response of held.values()) if (!response.writableEnded) response.end();
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
