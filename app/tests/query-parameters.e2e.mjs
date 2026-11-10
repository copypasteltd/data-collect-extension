import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>重复参数测试</title><img id="image" src="/image?token=private-first&tag=x&token=private-second"><button id="run">发送</button>
      <script>document.querySelector('#run').onclick = async () => {
        await fetch('/api/items?tag=one&token=private-first&tag=two&token=private-second');
        await fetch('/api/items?tag=three&token=private-third');
        await fetch('/api/search', {method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
          body:'tag=one&password=private-first&tag=two&password=private-second'});
        document.body.dataset.done = 'yes';
      };</script>`);
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-query-parameters-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-query-parameters-extension-"));
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
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: false, scope: "site" } }), tab);
  assert.equal(started.ok, true);
  await page.locator("#run").click();
  await page.locator('body[data-done="yes"]').waitFor();
  await page.waitForTimeout(500);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "重复参数测试" });
  await record.getByTitle("下载记录包").waitFor();
  const zipPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const archive = path.join(profile, "record.zip");
  await (await zipPromise).saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archiveManifest.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  const snapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.html?.includes('id="image"'));
  assert.ok(snapshot);
  const imageUrl = await panel.evaluate((html) => new DOMParser().parseFromString(html, "text/html").querySelector("#image").getAttribute("data-logic-src"), snapshot.payload.html);
  assert.deepEqual([...new URL(imageUrl).searchParams], [["token", "private-first"], ["tag", "x"], ["token", "private-second"]]);
  const requests = events.filter((event) => event.kind === "network.request" && new URL(event.payload.url).pathname === "/api/items");
  assert.equal(requests.length, 2);
  const query = new URL(requests[0].payload.url).searchParams;
  assert.deepEqual([...query], [["tag", "one"], ["token", "private-first"], ["tag", "two"], ["token", "private-second"]]);
  const post = events.find((event) => event.kind === "network.request" && new URL(event.payload.url).pathname === "/api/search");
  assert.ok(post);
  const bodyEvent = events.find((event) => event.kind === "network.requestBody" && event.payload.requestId === post.payload.requestId);
  const body = bodyEvent?.payload.body || post.payload.postData;
  assert.deepEqual([...new URLSearchParams(body.value)], [["tag", "one"], ["password", "private-first"], ["tag", "two"], ["password", "private-second"]]);
  assert.ok(JSON.stringify(events).includes("private-first"));
  assert.ok(JSON.stringify(events).includes("private-second"));
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: /^接口 \d+$/ }).click();
  const specPromise = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出接口规范草稿" }).click();
  const specPath = path.join(profile, "openapi.zip");
  await (await specPromise).saveAs(specPath);
  const specFiles = unzipSync(await fs.readFile(specPath));
  const index = JSON.parse(strFromU8(specFiles["index.json"]));
  const entry = index.find((item) => item.origin === `http://127.0.0.1:${server.address().port}`);
  const spec = JSON.parse(strFromU8(specFiles[entry.file]));
  const parameters = spec.paths["/api/items"].get.parameters;
  const tag = parameters.find((parameter) => parameter.name === "tag");
  assert.equal(tag.schema.type, "array");
  assert.deepEqual(tag.examples.sample_1.value, ["one", "two"]);
  assert.deepEqual(tag.examples.sample_2.value, ["three"]);
  assert.equal(tag.examples.sample_1["x-logic-recorder-event-id"], requests[0].id);
  const token = parameters.find((parameter) => parameter.name === "token");
  assert.deepEqual(token.examples.sample_1.value, ["private-first", "private-second"]);
  const form = spec.paths["/api/search"].post.requestBody.content["application/x-www-form-urlencoded"];
  assert.deepEqual(form.examples.sample_1.value.password, ["private-first", "private-second"]);
  console.log("重复查询参数和表单字段的原值录制及接口草稿验证通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
