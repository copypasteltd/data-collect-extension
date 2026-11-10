import { chromium } from "playwright";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";

const profile = await fs.mkdtemp(path.resolve("test-db-upgrade-profile-"));
const extension = path.resolve("dist");
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(),
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] ||
    await context.waitForEvent("serviceworker", { timeout: 15000 });
  await context.addInitScript(() => { window.setInterval = () => 0; });
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  await panel.evaluate(async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.deleteDatabase("logic-recorder");
      request.onsuccess = resolve;
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("旧数据库连接未释放"));
    });
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("sessions", { keyPath: "id" });
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("session", "sessionId");
        events.createIndex("sessionSeq", ["sessionId", "seq"]);
        db.createObjectStore("assets", { keyPath: "id" }).createIndex("session", "sessionId");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(["sessions", "events", "assets"], "readwrite");
      tx.objectStore("sessions").add({ id: "legacy", title: "旧版记录", startedAt: 1, status: "ready" });
      tx.objectStore("events").add({ id: "old-event", sessionId: "legacy", seq: 1,
        time: 1, kind: "interaction.click", payload: { target: { text: "旧操作" } } });
      tx.objectStore("assets").add({ id: "old-asset", sessionId: "legacy", type: "resource",
        mime: "text/plain", blob: new Blob(["旧资源"]) });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.ok(state.ok && state.value.sessions.some((session) => session.id === "legacy"));
  const migrated = await panel.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("logic-recorder");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = (store, key) => new Promise((resolve, reject) => {
      const request = db.transaction(store).objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const result = { version: db.version, hasImports: db.objectStoreNames.contains("imports"),
      event: await read("events", "old-event"), asset: await read("assets", "old-asset") };
    result.assetText = await result.asset.blob.text();
    db.close();
    return result;
  });
  assert.equal(migrated.version, 3);
  assert.equal(migrated.hasImports, true);
  assert.equal(migrated.event.payload.target.text, "旧操作");
  assert.equal(migrated.assetText, "旧资源");
  console.log("旧版本数据库升级保留记录、事件和资源");
} finally {
  if (context) await context.close();
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
