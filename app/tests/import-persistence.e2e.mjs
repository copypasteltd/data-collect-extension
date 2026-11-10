import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { zipSync, strToU8 } from "fflate";

const manifest = { format: "logic-recorder", version: 2,
  session: { id: "existing-id", title: "导入后持久化", origin: "https://example.test", startedAt: 1 },
  eventCount: 1, eventChunks: ["timeline/events-00001.jsonl"] };
const event = { id: "recorded-event", seq: 1, time: 2, kind: "interaction.click",
  payload: { target: { tag: "button", text: "示例按钮" } } };
const files = {
  "manifest.json": strToU8(JSON.stringify(manifest)),
  "timeline/events-00001.jsonl": strToU8(JSON.stringify(event) + "\n"),
};
files["integrity.json"] = strToU8(JSON.stringify(Object.entries(files).map(([entryPath, bytes]) => ({
  path: entryPath, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
}))));
const archive = Buffer.from(zipSync(files));
const profile = await fs.mkdtemp(path.resolve("test-import-persistence-profile-"));
const extension = path.resolve("dist");
const options = {
  executablePath: process.env.CHROME_BIN || chromium.executablePath(),
  headless: true,
  acceptDownloads: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
};
let context;
try {
  context = await chromium.launchPersistentContext(profile, options);
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  let panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  assert.equal((await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }))).ok, true);
  await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("sessions", "readwrite");
      tx.objectStore("sessions").put({ id: "existing-id", title: "本机原始记录", startedAt: 1, status: "ready" });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await panel.reload();
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "record.zip", mimeType: "application/zip", buffer: archive });
  await panel.getByText("记录包已保存到本机录制记录，内容保持原样。").waitFor();
  await panel.locator('.viewer-top input[type="file"]').setInputFiles({ name: "record.zip", mimeType: "application/zip", buffer: archive });
  await panel.waitForFunction(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction("imports").objectStore("imports").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count === 2;
  });
  await panel.getByTitle("返回录制").click();
  await panel.locator(".record").filter({ hasText: "导入后持久化" }).nth(1).getByText("已导入", { exact: false }).waitFor();
  assert.equal(await panel.locator(".record").filter({ hasText: "本机原始记录" }).count(), 1);
  await context.close();
  context = await chromium.launchPersistentContext(profile, options);
  if (!context.serviceWorkers()[0]) await context.waitForEvent("serviceworker", { timeout: 15000 });
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${extensionId}/sidepanel.html`);
  const records = panel.locator(".record").filter({ hasText: "导入后持久化" });
  const record = records.first();
  await records.nth(1).waitFor();
  await record.getByText("已导入", { exact: false }).waitFor();
  await record.getByTitle("查看记录").click();
  await panel.getByRole("heading", { name: "导入后持久化" }).waitFor();
  await panel.getByText("示例按钮", { exact: false }).first().waitFor();
  await panel.getByTitle("返回录制").click();
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  const downloadPath = path.join(profile, "export.zip");
  await download.saveAs(downloadPath);
  assert.deepEqual(await fs.readFile(downloadPath), archive, "重新下载应保留原始 ZIP");
  panel.once("dialog", (dialog) => dialog.accept());
  await record.getByTitle("删除记录").click();
  await records.nth(1).waitFor({ state: "detached" });
  panel.once("dialog", (dialog) => dialog.accept());
  await record.getByTitle("删除记录").click();
  await record.waitFor({ state: "detached" });
  assert.equal(await panel.locator(".record").filter({ hasText: "本机原始记录" }).count(), 1);
  const counts = await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = await new Promise((resolve, reject) => {
      const request = db.transaction("imports").objectStore("imports").count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return count;
  });
  assert.equal(counts, 0, "删除记录时应删除导入的 ZIP");
  await panel.evaluate(() => {
    const original = IDBObjectStore.prototype.add;
    IDBObjectStore.prototype.add = function (...args) {
      if (this.name === "imports") throw new DOMException("Quota exceeded", "QuotaExceededError");
      return original.apply(this, args);
    };
  });
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator('input[type="file"]').first().setInputFiles({ name: "record.zip", mimeType: "application/zip", buffer: archive });
  await panel.getByText("记录包已打开，但无法保存到本机；关闭后需重新导入。").waitFor();
  await panel.getByRole("heading", { name: "导入后持久化" }).waitFor();
  await panel.getByTitle("返回录制").click();
  assert.equal(await panel.locator(".record").filter({ hasText: "导入后持久化" }).count(), 0,
    "保存失败不得留下不完整的记录");
  const storedSessions = await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const sessions = await new Promise((resolve, reject) => {
      const request = db.transaction("sessions").objectStore("sessions").getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return sessions;
  });
  assert.deepEqual(storedSessions.map((session) => session.id), ["existing-id"]);
  console.log("导入记录跨重启保存、原包下载、删除及存储失败处理通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
