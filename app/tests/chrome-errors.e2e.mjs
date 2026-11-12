import { chromium } from "playwright";
import { spawn, execFileSync } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { reconstructFragments } from "../src/fragments.js";
import { unpackComputedEntries } from "../src/computed-style-packing.js";
import { indexComputedStyleEvidence } from "../src/computed-style-coverage.js";
import { createHash } from "node:crypto";
import { WebSocketServer } from "ws";

const executable = process.env.CHROME_BIN;
if (!executable) throw new Error("请通过 CHROME_BIN 指定正式版 Chrome 的路径");
const fontFixture = process.env.TEST_FONT === "1" || process.env.TEST_INITIAL_RESOURCES === "1" ? await fs.readFile(process.env.TEST_FONT_PATH || "C:\\Windows\\Fonts\\arial.ttf") : null;
const imageFixture = () => Buffer.concat([
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmioAAAAASUVORK5CYII=", "base64"),
  Buffer.alloc(2100000, 0x31),
]);
const svgFixture = (url) => `<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><title>${url}</title><rect width="4" height="4" fill="#2468ac"/></svg>`;
const server = http.createServer((req, res) => {
  if (req.url === "/fixture-font.ttf" && fontFixture) {
    res.writeHead(200, { "Content-Type": "font/ttf" });
    res.end(fontFixture);
  } else if (req.url === "/fixture-initial.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end('@font-face { font-family: InitialFixture; src: url("/fixture-font.ttf"); } body { font-family: InitialFixture; color: rgb(4, 5, 6); }');
  } else if (req.url.startsWith("/fixture-resource-") && req.url.endsWith(".svg")) {
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store" });
    res.end(svgFixture(req.url));
  } else if (req.url === "/fixture-events") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
    res.end(`event: fixture\nid: ${"i".repeat(5000)}\ndata: ${"s".repeat(1100000)}\n\n`);
  } else if (req.url === "/taint.png") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+nmioAAAAASUVORK5CYII=", "base64"));
  } else if (req.url === "/child") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><title>Child</title><iframe src="http://localhost:${server.address().port}/grandchild"></iframe>`);
  } else if (req.url === "/grandchild" || req.url === "/child-next") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>Frame page</title>");
  } else if (req.url === "/style-import.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end(".fixture-import { color: rgb(4, 5, 6); }");
  } else if (req.url === "/large-image") {
    res.writeHead(200, { "Content-Type": "image/png" });
    res.end(imageFixture());
  } else if (req.url === "/large-post" || req.url === "/binary-post") {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"result":"posted"}'); });
  } else if (req.url === "/large-binary") {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.alloc(4100000, 0xa7));
  } else if (req.url === "/large-binary-18") {
    res.writeHead(200, { "Content-Type": "application/octet-stream" });
    res.end(Buffer.alloc(18000000, 0x8d));
  } else if (req.url === "/fixture-text") {
    req.resume();
    req.on("end", () => { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }); res.end("response 42\n"); });
  } else if (req.url === "/fixture-concurrent?fixed=1") {
    const index = Number(req.headers["x-fixture-id"]);
    setTimeout(() => {
      res.writeHead(index === 5 ? 500 : 200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ fixtureId: index }));
    }, (5 - index) * 80);
  } else if (req.url.startsWith("/fixture-redirect?")) {
    res.writeHead(302, { Location: "/fixture-final?tag=three&tag=four", "X-Fixture-Redirect": "native-header" });
    res.end("redirect-body");
  } else if (req.url.startsWith("/fixture-final?")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"redirected":true}');
  } else if (req.url === "/large-response") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ payload: "x".repeat(1100000) }));
  } else if (req.url.startsWith("/api")) {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "example=test; Path=/" });
    res.end('{"result":"ok"}');
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    const large = process.env.TEST_LARGE_DOM === "1" ? `<div id="large" hidden>${"x".repeat(1600000)}</div>` : "";
    const css = `${process.env.TEST_PNG_PIXEL === "1" ? "body { background: rgb(23, 61, 97); }" : ""}${process.env.TEST_FULL_PAGE === "1" || process.env.TEST_FIXED_NESTED === "1" ? "body { min-height: 3500px; }" : ""}${process.env.TEST_FIXED_NESTED === "1" ? "body { padding-top: 40px; }" : ""}${process.env.TEST_FULL_PAGE_TILED === "1" ? "body { min-width: 10000px; min-height: 6500px; background: rgb(23, 61, 97); }" : ""}`;
    const style = css ? `<style>${css}</style>` : "";
    const frame = process.env.TEST_FRAME_TREE === "1" ? '<iframe src="/child"></iframe>' :
      process.env.TEST_FRAME_RESTRICTED === "1" ? '<iframe src="data:text/html,%3Ctitle%3ERestricted%3C%2Ftitle%3E"></iframe>' : "";
    const file = process.env.TEST_FILE_CAPTURE === "1" ? '<input id="file" type="file" multiple>' : "";
    const select = process.env.TEST_LARGE_SELECT === "1" ? `<select id="select" multiple>${Array.from({ length: 250 }, (_, index) =>
      `<option value="${index}:${"v".repeat(600)}">${index}:${"l".repeat(500)}</option>`).join("")}</select>` : "";
    const dynamicSelect = process.env.TEST_DYNAMIC_FORM === "1" ? '<select id="dynamic-select"><option value="first">First</option></select>' : "";
    const styleStress = process.env.TEST_STYLE_STRESS === "1" ? `<div id="style-stress">${'<span class="stress-item">sample</span>'.repeat(Number(process.env.TEST_STYLE_STRESS_COUNT || 300))}</div>` : "";
    const fixedNested = process.env.TEST_FIXED_NESTED === "1" ? '<div id="fixed" style="position:fixed;left:0;top:0;width:100%;height:30px;background:rgb(180,30,40);z-index:100"></div><div id="nested" style="position:absolute;top:150px;left:50px;width:100px;height:60px;overflow:auto"><div style="height:100px;background:red"></div><div style="height:200px;background:rgb(40,170,80)"></div></div>' : "";
    const virtualList = process.env.TEST_VIRTUAL_LIST === "1" ? '<div id="virtual" style="height:100px;overflow:auto"><div style="height:1200px"><div id="visible-rows">rows-0-9</div><div id="lazy-result"></div></div></div>' : "";
    const canvases = process.env.TEST_CANVAS_MANY === "1" ? '<canvas hidden width="1200" height="600"></canvas>'.repeat(6) : "";
    const delayedCanvas = process.env.TEST_DELAYED_CANVAS === "1" ? '<canvas id="delayed-canvas" width="40" height="40"></canvas>' : "";
    const tainted = process.env.TEST_CANVAS_TAINTED === "1" ? '<canvas id="tainted" hidden width="2" height="2"></canvas>' : "";
    const scrolls = process.env.TEST_SCROLL_MANY === "1" ? '<div class="scroll-fixture" style="height:2px;overflow:auto"><div style="height:30px"></div></div>'.repeat(205) : "";
    const initialResources = process.env.TEST_INITIAL_RESOURCES === "1" ? '<link rel="stylesheet" href="/fixture-initial.css"><img src="/large-image">' : "";
    res.end(`<!doctype html><title>Extension error test</title>${style}${initialResources}<input id="input"><button id="send" onclick="fetch('/api')">Send</button>${file}${select}${dynamicSelect}${styleStress}${fixedNested}${virtualList}${canvases}${delayedCanvas}${tainted}${scrolls}${frame}${large}`);
  }
});
if (process.env.TEST_REALTIME_LARGE === "1") {
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/fixture-socket") { socket.destroy(); return; }
    sockets.handleUpgrade(request, socket, head, (connection) => {
      connection.on("message", () => connection.send(Buffer.alloc(1100000, 42)));
    });
  });
}
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-chrome-errors-profile-"));
const child = spawn(executable, [
  `--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--no-proxy-server",
  "--host-resolver-rules=MAP recorder.test 127.0.0.1", "--window-size=1000,700",
  ...(process.env.TEST_DEVICE_SCALE ? [`--force-device-scale-factor=${process.env.TEST_DEVICE_SCALE}`] : []), "about:blank",
], { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
let chromeStderr = "";
child.stderr.on("data", (chunk) => { chromeStderr = (chromeStderr + chunk.toString()).slice(-8000); });
let launchError;
const exited = new Promise((resolve) => {
  child.once("exit", resolve);
  child.once("error", (error) => { launchError = error; resolve(); });
});
let browser, root;
try {
  let port;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline && !port) {
    if (launchError) throw launchError;
    try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  assert.ok(port, `Chrome 调试接口未启动（退出码 ${child.exitCode}）：${chromeStderr}`);
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  root = await browser.newBrowserCDPSession();
  const { id } = await root.send("Extensions.loadUnpacked", { path: path.resolve("dist") });
  const context = browser.contexts()[0];
  const manager = await context.newPage();
  await manager.goto("chrome://extensions/");
  await manager.evaluate(async (extensionId) => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId, errorCollection: true });
    await chrome.developerPrivate.addHostPermission(extensionId, "http://*/*");
    await chrome.developerPrivate.addHostPermission(extensionId, "https://*/*");
  }, id);
  const page = await context.newPage();
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const host = process.env.TEST_CACHE_BODY === "1" || process.env.TEST_CACHE_REMOVAL === "1" || process.env.TEST_CACHE_CATALOG_LARGE === "1" || process.env.TEST_PARTITIONED_COOKIE === "1" ? "127.0.0.1" : "recorder.test";
  await page.goto(`http://${host}:${server.address().port}/first`);
  if (process.env.TEST_VIRTUAL_LIST === "1") await page.evaluate(() => {
    document.querySelector("#virtual").addEventListener("scroll", () => {
      document.querySelector("#visible-rows").textContent = "rows-50-59";
      document.querySelector("#lazy-result").textContent = "lazy-loaded-data";
    });
  });
  if (process.env.TEST_FIXED_NESTED === "1") await page.evaluate(() => { document.querySelector("#nested").scrollTop = 100; });
  if (process.env.TEST_INITIAL_RESOURCES === "1") await page.evaluate(() => document.fonts.ready);
  if (process.env.TEST_SCROLL_MANY === "1") await page.evaluate(() => {
    document.querySelectorAll(".scroll-fixture").forEach((element) => { element.scrollTop = 10; });
  });
  if (process.env.TEST_CANVAS_MANY === "1") await page.evaluate(() => {
    document.querySelectorAll("canvas").forEach((canvas) => {
      const context = canvas.getContext("2d");
      context.fillStyle = "rgb(13, 79, 131)";
      context.fillRect(0, 0, canvas.width, canvas.height);
    });
  });
  if (process.env.TEST_CANVAS_TAINTED === "1") await page.evaluate(async (port) => {
    const image = new Image();
    image.src = `http://localhost:${port}/taint.png`;
    await image.decode();
    document.querySelector("#tainted").getContext("2d").drawImage(image, 0, 0);
  }, server.address().port);
  if (process.env.TEST_CACHE_BODY === "1") await page.evaluate(async () => {
    const cache = await caches.open("fixture-cache");
    const request = new Request("/cached-entry", { headers: { "x-fixture-request": "request-value" } });
    await cache.put(request, new Response(new Uint8Array(180000).fill(0xa7),
      { headers: { "content-type": "application/octet-stream", "x-fixture-response": "response-value" } }));
  });
  if (process.env.TEST_CACHE_REMOVAL === "1") await page.evaluate(async () => {
    const cache = await caches.open("fixture-remove");
    await cache.put("/removed-entry", new Response("original-cache-value"));
  });
  if (process.env.TEST_CACHE_CATALOG_LARGE === "1") await page.evaluate(async () => {
    for (let index = 0; index < 40; index++) await caches.open(`${index}:${"x".repeat(3000)}`);
  });
  if (process.env.TEST_CACHE_MANY === "1") await page.evaluate(async () => {
    const cache = await caches.open("fixture-cache");
    for (let index = 0; index < 55; index++) await cache.put(`/cached-${index}`, new Response(`value-${index}`));
  });
  if (process.env.TEST_CACHE_OPAQUE === "1") await page.evaluate(async (port) => {
    const cache = await caches.open("opaque-cache");
    const request = new Request(`http://localhost:${port}/opaque-entry`, { mode: "no-cors" });
    const response = await fetch(request);
    if (response.type !== "opaque") throw new Error("测试未取得 opaque 响应");
    await cache.put(request, response);
  }, server.address().port);
  if (process.env.TEST_DATABASE_GRAPH === "1") await page.evaluate(async (count) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("fixture-database", 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore("records", { keyPath: "id" });
        store.createIndex("kind", "kind");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("records", "readwrite"), store = tx.objectStore("records");
      for (let index = 0; index < count; index++) store.put({ id: index, kind: "simple", value: index });
      const special = { id: "complex", kind: "complex", big: 9007199254740993n,
        bytes: new Uint8Array([0, 255, 17]), blob: new Blob([new Uint8Array(120000).fill(42)]),
        collection: new Map([["group", new Set([{ name: "collection-value" }])]]) };
      special.self = special;
      store.put(special);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, process.env.TEST_DATABASE_LARGE === "1" ? 2100 : 600);
  if (process.env.TEST_DATABASE_CATALOG === "1") await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("fixture-remove-database", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("items");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
  });
  if (process.env.TEST_DATABASE_CATALOG_LARGE === "1") await page.evaluate(async () => {
    for (let index = 0; index < 35; index++) {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(`${index}:${"d".repeat(3000)}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
    }
  });
  if (process.env.TEST_LARGE_STORAGE === "1") await page.evaluate(() => {
    for (let index = 0; index < 250; index++) localStorage.setItem(`fixture-${index}`, `${index}:` + "s".repeat(8500));
    localStorage.setItem("__proto__", "special-value");
  });
  const expectedSource = process.env.TEST_LARGE_DOM === "1" ? await page.evaluate(() =>
    new XMLSerializer().serializeToString(document.doctype) + document.documentElement.outerHTML) : null;
  const background = process.env.TEST_BACKGROUND_PAGE === "1" ? await context.newPage() : null;
  if (background) await background.goto(`http://recorder.test:${server.address().port}/background`);
  if (host === "recorder.test")
    assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, "undefined"]);
  const panel = await context.newPage();
  panel.on("pageerror", (error) => pageErrors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  if (process.env.TEST_FRAME_INJECTION_FAILURE === "1") {
    const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${id}/`)) ||
      await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${id}/`), timeout: 15000 });
    await worker.evaluate(() => {
      const original = chrome.scripting.executeScript.bind(chrome.scripting);
      chrome.scripting.executeScript = (options) => {
        if (options.files?.includes("content.js") && options.target.frameIds?.length > 1)
          return Promise.reject(new Error("fixture batch injection failure"));
        if (options.files?.includes("content.js") && options.target.frameIds?.[0] !== 0)
          return Promise.reject(new Error("fixture child injection failure"));
        return original(options);
      };
    });
  }
  if (process.env.TEST_DELAYED_CANVAS === "1") {
    await page.evaluate(() => { const context = document.querySelector("#delayed-canvas").getContext("2d"); context.fillStyle = "red"; context.fillRect(0, 0, 40, 40); });
  }
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  try { await panel.getByRole("button", { name: "停止录制" }).waitFor({ timeout: 30000 }); }
  catch (error) {
    console.error("录制启动时的侧边栏状态:", await panel.locator("body").innerText().catch(() => "不可读取"));
    throw error;
  }
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 30000 });
  if (process.env.TEST_DYNAMIC_RESTRICTED_FRAME === "1") {
    await page.evaluate(() => {
      const frame = document.createElement("iframe");
      frame.src = "data:text/html,%3Ctitle%3EDynamicRestricted%3C%2Ftitle%3E";
      document.body.append(frame);
    });
    await page.waitForTimeout(1000);
  }
  if (process.env.TEST_INTERACTION_DESCENDANT_LIMIT === "1") {
    await page.evaluate(() => {
      const root = document.createElement("div");
      root.id = "descendant-limit";
      root.style.cssText = "position:fixed;left:0;top:0;width:200px;height:200px;z-index:9999";
      for (let index = 0; index < 40; index++) root.append(document.createElement("span"));
      document.body.append(root);
    });
    await page.locator("#descendant-limit").hover({ position: { x: 2, y: 2 } });
  }
  if (process.env.TEST_DATABASE_CATALOG === "1") {
    await panel.waitForFunction(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const events = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close();
      return events.some((event) => event.kind === "database.catalogEnd" && event.payload.reason === "initial" && event.payload.status === "captured" && event.payload.count === 1);
    }, null, { timeout: 20000 });
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("fixture-remove-database");
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("数据库删除受阻"));
    }));
  }
  if (process.env.TEST_DATABASE_CATALOG_LARGE === "1") await panel.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const events = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return events.some((event) => event.kind === "database.catalogEnd" && event.payload.reason === "initial" && event.payload.status === "captured" && event.payload.count === 35);
  }, null, { timeout: 30000 });
  if (process.env.TEST_VIRTUAL_LIST === "1") {
    await page.waitForTimeout(800);
    await page.evaluate(() => { document.querySelector("#virtual").scrollTop = 500; });
    await page.waitForTimeout(1200);
  }
  if (process.env.TEST_VISUAL_RESOURCES === "1") {
    await page.evaluate(async (port) => {
      const image = new Image();
      image.id = "fixture-responsive-image";
      image.srcset = "/fixture-resource-src1.svg 1x, /fixture-resource-src2.svg 2x";
      image.src = "/fixture-resource-src1.svg";
      document.body.append(image);
      const background = document.createElement("div");
      background.id = "fixture-layered-background";
      background.style.cssText = "width:20px;height:20px;background-image:url('/fixture-resource-layer1.svg'),url('/fixture-resource-layer2.svg')";
      document.body.append(background);
      const cross = new Image();
      cross.id = "fixture-cross-image";
      cross.src = `http://localhost:${port}/fixture-resource-cross.svg`;
      document.body.append(cross);
      await Promise.all([image.decode(), cross.decode()]);
      await new Promise((resolve) => setTimeout(resolve, 1200));
    }, server.address().port);
  }
  if (process.env.TEST_CACHE_REMOVAL === "1") {
    await panel.waitForFunction(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const events = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close();
      return events.some((event) => event.kind === "cache.catalogEnd" && event.payload.reason === "initial" && event.payload.status === "captured");
    }, null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => caches.delete("fixture-remove")), true);
  }
  if (process.env.TEST_CACHE_CATALOG_LARGE === "1") {
    await panel.waitForFunction(async () => {
      const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      const events = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
      db.close();
      return events.some((event) => event.kind === "cache.catalogEnd" && event.payload.reason === "initial" && event.payload.status === "captured" && event.payload.count === 40);
    }, null, { timeout: 20000 });
  }
  if (process.env.TEST_STYLE_STRESS === "1") await page.waitForTimeout(5000);
  if (process.env.TEST_DYNAMIC_FORM === "1") {
    await page.evaluate(() => {
      const select = document.querySelector("#dynamic-select");
      select.add(new Option("Second", "second"));
    });
    await page.locator("#dynamic-select").focus();
    await page.keyboard.press("ArrowDown");
    await page.locator("#input").focus();
    const input = await context.newCDPSession(page);
    await input.send("Input.imeSetComposition", { text: "中", selectionStart: 1, selectionEnd: 1 });
    await input.send("Input.insertText", { text: "中文" });
    await input.detach();
    await page.waitForTimeout(500);
  }
  if (process.env.TEST_PAGE_INSTANCES === "1") {
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForTimeout(1000);
  }
  if (process.env.TEST_REALTIME_LARGE === "1") {
    await page.evaluate(async () => Promise.all([
      new Promise((resolve, reject) => {
        const source = new EventSource("/fixture-events");
        source.addEventListener("fixture", (event) => { source.close(); event.data.length === 1100000 ? resolve() : reject(new Error("服务器推送长度错误")); });
        source.onerror = () => { source.close(); reject(new Error("服务器推送失败")); };
      }),
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://${location.host}/fixture-socket`);
        socket.binaryType = "arraybuffer";
        socket.onopen = () => socket.send("w".repeat(1100000));
        socket.onmessage = (event) => { socket.close(); event.data.byteLength === 1100000 ? resolve() : reject(new Error("WebSocket 内容长度错误")); };
        socket.onerror = () => reject(new Error("WebSocket 失败"));
      }),
    ]));
    await page.waitForTimeout(500);
  }
  if (process.env.TEST_QUOTA_FAILURE === "1") {
    const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${id}/`)) ||
      await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${id}/`), timeout: 15000 });
    await worker.evaluate(() => {
      const original = IDBObjectStore.prototype.put;
      globalThis.restoreQuotaFixture = () => { IDBObjectStore.prototype.put = original; };
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "events" && !globalThis.quotaFixtureTriggered) {
          globalThis.quotaFixtureTriggered = true;
          throw new DOMException("fixture quota exceeded", "QuotaExceededError");
        }
        return original.apply(this, args);
      };
    });
    await page.evaluate(() => fetch("/api?quota-failure"));
    const quotaDeadline = Date.now() + 5000;
    while (Date.now() < quotaDeadline && !await worker.evaluate(() => !!globalThis.quotaFixtureTriggered))
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await worker.evaluate(() => !!globalThis.quotaFixtureTriggered), true);
    await worker.evaluate(() => globalThis.restoreQuotaFixture());
    await page.waitForTimeout(500);
  }
  if (process.env.TEST_PARTITIONED_COOKIE === "1") {
    const created = await panel.evaluate(async (url) => {
      const [tab] = await chrome.tabs.query({ url: "http://127.0.0.1/*" });
      const { partitionKey } = await chrome.cookies.getPartitionKey({ tabId: tab.id, frameId: 0 });
      return chrome.cookies.set({ url, name: "fixture_partition", value: "partition-value", secure: true,
        sameSite: "no_restriction", partitionKey });
    }, page.url());
    assert.equal(created?.value, "partition-value", "测试分区 Cookie 未创建");
    await page.reload();
    await page.evaluate(() => { document.cookie = "fixture_change=changed; path=/"; });
  }
  if (process.env.TEST_SCROLL_MANY === "1") {
    await page.evaluate(() => { document.querySelector(".scroll-fixture").scrollTop = 15; });
    await page.waitForTimeout(300);
  }
  if (process.env.TEST_FRAME_TREE === "1") {
    const child = page.frames().find((frame) => frame.url().endsWith("/child"));
    assert.ok(child, "测试子框架未加载");
    await child.goto(`http://${host}:${server.address().port}/child-next`);
  }
  if (background) {
    await page.waitForTimeout(500);
    await background.bringToFront();
    await background.waitForTimeout(1500);
    await page.bringToFront();
  }
  if (process.env.TEST_LARGE_RESPONSE === "1") await page.evaluate(async () => {
    const response = await fetch("/large-response");
    await response.text();
  });
  if (process.env.TEST_LARGE_BINARY === "1") await page.evaluate(async () => {
    const response = await fetch("/large-binary");
    await response.arrayBuffer();
  });
  if (process.env.TEST_LARGE_BINARY_18 === "1") await page.evaluate(async () => {
    const response = await fetch("/large-binary-18");
    await response.arrayBuffer();
  });
  if (process.env.TEST_REDIRECT === "1") await page.evaluate(async () => {
    const response = await fetch("/fixture-redirect?tag=one&tag=two&encoded=%E4%B8%AD");
    await response.json();
  });
  if (process.env.TEST_NETWORK_CONCURRENT === "1") await page.evaluate(async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      fetch("/fixture-concurrent?fixed=1", { headers: { "x-fixture-id": String(index) } })
        .then(async (response) => ({ status: response.status, body: await response.json() }))));
    if (results.some((result, index) => result.body.fixtureId !== index || result.status !== (index === 5 ? 500 : 200)))
      throw new Error("并发测试响应不匹配");
  });
  if (process.env.TEST_TEXT_FIELDS === "1") await page.evaluate(async () => {
    const response = await fetch("/fixture-text", { method: "POST", headers: { "content-type": "text/plain; charset=utf-8" }, body: "request 123" });
    if (await response.text() !== "response 42\n") throw new Error("纯文本测试响应不匹配");
  });
  if (process.env.TEST_FORM_FIELDS === "1") await page.evaluate(async () => {
    const headers = { "content-type": "application/x-www-form-urlencoded; charset=UTF-8" };
    await (await fetch("/fixture-form", { method: "POST", headers, body: "tag=one&tag=%E4%B8%AD&empty=&flag" })).text();
    await (await fetch("/fixture-form-large", { method: "POST", headers, body: `tag=one&tag=two&payload=${"p".repeat(1100000)}` })).text();
    await (await fetch("/fixture-form-unsupported", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded; charset=iso-8859-1" }, body: "name=%E9" })).text();
    await (await fetch("/fixture-form-invalid", { method: "POST", headers, body: "name=%E9" })).text();
  });
  if (process.env.TEST_LARGE_REQUEST === "1") await page.evaluate(async () => {
    const response = await fetch("/large-post", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload: "p".repeat(1100000) }) });
    await response.text();
  });
  if (process.env.TEST_BINARY_REQUEST === "1") await page.evaluate(async () => {
    const response = await fetch("/binary-post", { method: "POST", body: new Uint8Array(40000).fill(0xe3) });
    await response.text();
  });
  if (process.env.TEST_LARGE_IMAGE === "1") await page.evaluate(async () => {
    const response = await fetch("/large-image");
    await response.arrayBuffer();
  });
  if (process.env.TEST_FONT === "1") {
    await page.evaluate(async () => {
      const font = new FontFace("FixtureFont", 'url("/fixture-font.ttf")', { weight: "400" });
      await font.load();
      document.fonts.add(font);
      const element = document.createElement("span");
      element.style.fontFamily = "FixtureFont";
      element.textContent = "font sample";
      document.body.append(element);
    });
    await page.waitForTimeout(1200);
  }
  if (process.env.TEST_STYLE_CAPTURE === "1") await page.evaluate(() => {
    const style = document.createElement("style");
    document.head.append(style);
    style.sheet.insertRule('@import url("/style-import.css");', 0);
    style.sheet.insertRule(":root { --fixture-tone: rgb(1, 2, 3); }", 1);
    style.sheet.insertRule('.fixture-background { background-image: url("/fixture-image.png"); }', 2);
    style.sheet.insertRule("body { color: rgb(1, 2, 3); }", 3);
  });
  if (process.env.TEST_STYLE_CAPTURE === "1") {
    await page.waitForFunction(() => [...document.styleSheets].some((sheet) => {
      try { return [...sheet.cssRules].some((rule) => rule.type === CSSRule.IMPORT_RULE && rule.styleSheet?.cssRules?.length); }
      catch { return false; }
    }));
    await page.waitForTimeout(1200);
  }
  if (process.env.TEST_PSEUDO_STYLE === "1") {
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = '.pseudo-input::placeholder { color: rgb(111, 22, 33); } li::marker { color: rgb(44, 55, 66); } .pseudo-text::first-letter { color: rgb(77, 88, 99); } .pseudo-text::selection { color: rgb(21, 32, 43); }';
      document.head.append(style);
      const container = document.createElement("div");
      container.innerHTML = '<input class="pseudo-input" placeholder="placeholder"><ul><li>list</li></ul><p class="pseudo-text">text</p>';
      document.body.append(container);
    });
    await page.waitForTimeout(1500);
  }
  if (process.env.TEST_THEME_SWITCH === "1") {
    await page.evaluate(() => {
      const style = document.createElement("style");
      style.textContent = ':root { --accent: rgb(11, 22, 33); } :root[data-theme="dark"] { --accent: rgb(99, 88, 77); } #theme-target { color: var(--accent); padding: 20px; } #theme-target:hover { color: rgb(200, 20, 30); } #theme-target:hover .theme-child { color: rgb(1, 222, 45); }';
      document.head.append(style);
      const button = document.createElement("button"); button.id = "theme-target"; button.innerHTML = '<span class="theme-child">Theme target</span>'; document.body.append(button);
    });
    await page.waitForTimeout(1500);
    await page.locator("#theme-target").hover({ position: { x: 2, y: 2 } });
    await page.waitForTimeout(1200);
    await page.mouse.move(0, 0);
    await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
    await page.waitForTimeout(1500);
  }
  if (process.env.TEST_SHADOW_STYLE === "1") {
    await page.evaluate(() => {
      const host = document.createElement("div");
      host.id = "fixture-shadow";
      document.body.append(host);
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>.inner { color: rgb(9, 8, 7); }</style><span class="inner">shadow${"z".repeat(110000)}</span><script type="text/plain">native-shadow-script</script>`;
      const nestedHost = document.createElement("section");
      root.append(nestedHost);
      nestedHost.attachShadow({ mode: "open" }).innerHTML = '<b data-native="yes">nested-shadow</b>';
    });
    await page.waitForTimeout(1200);
  }
  if (process.env.TEST_MUTATION_BATCH === "1") await page.evaluate(() => {
    const node = document.querySelector("#input");
    for (let index = 0; index < 250; index++) node.setAttribute("data-counter", String(index));
  });
  if (process.env.TEST_RAW_MUTATION === "1") await page.evaluate(() => {
    document.querySelector("#input").setAttribute("data-long", "r".repeat(15000));
    const wrapper = document.createElement("div");
    wrapper.innerHTML = '<span>raw-child</span><script type="text/plain">native-script-text</script>';
    document.body.append(wrapper);
  });
  await page.locator("#input").fill("example value");
  if (process.env.TEST_FILE_FAILURE === "1") {
    const [target] = await panel.evaluate((url) => chrome.tabs.query({ url }), `http://${host}/*`);
    await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
      Blob.prototype.arrayBuffer = () => Promise.reject(new Error("fixture file read failure"));
    } }), target.id);
  }
  if (process.env.TEST_FILE_CAPTURE === "1") await page.locator("#file").setInputFiles([
    { name: "fixture.bin", mimeType: "application/octet-stream", buffer: Buffer.alloc(180001, 0xa7) },
    { name: "empty.txt", mimeType: "text/plain", buffer: Buffer.alloc(0) },
  ]);
  if (process.env.TEST_FILE_DROP === "1") await page.evaluate(() => {
    const data = new DataTransfer();
    data.items.add(new File([new Uint8Array(90001).fill(37)], "drop.bin", { type: "application/octet-stream" }));
    document.body.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: data }));
  });
  if (process.env.TEST_LARGE_SELECT === "1") await page.locator("#select").selectOption([{ index: 0 }, { index: 249 }]);
  if (process.env.TEST_LONG_INPUT === "1") {
    await page.locator("#input").fill("a".repeat(15000));
    await page.locator("#input").fill("b".repeat(16000));
  }
  if (process.env.TEST_FAST_CLICKS === "1") {
    for (let index = 0; index < 3; index++) await page.locator("#send").click();
  }
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api")), page.locator("#send").click()]);
  let backgroundChangedAt;
  if (process.env.TEST_FULL_PAGE === "1") backgroundChangedAt = await page.evaluate(async () => {
    const changedAt = Date.now();
    document.body.style.backgroundColor = "rgb(75, 99, 123)";
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { changedAt, paintedAt: Date.now() };
  });
  if (process.env.TEST_DELAYED_CANVAS === "1") {
    const [tab] = await panel.evaluate((url) => chrome.tabs.query({ url }), page.url());
    await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const original = HTMLCanvasElement.prototype.toBlob;
      const originalTimeout = globalThis.setTimeout.bind(globalThis);
      globalThis.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 2500 ? 8000 : delay, ...args);
      let release, delayed = false;
      chrome.runtime.onMessage.addListener((message) => {
        if (message.type === "FLUSH" && release) originalTimeout(release, 0);
      });
      HTMLCanvasElement.prototype.toBlob = function (callback, ...args) {
        if (delayed) return original.call(this, callback, ...args);
        delayed = true;
        const canvas = this;
        globalThis.fixtureCanvasPending = true;
        release = () => original.call(canvas, (blob) => { globalThis.fixtureCanvasPending = false; callback(blob); }, ...args);
      };
    } }), tab.id);
    const deadline = Date.now() + 10000;
    let pending = false, lastRequest = 0;
    while (Date.now() < deadline && !pending) {
      if (Date.now() - lastRequest >= 700) {
        await panel.evaluate((tabId) => { chrome.tabs.sendMessage(tabId, { type: "SNAPSHOT" }, { frameId: 0 }).catch(() => {}); }, tab.id);
        lastRequest = Date.now();
      }
      const [result] = await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => !!globalThis.fixtureCanvasPending }), tab.id);
      pending = result.result;
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(pending, true, "测试未触发画布读取延迟");
  }
  if (process.env.TEST_DELAYED_SHADOW === "1") {
    const [tab] = await panel.evaluate((url) => chrome.tabs.query({ url }), page.url());
    await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => {
      const original = chrome.runtime.sendMessage.bind(chrome.runtime);
      let delayed = false;
      chrome.runtime.sendMessage = (message, ...args) => {
        if (!delayed && message.type === "EVENTS" && message.events?.some((event) => event.kind === "page.shadowRoot")) {
          delayed = true;
          globalThis.fixtureShadowPending = true;
          return new Promise((resolve, reject) => setTimeout(() => {
            globalThis.fixtureShadowPending = false;
            original(message, ...args).then(resolve, reject);
          }, 1800));
        }
        return original(message, ...args);
      };
    } }), tab.id);
    await page.evaluate(() => {
      const host = document.createElement("div"); document.body.append(host);
      host.attachShadow({ mode: "open" }).innerHTML = '<b>delayed-shadow</b>';
    });
    const deadline = Date.now() + 4000;
    let pending = false;
    while (Date.now() < deadline && !pending) {
      const [result] = await panel.evaluate((tabId) => chrome.scripting.executeScript({ target: { tabId }, func: () => !!globalThis.fixtureShadowPending }), tab.id);
      pending = result.result;
      if (!pending) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(pending, true, "测试未触发组件结构通信延迟");
  }
  let coverageWorker;
  if (process.env.TEST_COVERAGE_FAILURE === "1" || process.env.TEST_COVERAGE_TIMEOUT === "1") {
    coverageWorker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${id}/`)) ||
      await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${id}/`), timeout: 15000 });
    await coverageWorker.evaluate((timeout) => {
      const original = IDBIndex.prototype.getAll;
      globalThis.restoreCoverageFixture = () => { IDBIndex.prototype.getAll = original; };
      IDBIndex.prototype.getAll = function (...args) {
        if (this.name === "session" && this.objectStore.name === "events") {
          globalThis.coverageFixtureTriggered = true;
          if (timeout) return {};
          throw new Error("fixture coverage read failure");
        }
        return original.apply(this, args);
      };
    }, process.env.TEST_COVERAGE_TIMEOUT === "1");
  }
  const stopStartedAt = Date.now();
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 30000 });
  const stopDuration = Date.now() - stopStartedAt;
  if (coverageWorker) {
    assert.equal(await coverageWorker.evaluate(() => !!globalThis.coverageFixtureTriggered), true);
    await coverageWorker.evaluate(() => globalThis.restoreCoverageFixture());
  }
  if (process.env.TEST_MISSING_ASSET === "1") {
    await panel.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const events = await new Promise((resolve, reject) => {
        const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const id = events.find((event) => event.kind === "screenshot" && event.payload.assetId)?.payload.assetId;
      if (!id) throw new Error("测试截图不存在");
      const asset = await new Promise((resolve, reject) => {
        const request = db.transaction("assets").objectStore("assets").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      if (!asset) throw new Error("测试截图附件不存在");
      globalThis.fixtureDeletedAsset = asset;
      await new Promise((resolve, reject) => {
        const tx = db.transaction("assets", "readwrite"); tx.objectStore("assets").delete(id); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await panel.getByRole("button", { name: "导出记录包" }).click();
    await panel.getByRole("alert").getByText(/记录引用的附件不存在/).waitFor({ timeout: 30000 });
    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    assert.ok(state.value.sessions.some((session) => session.status === "ready"));
    await panel.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("assets", "readwrite"); tx.objectStore("assets").put(globalThis.fixtureDeletedAsset); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close(); delete globalThis.fixtureDeletedAsset;
    });
  }
  const download = panel.waitForEvent("download", { timeout: 30000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const archivePath = await (await download).path();
  const archive = unzipSync(await fs.readFile(archivePath));
  const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
  if (process.env.TEST_COVERAGE_FAILURE === "1" || process.env.TEST_COVERAGE_TIMEOUT === "1") {
    assert.equal(manifest.session.status, "interrupted");
    assert.equal(manifest.session.coverage.status, "unavailable");
    assert.match(manifest.session.coverage.reason, process.env.TEST_COVERAGE_TIMEOUT === "1" ? /记录检查超时/ : /fixture coverage read failure/);
    assert.match(manifest.session.notice, /完整性检查失败/);
  }
  if (process.env.TEST_QUOTA_FAILURE === "1") {
    assert.equal(manifest.session.status, "interrupted");
    assert.equal(manifest.session.storageError, true);
    assert.match(manifest.session.notice || "", /存储写入失败/);
  }
  const events = manifest.eventChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  if (process.env.TEST_DYNAMIC_RESTRICTED_FRAME === "1") {
    const unavailable = events.find((event) => event.kind === "navigation.frameUnavailable" && event.payload.reason === "outside_scope");
    assert.ok(unavailable, "未记录动态出现的范围外框架");
    assert.equal(unavailable.payload.parentFrameId, 0);
    assert.ok(unavailable.frameId > 0);
    assert.ok(manifest.session.coverage.frameScopeGaps > 0);
    assert.ok(!events.some((event) => event.kind === "page.snapshot" && event.tabId === unavailable.tabId && event.frameId === unavailable.frameId));
  }
  if (process.env.TEST_INTERACTION_DESCENDANT_LIMIT === "1") {
    const action = events.find((event) => event.kind === "interaction.pointerover" && event.payload.target?.selector === "#descendant-limit");
    const end = events.find((event) => event.kind === "page.interactionDescendantStyleEnd" &&
      event.payload.interactionCaptureId === action?.payload.interactionCaptureId);
    assert.equal(end?.payload.status, "partial");
    assert.equal(end.payload.truncated, true);
    assert.ok(manifest.session.coverage.interactionDescendantGaps > 0);
  }
  if (process.env.TEST_FRAME_INJECTION_FAILURE === "1") {
    assert.ok(events.some((event) => event.kind === "interaction.input" && event.frameId === 0 && event.payload.value === "example value"));
    assert.ok(events.some((event) => event.kind === "warning" && event.payload.error?.includes("fixture child injection failure")));
    assert.equal(manifest.session.status, "interrupted");
  }
  if (process.env.TEST_FRAME_RESTRICTED === "1") {
    const tree = events.find((event) => event.kind === "frame.tree" && event.payload.frames.some((frame) => frame.scope === "outside_scope"));
    const restricted = tree?.payload.frames.find((frame) => frame.scope === "outside_scope");
    assert.ok(restricted, "未标记不可注入的嵌入页面");
    assert.equal(restricted.parentFrameId, 0);
    assert.equal(restricted.url, null);
    assert.ok(!events.some((event) => event.kind === "page.snapshot" && event.tabId === tree.tabId && event.frameId === restricted.frameId));
  }
  const browserObservations = manifest.browserObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  if (process.env.TEST_STYLE_STRESS === "1") {
    const expected = Number(process.env.TEST_STYLE_STRESS_COUNT || 300);
    const end = events.find((event) => event.kind === "page.computedStyleEnd" && event.payload.total >= expected && event.payload.status === "captured");
    assert.ok(end, `${expected} 元素页面未完成计算样式采集`);
    assert.equal(end.payload.processed, end.payload.total);
    assert.equal(end.payload.failures, 0);
    assert.ok(stopDuration < 30000, "样式压力场景停止超时");
    const finalSnapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
    assert.ok(finalSnapshot && indexComputedStyleEvidence(events)(finalSnapshot.payload.snapshotId), "最终样式快照未完整采集");
    const timelineBytes = manifest.eventChunks.reduce((total, chunk) => total + archive[chunk].length, 0);
    console.log(`样式压力：${end.payload.total} 个元素，停止 ${stopDuration} ms，事件展开 ${timelineBytes} 字节，样式缺口 ${manifest.session.coverage.styleGaps}`);
    if (manifest.session.coverage.styleGaps) {
      const complete = indexComputedStyleEvidence(events);
      const gaps = events.filter((event) => event.kind === "page.snapshot" && !complete(event.payload.snapshotId))
        .map((event) => ({ reason: event.payload.reason, end: events.filter((item) => item.kind === "page.computedStyleEnd" && item.payload.snapshotId === event.payload.snapshotId).map((item) => item.payload.status) }));
      console.log(`样式缺口详情：${JSON.stringify(gaps)}`);
    }
  }
  if (process.env.TEST_DYNAMIC_FORM === "1") {
    const change = events.find((event) => event.kind === "interaction.change" && event.payload.target?.selector === "#dynamic-select");
    assert.deepEqual(change?.payload.formState?.selectedValues, ["second"]);
    assert.ok(change.payload.formState.options.some((option) => option.value === "second" && option.label === "Second"));
    assert.deepEqual(change.payload.beforeFormState?.selectedValues, ["first"]);
    assert.ok(events.some((event) => event.kind === "interaction.compositionstart" && event.payload.target?.selector === "#input"));
    assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "中文"));
  }
  if (process.env.TEST_PAGE_INSTANCES === "1") {
    const instances = manifest.pageInstanceChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    const snapshots = events.filter((event) => event.kind === "page.snapshot" && event.frameId === 0 && event.payload.url === page.url() && event.documentId);
    const documentIds = new Set(snapshots.map((event) => event.documentId));
    assert.ok(documentIds.size >= 2, "相同网址刷新应产生不同文档身份");
    for (const documentId of documentIds) {
      const instance = instances.find((item) => item.frameId === 0 && item.documentId === documentId && item.urls.includes(page.url()));
      assert.ok(instance && instance.association === "recorded_document_id");
      for (const evidence of instance.evidence) {
        const source = strFromU8(archive[evidence.path]).split("\n")[evidence.line - 1];
        assert.equal(JSON.parse(source).id, evidence.eventId);
      }
    }
    assert.ok(Number.isSafeInteger(manifest.pageInstanceUnassociatedCount));
  }
  if (process.env.TEST_REALTIME_LARGE === "1") {
    const eventSource = events.find((event) => event.kind === "network.eventSourceMessage" && event.payload.eventName === "fixture");
    const sent = events.find((event) => event.kind === "network.websocketFrame" && event.payload.direction === "sent" && event.payload.opcode === 1);
    const received = events.find((event) => event.kind === "network.websocketFrame" && event.payload.direction === "received" && event.payload.opcode === 2);
    assert.equal(eventSource?.payload.eventId, "i".repeat(5000));
    for (const [event, expected, encoding] of [[eventSource, "s".repeat(1100000), "text"], [sent, "w".repeat(1100000), "text"], [received, Buffer.alloc(1100000, 42), "base64"]]) {
      assert.equal(event?.payload.data?.status, "pending_asset");
      const result = events.find((item) => item.kind === "network.realtimePayload" && item.payload.captureId === event.payload.data.captureId);
      assert.equal(result?.payload.status, "captured_asset");
      assert.equal(result.payload.encoding, encoding);
      const content = JSON.parse(strFromU8(archive[`resources/${result.payload.assetId}.bin`]));
      if (encoding === "base64") assert.deepEqual(Buffer.from(content, "base64"), expected);
      else assert.equal(content, expected);
    }
    assert.equal(manifest.session.coverage.realtimePayloadGaps, 0);
  }
  if (process.env.TEST_FULL_PAGE_TILED === "1") {
    const result = events.find((event) => event.kind === "screenshot.fullPage" && event.payload.captureMode === "tiles");
    assert.ok(result, "未记录整页分片结果");
    const tiles = events.filter((event) => event.kind === "screenshot.fullPageTile" && event.payload.captureId === result.payload.captureId);
    assert.ok(tiles.length > 0, JSON.stringify(result.payload));
    assert.equal(tiles.length, result.payload.capturedTiles);
    assert.equal(result.payload.status, tiles.length === result.payload.totalTiles ? "captured" : "partial");
    assert.ok(events.some((event) => event.kind === "screenshot.fullPageStarted" && event.payload.captureRequestId === result.payload.captureRequestId));
    for (const [index, tile] of tiles.entries()) {
      assert.equal(tile.payload.index, index);
      assert.ok(archive[`screenshots/${tile.payload.assetId}.png`]?.length > 8);
      const encoded = Buffer.from(archive[`screenshots/${tile.payload.assetId}.png`]).toString("base64");
      const pixel = await page.evaluate(async (base64) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
        const context = canvas.getContext("2d");
        context.drawImage(bitmap, Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1, 0, 0, 1, 1);
        const rgba = Array.from(context.getImageData(0, 0, 1, 1).data); bitmap.close(); return rgba;
      }, encoded);
      assert.deepEqual(pixel, [23, 61, 97, 255]);
    }
    if (result.payload.status === "partial") assert.ok(result.payload.reason && manifest.session.coverage.fullPageScreenshotGaps > 0);
    else assert.equal(manifest.session.coverage.fullPageScreenshotGaps, 0);
    console.log(`整页分片：${result.payload.capturedTiles}/${result.payload.totalTiles}，状态 ${result.payload.status}`);
  }
  if (process.env.TEST_FIXED_NESTED === "1") {
    const full = events.find((event) => event.kind === "screenshot.fullPage" && event.payload.status === "captured" && event.payload.capturePhase === "initial");
    assert.ok(full?.payload.contentSize.height >= 3500);
    assert.match(full.payload.limitation, /嵌套滚动容器仅记录当前可见区域/);
    const encoded = Buffer.from(archive[`screenshots/${full.payload.assetId}.png`]).toString("base64");
    const pixels = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d");
      const pixel = (x, y) => { context.clearRect(0, 0, 1, 1); context.drawImage(bitmap, x, y, 1, 1, 0, 0, 1, 1); return Array.from(context.getImageData(0, 0, 1, 1).data); };
      const result = [pixel(10, 10), pixel(70, 170)]; bitmap.close(); return result;
    }, encoded);
    assert.deepEqual(pixels, [[180, 30, 40, 255], [40, 170, 80, 255]]);
    assert.ok(events.some((event) => event.kind === "page.snapshot" && event.payload.scroll?.positions?.some((position) => position.top === 100)));
  }
  if (process.env.TEST_DELAYED_CANVAS === "1") {
    const finalSnapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
    assert.ok(finalSnapshot, "缺少停止时页面快照");
    const finalEnd = events.find((event) => event.kind === "canvas.captureEnd" && event.payload.snapshotId === finalSnapshot.payload.snapshotId);
    assert.equal(finalEnd?.payload.status, "captured", JSON.stringify(finalEnd?.payload));
    assert.equal(finalEnd.payload.total, 1);
    assert.ok(events.some((event) => event.kind === "canvas.capture" && event.payload.snapshotId !== finalSnapshot.payload.snapshotId &&
      event.payload.captureStartedAt <= finalSnapshot.time && event.payload.capturedAt >= finalSnapshot.time), "测试未触发停止时采集并发");
    const finalCanvas = events.find((event) => event.kind === "canvas.capture" && event.payload.snapshotId === finalSnapshot.payload.snapshotId);
    assert.ok(finalCanvas?.payload.reference && reconstructFragments(finalCanvas.payload.reference, events));
  }
  if (process.env.TEST_DELAYED_SHADOW === "1") {
    const finalSnapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
    const captureId = finalSnapshot?.payload.shadowSourceCaptureId;
    const end = events.find((event) => event.kind === "page.shadowRootEnd" && event.payload.captureId === captureId);
    assert.equal(end?.payload.status, "captured", JSON.stringify(end?.payload));
    assert.ok(events.some((event) => event.kind === "page.shadowRoot" && event.payload.captureId === captureId && event.payload.html === "<b>delayed-shadow</b>"));
  }
  if (process.env.TEST_INITIAL_RESOURCES === "1") {
    const loaded = events.filter((event) => event.kind === "resource.loaded");
    for (const [url, expected] of [["/fixture-initial.css", Buffer.from('@font-face { font-family: InitialFixture; src: url("/fixture-font.ttf"); } body { font-family: InitialFixture; color: rgb(4, 5, 6); }')], ["/fixture-font.ttf", fontFixture], ["/large-image", imageFixture()]]) {
      const item = loaded.find((event) => event.payload.url.endsWith(url));
      assert.ok(item, `未记录已加载资源 ${url}`);
      if (item.payload.status === "captured") {
        const bytes = archive[`resources/${item.payload.assetId}.bin`];
        assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(expected).digest("hex"), url);
      } else {
        assert.equal(item.payload.status, "unavailable");
        assert.ok(item.payload.reason);
        assert.ok(manifest.session.coverage.initialResourceGaps > 0);
      }
      assert.ok(item.payload.protocolFrameId && item.payload.loaderId);
    }
    assert.ok(loaded.some((event) => event.payload.url.endsWith("/fixture-initial.css") && event.payload.status === "captured"));
  }
  if (process.env.TEST_PARTITIONED_COOKIE === "1") {
    const partition = events.find((event) => event.kind === "cookie.partitionSnapshot" && event.payload.status === "captured" &&
      event.payload.items.some((cookie) => cookie.name === "fixture_partition"));
    assert.ok(partition, "未采集框架分区 Cookie");
    const cookie = partition.payload.items.find((item) => item.name === "fixture_partition");
    assert.equal(cookie.value, "partition-value");
    assert.equal(cookie.hostOnly, true);
    assert.ok(cookie.partitionKey);
    const change = events.find((event) => event.kind === "cookie.change" && event.payload.name === "fixture_change" && !event.payload.removed);
    assert.equal(change?.payload.value, "changed");
    assert.equal(change?.payload.hostOnly, true);
    assert.equal(change?.payload.session, true);
  }
  if (process.env.TEST_SCROLL_MANY === "1") {
    const snapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.scroll?.positions?.length >= 205);
    assert.ok(snapshot, "超过旧上限的滚动容器未完整记录");
    assert.equal(snapshot.payload.scroll.coverage, "rendered_only");
    assert.ok(snapshot.payload.scroll.positions.filter((item) => item.top >= 10).length >= 205);
    assert.ok(events.some((event) => event.kind === "interaction.scroll" && event.payload.targetScope === "element" &&
      event.payload.scrollTop === 15 && event.payload.eventCount >= 1));
  }
  if (process.env.TEST_CANVAS_MANY === "1") {
    const end = events.find((event) => event.kind === "canvas.captureEnd" && event.payload.status === "captured" && event.payload.total === 6);
    assert.ok(end, "未完成多个大画布采集");
    const captures = events.filter((event) => event.kind === "canvas.capture" && event.payload.snapshotId === end.payload.snapshotId);
    assert.equal(captures.length, 6);
    assert.ok(captures.every((item) => item.payload.drawingContext === "unknown" && item.payload.screenEquivalence === "unverified"));
    assert.ok(manifest.session.coverage.canvasContextUnknown >= 6);
    const data = reconstructFragments(captures[0].payload.reference, events);
    const decoded = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width; canvas.height = bitmap.height;
      const context = canvas.getContext("2d"); context.drawImage(bitmap, 0, 0);
      const result = { width: bitmap.width, height: bitmap.height, pixel: Array.from(context.getImageData(10, 10, 1, 1).data) };
      bitmap.close();
      return result;
    }, data);
    assert.deepEqual(decoded, { width: 1200, height: 600, pixel: [13, 79, 131, 255] });
  }
  if (process.env.TEST_CANVAS_TAINTED === "1") {
    assert.ok(events.some((event) => event.kind === "canvas.capture" && event.payload.status === "unavailable" &&
      /security|taint/i.test(event.payload.reason)), "污染画布未记录读取失败");
    assert.ok(manifest.session.coverage.canvasGaps > 0);
  }
  if (process.env.TEST_FILE_CAPTURE === "1" && process.env.TEST_FILE_FAILURE !== "1") {
    const change = events.find((event) => event.kind === "interaction.change" && event.payload.target?.selector === "#file");
    const file = change?.payload.files?.find((item) => item.name === "fixture.bin");
    const empty = change?.payload.files?.find((item) => item.name === "empty.txt");
    assert.equal(file?.size, 180001);
    const bytes = Buffer.from(reconstructFragments(file.contentReference, events), "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(180001, 0xa7)).digest("hex"));
    assert.equal(empty?.contentStatus, "captured");
    assert.equal(empty?.data, "");
  }
  if (process.env.TEST_FILE_FAILURE === "1") {
    assert.ok(events.some((event) => event.kind === "capture.fragmentFailure" && event.payload.reason.includes("fixture file read failure")));
    assert.ok(manifest.session.coverage.inputGaps > 0);
  }
  if (process.env.TEST_FILE_DROP === "1") {
    const drop = events.find((event) => event.kind === "interaction.drop" && event.payload.files?.some((file) => file.name === "drop.bin"));
    const file = drop?.payload.files.find((item) => item.name === "drop.bin");
    assert.ok(file?.contentReference);
    const bytes = Buffer.from(reconstructFragments(file.contentReference, events), "base64");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(90001, 37)).digest("hex"));
  }
  if (process.env.TEST_LARGE_SELECT === "1") {
    const change = events.find((event) => event.kind === "interaction.change" && event.payload.target?.selector === "#select");
    assert.equal(change?.payload.formState?.status, "fragmented");
    const state = JSON.parse(reconstructFragments(change.payload.formState.reference, events));
    assert.equal(state.options.length, 250);
    assert.equal(state.options[249].value, `249:${"v".repeat(600)}`);
    assert.equal(state.options[249].label, `249:${"l".repeat(500)}`);
    assert.deepEqual(state.selectedIndices, [0, 249]);
  }
  if (process.env.TEST_FRAME_TREE === "1") {
    const navigation = events.find((event) => event.kind === "navigation.committed" && event.payload.url.endsWith("/child-next"));
    const tree = events.find((event) => event.kind === "frame.tree" && event.tabId === navigation?.tabId &&
      event.payload.frames.some((frame) => frame.url?.endsWith("/child")));
    assert.ok(tree, "缺少初始框架树");
    const child = tree.payload.frames.find((frame) => frame.url?.endsWith("/child"));
    const grandchild = tree.payload.frames.find((frame) => frame.url?.endsWith("/grandchild"));
    assert.equal(child.parentFrameId, 0);
    assert.equal(grandchild?.parentFrameId, child.frameId);
    assert.equal(navigation?.payload.parentFrameId, 0);
    assert.equal(navigation?.frameId, child.frameId);
    assert.ok(navigation?.documentId);
  }
  if (process.env.TEST_DATABASE_GRAPH === "1") {
    const browserFields = manifest.browserFieldSummaryChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    const snapshot = events.find((event) => event.kind === "database.snapshot" && event.payload.database?.name === "fixture-database" && event.payload.reason === "initial");
    assert.ok(snapshot?.payload.graphCaptureId, "未记录数据库图快照引用");
    assert.ok(snapshot.payload.database.stores[0].indexDefinitions.some((index) => index.name === "kind" && index.keyPath === "kind"));
    const rows = events.filter((event) => event.kind === "database.record" && event.payload.graphCaptureId === snapshot.payload.graphCaptureId);
    const end = events.find((event) => event.kind === "database.recordsEnd" && event.payload.graphCaptureId === snapshot.payload.graphCaptureId);
    assert.equal(end?.payload.status, "captured", JSON.stringify(end?.payload));
    assert.equal(rows.length, process.env.TEST_DATABASE_LARGE === "1" ? 2101 : 601);
    assert.equal(end.payload.consistency, "batched_non_atomic");
    const storeScan = events.find((event) => event.kind === "database.storeScan" && event.payload.graphCaptureId === snapshot.payload.graphCaptureId);
    assert.equal(storeScan?.payload.status, "count_matched");
    assert.equal(storeScan.payload.initialCount, rows.length);
    const large = rows.find((event) => event.payload.graphReference);
    assert.ok(large, "未记录大型数据库值分段");
    const graph = JSON.parse(reconstructFragments(large.payload.graphReference, events));
    const blob = graph.nodes.find((node) => node.type === "blob");
    assert.equal(blob?.size, 120000);
    assert.equal(createHash("sha256").update(Buffer.from(blob.data, "base64")).digest("hex"),
      createHash("sha256").update(Buffer.alloc(120000, 42)).digest("hex"));
    assert.ok(JSON.stringify(graph).includes("9007199254740993"));
    assert.ok(browserObservations.some((row) => row.domain === "indexeddb" && row.kind === "graph-node" && row.type === "blob" &&
      row.source.eventId === large.id && row.source.fragmentCaptureId === large.payload.graphReference.captureId));
    assert.ok(browserObservations.some((row) => row.kind === "field-path" && row.path === "/value/self" && row.cycle && row.source.eventId === large.id));
    assert.ok(browserObservations.some((row) => row.kind === "field-path" && row.path === null && row.type === "string" &&
      row.source.eventId === large.id && row.location.some((part) => part.mapEntry === 0 && part.part === "value") &&
      row.location.some((part) => part.setEntry === 0) && row.location.at(-1)?.key === "name"));
    const idField = browserFields.find((row) => row.database === "fixture-database" && row.store === "records" && row.path === "/value/id");
    assert.ok(idField?.typeConflict && idField.types.number >= 600 && idField.types.string >= 1);
    assert.ok(idField.evidence.every((source) => source.eventId && source.path && source.line));
  }
  if (process.env.TEST_DATABASE_CATALOG === "1") {
    const initial = events.find((event) => event.kind === "database.catalog" && event.payload.reason === "initial" &&
      event.payload.databases?.some((database) => database.name === "fixture-remove-database"));
    assert.ok(initial, "缺少录制开始时数据库目录");
    assert.ok(events.some((event) => event.kind === "database.snapshot" && event.payload.catalogId === initial.payload.catalogId && event.payload.catalogIndex === 0));
    assert.ok(events.some((event) => event.kind === "database.catalogEnd" && event.payload.catalogId === initial.payload.catalogId && event.payload.status === "captured"));
    const final = events.find((event) => event.kind === "database.catalog" && event.frameId === initial.frameId && event.payload.reason === "stop");
    assert.deepEqual(final?.payload.databases, []);
    assert.ok(events.some((event) => event.kind === "database.catalogEnd" && event.payload.catalogId === final.payload.catalogId && event.payload.status === "captured"));
    assert.equal(manifest.session.coverage.databaseGaps, 0);
    const relationships = manifest.relationshipChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(relationships.some((edge) => edge.relation === "database_catalog" && edge.targetId === initial.payload.catalogId));
    assert.ok(!relationships.some((edge) => edge.relation === "cache_catalog" && edge.targetId === initial.payload.catalogId));
  }
  if (process.env.TEST_DATABASE_CATALOG_LARGE === "1") {
    const catalog = events.find((event) => event.kind === "database.catalog" && event.payload.reason === "initial" && event.payload.count === 35);
    assert.equal(catalog?.payload.status, "fragmented");
    const databases = JSON.parse(reconstructFragments(catalog.payload.reference, events));
    assert.equal(databases.length, 35);
    assert.ok(databases.some((entry) => entry.name === `34:${"d".repeat(3000)}`));
    assert.ok(events.some((event) => event.kind === "database.catalogEnd" && event.payload.catalogId === catalog.payload.catalogId && event.payload.processed === 35));
    assert.equal(manifest.session.coverage.databaseGaps, 0);
  }
  if (process.env.TEST_CACHE_BODY === "1") {
    const cached = events.find((event) => event.kind === "cache.entry" && event.payload.cacheName === "fixture-cache" && event.payload.body?.reference);
    assert.ok(cached, "未记录缓存正文分段");
    assert.ok(cached.payload.request.headers.some(([name, value]) => name === "x-fixture-request" && value === "request-value"));
    assert.ok(cached.payload.response.headers.some(([name, value]) => name === "x-fixture-response" && value === "response-value"));
    const bytes = Buffer.from(reconstructFragments(cached.payload.body.reference, events), "base64");
    assert.equal(bytes.length, cached.payload.body.size);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(180000, 0xa7)).digest("hex"));
  }
  if (process.env.TEST_VIRTUAL_LIST === "1") {
    const snapshots = events.filter((event) => event.kind === "page.snapshot");
    assert.ok(snapshots.some((event) => event.payload.html?.includes("rows-0-9")));
    assert.ok(snapshots.some((event) => event.payload.html?.includes("rows-50-59") && event.payload.html.includes("lazy-loaded-data") && event.payload.scroll?.coverage === "rendered_only"));
    const scroll = events.find((event) => event.kind === "interaction.scroll" && event.payload.target?.selector === "#virtual" && event.payload.scrollTop === 500);
    const input = events.find((event) => event.kind === "interaction.input" && event.payload.value === "example value");
    assert.ok(scroll && input);
    for (const action of [scroll, input]) {
      const screenshots = events.filter((event) => event.kind === "screenshot" && event.payload.eventIds?.includes(action.id));
      assert.equal(screenshots.length, 1);
      assert.ok(["captured", "shared"].includes(screenshots[0].payload.status));
      assert.ok(screenshots[0].payload.capturedAt >= action.time);
    }
  }
  if (process.env.TEST_CACHE_REMOVAL === "1") {
    const initial = events.find((event) => event.kind === "cache.catalog" && event.payload.reason === "initial" && event.payload.names?.includes("fixture-remove"));
    const final = events.find((event) => event.kind === "cache.catalog" && event.payload.reason === "stop" && event.payload.status === "captured");
    assert.ok(initial && final && !final.payload.names.includes("fixture-remove"));
    assert.ok(events.some((event) => event.kind === "cache.catalogEnd" && event.payload.catalogId === initial.payload.catalogId && event.payload.status === "captured"));
    assert.ok(events.some((event) => event.kind === "cache.catalogEnd" && event.payload.catalogId === final.payload.catalogId && event.payload.status === "captured"));
    const item = events.find((event) => event.kind === "cache.entry" && event.payload.catalogId === initial.payload.catalogId && event.payload.cacheName === "fixture-remove");
    assert.equal(Buffer.from(item?.payload.body?.data || "", "base64").toString(), "original-cache-value");
    assert.equal(manifest.session.coverage.cacheGaps, 0);
  }
  if (process.env.TEST_CACHE_CATALOG_LARGE === "1") {
    const catalog = events.find((event) => event.kind === "cache.catalog" && event.payload.reason === "initial" && event.payload.status === "fragmented");
    assert.ok(catalog, "未记录大型缓存目录分段");
    const names = JSON.parse(reconstructFragments(catalog.payload.reference, events));
    assert.equal(names.length, 40);
    assert.deepEqual(names, Array.from({ length: 40 }, (_, index) => `${index}:${"x".repeat(3000)}`));
    assert.ok(events.some((event) => event.kind === "cache.catalogEnd" && event.payload.catalogId === catalog.payload.catalogId && event.payload.processed === 40));
    assert.equal(manifest.session.coverage.cacheGaps, 0);
  }
  if (process.env.TEST_CACHE_OPAQUE === "1") {
    assert.ok(events.some((event) => event.kind === "cache.entry" && event.payload.cacheName === "opaque-cache" && event.payload.status === "opaque"));
    assert.ok(manifest.session.coverage.cacheGaps > 0);
  }
  if (process.env.TEST_CACHE_MANY === "1") {
    const snapshot = events.find((event) => event.kind === "cache.snapshot" && event.payload.name === "fixture-cache" && event.payload.reason === "initial");
    assert.equal(snapshot?.payload.total, 56);
    assert.equal(snapshot.payload.omitted, 0);
    const entries = events.filter((event) => event.kind === "cache.entry" && event.payload.snapshotId === snapshot.payload.snapshotId);
    assert.equal(entries.length, 56);
    assert.ok(entries.every((event) => event.payload.status === "captured"));
  }
  if (background) assert.ok(events.some((event) => event.kind === "screenshot.fullPage" &&
    event.payload.status === "captured" && event.payload.url.endsWith("/background")), "切回标签后未取得整页截图");
  if (process.env.TEST_FULL_PAGE === "1") {
    const full = events.find((event) => event.kind === "screenshot.fullPage" && event.payload.status === "captured");
    assert.ok(full, JSON.stringify(events.filter((event) => event.kind === "screenshot.fullPage").map((event) => event.payload)));
    assert.ok(full.payload.contentSize.height >= 3500);
    const finalSnapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
    const final = events.find((event) => event.kind === "screenshot.fullPage" && event.payload.capturePhase === "final" && event.payload.snapshotEventId === finalSnapshot?.id);
    assert.equal(final?.payload.status, "captured", JSON.stringify(final?.payload));
    const finalEncoded = Buffer.from(archive[`screenshots/${final.payload.assetId}.png`]).toString("base64");
    const finalPixel = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1;
      const context = canvas.getContext("2d"); context.drawImage(bitmap, Math.floor(bitmap.width * 0.9), Math.floor(bitmap.height * 0.9), 1, 1, 0, 0, 1, 1);
      const pixel = Array.from(context.getImageData(0, 0, 1, 1).data); bitmap.close(); return pixel;
    }, finalEncoded);
    assert.deepEqual(finalPixel, [75, 99, 123, 255]);
    const bytes = archive[`screenshots/${full.payload.assetId}.png`];
    assert.ok(bytes?.length > 24);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    assert.equal(view.getUint32(16), full.payload.pixelSize.width);
    assert.equal(view.getUint32(20), full.payload.pixelSize.height);
    assert.ok(full.payload.pixelSize.height >= 3500);
  }
  if (expectedSource) {
    const snapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.sourceReference);
    assert.ok(snapshot, "未记录大页面分段引用");
    assert.equal(snapshot.payload.sourceStatus, "fragmented");
    assert.equal(reconstructFragments(snapshot.payload.sourceReference, events), expectedSource);
    if (process.env.TEST_SKILL_RECONSTRUCT === "1") {
      const index = path.join(profile, "skill-index.sqlite3"), output = path.join(profile, "source.html");
      const skill = path.resolve("skills/extension-logic-clone/scripts");
      execFileSync("python", [path.join(skill, "index_archive.py"), archivePath, "--output", index], { env: { ...process.env, PYTHONUTF8: "1" } });
      execFileSync("python", [path.join(skill, "reconstruct_payload.py"), index, "--event-id", snapshot.id,
        "--reference", "/payload/sourceReference", "--output", output], { env: { ...process.env, PYTHONUTF8: "1" } });
      assert.equal(await fs.readFile(output, "utf8"), expectedSource);
    }
  }
  if (process.env.TEST_MUTATION_BATCH === "1") {
    const mutations = events.filter((event) => event.kind === "page.mutation");
    const changes = mutations.flatMap((event) => event.payload.changes)
      .filter((change) => change.type === "attribute" && change.name === "data-counter");
    assert.equal(changes.length, 250);
    for (let index = 0; index < changes.length; index++) {
      assert.equal(changes[index].before, index === 0 ? null : String(index - 1));
      assert.equal(changes[index].value, String(index));
    }
    const groups = mutations.filter((event) => event.payload.batchCount > 1);
    assert.ok(groups.length >= 2);
    assert.equal(groups[0].payload.batchId, groups[1].payload.batchId);
    assert.deepEqual(groups.slice(0, 2).map((event) => event.payload.batchIndex), [0, 1]);
  }
  if (process.env.TEST_RAW_MUTATION === "1") {
    const changes = events.filter((event) => event.kind === "page.mutation").flatMap((event) => event.payload.rawChanges || []);
    const attr = changes.find((change) => change.type === "attribute" && change.name === "data-long");
    assert.equal(attr?.before.value, null);
    assert.equal(reconstructFragments(attr.value.reference, events), "r".repeat(15000));
    const child = changes.filter((change) => change.type === "children").flatMap((change) => change.added)
      .find((node) => node.data?.content?.includes("native-script-text"));
    assert.ok(child?.data.topology.length >= 4, "原始新增节点和子节点标识缺失");
  }
  if (process.env.TEST_LARGE_STORAGE === "1") {
    const snapshot = events.find((event) => event.kind === "storage.snapshot" && event.payload.storageReference);
    assert.ok(snapshot, "未记录大存储快照的分段引用");
    const storage = JSON.parse(reconstructFragments(snapshot.payload.storageReference, events));
    assert.equal(storage.coverage.localStorage.status, "captured");
    assert.equal(storage.coverage.localStorage.captured, 251);
    for (let index = 0; index < 250; index++)
      assert.equal(storage.stores.localStorage[`fixture-${index}`], `${index}:` + "s".repeat(8500));
    assert.equal(storage.stores.localStorage.__proto__, "special-value");
    assert.ok(browserObservations.some((row) => row.domain === "storage" && row.key === "fixture-249" &&
      row.source.fragmentCaptureId === snapshot.payload.storageReference.captureId));
    assert.equal(manifest.session.coverage.storageGaps, 0, JSON.stringify(events.filter((event) => event.kind === "storage.snapshot")
      .map((event) => ({ url: event.payload.url, coverage: event.payload.coverage,
        storageStatus: event.payload.storageStatus, reference: event.payload.storageReference,
        hasEnd: events.some((item) => item.kind === "capture.fragmentEnd" && item.payload.captureId === event.payload.storageReference?.captureId) }))));
  }
  if (process.env.TEST_STYLE_CAPTURE === "1") {
    const stylesheet = events.find((event) => event.kind === "page.stylesheet" &&
      event.payload.cssText?.includes("--fixture-tone") && event.payload.cssText.includes("/fixture-image.png"));
    assert.ok(stylesheet, "未保存动态样式规则和资源引用");
    assert.equal(stylesheet.payload.status, "captured");
    assert.ok(events.some((event) => event.kind === "page.snapshot" &&
      event.payload.snapshotId === stylesheet.payload.snapshotId));
    const imported = events.find((event) => event.kind === "page.stylesheet" && event.payload.source === "import" &&
      event.payload.snapshotId === stylesheet.payload.snapshotId && event.payload.cssText?.includes(".fixture-import"));
    assert.equal(imported?.payload.parentIndex, stylesheet.payload.index);
    const computed = events.filter((event) => event.kind === "page.computedStyle").flatMap((event) => unpackComputedEntries(event.payload));
    assert.ok(computed.some((entry) => entry.status === "captured" &&
      entry.properties.some(([name, value]) => name === "color" && value === "rgb(1, 2, 3)")), "未记录实际计算颜色");
    const theme = manifest.themeObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(theme.some((item) => item.property === "color" && item.value === "rgb(1, 2, 3)" && item.source === "computed"));
  }
  if (process.env.TEST_PSEUDO_STYLE === "1") {
    const styleEvents = events.filter((event) => event.kind === "page.computedStyle");
    const entries = styleEvents.flatMap((event) => unpackComputedEntries(event.payload));
    const compressed = styleEvents.find((event) => event.payload.entriesEncoding === "gzip-base64-json-v1");
    assert.ok(compressed);
    const skill = path.resolve("skills/extension-logic-clone/scripts");
    const styleIndex = path.join(profile, "style-index.sqlite3"), decoded = path.join(profile, "style-batch.json");
    execFileSync("python", [path.join(skill, "index_archive.py"), archivePath, "--output", styleIndex], { env: { ...process.env, PYTHONUTF8: "1" } });
    execFileSync("python", [path.join(skill, "decode_computed_style.py"), styleIndex, "--event-id", compressed.id, "--output", decoded], { env: { ...process.env, PYTHONUTF8: "1" } });
    assert.deepEqual(JSON.parse(await fs.readFile(decoded, "utf8")), unpackComputedEntries(compressed.payload));
    for (const [pseudo, color] of [["::placeholder", "rgb(111, 22, 33)"], ["::marker", "rgb(44, 55, 66)"],
      ["::first-letter", "rgb(77, 88, 99)"], ["::selection", "rgb(21, 32, 43)"]]) {
      assert.ok(entries.some((entry) => entry.pseudos?.[pseudo]?.some(([name, value]) => name === "color" && value === color)), `未记录 ${pseudo} 颜色`);
      const theme = manifest.themeObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
      assert.ok(theme.some((item) => item.pseudo === pseudo && item.property === "color" && item.value === color));
    }
    const captured = entries.find((entry) => entry.pseudos?.["::placeholder"]?.some(([name, value]) => name === "color" && value === "rgb(111, 22, 33)"));
    const actual = await page.evaluate(() => {
      const element = document.querySelector(".pseudo-input");
      return [null, "::before", "::after", "::placeholder"].map((pseudo) => {
        const style = getComputedStyle(element, pseudo);
        return Array.from({ length: style.length }, (_, index) => { const name = style.item(index); return [name, style.getPropertyValue(name)]; });
      });
    });
    assert.deepEqual([captured.properties, captured.before, captured.after, captured.pseudos["::placeholder"]], actual);
  }
  if (process.env.TEST_THEME_SWITCH === "1") {
    const styles = events.filter((event) => event.kind === "page.interactionStyle" && event.payload.reason === "pointerover");
    const hover = styles.find((event) => event.payload.properties?.some(([name, value]) => name === "color" && value === "rgb(200, 20, 30)"));
    assert.ok(hover, "未记录悬停时的实际颜色");
    assert.ok(events.some((event) => event.kind === "interaction.pointerover" && event.payload.interactionCaptureId === hover.payload.interactionCaptureId &&
      event.payload.target?.nodeId === hover.payload.nodeId));
    assert.equal(manifest.session.coverage.interactionStyleGaps, 0);
    const relations = manifest.relationshipChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(relations.filter((item) => item.relation === "interaction_capture" && item.targetId === hover.payload.interactionCaptureId).length >= 2);
    const theme = manifest.themeObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(theme.some((item) => item.source === "computed_interaction" && item.interactionCaptureId === hover.payload.interactionCaptureId && item.value === "rgb(200, 20, 30)"));
    assert.ok(theme.some((item) => item.source === "computed_interaction" && item.interactionCaptureId === hover.payload.interactionCaptureId &&
      item.property === "color" && item.value === "rgb(1, 222, 45)"), "未记录悬停影响的子元素颜色");
    assert.equal(manifest.session.coverage.interactionDescendantGaps, 0);
    for (const value of ["rgb(11, 22, 33)", "rgb(99, 88, 77)"])
      assert.ok(theme.some((item) => item.property === "--accent" && item.value.trim() === value), `未记录主题变量 ${value}`);
  }
  if (process.env.TEST_SHADOW_STYLE === "1") {
    const style = events.find((event) => event.kind === "page.stylesheet" && event.payload.source === "shadow" &&
      event.payload.cssText?.includes("rgb(9, 8, 7)"));
    assert.ok(style?.payload.hostNodeId && style.payload.shadowRootId, "未保存关闭式 Shadow DOM 样式和宿主关联");
    const source = events.find((event) => event.kind === "page.shadowRoot" && event.payload.mode === "closed" &&
      event.payload.rootNodeId === style.payload.shadowRootId && event.payload.status === "fragmented");
    assert.ok(source && source.payload.hostNodeId === style.payload.hostNodeId, "未记录关闭式组件原始结构");
    const sourceHtml = reconstructFragments(source.payload.reference, events);
    assert.ok(sourceHtml.includes("z".repeat(110000)) && sourceHtml.includes('<script type="text/plain">native-shadow-script</script>'));
    assert.ok(events.some((event) => event.kind === "page.shadowRootEnd" && event.payload.captureId === source.payload.captureId && event.payload.status === "captured"));
    assert.ok(events.some((event) => event.kind === "page.shadowRoot" && event.payload.captureId === source.payload.captureId &&
      event.payload.parentRootNodeId === source.payload.rootNodeId && event.payload.html === '<b data-native="yes">nested-shadow</b>'));
    assert.ok(events.filter((event) => event.kind === "page.computedStyle").flatMap((event) => unpackComputedEntries(event.payload))
      .some((entry) => entry.properties?.some(([name, value]) => name === "color" && value === "rgb(9, 8, 7)")));
  }
  if (process.env.TEST_LARGE_RESPONSE === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/large-response"));
    const response = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request?.payload.requestId);
    assert.equal(response?.payload.body.status, "captured_asset", JSON.stringify(response?.payload.body));
    const bytes = archive[`resources/${response.payload.assetId}.bin`];
    assert.equal(Buffer.from(bytes).toString("utf8"), JSON.stringify({ payload: "x".repeat(1100000) }));
    assert.ok(["browser-decoded-text", "browser-provided-bytes"].includes(response.payload.body.representation));
    const observations = manifest.fieldObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(observations.some((row) => row.kind === "field" && row.location[0]?.key === "payload" &&
      row.source.assetPath === `resources/${response.payload.assetId}.bin`));
  }
  if (process.env.TEST_LARGE_BINARY === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/large-binary"));
    const response = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request?.payload.requestId);
    assert.equal(response?.payload.body.status, "captured_asset", JSON.stringify(response?.payload.body));
    assert.equal(response.payload.body.representation, "browser-provided-bytes");
    const bytes = archive[`resources/${response.payload.assetId}.bin`];
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(4100000, 0xa7)).digest("hex"));
  }
  if (process.env.TEST_LARGE_BINARY_18 === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/large-binary-18"));
    const response = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request?.payload.requestId);
    assert.equal(response?.payload.body.status, "captured_asset", JSON.stringify(response?.payload.body));
    assert.equal(response.payload.body.representation, "browser-provided-bytes");
    const bytes = archive[`resources/${response.payload.assetId}.bin`];
    assert.equal(bytes?.length, 18000000);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(18000000, 0x8d)).digest("hex"));
  }
  if (process.env.TEST_VISUAL_RESOURCES === "1") {
    const selected = await page.locator("#fixture-responsive-image").evaluate((image) => new URL(image.currentSrc).pathname);
    for (const url of [selected, "/fixture-resource-layer1.svg", "/fixture-resource-layer2.svg", "/fixture-resource-cross.svg"]) {
      const request = events.find((event) => event.kind === "network.request" && new URL(event.payload.url).pathname === url);
      const response = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request?.payload.requestId);
      assert.equal(response?.payload.body.status, "captured_asset", `${url}: ${JSON.stringify(response?.payload.body)}`);
      const bytes = archive[`resources/${response.payload.assetId}.bin`];
      assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(svgFixture(url)).digest("hex"));
      assert.ok(request.payload.frameId);
      assert.equal(request.tabId, response.tabId);
    }
    assert.ok(events.some((event) => event.kind === "page.snapshot" && event.payload.sourceHtml?.includes("fixture-resource-layer1.svg") &&
      event.payload.sourceHtml.includes("fixture-resource-src2.svg")));
    assert.ok(events.some((event) => event.kind === "page.computedStyle" || event.kind === "page.stylesheet"));
  }
  if (process.env.TEST_REDIRECT === "1") {
    const first = events.find((event) => event.kind === "network.request" && event.payload.url.includes("/fixture-redirect?"));
    const next = events.find((event) => event.kind === "network.request" && event.payload.url.includes("/fixture-final?"));
    assert.ok(first && next);
    assert.deepEqual([...new URL(first.payload.url).searchParams], [["tag", "one"], ["tag", "two"], ["encoded", "中"]]);
    assert.equal(next.payload.redirectFrom, first.payload.requestId);
    const redirect = events.find((event) => event.kind === "network.response" && event.payload.requestId === first.payload.requestId);
    assert.equal(redirect?.payload.status, 302);
    assert.equal(redirect.payload.protocolResponse.url, first.payload.url);
    assert.ok(Object.entries(redirect.payload.protocolResponse.headers).some(([name, value]) => name.toLowerCase() === "x-fixture-redirect" && value === "native-header"));
    assert.ok(events.some((event) => event.kind === "network.finished" && event.payload.requestId === first.payload.requestId && event.payload.body.status === "omitted_redirect"));
    assert.ok(manifest.session.coverage.responseGaps > 0);
    const relations = manifest.relationshipChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(relations.some((row) => row.relation === "redirected_from" && row.targetId === first.payload.requestId));
    const queryFields = manifest.fieldObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse))
      .filter((row) => row.kind === "field" && row.source.requestId === first.payload.requestId && row.source.direction === "query");
    assert.deepEqual(queryFields.map((row) => [row.location[0].key, row.location[0].occurrence, row.queryIndex]),
      [["tag", 0, 0], ["tag", 1, 1], ["encoded", 0, 2]]);
    const summaries = manifest.fieldSummaryChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(summaries.some((row) => row.direction === "query" && row.endpoint.url.endsWith("/fixture-redirect") && row.location[0]?.key === "tag" && row.occurrences === 2));
  }
  if (process.env.TEST_NETWORK_CONCURRENT === "1") {
    const requests = events.filter((event) => event.kind === "network.request" && event.payload.url.endsWith("/fixture-concurrent?fixed=1"));
    assert.equal(requests.length, 6);
    assert.equal(new Set(requests.map((event) => event.payload.requestId)).size, 6);
    for (const request of requests) {
      const header = Object.entries(request.payload.headers).find(([name]) => name.toLowerCase() === "x-fixture-id");
      const index = Number(header?.[1]);
      const response = events.find((event) => event.kind === "network.response" && event.payload.requestId === request.payload.requestId);
      const finished = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request.payload.requestId);
      assert.equal(response?.payload.status, index === 5 ? 500 : 200);
      assert.equal(JSON.parse(finished.payload.body.value).fixtureId, index);
    }
  }
  if (process.env.TEST_TEXT_FIELDS === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/fixture-text"));
    assert.ok(request);
    const observations = manifest.fieldObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    const fields = observations.filter((row) => row.kind === "field" && row.source.requestId === request.payload.requestId);
    assert.ok(fields.some((row) => row.source.direction === "request" && row.type === "string" && row.length === "request 123".length));
    assert.ok(fields.some((row) => row.source.direction === "response" && row.type === "string" && row.length === "response 42\n".length));
  }
  if (process.env.TEST_FORM_FIELDS === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/fixture-form"));
    const large = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/fixture-form-large"));
    assert.ok(request && large);
    const captured = events.find((event) => event.kind === "network.requestBody" && event.payload.requestId === large.payload.requestId);
    assert.equal(captured?.payload.body.status, "captured_asset");
    const observations = manifest.fieldObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    const fields = observations.filter((row) => row.kind === "field" && row.source.requestId === request.payload.requestId);
    assert.deepEqual(fields.map((row) => [row.location[0].key, row.location[0].occurrence, row.formIndex]),
      [["tag", 0, 0], ["tag", 1, 1], ["empty", 0, 2], ["flag", 0, 3]]);
    assert.ok(observations.some((row) => row.kind === "field" && row.source.requestId === large.payload.requestId &&
      row.location[0]?.key === "payload" && row.source.assetPath === `resources/${captured.payload.body.assetId}.bin`));
    for (const [suffix, status] of [["/fixture-form-unsupported", "unsupported_form_charset"], ["/fixture-form-invalid", "invalid_form_encoding"]]) {
      const failed = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith(suffix));
      assert.equal(failed?.payload.postData.value, "name=%E9");
      assert.ok(observations.some((row) => row.kind === "sample" && row.source.requestId === failed.payload.requestId && row.status === status));
      assert.ok(!observations.some((row) => row.kind === "field" && row.source.requestId === failed.payload.requestId));
    }
  }
  if (process.env.TEST_LARGE_REQUEST === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/large-post"));
    const captured = events.find((event) => event.kind === "network.requestBody" && event.payload.requestId === request?.payload.requestId);
    assert.equal(captured?.payload.body.status, "captured_asset", JSON.stringify(captured?.payload.body));
    const bytes = archive[`resources/${captured.payload.body.assetId}.bin`];
    assert.equal(Buffer.from(bytes).toString("utf8"), JSON.stringify({ payload: "p".repeat(1100000) }));
    const observations = manifest.fieldObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(observations.some((row) => row.kind === "field" && row.location[0]?.key === "payload" &&
      row.source.assetPath === `resources/${captured.payload.body.assetId}.bin`));
  }
  if (process.env.TEST_BINARY_REQUEST === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/binary-post"));
    assert.equal(request?.payload.postDataEntriesStatus, "pending", "浏览器未提供测试请求体字节条目");
    const result = events.find((event) => event.kind === "network.requestDataEntries" && event.payload.requestId === request.payload.requestId);
    assert.equal(result?.payload.status, "captured");
    const bytes = Buffer.concat(result.payload.entries.map((entry) => Buffer.from(archive[`resources/${entry.assetId}.bin`])));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(Buffer.alloc(40000, 0xe3)).digest("hex"));
  }
  if (process.env.TEST_LARGE_IMAGE === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/large-image"));
    const response = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request?.payload.requestId);
    assert.equal(response?.payload.body.status, "captured_asset", JSON.stringify(response?.payload.body));
    const bytes = archive[`resources/${response.payload.assetId}.bin`];
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(imageFixture()).digest("hex"));
    const index = JSON.parse(strFromU8(archive["resources/index.json"]));
    assert.equal(index.find((asset) => asset.id === response.payload.assetId)?.mime, "image/png");
  }
  if (process.env.TEST_FONT === "1") {
    const request = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/fixture-font.ttf"));
    const response = events.find((event) => event.kind === "network.finished" && event.payload.requestId === request?.payload.requestId);
    assert.equal(response?.payload.body.status, "captured_asset", JSON.stringify(response?.payload.body));
    const bytes = archive[`resources/${response.payload.assetId}.bin`];
    assert.equal(createHash("sha256").update(bytes).digest("hex"), createHash("sha256").update(fontFixture).digest("hex"));
    const fonts = events.find((event) => event.kind === "page.fonts" && event.payload.faces?.some((font) => font.family.includes("FixtureFont") && font.status === "loaded"));
    assert.ok(fonts, "未记录实际加载的字体状态");
  }
  if (process.env.TEST_LONG_INPUT === "1") {
    const input = events.find((event) => event.kind === "interaction.input" && event.payload.valueReference?.length === 16000);
    assert.ok(input, "长输入未记录分段引用");
    assert.equal(reconstructFragments(input.payload.valueReference, events), "b".repeat(16000));
    assert.ok(input.payload.beforeValueReference, "长输入前值未记录分段引用");
    assert.equal(reconstructFragments(input.payload.beforeValueReference, events), "a".repeat(15000));
  }
  if (process.env.TEST_FAST_CLICKS === "1") {
    const clicks = events.filter((event) => event.kind === "interaction.click" && event.payload.target?.selector === "#send");
    assert.ok(clicks.length >= 4);
    for (const click of clicks) {
      const images = events.filter((event) => event.kind === "screenshot" && event.payload.eventIds?.includes(click.id));
      assert.equal(images.length, 1, `点击 ${click.id} 的截图结果不唯一或缺失`);
      if (images[0].payload.eventIds.length > 1 && images[0].payload.status !== "unavailable")
        assert.equal(images[0].payload.status, "shared");
    }
  }
  const info = await manager.evaluate((extensionId) => chrome.developerPrivate.getExtensionInfo(extensionId), id);
  const errors = [...info.manifestErrors, ...info.runtimeErrors].map(({ message, source, occurrences }) => ({ message, source, occurrences }));
  assert.deepEqual(pageErrors, [], `页面错误: ${JSON.stringify(pageErrors)}`);
  const unexpectedErrors = process.env.TEST_QUOTA_FAILURE === "1"
    ? errors.filter((error) => !/事件写入失败|quota|配额/i.test(error.message)) : errors;
  assert.deepEqual(unexpectedErrors, [], `扩展错误: ${JSON.stringify(unexpectedErrors)}`);
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "example value"), "HTTP 页面输入未写入记录包");
  assert.ok(events.some((event) => event.kind === "network.request" && event.payload.url.endsWith("/api")), "HTTP 请求未写入记录包");
  const apiRequest = events.find((event) => event.kind === "network.request" && event.payload.url.endsWith("/api"));
  assert.ok(apiRequest.payload.protocolRequestId);
  const interfaces = manifest.interfaceChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  const apiIndex = interfaces.find((item) => item.method === apiRequest.payload.method && item.origin === new URL(apiRequest.payload.url).origin && item.path === "/api");
  assert.ok(apiIndex?.requests >= 1 && apiIndex.association === "recorded_context_only");
  assert.ok(apiIndex.contexts.some((context) => context.tabId === apiRequest.tabId && context.documentUrl === apiRequest.payload.documentUrl));
  assert.ok(apiIndex.evidence.some((evidence) => evidence.eventId === apiRequest.id && evidence.requestId === apiRequest.payload.requestId));
  assert.equal(apiRequest.payload.protocolRequest.url, apiRequest.payload.url);
  assert.ok(apiRequest.payload.initiator?.type);
  const apiResponse = events.find((event) => event.kind === "network.response" && event.payload.requestId === apiRequest.payload.requestId);
  assert.equal(apiResponse?.payload.protocolResponse.status, 200);
  const requestExtra = events.find((event) => event.kind === "network.requestExtraInfo" && event.payload.protocolRequestKey === apiRequest.payload.protocolRequestKey);
  const responseExtra = events.find((event) => event.kind === "network.responseExtraInfo" && event.payload.protocolRequestKey === apiRequest.payload.protocolRequestKey);
  assert.ok(requestExtra?.payload.details.headers, "未记录浏览器附加请求头");
  assert.ok(responseExtra?.payload.details.headers, "未记录浏览器附加响应头");
  assert.equal(responseExtra.payload.correlation, "protocol_id_only");
  const fields = manifest.fieldObservationChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(fields.some((field) => field.kind === "field" && field.type === "string" && field.location[0]?.key === "result"), "响应字段观察未写入记录包");
  const summaries = manifest.fieldSummaryChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(summaries.some((field) => field.direction === "response" && field.endpoint.url.endsWith("/api") && field.location[0]?.key === "result"));
  const relationships = manifest.relationshipChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(relationships.some((row) => row.relation === "screenshot_of" && row.confidence === "recorded"));
  if (process.env.TEST_FRAME_TREE === "1") assert.ok(relationships.some((row) => row.relation === "frame_parent" && row.parentFrameId === 0));
  assert.ok(events.some((event) => event.kind === "screenshot" && event.payload.assetId &&
    archive[`screenshots/${event.payload.assetId}.png`]?.length > 8), "HTTP 页面截图未写入记录包");
  if (process.env.TEST_PNG_PIXEL === "1") {
    const screenshot = events.find((event) => event.kind === "screenshot" && event.payload.assetId && !event.payload.contextChanged);
    assert.ok(screenshot, "未找到匹配页面的截图");
    const encoded = Buffer.from(archive[`screenshots/${screenshot.payload.assetId}.png`]).toString("base64");
    const actual = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const pixel = Array.from(context.getImageData(Math.floor(bitmap.width * 0.9), Math.floor(bitmap.height * 0.9), 1, 1).data);
      bitmap.close();
      return { width: canvas.width, height: canvas.height, pixel };
    }, encoded);
    assert.ok(Math.abs(actual.width - screenshot.payload.viewport.width * screenshot.payload.viewport.dpr) <= 2);
    assert.ok(Math.abs(actual.height - screenshot.payload.viewport.height * screenshot.payload.viewport.dpr) <= 2);
    const oldColor = [23, 61, 97, 255], newColor = [75, 99, 123, 255];
    if (!backgroundChangedAt || screenshot.payload.capturedAt < backgroundChangedAt.changedAt) assert.deepEqual(actual.pixel, oldColor);
    else if (screenshot.payload.captureStartedAt > backgroundChangedAt.paintedAt) assert.deepEqual(actual.pixel, newColor);
    else assert.ok([oldColor, newColor].some((color) => color.every((value, index) => value === actual.pixel[index])), "跨越颜色变化的截图包含非预期像素");
  }
  console.log("正式版 Chrome 录制和导出完成，未发现非预期扩展错误");
} finally {
  if (root) await root.send("Browser.close").catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await exited;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
