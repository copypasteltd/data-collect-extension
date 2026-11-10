import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html" });
  response.end("<!doctype html><title>Stop timeout</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-stop-timeout-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-stop-timeout-extension-"));
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
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 20000 });
  await panel.evaluate(() => {
    const originalTimeout = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...args) => originalTimeout(callback, delay === 90000 ? 300 : delay, ...args);
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    let gateActive = false;
    const gate = new Promise((resolve) => { globalThis.releaseReviewStatus = resolve; });
    chrome.runtime.sendMessage = async (...args) => {
      if (args[0]?.type === "GET_STATUS" && gateActive) await gate;
      if (args[0]?.type !== "STOP") return send(...args);
      gateActive = true;
      const result = await send(...args);
      await new Promise((resolve) => originalTimeout(resolve, 2500));
      return result;
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByText("后台响应超时，请等待状态刷新").waitFor({ timeout: 8000 });
  await panel.evaluate(() => globalThis.releaseReviewStatus());
  await panel.getByText("后台响应超时，请等待状态刷新").waitFor({ state: "detached", timeout: 30000 });
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 30000 });
  await panel.getByRole("radio").first().waitFor({ timeout: 15000 });
  const result = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(result.value.active, null);
  assert.ok(result.value.sessions.some((session) => ["ready", "interrupted"].includes(session.status)));
  console.log("停止回复超时后，后台完成时自动清除过期错误提示");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
