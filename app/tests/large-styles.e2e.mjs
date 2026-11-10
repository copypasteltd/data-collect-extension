import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const rules = Array.from({ length: 700 }, (_, i) => `.item-${i}{margin-left:${i}px}`).join("\n");
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>大样式测试</title>
    <style>${rules}\n#styled{color:rgb(12,34,56);--token:hidden-value-style}</style>
    <div id="styled">页面内容</div><div id="host"></div>
    <script>
      const root = document.querySelector('#host').attachShadow({mode:'open'});
      const style = document.createElement('style');
      style.textContent = ${JSON.stringify(`${rules}\n.shadow-target{color:rgb(65,43,21);--token:hidden-value-shadow}`)};
      root.append(style);
      const target = document.createElement('span');
      target.className = 'shadow-target';
      target.textContent = '组件内容';
      root.append(target);
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-styles-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-styles-extension-"));
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
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  const readSnapshots = (sessionId) => panel.evaluate(async (sessionId) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const events = await new Promise((resolve, reject) => {
      const request = db.transaction("events").objectStore("events").index("session").getAll(sessionId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return events.filter((event) => event.kind === "page.snapshot" && event.payload.html);
  }, sessionId);
  const snapshots = await readSnapshots(stopped.value.id);
  const snapshot = snapshots.find((event) => event.payload.reason === "stop");
  assert.ok(snapshot, "未取得结束时页面快照");
  assert.ok(snapshot.payload.html.includes(".item-699"), "大样式表被丢弃");
  assert.ok(!snapshot.payload.html.includes("[超过大小限制]"), "大样式表被替换为占位内容");
  assert.ok(!snapshot.payload.html.includes("hidden-value"), "大样式表中的敏感值未隐藏");
  assert.equal(snapshot.payload.status, "captured");
  await panel.reload();
  await panel.locator(".record").filter({ hasText: "大样式测试" }).getByTitle("查看记录").click();
  await panel.getByPlaceholder("搜索记录").fill(snapshot.id);
  await panel.locator(".timeline-item").first().click();
  const frame = panel.frameLocator('iframe[title="页面快照"]');
  await frame.locator("#styled").waitFor({ state: "attached" });
  assert.equal(await frame.locator("#styled").evaluate((el) => getComputedStyle(el).color), "rgb(12, 34, 56)");
  assert.equal(await frame.locator(".shadow-target").evaluate((el) => getComputedStyle(el).color), "rgb(65, 43, 21)");
  await page.evaluate(() => {
    document.querySelector("#host").shadowRoot.querySelector("style").textContent =
      `.large{--data:${"x".repeat(500100)}}`;
  });
  const secondStart = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(secondStart.ok, true);
  const secondStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(secondStop.ok, true);
  const oversized = (await readSnapshots(secondStop.value.id))
    .find((event) => event.payload.reason === "stop");
  assert.equal(oversized.payload.status, "truncated");
  assert.equal(oversized.payload.shadow.stylesTruncated, true);
  assert.ok(!oversized.payload.html.includes("[超过大小限制]"));
  console.log("大样式表和组件样式的采集与侧边栏回看通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
