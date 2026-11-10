import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const initial = `${"初始正文".repeat(4000)}初始末尾`;
const updated = `${"更新正文".repeat(4000)} token=private-value 更新末尾`;
const shadow = `${"组件正文".repeat(4000)}组件末尾`;
const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>长页面正文测试</title><p id="article">${initial}</p><div id="host"></div>
    <script>
      const root = document.querySelector('#host').attachShadow({mode:'open'});
      const p = document.createElement('p');
      p.id = 'shadow-text';
      p.textContent = ${JSON.stringify(shadow)};
      root.append(p);
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-longtext-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-longtext-extension-"));
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
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const start = () => panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  const stop = () => panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  const readSnapshots = (id) => panel.evaluate(async (id) => {
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
    return events.filter((event) => event.kind === "page.snapshot" && event.payload.html);
  }, id);
  const started = await start();
  assert.equal(started.ok, true);
  await page.evaluate((value) => { document.querySelector("#article").firstChild.data = value; }, updated);
  await page.waitForTimeout(700);
  const stopped = await stop();
  assert.equal(stopped.ok, true);
  const snapshots = await readSnapshots(stopped.value.id);
  const first = snapshots.find((event) => event.payload.reason === "initial");
  const last = snapshots.find((event) => event.payload.reason === "stop");
  assert.ok(first?.payload.html.includes("初始末尾"), "初始长正文丢失");
  assert.ok(first.payload.html.includes("组件末尾"), "组件长正文丢失");
  assert.ok(last?.payload.html.includes("更新末尾"), "更新后的长正文丢失");
  assert.ok(!last.payload.html.includes("private-value"), "长正文中的敏感内容未隐藏");
  assert.equal(last.payload.status, "captured");
  await panel.reload();
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await panel.locator(".record").filter({ hasText: "长页面正文测试" }).getByTitle("下载记录包").click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "recording.zip");
  await download.saveAs(archive);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles(archive);
  await panel.getByRole("heading", { name: "长页面正文测试" }).waitFor();
  await panel.getByPlaceholder("搜索记录").fill(last.id);
  await panel.locator(".timeline-item").first().click();
  const restored = panel.frameLocator('iframe[title="页面快照"]');
  assert.ok((await restored.locator("#article").textContent()).endsWith("更新末尾"));
  assert.ok((await restored.locator("#shadow-text").textContent()).endsWith("组件末尾"));
  await page.evaluate(() => {
    document.querySelector("#article").textContent = "a".repeat(500100);
    document.querySelector("#host").remove();
  });
  const next = await start();
  assert.equal(next.ok, true);
  const ended = await stop();
  assert.equal(ended.ok, true);
  const oversized = (await readSnapshots(ended.value.id)).find((event) => event.payload.reason === "stop");
  assert.equal(oversized.payload.status, "truncated");
  assert.ok(oversized.payload.html.includes("a".repeat(500000)));
  assert.ok(!oversized.payload.html.includes("a".repeat(500001)));
  assert.ok(ended.value.coverage.snapshotGaps > 0, "快照截断未计入采集提示");
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "长页面正文测试" }).first();
  await record.getByText("完成（有采集提示）").waitFor();
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("页面快照已截断").first().waitFor();
  console.log("长页面正文、组件、导出导入和截断提示通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
