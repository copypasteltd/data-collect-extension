import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const profile = await fs.mkdtemp(path.resolve("test-recovery-stop-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-recovery-stop-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const background = path.join(extension, "background.js");
  const source = await fs.readFile(background, "utf8");
  await fs.writeFile(background, `const originalGet = IDBObjectStore.prototype.get;
    globalThis.failReviewWrite = true;
    IDBObjectStore.prototype.get = function (...args) {
      if (this.name === "sessions" && String(args[0]).startsWith("review-")) {
        if (this.transaction.mode === "readonly") return {};
        if (args[0] === "review-write-failure" && globalThis.failReviewWrite) throw new Error("模拟本地写入失败");
      }
      return originalGet.apply(this, args);
    };\n` + source);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");

  async function restartWithSession(id, storedStatus) {
    await panel.evaluate(async ({ id, storedStatus }) => {
      const session = { id, title: id, origin: "https://example.test", startedAt: Date.now(), status: storedStatus, options: { scope: "site" }, tabs: {}, ...(id === "review-cleanup" ? { scriptId: "review-script", scriptRegistered: true } : {}) };
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open("logic-recorder"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").put(session); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction("events", "readwrite"); tx.objectStore("events").put({ id: `${id}-event`, sessionId: id, seq: 1, time: Date.now(), kind: "test.saved", payload: { value: "retained" } }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      await chrome.storage.session.set({ active: { ...session, status: "recording" } });
    }, { id, storedStatus });
    await cdp.send("ServiceWorker.stopAllWorkers");
    const first = panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
    await panel.waitForTimeout(500);
    const status = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
    assert.equal(status.value.active.id, id);
    return first;
  }

  let first = restartWithSession("review-recording", "recording");
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 12000 });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 20000 });
  await panel.getByText("录制中断", { exact: false }).first().waitFor({ timeout: 15000 });
  const interrupted = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  const saved = interrupted.value.sessions.find((session) => session.id === "review-recording");
  assert.equal(saved.status, "interrupted");
  assert.match(saved.notice, /后台恢复失败/);
  const download = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const archive = unzipSync(await fs.readFile(await (await download).path()));
  const metadata = JSON.parse(strFromU8(archive["manifest.json"]));
  const events = metadata.eventChunks.flatMap((name) => strFromU8(archive[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(events.some((event) => event.kind === "test.saved" && event.payload.value === "retained"));
  await first;
  console.log("恢复读取失败时可停止并保留中断批次");

  first = restartWithSession("review-completed", "ready");
  await panel.waitForTimeout(700);
  const stale = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP", sessionId: "review-recording" }));
  assert.equal(stale.ok, false);
  const stillActive = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
  assert.equal(stillActive.value.active.id, "review-completed");
  const replies = await panel.evaluate(() => Promise.all([
    chrome.runtime.sendMessage({ type: "STOP", sessionId: "review-completed" }),
    chrome.runtime.sendMessage({ type: "STOP", sessionId: "review-completed" }),
  ]));
  assert.equal(replies.filter((result) => result.ok).length, 1);
  assert.equal(replies.find((result) => result.ok).value.status, "ready");
  assert.match(replies.find((result) => !result.ok).error, /正在停止/);
  await first;
  const completed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(completed.value.sessions.find((session) => session.id === "review-completed").status, "ready");
  console.log("重复停止被拒绝，已完成批次不会被覆盖为中断");

  first = restartWithSession("review-write-failure", "recording");
  await panel.waitForTimeout(700);
  const failed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP", sessionId: "review-write-failure" }));
  assert.equal(failed.ok, false);
  assert.match(failed.error, /已请求停止，但无法更新本地批次/);
  await first;
  worker = context.serviceWorkers().at(-1);
  await worker.evaluate(() => { globalThis.failReviewWrite = false; });
  const recovered = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(recovered.ok, true);
  assert.equal(recovered.value.active, null);
  assert.equal(recovered.value.sessions.find((session) => session.id === "review-write-failure").status, "interrupted");
  console.log("中断批次写入失败时报告错误，存储恢复后可重新归档");

  first = restartWithSession("review-cleanup", "recording");
  await panel.waitForTimeout(700);
  worker = context.serviceWorkers().at(-1);
  await worker.evaluate(() => {
    chrome.scripting.unregisterContentScripts = () => Promise.reject(new Error("模拟采集器清理失败"));
  });
  const cleanup = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP", sessionId: "review-cleanup" }));
  assert.equal(cleanup.ok, false);
  assert.match(cleanup.error, /部分清理未能确认：页面采集器清理/);
  await first;
  const afterCleanup = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(afterCleanup.value.active, null);
  assert.equal(afterCleanup.value.sessions.find((session) => session.id === "review-cleanup").status, "interrupted");
  console.log("采集器清理失败时报告未确认状态，保留中断批次");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
