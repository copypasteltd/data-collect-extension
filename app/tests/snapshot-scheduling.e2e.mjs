import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>持续变化测试</title>
    <button id="start">开始更新</button><button id="pause">暂停更新</button><button id="leave">离开页面</button><span id="clock">0</span><input id="result">
    <script>
      let interval;
      document.querySelector('#start').onclick = () => {
        const clock = document.querySelector('#clock');
        interval = setInterval(() => { clock.textContent = String(Number(clock.textContent) + 1); }, 75);
        setTimeout(() => { document.querySelector('#result').value = '异步业务结果'; }, 700);
      };
      document.querySelector('#pause').onclick = () => clearInterval(interval);
      document.querySelector('#leave').onclick = () => {
        document.querySelector('#result').value = '离开前业务结果';
        location.href = '/next';
      };
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-snapshot-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-snapshot-extension-"));
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
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  const [tab] = await worker.evaluate(() =>
    chrome.tabs.query({ url: "http://127.0.0.1/*" }),
  );
  const started = await panel.evaluate(
    (tab) =>
      chrome.runtime.sendMessage({
        type: "START",
        tab,
        options: { screenshots: false, scope: "site" },
      }),
    tab,
  );
  assert.equal(started.ok, true);
  await page.bringToFront();
  await page.locator("#start").click();
  const readSnapshots = () =>
    panel.evaluate(async (sessionId) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const events = await new Promise((resolve, reject) => {
        const request = db
          .transaction("events")
          .objectStore("events")
          .index("session")
          .getAll(sessionId);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return events
        .filter((event) => event.kind === "page.snapshot")
        .map((event) => ({
          reason: event.payload.reason,
          time: event.time,
          hasResult: event.payload.html?.includes("异步业务结果"),
          hasExitResult: event.payload.html?.includes("离开前业务结果"),
        }));
    }, started.value.id);
  const deadline = Date.now() + 8000;
  let found = false;
  while (
    Date.now() < deadline &&
    !(found = (await readSnapshots()).some(
      (item) => item.reason === "mutation" && item.hasResult,
    ))
  )
    await page.waitForTimeout(200);
  assert.ok(found, "持续变化期间未取得异步业务结果快照");
  assert.ok(Number(await page.locator("#clock").innerText()) > 10);
  const pausedAt = Date.now();
  await page.locator("#pause").click();
  const quietDeadline = Date.now() + 8000;
  let quietSnapshots = [];
  while (
    Date.now() < quietDeadline &&
    !(quietSnapshots = await readSnapshots()).some(
      (item) => item.time >= pausedAt,
    )
  )
    await page.waitForTimeout(200);
  assert.ok(
    quietSnapshots.some((item) => item.time >= pausedAt),
    "页面停止更新后未取得快照",
  );
  const quietCount = quietSnapshots.length;
  await page.waitForTimeout(2200);
  assert.equal(
    (await readSnapshots()).length,
    quietCount,
    "页面安静后产生了重复快照",
  );
  await Promise.all([
    page.waitForURL("**/next"),
    page.locator("#leave").click(),
  ]);
  const exitDeadline = Date.now() + 8000;
  let capturedExit = false;
  while (
    Date.now() < exitDeadline &&
    !(capturedExit = (await readSnapshots()).some(
      (item) => item.reason === "pagehide" && item.hasExitResult,
    ))
  )
    await page.waitForTimeout(200);
  assert.ok(capturedExit, "页面离开时未保存等待中的业务状态");
  const stopped = await panel.evaluate(() =>
    chrome.runtime.sendMessage({ type: "STOP" }),
  );
  assert.equal(stopped.ok, true);
  console.log("持续变化时的录制中页面快照和异步表单结果通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
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
