import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end('<!doctype html><title>Status isolation</title><input id="value">');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-status-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-status-extension-"));
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
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).waitFor();
  await panel.waitForTimeout(2200);
  await worker.evaluate(() => {
    const transaction = IDBDatabase.prototype.transaction;
    let blocked = true;
    IDBDatabase.prototype.transaction = function (stores, mode, ...rest) {
      if (blocked && stores === "sessions" && (!mode || mode === "readonly"))
        return { objectStore: () => ({ getAll: () => ({}) }) };
      return transaction.call(this, stores, mode, ...rest);
    };
    globalThis.restoreBatchReads = () => { blocked = false; };
    const attach = chrome.debugger.attach.bind(chrome.debugger);
    chrome.debugger.attach = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 3500));
      return attach(...args);
    };
  });
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("准备中", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await panel.getByRole("button", { name: "停止录制" }).isEnabled(), true);
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 15000 });
  await panel.getByText("录制批次读取超时").waitFor({ timeout: 12000 });
  assert.equal(await panel.getByRole("button", { name: "停止录制" }).isEnabled(), true,
    "批次列表读取失败不能阻止停止录制");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 15000 });
  await worker.evaluate(() => globalThis.restoreBatchReads());
  await panel.getByText("录制批次读取超时").waitFor({ state: "detached", timeout: 12000 });
  await panel.getByRole("radio").first().waitFor({ timeout: 12000 });
  const download = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  await download;
  console.log("批次列表无响应时仍可停止，读取恢复后可导出且错误消失");

  await worker.evaluate(() => {
    const remove = chrome.storage.session.remove.bind(chrome.storage.session);
    let fail = true;
    chrome.storage.session.remove = (...args) => {
      if (fail && args[0] === "recorderFrames") {
        fail = false;
        return Promise.reject(new Error("模拟录制准备失败"));
      }
      return remove(...args);
    };
  });
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中断", { exact: false }).first().waitFor({ timeout: 15000 });
  const failed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(failed.value.active, null);
  assert.equal(failed.value.sessions[0].status, "interrupted");
  assert.match(failed.value.sessions[0].notice, /录制准备失败/);
  console.log("启动确认后发生准备错误时保留中断批次并恢复可操作状态");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
