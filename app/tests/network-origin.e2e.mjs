import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { WebSocketServer } from "ws";

function createServer(handler) {
  const server = http.createServer(handler);
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) =>
    sockets.handleUpgrade(request, socket, head, (ws) =>
      sockets.emit("connection", ws, request),
    ),
  );
  sockets.on("connection", (ws) => ws.on("message", (data) => ws.send(data)));
  return { server, sockets };
}
const outside = createServer((request, response) => {
  response.setHeader("Access-Control-Allow-Origin", "*");
  if (request.url.startsWith("/frame")) {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>其他端口</title><p>嵌入页面</p>");
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ result: request.url }));
  }
});
await new Promise((resolve) => outside.server.listen(0, "127.0.0.1", resolve));
const outsideOrigin = `http://127.0.0.1:${outside.server.address().port}`;
const inside = createServer((request, response) => {
  if (request.url === "/") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<!doctype html><title>录制范围测试</title><iframe src="/same-frame"></iframe><iframe src="${outsideOrigin}/frame"></iframe>`,
    );
  } else if (request.url === "/same-frame") {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end("<!doctype html><title>当前站点嵌入页</title>");
  } else {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ result: request.url }));
  }
});
await new Promise((resolve) => inside.server.listen(0, "127.0.0.1", resolve));
const insideOrigin = `http://127.0.0.1:${inside.server.address().port}`;
const profile = await fs.mkdtemp(path.resolve("test-network-origin-profile-"));
const extension = await fs.mkdtemp(
  path.resolve("test-network-origin-extension-"),
);
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
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const page = await context.newPage();
  await page.goto(insideOrigin);
  const frame = page.frame({ url: `${outsideOrigin}/frame` });
  const sameFrame = page.frame({ url: `${insideOrigin}/same-frame` });
  assert.ok(frame);
  assert.ok(sameFrame);
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  const [tab] = await worker.evaluate(
    (url) => chrome.tabs.query({ url: `${url}/*` }),
    insideOrigin,
  );
  await page.evaluate(
    (port) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
        window.existingSocket = ws;
        ws.onopen = resolve;
        ws.onerror = reject;
      }),
    inside.server.address().port,
  );
  const socket = async (context, port, message) =>
    context.evaluate(
      ({ port, message }) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${port}/socket`);
          ws.onopen = () => ws.send(message);
          ws.onmessage = () => {
            ws.close();
            resolve();
          };
          ws.onerror = () => reject(new Error("WebSocket failed"));
        }),
      { port, message },
    );
  page.on("dialog", (dialog) => dialog.dismiss());
  async function readEvents(sessionId) {
    return panel.evaluate(async (sessionId) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const result = await new Promise((resolve, reject) => {
        const request = db
          .transaction("events")
          .objectStore("events")
          .index("session")
          .getAll(sessionId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return result;
    }, sessionId);
  }
  for (const scope of ["site", "browser"]) {
    const started = await panel.evaluate(
      ({ tab, scope }) =>
        chrome.runtime.sendMessage({
          type: "START",
          tab,
          options: { screenshots: false, scope },
        }),
      { tab, scope },
    );
    assert.equal(started.ok, true);
    await frame.goto(`${outsideOrigin}/frame?scope=${scope}`);
    if (scope === "site")
      await page.evaluate(() =>
        window.existingSocket.send("preexisting-socket-message"),
      );
    await page.evaluate(async (outsideOrigin) => {
      await fetch("/api-main");
      await fetch(`${outsideOrigin}/api-from-main`);
    }, outsideOrigin);
    await sameFrame.evaluate(() => fetch("/api-same-frame"));
    await frame.evaluate(() => fetch("/api-outside"));
    await frame.evaluate((scope) => {
      document.cookie = `shared_${scope}=fixture; path=/`;
    }, scope);
    await socket(page, inside.server.address().port, "inside-socket-message");
    await socket(
      sameFrame,
      inside.server.address().port,
      "same-frame-socket-message",
    );
    await socket(
      frame,
      outside.server.address().port,
      "outside-socket-message",
    );
    await page.evaluate(() => alert("inside-dialog"));
    await sameFrame.evaluate(() => alert("same-frame-dialog"));
    await frame.evaluate(() => alert("outside-dialog"));
    await page.waitForTimeout(600);
    const stopped = await panel.evaluate(() =>
      chrome.runtime.sendMessage({ type: "STOP" }),
    );
    assert.equal(stopped.ok, true);
    const events = await readEvents(stopped.value.id);
    const requests = events
      .filter((event) => event.kind === "network.request")
      .map((event) => event.payload.url);
    assert.ok(requests.includes(`${insideOrigin}/api-main`));
    assert.ok(requests.includes(`${insideOrigin}/api-same-frame`));
    assert.ok(requests.includes(`${outsideOrigin}/api-from-main`));
    assert.equal(
      requests.includes(`${outsideOrigin}/frame?scope=${scope}`),
      scope === "browser",
      "嵌入页面导航请求的录制范围不正确",
    );
    assert.equal(
      requests.includes(`${outsideOrigin}/api-outside`),
      scope === "browser",
      "嵌入页面请求的录制范围不正确",
    );
    const text = JSON.stringify(events);
    assert.ok(text.includes("inside-socket-message"));
    assert.ok(text.includes("same-frame-socket-message"));
    assert.equal(
      text.includes("outside-socket-message"),
      scope === "browser",
      "嵌入页面 WebSocket 的录制范围不正确",
    );
    if (scope === "site") {
      assert.ok(!text.includes("preexisting-socket-message"));
      assert.ok(
        events.some(
          (event) =>
            event.kind === "warning" &&
            event.payload.message === "WebSocket 来源无法确认，未采集该连接",
        ),
      );
      await page.evaluate(() => window.existingSocket.close());
    }
    const sockets = events
      .filter(
        (event) =>
          event.kind === "network.websocket" &&
          event.payload.type === "webSocketCreated",
      )
      .map((event) => event.payload.url);
    assert.ok(
      sockets.includes(`ws://127.0.0.1:${inside.server.address().port}/socket`),
    );
    assert.equal(
      sockets.includes(
        `ws://127.0.0.1:${outside.server.address().port}/socket`,
      ),
      scope === "browser",
    );
    assert.ok(text.includes("inside-dialog"));
    assert.ok(text.includes("same-frame-dialog"));
    assert.equal(
      text.includes("outside-dialog"),
      scope === "browser",
      "嵌入页面弹窗的录制范围不正确",
    );
    assert.equal(
      events.filter((event) => event.kind === "dialog.open").length,
      scope === "browser" ? 3 : 2,
    );
    assert.equal(
      events.filter((event) => event.kind === "dialog.closed").length,
      scope === "browser" ? 3 : 2,
    );
    const sharedCookie = events.find(
      (event) =>
        event.kind === "cookie.change" &&
        event.payload.name === `shared_${scope}` &&
        !event.payload.removed,
    );
    assert.equal(sharedCookie?.payload.source, "domain_scope_unconfirmed");
    assert.equal(sharedCookie.payload.value, "fixture");
  }
  console.log("同主机不同端口的嵌入页面网络范围通过");
} finally {
  if (context) await context.close();
  await Promise.all([
    new Promise((resolve) => inside.sockets.close(resolve)),
    new Promise((resolve) => outside.sockets.close(resolve)),
  ]);
  await Promise.all([
    new Promise((resolve) => inside.server.close(resolve)),
    new Promise((resolve) => outside.server.close(resolve)),
  ]);
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
  await fs.rm(extension, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
