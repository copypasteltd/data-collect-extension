import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>Many tabs</title><input id="value">');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-many-tabs-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-many-tabs-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    viewport: null,
    args: ["--window-size=1000,700", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const pages = [];
  for (let index = 0; index < 8; index++) {
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/page-${index}`);
    pages.push(page);
  }
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = async (...args) => {
      const result = await send(...args);
      if (args[0]?.type === "START") globalThis.startAcknowledged = true;
      return result;
    };
  });
  await worker.evaluate(() => {
    const attach = chrome.debugger.attach.bind(chrome.debugger);
    globalThis.concurrentAttaches = 0;
    globalThis.peakAttaches = 0;
    chrome.debugger.attach = async (...args) => {
      globalThis.concurrentAttaches++;
      globalThis.peakAttaches = Math.max(globalThis.peakAttaches, globalThis.concurrentAttaches);
      try {
        await new Promise((resolve) => setTimeout(resolve, 4200));
        return await attach(...args);
      } finally { globalThis.concurrentAttaches--; }
    };
  });
  await pages[0].bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("准备中", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await panel.getByRole("button", { name: "停止录制" }).isEnabled(), true);
  await panel.waitForFunction(() => globalThis.startAcknowledged === true, null, { timeout: 3000 });
  assert.equal(await panel.getByText("准备中", { exact: true }).isVisible(), true,
    "创建批次后应在后台准备完成前确认开始请求");
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 25000 });
  assert.equal(await panel.getByText("后台响应超时，请等待状态刷新").count(), 0);
  const peak = await worker.evaluate(() => globalThis.peakAttaches);
  assert.ok(peak >= 2 && peak <= 4, `标签页连接并发数量异常: ${peak}`);
  await pages[0].locator("#value").fill("many-tabs-recorded");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 30000 });
  const download = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const archive = unzipSync(await fs.readFile(await (await download).path()));
  const metadata = JSON.parse(strFromU8(archive["manifest.json"]));
  const events = metadata.eventChunks.flatMap((name) => strFromU8(archive[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "many-tabs-recorded"));
  console.log(`多个慢标签页并发准备完成、录制与导出通过，并发上限 ${peak}`);
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
