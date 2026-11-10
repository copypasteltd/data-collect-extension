import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end("<!doctype html><title>数据库值测试</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-dbvalues-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-dbvalues-extension-"));
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
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("business-db", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("orders");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cycle = { name: "循环业务数据" };
    cycle.self = cycle;
    const record = {
      count: 12345678901234567890n,
      options: new Map([["customer", "客户甲"], ["token", "private-map-token"]]),
      tags: new Set(["已支付", "已发货"]),
      timestamp: new Date("2025-01-01T00:00:00.000Z"),
      binary: new Uint8Array([1, 2, 3]),
      cycle,
      fields: Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`item${i}`, i])),
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction("orders", "readwrite");
      tx.objectStore("orders").put(record, "order-1");
      tx.objectStore("orders").put({ note: "二进制主键" }, new Uint8Array([4, 5]).buffer);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  const [tab] = await worker.evaluate(() => chrome.tabs.query({ url: "http://127.0.0.1/*" }));
  const started = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab, options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(started.ok, true);
  const stopped = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(stopped.ok, true);
  await panel.reload();
  const record = panel.locator(".record").filter({ hasText: "数据库值测试" });
  const downloadPromise = panel.waitForEvent("download", { timeout: 15000 });
  await record.getByTitle("下载记录包").click();
  const download = await downloadPromise;
  assert.equal(await download.failure(), null);
  const archive = path.join(profile, "database.zip");
  await download.saveAs(archive);
  const files = unzipSync(await fs.readFile(archive));
  const archiveManifest = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archiveManifest.eventChunks.flatMap((chunk) =>
    strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse),
  );
  const snapshot = events.find((event) => event.kind === "database.snapshot" &&
    event.payload.reason === "stop" && event.payload.database?.name === "business-db");
  const store = snapshot?.payload.database.stores.find((item) => item.name === "orders");
  const row = store?.records.find((item) => item.key === "order-1");
  assert.deepEqual(row?.value.count, { $type: "bigint", value: "12345678901234567890" });
  assert.deepEqual(row.value.options, { $type: "map", entries: [["customer", "客户甲"], ["token", "[已隐藏]"]] });
  assert.deepEqual(row.value.tags, { $type: "set", values: ["已支付", "已发货"] });
  assert.equal(row.value.timestamp, "2025-01-01T00:00:00.000Z");
  assert.deepEqual(row.value.binary, { $type: "binary", kind: "Uint8Array", size: 3 });
  assert.equal(row.value.cycle.self, "[循环引用未采集]");
  assert.equal(Object.keys(row.value.fields).length, 200);
  assert.ok(row.issues.includes("binary_omitted"));
  assert.ok(row.issues.includes("circular_reference"));
  assert.ok(row.issues.includes("entry_limit"));
  assert.equal(store.truncated, true);
  const binaryKey = store.records.find((item) => item.key?.$type === "binary");
  assert.equal(binaryKey?.key.size, 2);
  assert.ok(binaryKey.issues.includes("binary_omitted"));
  assert.ok(stopped.value.coverage.databaseGaps > 0);
  assert.ok(!JSON.stringify(events).includes("private-map-token"));
  await record.getByText("完成（有采集提示）").waitFor();
  await record.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("数据库部分内容未采集或超过上限").first().waitFor();
  await panel.evaluate((tabId) => chrome.scripting.executeScript({
    target: { tabId },
    func: () => Object.defineProperty(indexedDB, "databases", { configurable: true, value: undefined }),
  }), tab.id);
  const unavailableStart = await panel.evaluate((tab) => chrome.runtime.sendMessage({
    type: "START", tab: { ...tab, title: "数据库不可读取测试" },
    options: { screenshots: false, scope: "site" },
  }), tab);
  assert.equal(unavailableStart.ok, true);
  const unavailableStop = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP" }));
  assert.equal(unavailableStop.ok, true);
  assert.ok(unavailableStop.value.coverage.databaseGaps > 0);
  await panel.reload();
  const unavailableRecord = panel.locator(".record").filter({ hasText: "数据库不可读取测试" });
  await unavailableRecord.getByText("完成（有采集提示）").waitFor();
  await unavailableRecord.getByTitle("查看记录").click();
  await panel.getByRole("button", { name: "报告", exact: true }).click();
  await panel.getByText("数据库快照无法读取").first().waitFor();
  console.log("数据库复杂值、缺口提示和导出通过");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
