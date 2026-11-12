import { launchExtension } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Tab close</title><input id='value'>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-tab-close-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-tab-close-extension-"));
let browser;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension);
  const context = browser.context;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 30000 });
  const closing = await context.newPage();
  await closing.goto(`http://127.0.0.1:${server.address().port}/closing`);
  const [tab] = await panel.evaluate((url) => chrome.tabs.query({ url }), closing.url());
  await closing.locator("#value").fill("before-close");
  await panel.waitForFunction(async (tabId) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const events = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return events.some((event) => event.tabId === tabId && event.kind === "interaction.input" && event.payload.value === "before-close");
  }, tab.id, { timeout: 20000 });
  await closing.close();
  await page.bringToFront();
  await page.locator("#value").fill("after-close");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 45000 });
  await panel.getByRole("radio").first().waitFor();
  await panel.getByRole("radio").first().check();
  const downloadPromise = panel.waitForEvent("download", { timeout: 30000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await downloadPromise;
  const archivePath = path.join(profile, "tab-close.zip");
  await download.saveAs(archivePath);
  const files = unzipSync(await fs.readFile(archivePath));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archive.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(events.some((event) => event.kind === "tab.closed" && event.payload.tabId === tab.id));
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.tabId === tab.id && event.payload.value === "before-close"));
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "after-close"));
  console.log("录制期间关闭标签后，已确认事件及其他页面后续操作可导出");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
