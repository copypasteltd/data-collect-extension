import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const server = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>数值控件复现</title><input id="range" aria-label="范围" type="range" min="10" max="20" step="2" value="12"><input id="color" aria-label="颜色" type="color" value="#000000"><input id="number" aria-label="数量" type="number" min="1" max="9" step="2" value="3"><input id="fraction" type="range" min="-2.5" max="3.5" step="any" value="0"><input id="invalid" type="range" min="bad" max="1e999" step="-1" value="10">');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-numeric-replay-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-numeric-replay-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: false, scope: "site" } }), tab);
  assert.equal(started.ok, true);
  await page.bringToFront();
  await page.locator("#range").focus();
  await page.locator("#range").press("ArrowRight");
  await page.locator("#number").fill("7");
  await page.locator("#color").evaluate((input) => {
    input.value = "#123456";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#fraction").evaluate((input) => {
    input.value = "1.25";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator("#invalid").evaluate((input) => {
    input.value = "20";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.waitForTimeout(400);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  const events = await panel.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const items = await new Promise((resolve, reject) => {
      const request = db.transaction("events").objectStore("events").index("session").getAll(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return items;
  }, started.value.id);
  const findInput = (selector) => events.find((event) => event.kind === "interaction.input" && event.payload.target?.selector === selector);
  const range = findInput("#range"), number = findInput("#number"), color = findInput("#color");
  assert.equal(range?.payload.value, "14");
  assert.deepEqual(range.payload.target.numericConstraints, { min: "10", max: "20", step: "2" });
  assert.equal(number?.payload.value, "7");
  assert.deepEqual(number.payload.target.numericConstraints, { min: "1", max: "9", step: "2" });
  assert.equal(color?.payload.value, "#123456");
  assert.deepEqual(findInput("#fraction")?.payload.target.numericConstraints, { min: "-2.5", max: "3.5", step: "any" });
  assert.deepEqual(findInput("#invalid")?.payload.target.numericConstraints, { min: null, max: null, step: null });
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "数值控件复现" });
  async function openStep(id) {
    await record.getByTitle("查看记录").click();
    await panel.getByPlaceholder("搜索记录").fill(id);
    await panel.locator(".timeline-item").first().click();
    await panel.getByRole("button", { name: "从此操作复现" }).click();
  }
  async function exitViewer() { await panel.getByTitle("返回录制").click(); }
  await openStep(range.id);
  const slider = panel.getByLabel("输入记录值");
  assert.equal(await slider.getAttribute("type"), "range");
  assert.equal(await slider.getAttribute("min"), "10");
  assert.equal(await slider.getAttribute("max"), "20");
  assert.equal(await slider.getAttribute("step"), "2");
  const rangeStep = await panel.locator(".replay-header .section-label").textContent();
  await slider.focus();
  await slider.press("Home");
  await slider.press("ArrowRight");
  await slider.press("ArrowRight");
  await panel.waitForFunction((previous) => document.querySelector(".replay-header .section-label")?.textContent !== previous, rangeStep);
  await panel.getByRole("button", { name: "上一步" }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const pageSlider = panel.frameLocator('iframe[title="逐步复现页面"]').locator("#range");
  await pageSlider.focus();
  await pageSlider.press("Home");
  await pageSlider.press("ArrowRight");
  await pageSlider.press("ArrowRight");
  await panel.waitForFunction((previous) => document.querySelector(".replay-header .section-label")?.textContent !== previous, rangeStep);
  await exitViewer();
  await openStep(number.id);
  const numberInput = panel.getByLabel("输入记录值");
  assert.equal(await numberInput.getAttribute("type"), "number");
  assert.equal(await numberInput.getAttribute("step"), "2");
  const numberStep = await panel.locator(".replay-header .section-label").textContent();
  await numberInput.fill("7");
  await panel.waitForFunction((previous) => document.querySelector(".replay-header .section-label")?.textContent !== previous, numberStep);
  await exitViewer();
  await openStep(color.id);
  const colorInput = panel.getByLabel("输入记录值");
  assert.equal(await colorInput.getAttribute("type"), "color");
  const colorStep = await panel.locator(".replay-header .section-label").textContent();
  await colorInput.evaluate((input) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, "#123456");
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await panel.waitForFunction((previous) => document.querySelector(".replay-header .section-label")?.textContent !== previous ||
    [...document.querySelectorAll('[role="status"]')].some((node) => node.textContent.includes("已到达记录末尾")), colorStep);
  await exitViewer();
  const legacyEvent = { id: "legacy-range", kind: "interaction.input", seq: 1, time: 1, tabId: 1, frameId: 0,
    payload: { url: "https://example.test/", target: { tag: "input", type: "range", selector: "#range" }, value: "500" } };
  const legacyManifest = { format: "logic-recorder", version: 2, session: { id: "legacy-range", title: "旧滑块记录", startedAt: 1 }, eventCount: 1, eventChunks: ["timeline/events-00001.jsonl"] };
  const files = { "manifest.json": strToU8(JSON.stringify(legacyManifest)), "timeline/events-00001.jsonl": strToU8(JSON.stringify(legacyEvent)) };
  files["integrity.json"] = strToU8(JSON.stringify(Object.entries(files).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "legacy.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(files)) });
  await panel.getByRole("heading", { name: "旧滑块记录" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  const legacyInput = panel.getByLabel("输入记录值");
  assert.equal(await legacyInput.getAttribute("type"), "text");
  await legacyInput.fill("500");
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  const mismatchUrl = "https://example.test/mismatch";
  const mismatchEvents = [
    { id: "mismatch-snapshot", kind: "page.snapshot", seq: 1, time: 1, tabId: 1, frameId: 0, documentId: "doc",
      payload: { url: mismatchUrl, status: "captured", html: '<!doctype html><input id="range" data-logic-node="101" type="range" min="0" max="100" value="10">' } },
    { id: "mismatch-input", kind: "interaction.input", seq: 2, time: 2, tabId: 1, frameId: 0, documentId: "doc",
      payload: { url: mismatchUrl, target: { tag: "input", type: "range", selector: "#range", nodeId: "101",
        numericConstraints: { min: "10", max: "20", step: "2" } }, value: "14" } },
  ];
  const mismatchManifest = { format: "logic-recorder", version: 2, session: { id: "mismatch", title: "数值范围变化", startedAt: 1 }, eventCount: mismatchEvents.length, eventChunks: ["timeline/events-00001.jsonl"] };
  const mismatchFiles = { "manifest.json": strToU8(JSON.stringify(mismatchManifest)), "timeline/events-00001.jsonl": strToU8(mismatchEvents.map((event) => JSON.stringify(event)).join("\n")) };
  mismatchFiles["integrity.json"] = strToU8(JSON.stringify(Object.entries(mismatchFiles).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  await panel.locator('.viewer-top input[type="file"]').setInputFiles({ name: "mismatch.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(mismatchFiles)) });
  await panel.getByRole("heading", { name: "数值范围变化" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  await panel.getByText("页面快照中的数值范围与操作记录不一致").waitFor();
  const fallback = panel.getByLabel("输入记录值");
  assert.equal(await fallback.getAttribute("type"), "range");
  assert.equal(await fallback.getAttribute("min"), "10");
  await fallback.focus();
  await fallback.press("Home");
  await fallback.press("ArrowRight");
  await fallback.press("ArrowRight");
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  const viewport = { width: 100, height: 100, scrollX: 0, scrollY: 0 };
  const shotEvents = [
    { id: "shot-before", kind: "screenshot", seq: 1, time: 3100, tabId: 1,
      payload: { assetId: "range-shot", documentId: "doc", url: mismatchUrl, viewport, captureStartedAt: 3000, capturedAt: 3100 } },
    { id: "shot-range", kind: "interaction.input", seq: 2, time: 5000, tabId: 1, frameId: 0, documentId: "doc",
      payload: { url: mismatchUrl, viewport, target: { tag: "input", type: "range", selector: "#range", rect: { x: 10, y: 10, width: 70, height: 20 },
        numericConstraints: { min: "10", max: "20", step: "2" } }, value: "14" } },
  ];
  const shotManifest = { format: "logic-recorder", version: 2, session: { id: "shot-range", title: "截图滑块复现", startedAt: 1 }, eventCount: shotEvents.length, eventChunks: ["timeline/events-00001.jsonl"] };
  const shotFiles = { "manifest.json": strToU8(JSON.stringify(shotManifest)), "timeline/events-00001.jsonl": strToU8(shotEvents.map((event) => JSON.stringify(event)).join("\n")),
    "screenshots/range-shot.jpg": new Uint8Array(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64")) };
  shotFiles["integrity.json"] = strToU8(JSON.stringify(Object.entries(shotFiles).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  await panel.locator('.viewer-top input[type="file"]').setInputFiles({ name: "shot.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(shotFiles)) });
  await panel.getByRole("heading", { name: "截图滑块复现" }).waitFor();
  await panel.getByRole("button", { name: "复现", exact: true }).click();
  const overlay = panel.locator("input.replay-input");
  await overlay.waitFor();
  assert.equal(await overlay.getAttribute("type"), "range");
  const stageBox = await panel.locator(".replay-stage").boundingBox(), overlayBox = await overlay.boundingBox();
  assert.ok(stageBox && overlayBox && overlayBox.width > 0 && overlayBox.height > 0 &&
    overlayBox.x >= stageBox.x && overlayBox.x + overlayBox.width <= stageBox.x + stageBox.width + 1 &&
    overlayBox.y >= stageBox.y && overlayBox.y + overlayBox.height <= stageBox.y + stageBox.height + 1,
    "滑块应位于截图范围内");
  await overlay.focus();
  await overlay.press("Home");
  await overlay.press("ArrowRight");
  await overlay.press("ArrowRight");
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  console.log("真实滑块、数字和颜色记录及侧边栏复现通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
