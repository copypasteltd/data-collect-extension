import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const profile = await fs.mkdtemp(path.resolve("test-archive-limits-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    acceptDownloads: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "events", "assets"], "readwrite");
      for (const [id, title] of [["long-event", "超长事件"], ["large-asset", "超大资源"]])
        tx.objectStore("sessions").put({ id, title, status: "ready", startedAt: Date.now() });
      tx.objectStore("events").put({ id: "event", sessionId: "long-event", seq: 1,
        time: Date.now(), kind: "page.snapshot", payload: { text: "x".repeat(10000001) } });
      tx.objectStore("assets").put({ id: "asset", sessionId: "large-asset", type: "resource",
        mime: "application/octet-stream", blob: new Blob([new Uint8Array(50000001)]) });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  });
  await panel.reload();
  for (const [title, expectedNotice, expectedImportError] of [
    ["超长事件", "单条事件超过 1000 万个 UTF-16 代码单元", "事件数据超过大小限制"],
    ["超大资源", "单个文件超过 50 MB", "单个文件超过 50 MB"],
  ]) {
    const record = panel.locator(".record").filter({ hasText: title });
    const promise = panel.waitForEvent("download", { timeout: 60000 });
    await record.getByTitle("下载记录包").click();
    const download = await promise;
    assert.equal(await download.failure(), null);
    await panel.getByText(expectedNotice, { exact: false }).waitFor();
    const file = path.join(profile, `${title}.zip`);
    await download.saveAs(file);
    await panel.getByRole("button", { name: "导入记录包" }).click();
    await panel.locator('input[type="file"]').first().setInputFiles(file);
    await panel.getByText(expectedImportError, { exact: false }).waitFor({ timeout: 30000 });
    await panel.getByTitle("返回录制").click();
  }
  console.log("超长事件及超大资源可备份，下载提示与导入限制一致");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
