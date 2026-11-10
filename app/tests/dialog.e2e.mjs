import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8, zipSync, strToU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>对话框测试</title>
    <style>dialog::backdrop { background: rgb(10, 20, 30) }</style>
    <button id="show" onclick="document.querySelector('#dialog').showModal()">打开模态框</button>
    <button id="plain-show" onclick="document.querySelector('#plain').show()">打开普通对话框</button>
    <button id="shadow-show" onclick="window.showShadowDialog()">打开组件对话框</button>
    <dialog id="pre"><button id="preclose" onclick="this.parentElement.close()">关闭初始框</button></dialog>
    <dialog id="dialog"><button id="inner">对话框操作</button><button id="dismiss" onclick="this.parentElement.close()">关闭</button></dialog>
    <dialog id="plain"><button id="plain-close" onclick="this.parentElement.close()">关闭普通框</button></dialog>
    <div id="host"></div>
    <script>
      document.querySelector('#pre').showModal();
      const root = document.querySelector('#host').attachShadow({mode:'closed'});
      root.innerHTML = '<dialog id="shadow-dialog">组件对话框</dialog>';
      window.showShadowDialog = () => root.querySelector('#shadow-dialog').showModal();
      window.hideShadowDialog = () => root.querySelector('#shadow-dialog').close();
    </script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-dialog-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-dialog-extension-"));
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
  await page.locator("#preclose").click();
  await page.locator("#show").click();
  assert.equal(await page.locator("#dialog").evaluate((node) => node.matches(":modal")), true);
  await page.locator("#inner").click();
  await page.locator("#dismiss").click();
  await page.locator("#plain-show").click();
  assert.equal(await page.locator("#plain").evaluate((node) => node.open && !node.matches(":modal")), true);
  await page.locator("#plain-close").click();
  await page.locator("#shadow-show").click();
  await page.evaluate(() => window.hideShadowDialog());
  await page.waitForTimeout(300);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "对话框测试" });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const file = path.join(profile, "dialog.zip");
  await (await downloadPromise).saveAs(file);
  const files = unzipSync(await fs.readFile(file));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archive.eventChunks.flatMap((name) => strFromU8(files[name]).split("\n").filter(Boolean).map(JSON.parse));
  const initial = events.find((event) => event.kind === "page.snapshot" && event.payload.reason === "initial");
  assert.equal(initial?.payload.dialog.modal.length, 1);
  const ids = await panel.evaluate((html) => {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return { pre: doc.querySelector("#pre").getAttribute("data-logic-node"),
      main: doc.querySelector("#dialog").getAttribute("data-logic-node"),
      plain: doc.querySelector("#plain").getAttribute("data-logic-node"),
      shadow: doc.querySelector("#host template").content.querySelector("#shadow-dialog").getAttribute("data-logic-node") };
  }, initial.payload.html);
  assert.deepEqual(initial.payload.dialog.modal, [ids.pre]);
  const transitions = events.filter((event) => event.kind === "page.dialog");
  const find = (id, open, modal) => transitions.find((event) => event.payload.targetNodeId === id && event.payload.open === open && event.payload.modal === modal);
  const mainOpen = find(ids.main, true, true), mainClose = find(ids.main, false, false);
  const plainOpen = find(ids.plain, true, false), shadowOpen = find(ids.shadow, true, true);
  assert.ok(mainOpen && mainClose && plainOpen && shadowOpen);
  const click = events.find((event) => event.kind === "interaction.click" && event.payload.target?.selector === "#inner");
  assert.ok(click);
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles(file);
  await panel.getByRole("heading", { name: "对话框测试" }).waitFor();
  async function select(event) {
    await panel.getByPlaceholder("搜索记录").fill(event.id);
    await panel.locator(".timeline-item").first().click();
  }
  const frame = panel.frameLocator('iframe[title="页面快照"]');
  await select(initial);
  assert.equal(await frame.locator("#pre").evaluate((node) => node.matches(":modal")), true);
  assert.equal(await frame.locator("#pre").evaluate((node) => getComputedStyle(node, "::backdrop").backgroundColor), "rgb(10, 20, 30)");
  await select(mainOpen);
  assert.equal(await frame.locator("#dialog").evaluate((node) => node.matches(":modal")), true);
  await select(mainClose);
  assert.equal(await frame.locator("#dialog").isVisible(), false);
  await select(plainOpen);
  assert.equal(await frame.locator("#plain").evaluate((node) => node.open && !node.matches(":modal")), true);
  await select(shadowOpen);
  assert.equal(await frame.locator("#shadow-dialog").evaluate((node) => node.matches(":modal")), true);
  await select(click);
  await panel.getByRole("button", { name: "从此操作复现" }).click();
  await panel.getByRole("button", { name: "页面", exact: true }).click();
  const replay = panel.frameLocator('iframe[title="逐步复现页面"]');
  assert.equal(await replay.locator("#dialog").evaluate((node) => node.matches(":modal")), true);
  await replay.locator("#inner").click();
  await panel.getByRole("heading", { name: /点击 关闭/ }).waitFor();
  const invalid = { id: "bad-dialog", kind: "page.snapshot", seq: 1, time: 1, tabId: 1, frameId: 0, documentId: "doc",
    payload: { url: "https://example.test/", status: "captured",
      html: '<!doctype html><dialog id="forged" data-logic-node="1" open data-logic-dialog-modal="1">伪造</dialog><dialog id="duplicate-a" data-logic-node="3" open>甲</dialog><dialog id="duplicate-b" data-logic-node="3" open>乙</dialog>',
      dialog: { total: 3, modal: ["3"], omitted: 0, unavailable: 0 } } };
  const badManifest = { format: "logic-recorder", version: 2, session: { id: "bad-dialog", title: "异常对话框测试", startedAt: 1 }, eventCount: 1, eventChunks: ["timeline/events-00001.jsonl"] };
  const badFiles = { "manifest.json": strToU8(JSON.stringify(badManifest)), "timeline/events-00001.jsonl": strToU8(JSON.stringify(invalid)) };
  badFiles["integrity.json"] = strToU8(JSON.stringify(Object.entries(badFiles).map(([entryPath, bytes]) => ({ path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }))));
  await panel.getByTitle("返回录制").click();
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "bad.zip", mimeType: "application/zip", buffer: Buffer.from(zipSync(badFiles)) });
  await panel.getByRole("heading", { name: "异常对话框测试" }).waitFor();
  await panel.getByText("模态对话框目标无法确认", { exact: false }).waitFor();
  const badFrame = panel.frameLocator('iframe[title="页面快照"]');
  for (const selector of ["#forged", "#duplicate-a", "#duplicate-b"])
    assert.equal(await badFrame.locator(selector).evaluate((node) => node.matches(":modal")), false);
  await page.evaluate(() => {
    for (let i = 0; i < 101; i++) {
      const node = document.createElement("dialog");
      document.body.append(node);
      node.showModal();
    }
  });
  const limited = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab: { ...tab, title: "对话框上限测试" }, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(limited.ok, true);
  const limitedStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(limitedStop.ok, true);
  assert.ok(limitedStop.value.coverage.dialogGaps > 0);
  await panel.reload();
  const limitedRecord = panel.locator(".record").filter({ hasText: "对话框上限测试" });
  await limitedRecord.getByText("完成（有采集提示）").waitFor();
  await limitedRecord.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("模态对话框状态超过采集上限", { exact: false }).first().waitFor();
  console.log("模态和普通对话框、组件内状态、遮罩、归档及逐步复现通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
