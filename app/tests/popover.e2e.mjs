import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>弹出层测试</title>
    <button id="show" onclick="document.querySelector('#pop').showPopover()">显示详情</button>
    <button id="shadow-show" onclick="window.showShadow()">显示组件</button>
    <div id="pre" popover="manual" style="inset:auto;top:45px;left:5px">初始弹层</div>
    <div id="pop" popover="manual" style="inset:auto;top:90px;left:5px"><button id="inner">弹层操作</button></div>
    <div id="host"></div>
    <script>
      document.querySelector('#pre').showPopover();
      const root = document.querySelector('#host').attachShadow({mode:'closed'});
      root.innerHTML = '<div id="shadow-pop" popover="manual" style="inset:auto;top:180px;left:5px">组件弹层</div>';
      window.showShadow = () => root.querySelector('#shadow-pop').showPopover();
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-popover-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-popover-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  await page.bringToFront();
  await page.locator("#show").click();
  await page.locator("#pop").waitFor({ state: "visible" });
  await page.locator("#shadow-show").click();
  await page.locator("#inner").click();
  await page.evaluate(() => document.querySelector("#pop").hidePopover());
  await page.waitForTimeout(300);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "弹出层测试" });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const file = path.join(profile, "popover.zip");
  await (await downloadPromise).saveAs(file);
  const files = unzipSync(await fs.readFile(file));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archive.eventChunks.flatMap((name) => strFromU8(files[name]).split("\n").filter(Boolean).map(JSON.parse));
  const initial = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "initial");
  assert.ok(initial?.payload.popover.open.length === 1);
  const popovers = events.filter((event) => event.kind === "page.popover");
  const openEvents = popovers.filter((event) => event.payload.open === true);
  const close = popovers.find((event) => event.payload.open === false);
  assert.equal(openEvents.length, 2);
  assert.ok(close);
  const mainOpen = openEvents.find((event) => event.payload.targetNodeId === close.payload.targetNodeId);
  const shadowOpen = openEvents.find((event) => event !== mainOpen);
  assert.ok(mainOpen && shadowOpen);
  const click = events.find((event) => event.kind === "interaction.click" && event.payload.target?.selector === "#inner");
  assert.ok(click);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles(file);
  await panel.getByRole("heading", { name: "弹出层测试" }).waitFor();
  async function select(event) {
    await panel.getByPlaceholder("搜索记录").fill(event.id);
    await panel.locator(".timeline-item").first().click();
  }
  const frame = panel.frameLocator('iframe[title="页面快照"]');
  await select(initial);
  await frame.locator("#pre").waitFor({ state: "visible" });
  assert.equal(await frame.locator("#pop").isVisible(), false);
  await select(mainOpen);
  await frame.locator("#pre").waitFor({ state: "visible" });
  await frame.locator("#pop").waitFor({ state: "visible" });
  await select(shadowOpen);
  await frame.locator("#shadow-pop").waitFor({ state: "visible" });
  await select(close);
  await frame.locator("#shadow-pop").waitFor({ state: "visible" });
  assert.equal(await frame.locator("#pop").isVisible(), false);
  await select(click);
  await panel.getByRole("button", { name: "从此操作复现" }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  await panel.frameLocator('iframe[title="逐步复现页面"]').locator("#inner").click();
  await panel.getByRole("status").getByText("已到达记录末尾").waitFor();
  const invalid = { id: "bad-popover", kind: "page.snapshot", seq: 1, time: 1, tabId: 1, frameId: 0, documentId: "doc",
    payload: { url: "https://example.test/", status: "captured",
      html: '<!doctype html><div id="forged" data-logic-node="1" popover="manual" data-logic-popover-open="1">伪造</div><div id="duplicate-a" data-logic-node="3" popover="manual">甲</div><div id="duplicate-b" data-logic-node="3" popover="manual">乙</div>',
      popover: { total: 3, open: ["3"], omitted: 0, unavailable: 0 } } };
  const badManifest = { format: "logic-recorder", version: 2, session: { id: "bad-popover", title: "异常弹层测试", startedAt: 1 }, eventCount: 1, eventChunks: ["timeline/events-00001.jsonl"] };
  const badFiles = { "manifest.json": strToU8(JSON.stringify(badManifest)), "timeline/events-00001.jsonl": strToU8(JSON.stringify(invalid)) };
  badFiles["integrity.json"] = strToU8(JSON.stringify(Object.entries(badFiles).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  await panel.getByTitle("返回录制").click();
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(badFiles)) });
  await panel.getByRole("heading", { name: "异常弹层测试" }).waitFor();
  await panel.getByText("弹出层目标无法确认", { exact: false }).waitFor();
  const badFrame = panel.frameLocator('iframe[title="页面快照"]');
  assert.equal(await badFrame.locator("#forged").isVisible(), false);
  assert.equal(await badFrame.locator("#duplicate-a").isVisible(), false);
  assert.equal(await badFrame.locator("#duplicate-b").isVisible(), false);
  await page.evaluate(() => {
    for (let i = 0; i < 101; i++) {
      const node = document.createElement("div");
      node.setAttribute("popover", "manual");
      document.body.append(node);
      node.showPopover();
    }
  });
  const limited = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab: { ...tab, title: "弹出层上限测试" }, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(limited.ok, true);
  const limitedStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(limitedStop.ok, true);
  assert.ok(limitedStop.value.coverage.popoverGaps > 0);
  await panel.reload();
  const limitedRecord = panel.locator(".record").filter({ hasText: "弹出层上限测试" });
  await limitedRecord.getByText("完成（有采集提示）").waitFor();
  await limitedRecord.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("弹出层状态超过采集上限", { exact: false }).first().waitFor();
  console.log("原生弹出层初始状态、组件内变化、ZIP 回看和逐步复现通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
