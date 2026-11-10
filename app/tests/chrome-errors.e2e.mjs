import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const executable = process.env.CHROME_BIN;
if (!executable) throw new Error("请通过 CHROME_BIN 指定正式版 Chrome 的路径");
const server = http.createServer((req, res) => {
  if (req.url.startsWith("/api")) {
    res.writeHead(200, { "Content-Type": "application/json", "Set-Cookie": "example=test; Path=/" });
    res.end('{"result":"ok"}');
  } else {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end('<!doctype html><title>Extension error test</title><input id="input"><button id="send" onclick="fetch(\'/api\')">Send</button>');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-chrome-errors-profile-"));
const child = spawn(executable, [
  `--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0",
  "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
  "--disable-background-networking", "--no-proxy-server",
  "--host-resolver-rules=MAP recorder.test 127.0.0.1", "--window-size=1000,700", "about:blank",
], { windowsHide: true, stdio: "ignore" });
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
  assert.ok(port, "Chrome 调试接口未启动");
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
  await page.goto(`http://recorder.test:${server.address().port}/first`);
  assert.deepEqual(await page.evaluate(() => [isSecureContext, typeof crypto.randomUUID]), [false, "undefined"]);
  const panel = await context.newPage();
  panel.on("pageerror", (error) => pageErrors.push(error.message));
  await panel.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByRole("button", { name: "停止录制" }).waitFor({ timeout: 30000 });
  await page.locator("#input").fill("example value");
  await Promise.all([page.waitForResponse((response) => response.url().endsWith("/api")), page.locator("#send").click()]);
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 30000 });
  const download = panel.waitForEvent("download", { timeout: 30000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const archive = unzipSync(await fs.readFile(await (await download).path()));
  const manifest = JSON.parse(strFromU8(archive["manifest.json"]));
  const events = manifest.eventChunks.flatMap((chunk) => strFromU8(archive[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  const info = await manager.evaluate((extensionId) => chrome.developerPrivate.getExtensionInfo(extensionId), id);
  const errors = [...info.manifestErrors, ...info.runtimeErrors].map(({ message, source, occurrences }) => ({ message, source, occurrences }));
  assert.deepEqual(pageErrors, [], `页面错误: ${JSON.stringify(pageErrors)}`);
  assert.deepEqual(errors, [], `扩展错误: ${JSON.stringify(errors)}`);
  assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "example value"), "HTTP 页面输入未写入记录包");
  assert.ok(events.some((event) => event.kind === "network.request" && event.payload.url.endsWith("/api")), "HTTP 请求未写入记录包");
  assert.ok(events.some((event) => event.kind === "screenshot" && event.payload.assetId &&
    archive[`screenshots/${event.payload.assetId}.jpg`]?.length > 2), "HTTP 页面截图未写入记录包");
  console.log("正式版 Chrome 录制和导出完成，扩展错误列表为空");
} finally {
  if (root) await root.send("Browser.close").catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (child.exitCode === null) child.kill();
  await exited;
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
