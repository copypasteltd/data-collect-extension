import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((request, response) => {
  if (request.url === "/api-after-navigation") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(request.url === "/next"
      ? '<!doctype html><title>新页面</title><script>setTimeout(() => fetch("/api-after-navigation"), 200)</script>'
      : '<!doctype html><title>跳转请求测试</title><button id="go" onclick="location.href=\'/next\'">进入新页面</button>');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await fs.mkdtemp(path.resolve("test-candidate-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-candidate-extension-"));
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
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(origin);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate((url) => chrome.tabs.query({ url: `${url}/*` }), origin);
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await page.bringToFront();
  const response = page.waitForResponse((item) => item.url().endsWith("/api-after-navigation"));
  await page.locator("#go").click();
  assert.equal((await response).status(), 200);
  await page.waitForTimeout(500);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "跳转请求测试" });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  const file = path.join(profile, "candidate.zip");
  await download.saveAs(file);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles(file);
  await panel.getByRole("heading", { name: "跳转请求测试" }).waitFor();
  await panel.getByRole("button", { name: /^流程 \d+$/ }).click();
  const candidate = panel.locator(".flow").filter({ hasText: "进入新页面" })
    .locator(".flow-request").filter({ hasText: "/api-after-navigation" });
  await candidate.getByText("页面跳转后", { exact: false }).waitFor();
  assert.match(await candidate.innerText(), /仅按时间推测/);
  await candidate.click();
  await panel.getByText(/api-after-navigation/).first().waitFor();
  console.log("真实跳转请求的录制、归档、侧栏候选标记和证据链接通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
