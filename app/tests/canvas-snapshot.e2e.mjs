import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";

const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
const server = http.createServer((request, response) => {
  if (request.url === "/cross.png") {
    response.writeHead(200, { "Content-Type": "image/png" });
    response.end(pixel);
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>画布快照测试</title>
    <canvas id="chart" width="100" height="40"></canvas><button id="update">更新图表</button>
    <canvas id="cross" width="2" height="2"></canvas><canvas id="large" width="1001" height="500"></canvas>
    <canvas id="password-canvas" width="2" height="2"></canvas><div id="host"></div>
    <script>
      const chart = document.querySelector('#chart');
      function paint(color) { const c = chart.getContext('2d'); c.fillStyle = color; c.fillRect(0, 0, 100, 40); }
      paint('#ff0000'); document.querySelector('#update').onclick = () => paint('#0000ff');
      const shadow = document.querySelector('#host').attachShadow({mode:'closed'});
      const inner = document.createElement('canvas'); inner.id = 'shadow-chart'; inner.width = 20; inner.height = 20;
      shadow.append(inner); inner.getContext('2d').fillStyle = '#00ff00'; inner.getContext('2d').fillRect(0,0,20,20);
      window.canvasReady = new Promise((resolve, reject) => {
        const image = new Image(); image.onload = () => { document.querySelector('#cross').getContext('2d').drawImage(image,0,0); resolve(); };
        image.onerror = reject; image.src = 'http://localhost:${server.address().port}/cross.png';
      });
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-canvas-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-canvas-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(() => window.canvasReady);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  assert.equal(await panel.getByLabel("记录画布静态画面（可能含敏感信息）").isChecked(), true);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const start = (enabled) => panel.evaluate(({ tab, enabled }) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, canvasSnapshots: enabled, scope: "site" },
  }), { tab, enabled });
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
  const started = await start(true);
  assert.equal(started.ok, true);
  await page.bringToFront();
  await page.locator("#update").click();
  await page.locator("#chart").click();
  await page.waitForTimeout(800);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  assert.ok(stopped.value.coverage.canvasGaps > 0);
  let events = await readEvents(started.value.id);
  const snapshot = events.find((event) => event.kind === "page.snapshot" && event.frameId === 0 && event.payload.reason === "stop");
  assert.ok(snapshot?.payload.html);
  assert.equal(snapshot.payload.canvas.status, "captured");
  assert.equal(snapshot.payload.canvas.total, 5);
  assert.equal(snapshot.payload.canvas.captured, 2);
  assert.equal(snapshot.payload.canvas.unavailable, 1);
  assert.equal(snapshot.payload.canvas.omitted, 2);
  assert.equal(snapshot.payload.canvas.reasons.cross_origin, 1);
  assert.equal(snapshot.payload.canvas.reasons.pixel_limit, 1);
  assert.equal(snapshot.payload.canvas.reasons.sensitive, 1);
  const ids = await panel.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { chart: doc.querySelector("#chart")?.getAttribute("data-logic-node"),
      sensitive: doc.querySelector("#password-canvas")?.getAttribute("data-logic-node"),
      shadow: doc.querySelector("#host template")?.content.querySelector("#shadow-chart")?.getAttribute("data-logic-node") };
  }, snapshot.payload.html);
  const chartItem = snapshot.payload.canvas.items.find((item) => item.nodeId === ids.chart);
  assert.ok(chartItem);
  assert.equal(chartItem.pixelWidth, 100);
  assert.equal(chartItem.pixelHeight, 40);
  assert.ok(Number.isFinite(chartItem.captureStartedAt) && chartItem.captureStartedAt <= chartItem.capturedAt && chartItem.capturedAt <= snapshot.time);
  assert.ok(snapshot.payload.canvas.items.some((item) => item.nodeId === ids.shadow));
  assert.ok(!snapshot.payload.canvas.items.some((item) => item.nodeId === ids.sensitive));
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "画布快照测试" }).first();
  await record.getByText("完成（有采集提示）").waitFor();
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  const archivePath = path.join(profile, "canvas.zip");
  await download.saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const exported = archive.eventChunks.flatMap((name) => strFromU8(files[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(exported.find((event) => event.id === snapshot.id)?.payload.canvas.items.some((item) => item.nodeId === ids.chart));
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles(archivePath);
  await panel.getByRole("heading", { name: "画布快照测试" }).waitFor();
  await panel.getByPlaceholder("搜索记录").fill(snapshot.id);
  await panel.locator(".timeline-item").first().click();
  await panel.getByText("画布仅显示快照时采集的静态画面", { exact: false }).waitFor();
  await panel.getByText("画布静态画面无法读取：1 个", { exact: false }).waitFor();
  const frame = panel.frameLocator('iframe[title="页面快照"]');
  async function renderedPixel(locator) {
    const image = await locator.screenshot();
    return panel.evaluate(async (encoded) => {
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      const color = [...context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1).data];
      bitmap.close();
      return color;
    }, image.toString("base64"));
  }
  const chartInfo = await frame.locator("#chart").evaluate((node) => ({
    rect: node.getBoundingClientRect().toJSON(), display: getComputedStyle(node).display,
    visibility: getComputedStyle(node).visibility, html: node.outerHTML.slice(0, 300),
  }));
  if (!chartInfo.rect.width || !chartInfo.rect.height) throw new Error(`图表尺寸无效：${JSON.stringify(chartInfo)}`);
  assert.deepEqual((await renderedPixel(frame.locator("#chart"))).slice(0, 3), [0, 0, 255]);
  assert.deepEqual((await renderedPixel(frame.locator("#shadow-chart"))).slice(0, 3), [0, 255, 0]);
  const canvasClick = events.find((event) => event.kind === "interaction.click" && event.payload?.target?.selector === "#chart");
  assert.ok(canvasClick);
  await panel.getByPlaceholder("搜索记录").fill(canvasClick.id);
  await panel.locator(".timeline-item").first().click();
  await panel.getByRole("button", { name: "从此操作复现" }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const replayCanvas = panel.frameLocator('iframe[title="逐步复现页面"]').locator("#chart");
  await replayCanvas.click();
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  assert.deepEqual((await renderedPixel(replayCanvas)).slice(0, 3), [0, 0, 255]);
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("画布静态画面无法读取：1 个", { exact: false }).first().waitFor();
  await panel.getByTitle("返回录制").click();
  await panel.getByLabel("记录画布静态画面（可能含敏感信息）").uncheck();
  await panel.getByLabel("记录操作截图").uncheck();
  await panel.getByText("我有权记录当前站点", { exact: false }).click();
  await page.bringToFront();
  await panel.waitForTimeout(2200);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).first().waitFor();
  const disabled = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(disabled.value.active.options.canvasSnapshots, false);
  const disabledStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(disabledStop.ok, true);
  events = await readEvents(disabled.value.active.id);
  const disabledSnapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
  assert.equal(disabledSnapshot?.payload.canvas.status, "disabled");
  assert.equal(disabledSnapshot.payload.canvas.total, 5);
  assert.deepEqual(disabledSnapshot.payload.canvas.items, []);
  await page.evaluate(() => {
    for (let i = 0; i < 55; i++) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      canvas.getContext("2d").fillRect(0, 0, 2, 2);
      document.body.append(canvas);
    }
  });
  const limited = await start(true);
  assert.equal(limited.ok, true);
  const limitedStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(limitedStop.ok, true);
  events = await readEvents(limited.value.id);
  const limitedSnapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
  assert.equal(limitedSnapshot?.payload.canvas.total, 60);
  assert.ok(limitedSnapshot.payload.canvas.items.length <= 5);
  assert.ok(limitedSnapshot.payload.canvas.geometry.length <= 50);
  assert.ok(limitedSnapshot.payload.canvas.geometryOmitted >= 10);
  const malicious = { id: "bad-canvas", kind: "page.snapshot", seq: 1, time: 1, tabId: 1, frameId: 0, documentId: "doc",
    payload: { url: "https://example.test/", status: "captured", html: '<!doctype html><canvas id="bad" data-logic-node="1" width="100" height="40"></canvas>',
      canvas: { status: "captured", total: 1, captured: 1, omitted: 0, unavailable: 0,
        geometry: [{ nodeId: "1", width: "100px", height: "40px", inline: true }],
        items: [{ nodeId: "1", data: 'data:image/png;base64,iVBORw0KGgo");background-image:url(https://example.test/tracker)/*' }] } } };
  const badManifest = { format: "logic-recorder", version: 2, session: { id: "bad-canvas", title: "异常画布测试", startedAt: 1 }, eventCount: 1, eventChunks: ["timeline/events-00001.jsonl"] };
  const badFiles = { "manifest.json": strToU8(JSON.stringify(badManifest)), "timeline/events-00001.jsonl": strToU8(JSON.stringify(malicious)) };
  badFiles["integrity.json"] = strToU8(JSON.stringify(Object.entries(badFiles).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  let probes = 0;
  await context.route("**/tracker", (route) => { probes++; return route.abort(); });
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(badFiles)) });
  await panel.getByRole("heading", { name: "异常画布测试" }).waitFor();
  await panel.getByText("部分画布数据或目标无法确认").waitFor();
  const badCanvas = panel.frameLocator('iframe[title="页面快照"]').locator("#bad");
  assert.equal(await badCanvas.evaluate((node) => getComputedStyle(node).backgroundImage), "none");
  await panel.waitForTimeout(200);
  assert.equal(probes, 0, "异常画布数据不得触发外部访问");
  console.log("画布静态采样、跨域和敏感限制、ZIP 回放及关闭选项通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
