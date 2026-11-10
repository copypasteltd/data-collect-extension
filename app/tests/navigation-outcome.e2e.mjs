import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const outside = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>范围外页面</title>");
});
const inside = http.createServer((request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (request.url === "/frame")
    response.end('<!doctype html><title>嵌入页面</title><button id="frame-action">嵌入页操作</button>');
  else if (request.url === "/result")
    response.end('<!doctype html><title>跳转结果</title><main id="result">主页面结果</main>');
  else response.end('<!doctype html><title>跳转边界测试</title><iframe src="/frame"></iframe>');
});
await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => inside.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${inside.address().port}`;
const outsideUrl = `http://127.0.0.1:${outside.address().port}/private-outside-marker`;
const profile = await fs.mkdtemp(path.resolve("test-navigation-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-navigation-extension-"));
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
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const readEvents = (id) => panel.evaluate(async (id) => {
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
    return events;
  }, id);
  for (const scope of ["inside", "outside", "return"]) {
    const page = await context.newPage();
    await page.goto(origin);
    const [tab] = await worker.evaluate((url) => chrome.tabs.query({ url: `${url}/*` }), origin);
    const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
      type: "START", tab, options: { screenshots: false, scope: "site" },
    }), tab);
    assert.equal(started.ok, true);
    await page.bringToFront();
    await page.frameLocator("iframe").locator("#frame-action").click();
    await page.waitForTimeout(600);
    await page.goto(scope === "inside" ? `${origin}/result` : outsideUrl);
    if (scope === "return") {
      const deadline = Date.now() + 8000;
      while (!(await readEvents(started.value.id)).some((event) => event.kind === "navigation.out_of_scope") && Date.now() < deadline)
        await page.waitForTimeout(100);
      assert.ok((await readEvents(started.value.id)).some((event) => event.kind === "navigation.out_of_scope"));
      await page.goto(`${origin}/result`);
    }
    let events;
    const deadline = Date.now() + 8000;
    do {
      events = await readEvents(started.value.id);
      if (scope !== "outside"
        ? events.some((event) => event.kind === "page.snapshot" && event.frameId === 0 && event.payload.url === `${origin}/result`)
        : events.some((event) => event.kind === "navigation.out_of_scope")) break;
      await page.waitForTimeout(100);
    } while (Date.now() < deadline);
    assert.ok(events.some((event) => event.kind === "interaction.click" && event.frameId !== 0 && event.payload.target?.selector === "#frame-action"));
    if (scope !== "inside") {
      assert.ok(events.some((event) => event.kind === "navigation.out_of_scope" && event.frameId === 0));
      assert.ok(!JSON.stringify(events).includes("private-outside-marker"));
    }
    if (scope !== "outside") assert.ok(events.some((event) => event.kind === "page.snapshot" && event.payload.url === `${origin}/result`));
    const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
    assert.equal(stopped.ok, true);
    await panel.reload();
    const record = panel.locator(".record").filter({ hasText: "跳转边界测试" }).first();
    const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
    await record.getByTitle("下载记录包").click();
    const download = await downloadPromise;
    const file = path.join(profile, `${scope}.zip`);
    await download.saveAs(file);
    await panel.getByRole("button", { name: "导入记录包" }).click();
    await panel.locator('input[type="file"]').first().setInputFiles(file);
    await panel.getByRole("heading", { name: "跳转边界测试" }).waitFor();
    await panel.getByRole("button", { name: "复现", exact: true }).click();
    await panel.getByRole("button", { name: "页面", exact: true }).click();
    await panel.frameLocator('iframe[title="逐步复现页面"]').locator("#frame-action").click();
    if (scope !== "outside") {
      await panel.getByText("主页面跳转后的页面状态").waitFor();
      await panel.frameLocator('iframe[title="逐步复现页面"]').locator("#result").waitFor();
    } else {
      await panel.getByText("未取得最后操作后的页面状态").waitFor();
      assert.equal(await panel.locator('iframe[title="逐步复现页面"]').count(), 0);
    }
    await page.close();
    await panel.reload();
  }
  console.log("嵌入页跳转、范围外边界、归档及侧栏最终页面通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => inside.close(resolve));
  await new Promise((resolve) => outside.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
