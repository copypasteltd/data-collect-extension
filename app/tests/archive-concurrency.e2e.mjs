import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const profile = await fs.mkdtemp(path.resolve("test-archive-concurrency-profile-"));
let context;
try {
  const extension = path.resolve("dist");
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const url = `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`;
  const panel = await context.newPage(), other = await context.newPage();
  await panel.goto(url);
  await other.goto(url);
  assert.equal((await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).ok, true);
  const makeRecord = (id, title) => panel.evaluate(async ({ id, title }) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "events", "assets"], "readwrite");
      tx.objectStore("sessions").put({ id, title, status: "ready", startedAt: Date.now() });
      tx.objectStore("events").put({ id: `${id}-event`, sessionId: id, seq: 1, time: Date.now(),
        kind: "interaction.click", payload: { target: { tag: "button", text: "记录操作" } } });
      tx.objectStore("assets").put({ id: `${id}-asset`, sessionId: id, type: "screenshot", mime: "image/jpeg",
        blob: new Blob(["test image bytes"], { type: "image/jpeg" }) });
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { id, title });
  const beginDelete = (id) => other.evaluate((id) => {
    globalThis.testDeleteDone = false;
    chrome.runtime.sendMessage({ type: "DELETE", id }).then((result) => {
      globalThis.testDeleteResult = result;
      globalThis.testDeleteDone = true;
    });
  }, id);
  async function verifyDeleteWaits(id) {
    await beginDelete(id);
    await other.waitForTimeout(300);
    assert.equal(await other.evaluate(() => globalThis.testDeleteDone), false, "删除不能在读取期间完成");
    assert.ok(await panel.evaluate(async (id) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      const item = await new Promise((resolve, reject) => {
        const request = db.transaction("sessions").objectStore("sessions").get(id); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      db.close(); return !!item;
    }, id));
  }
  const installDigestGate = () => panel.evaluate(() => {
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    globalThis.testDigestStarted = false;
    Object.defineProperty(crypto.subtle, "digest", { configurable: true, value: async (...args) => {
      if (!globalThis.testDigestStarted) {
        globalThis.testDigestStarted = true;
        await new Promise((resolve) => { globalThis.releaseTestDigest = resolve; });
      }
      return digest(...args);
    } });
    globalThis.restoreTestDigest = () => { delete crypto.subtle.digest; };
  });
  await makeRecord("export-lock", "并发打包测试");
  await panel.reload();
  await installDigestGate();
  const record = panel.locator(".record").filter({ hasText: "并发打包测试" });
  const downloaded = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  await panel.waitForFunction(() => globalThis.testDigestStarted);
  assert.equal(await record.getByTitle("删除记录").isDisabled(), true);
  assert.equal(await record.getByTitle("查看记录").isDisabled(), true);
  await verifyDeleteWaits("export-lock");
  await panel.evaluate(() => globalThis.releaseTestDigest());
  const download = await downloaded;
  const file = path.join(profile, "export.zip");
  await download.saveAs(file);
  const files = unzipSync(await fs.readFile(file));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  assert.equal(manifest.eventCount, 1);
  assert.match(strFromU8(files[manifest.eventChunks[0]]), /记录操作/);
  assert.equal(strFromU8(files["screenshots/export-lock-asset.jpg"]), "test image bytes");
  await other.waitForFunction(() => globalThis.testDeleteDone);
  assert.equal(await other.evaluate(() => globalThis.testDeleteResult.ok), true);
  await panel.evaluate(() => globalThis.restoreTestDigest());

  await makeRecord("view-lock", "并发查看测试");
  await panel.reload();
  await panel.evaluate(() => {
    const read = Blob.prototype.arrayBuffer;
    globalThis.testBlobStarted = false;
    Blob.prototype.arrayBuffer = async function (...args) {
      if (!globalThis.testBlobStarted && this.type === "image/jpeg") {
        globalThis.testBlobStarted = true;
        await new Promise((resolve) => { globalThis.releaseTestBlob = resolve; });
      }
      return read.apply(this, args);
    };
    globalThis.restoreTestBlob = () => { Blob.prototype.arrayBuffer = read; };
  });
  await panel.locator(".record").filter({ hasText: "并发查看测试" }).getByTitle("查看记录").click();
  await panel.waitForFunction(() => globalThis.testBlobStarted);
  await verifyDeleteWaits("view-lock");
  await panel.evaluate(() => globalThis.releaseTestBlob());
  await panel.getByRole("heading", { name: "并发查看测试" }).waitFor();
  await panel.locator(".timeline-item").getByText("点击", { exact: true }).waitFor();
  await other.waitForFunction(() => globalThis.testDeleteDone);
  assert.equal(await other.evaluate(() => globalThis.testDeleteResult.ok), true);
  await panel.evaluate(() => globalThis.restoreTestBlob());
  await panel.getByTitle("返回录制").click();

  for (const kind of ["event", "asset", "missing"]) {
    const id = `changed-${kind}`, title = `数据变化测试 ${kind}`;
    await makeRecord(id, title);
    await panel.reload();
    await installDigestGate();
    await panel.locator(".record").filter({ hasText: title }).getByTitle("下载记录包").click();
    await panel.waitForFunction(() => globalThis.testDigestStarted);
    await other.evaluate(async ({ id, kind }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const store = kind === "event" ? "events" : kind === "asset" ? "assets" : "sessions";
        const tx = db.transaction(store, "readwrite");
        if (kind === "event") tx.objectStore(store).put({ id: `late-${id}`, sessionId: id, seq: 2, time: Date.now(), kind: "interaction.click", payload: {} });
        else if (kind === "asset") tx.objectStore(store).put({ id: `late-${id}`, sessionId: id, type: "resource", mime: "image/png", blob: new Blob(["late"]) });
        else tx.objectStore(store).delete(id);
        tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { id, kind });
    await panel.evaluate(() => globalThis.releaseTestDigest());
    await panel.getByText("记录在打包期间发生变化，请重新下载").waitFor();
    await panel.evaluate(() => globalThis.restoreTestDigest());
  }
  console.log("并发查看和打包时保护记录，打包期间的数据变化可检测");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
