import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";
import { readArchive } from "../src/archive.js";
import { buildCatalog } from "../src/analysis.js";
import { buildOpenApi } from "../src/openapi.js";
import { reconstructFragments } from "../src/fragments.js";

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api/")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>重复参数测试</title><meta name="fixture" content="${"x".repeat(3000)}"><img id="image" src="/image?token=private-first&tag=x&token=private-second"><button id="run">发送</button>
      <script>globalThis.__rawFixtureRan = true; document.querySelector('#run').onclick = async () => {
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
let context, browser;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension);
  context = browser.context;
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const panel = await context.newPage();
  await panel.setViewportSize({ width: 360, height: 780 });
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  const worker = context.serviceWorkers().find((item) => item.url().startsWith(`chrome-extension://${browser.id}/`)) ||
    await context.waitForEvent("serviceworker", { predicate: (item) => item.url().startsWith(`chrome-extension://${browser.id}/`), timeout: 15000 });
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: false, scope: "site" } }), tab);
  assert.equal(started.ok, true);
  await page.locator("#run").click();
  await page.locator('body[data-done="yes"]').waitFor();
  await page.waitForTimeout(500);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  await panel.getByRole("radio").first().waitFor();
  const zipPromise = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const archive = path.join(profile, "record.zip");
  await (await zipPromise).saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archiveManifest.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  const snapshot = events.find((event) => event.kind === "page.snapshot" && event.payload.html?.includes('id="image"'));
  assert.ok(snapshot);
  assert.equal(snapshot.payload.sourceStatus, "captured");
  assert.ok(snapshot.payload.sourceHtml.includes("<script>globalThis.__rawFixtureRan = true"));
  assert.ok(snapshot.payload.sourceHtml.includes('src="/image?token=private-first'));
  assert.ok(!snapshot.payload.html.includes("__rawFixtureRan"));
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
  const loaded = await readArchive(new Blob([await fs.readFile(archive)]));
  assert.equal(loaded.events.find((event) => event.id === snapshot.id)?.payload.sourceHtml, snapshot.payload.sourceHtml);
  const entry = buildOpenApi(buildCatalog(loaded.events)).find((item) => item.origin === `http://127.0.0.1:${server.address().port}`);
  const spec = entry.document;
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
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = "x".repeat(1500001);
    document.body.append(script);
  });
  const oversized = await panel.evaluate((tab) => chrome.runtime.sendMessage({ type: "START", tab, options: { screenshots: false, scope: "site" } }), tab);
  assert.equal(oversized.ok, true);
  const oversizedStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(oversizedStop.ok, true);
  assert.equal(oversizedStop.value.coverage.snapshotGaps, 0);
  const oversizedEvents = await panel.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const items = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").index("session").getAll(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close();
    return items;
  }, oversized.value.id);
  const oversizedSnapshot = oversizedEvents.find((event) => event.kind === "page.snapshot" && event.payload.reason === "stop");
  assert.equal(oversizedSnapshot?.payload.sourceStatus, "fragmented");
  assert.equal(oversizedSnapshot.payload.sourceHtml, null);
  assert.ok(reconstructFragments(oversizedSnapshot.payload.sourceReference, oversizedEvents.sort((a, b) => a.seq - b.seq)).includes("x".repeat(1500001)));
  assert.equal(oversizedSnapshot.payload.status, "captured");
  assert.equal(await panel.evaluate(() => globalThis.__rawFixtureRan), undefined);
  console.log("重复参数、原始 DOM、记录包校验和大型页面分段通过");
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
