import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const profile = await fs.mkdtemp(path.resolve("test-archive-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
    ],
  });
  const worker =
    context.serviceWorkers()[0] ||
    (await context.waitForEvent("serviceworker", { timeout: 15000 }));
  const panel = await context.newPage();
  await panel.goto(
    `chrome-extension://${new URL(worker.url()).host}/sidepanel.html`,
  );
  const htmlLength = await panel.evaluate(async () => {
    const html = `<div>${"x".repeat(5000)}</div>`.repeat(260);
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "events"], "readwrite");
      tx.objectStore("sessions").put({
        id: "compressible-test",
        title: "高压缩率页面测试",
        status: "ready",
        startedAt: Date.now(),
      });
      tx.objectStore("events").put({
        id: "snapshot-test",
        sessionId: "compressible-test",
        seq: 1,
        time: Date.now(),
        kind: "page.snapshot",
        payload: { html, status: "captured" },
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return html.length;
  });
  await panel.reload();
  const record = panel
    .locator(".record")
    .filter({ hasText: "高压缩率页面测试" });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  const archivePath = path.join(profile, "roundtrip.zip");
  await download.saveAs(archivePath);
  const archive = await fs.readFile(archivePath);
  let ratio = 0;
  for (let i = 0; i + 46 <= archive.length; i++) {
    if (archive.readUInt32LE(i) !== 0x02014b50) continue;
    const length = archive.readUInt16LE(i + 28);
    const name = archive.subarray(i + 46, i + 46 + length).toString();
    if (name === "timeline/events-00001.jsonl")
      ratio = archive.readUInt32LE(i + 24) / archive.readUInt32LE(i + 20);
  }
  assert.ok(
    htmlLength > 1000000 && ratio > 500,
    "测试包必须超过原有压缩比限制",
  );
  await panel.getByRole("button", { name: "导入记录包" }).click();
  await panel.locator("input[type=file]").first().setInputFiles(archivePath);
  await panel
    .getByRole("heading", { name: "高压缩率页面测试" })
    .waitFor({ timeout: 15000 });
  await panel
    .locator(".timeline-item")
    .getByText("页面状态", { exact: true })
    .waitFor({ timeout: 15000 });
  console.log("高压缩率页面记录包真实导出与导入通过");
} finally {
  if (context) await context.close();
  await fs.rm(profile, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 250,
  });
}
