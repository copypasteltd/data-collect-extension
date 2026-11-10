import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawn } from "node:child_process";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(req.url === "/child" ? '<!doctype html><input id="child">' : '<!doctype html><input id="value"><iframe src="/child"></iframe>');
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

async function scenario(prelude, run) {
  const profile = await fs.mkdtemp(path.resolve("test-review-profile-"));
  const extension = await fs.mkdtemp(path.resolve("test-review-extension-"));
  let context, browser, root, child, exited;
  try {
    await fs.cp(path.resolve("dist"), extension, { recursive: true });
    const manifestPath = path.join(extension, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    manifest.host_permissions = ["http://*/*", "https://*/*"];
    const { publicKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "der" },
      privateKeyEncoding: { type: "pkcs8", format: "der" },
    });
    manifest.key = publicKey.toString("base64");
    const extensionId = [...createHash("sha256").update(publicKey).digest().subarray(0, 16)]
      .flatMap((byte) => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))]).join("");
    await fs.writeFile(manifestPath, JSON.stringify(manifest));
    if (prelude) {
      const background = path.join(extension, "background.js");
      await fs.writeFile(background, prelude + "\n" + await fs.readFile(background, "utf8"));
    }
    let loadedId = extensionId;
    if (process.env.CHROME_BIN) {
      child = spawn(process.env.CHROME_BIN, [
        `--user-data-dir=${profile}`, "--headless=new", "--remote-debugging-port=0",
        "--enable-unsafe-extension-debugging", "--no-first-run", "--no-default-browser-check",
        "--disable-background-networking", "--no-proxy-server", "about:blank",
      ], { windowsHide: true, stdio: "ignore" });
      let launchError;
      exited = new Promise((resolve) => { child.once("exit", resolve); child.once("error", (error) => { launchError = error; resolve(); }); });
      let port;
      const deadline = Date.now() + 60000;
      while (!port && Date.now() < deadline) {
        if (launchError) throw launchError;
        try { port = Number((await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); }
        catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
      assert.ok(port, "Chrome 调试接口未启动");
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      root = await browser.newBrowserCDPSession();
      loadedId = (await root.send("Extensions.loadUnpacked", { path: extension })).id;
      context = browser.contexts()[0];
    } else {
      context = await chromium.launchPersistentContext(profile, {
        executablePath: chromium.executablePath(), headless: true,
        args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
      });
    }
    const workerEvent = context.waitForEvent("serviceworker", { predicate: (entry) => entry.url().includes(loadedId), timeout: 30000 }).catch(() => null);
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${loadedId}/sidepanel.html`);
    const worker = context.serviceWorkers().find((entry) => entry.url().includes(loadedId)) || await workerEvent;
    assert.ok(worker, "扩展后台未启动");
    const page = await context.newPage();
    await page.goto(url);
    await page.bringToFront();
    await run({ context, worker, page, panel });
  } finally {
    if (root) await root.send("Browser.close").catch(() => {});
    if (browser) await browser.close().catch(() => {});
    else if (context) await context.close();
    if (child?.exitCode === null) child.kill();
    if (exited) await exited;
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
}
async function start(page, panel) {
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  try { await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 25000 }); }
  catch (error) {
    console.error("录制未就绪时的侧边栏状态:", await panel.locator("body").innerText().catch(() => "不可读取"));
    throw error;
  }
  return panel.evaluate(async () => (await chrome.runtime.sendMessage({ type: "GET_STATUS" })).value.active.id);
}
async function restart(context, panel) {
  const cdp = await context.newCDPSession(panel);
  await cdp.send("ServiceWorker.enable");
  await cdp.send("ServiceWorker.stopAllWorkers");
  const first = panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
  await panel.waitForTimeout(500);
  const id = new URL(panel.url()).host;
  const worker = context.serviceWorkers().find((entry) => entry.url().includes(id)) ||
    await context.waitForEvent("serviceworker", { predicate: (entry) => entry.url().includes(id), timeout: 30000 });
  return { worker, first };
}
async function eventsFor(panel, id) {
  return panel.evaluate(async (sessionId) => {
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open("logic-recorder"); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const values = await new Promise((resolve, reject) => { const request = db.transaction("events").objectStore("events").index("session").getAll(sessionId); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    db.close(); return values;
  }, id);
}

try {
  await scenario(`const originalReviewGet = chrome.storage.session.get.bind(chrome.storage.session);
    chrome.storage.session.get = async (...args) => { const result = await originalReviewGet(...args); if (result.active) return new Promise(() => {}); return result; };`, async ({ context, page, panel }) => {
    const id = await start(page, panel);
    await page.locator("#value").fill("saved-before-session-read-failure");
    await page.waitForTimeout(1000);
    const { first } = await restart(context, panel);
    await panel.getByRole("button", { name: "停止录制" }).click();
    await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 30000 });
    await panel.getByRole("radio").first().waitFor({ timeout: 15000 });
    await first;
    const result = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    assert.equal(result.value.sessions.find((session) => session.id === id).status, "interrupted");
    assert.ok((await eventsFor(panel, id)).some((event) => event.kind === "interaction.input" && event.payload.value === "saved-before-session-read-failure"));
    console.log("会话状态读取超时时停止并保留已保存事件");
  });

  await scenario(`const originalReviewGet = chrome.storage.session.get.bind(chrome.storage.session);
    chrome.storage.session.get = async (...args) => { const result = await originalReviewGet(...args); if (result.active) return new Promise(() => {}); return result; };`, async ({ context, panel }) => {
    await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    await panel.evaluate(async () => {
      const older = { id: "old-review", origin: "https://example.test", startedAt: 1, status: "stopping", tabs: {}, options: {} };
      const current = { id: "new-review", origin: "https://example.test", startedAt: 2, status: "recording", tabs: {}, options: {} };
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open("logic-recorder"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").put(older); tx.objectStore("sessions").put(current); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
      await chrome.storage.session.set({ active: current });
    });
    const { first } = await restart(context, panel);
    const stale = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP", sessionId: "old-review" }));
    assert.equal(stale.ok, false);
    assert.match(stale.error, /无法确认当前录制批次/);
    assert.equal((await panel.evaluate(() => chrome.storage.session.get("active"))).active.id, "new-review");
    await panel.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open("logic-recorder"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").put({ id: "new-review", startedAt: 0, status: "recording", tabs: {}, options: {} }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
    });
    const skewed = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP", sessionId: "old-review" }));
    assert.equal(skewed.ok, false);
    assert.match(skewed.error, /无法确认当前录制批次/);
    assert.equal((await panel.evaluate(() => chrome.storage.session.get("active"))).active.id, "new-review");
    await panel.evaluate(async () => {
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open("logic-recorder"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      await new Promise((resolve, reject) => { const tx = db.transaction("sessions", "readwrite"); tx.objectStore("sessions").put({ id: "old-review", startedAt: 1, status: "interrupted" }); tx.objectStore("sessions").put({ id: "new-review", startedAt: 2, status: "recording", tabs: {}, options: {} }); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
      db.close();
    });
    const current = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "STOP", sessionId: "new-review" }));
    assert.equal(current.ok, true);
    assert.equal(current.value.id, "new-review");
    await first;
    console.log("状态不可读取时拒绝过期停止请求，保留并可停止较新批次");
  });

  await scenario(`const originalReviewGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) { if (this.name === "sessions" && this.transaction.mode === "readonly") return {}; return originalReviewGet.apply(this, args); };`, async ({ context, page, panel }) => {
    const firstId = await start(page, panel);
    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    const tabId = Number(Object.keys(state.value.active.tabs)[0]);
    const originalWorker = context.serviceWorkers().find((entry) => entry.url().includes(new URL(panel.url()).host));
    const childFrame = await originalWorker.evaluate(async (id) => (await chrome.webNavigation.getAllFrames({ tabId: id })).find((frame) => frame.frameId !== 0).frameId, tabId);
    await originalWorker.evaluate(async ({ id, frameId }) => {
      await chrome.scripting.executeScript({ target: { tabId: id, frameIds: [frameId] }, func: () => {
        const collector = globalThis.__logicRecorderInstalled;
        const original = collector.sessionId.bind(collector);
        collector.sessionId = async () => { await new Promise((resolve) => setTimeout(resolve, 2500)); return original(); };
      } });
    }, { id: tabId, frameId: childFrame });
    const { worker, first } = await restart(context, panel);
    await worker.evaluate((blockedFrame) => {
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      globalThis.restoreReviewSend = () => { chrome.tabs.sendMessage = original; };
      chrome.tabs.sendMessage = (...args) => args[1]?.type === "STOP_CAPTURE" && args[2]?.frameId === blockedFrame ? Promise.resolve({ ok: false }) : original(...args);
    }, childFrame);
    const stopped = await panel.evaluate((id) => chrome.runtime.sendMessage({ type: "STOP", sessionId: id }), firstId);
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /采集器关闭/);
    await first;
    await worker.evaluate(() => globalThis.restoreReviewSend());
    await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 15000 });
    const secondId = await start(page, panel);
    await page.frameLocator("iframe").locator("#child").fill("second-session-frame-value");
    await page.waitForTimeout(1400);
    await panel.getByRole("button", { name: "停止录制" }).click();
    await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 30000 });
    assert.ok((await eventsFor(panel, secondId)).some((event) => event.kind === "interaction.input" && event.payload.value === "second-session-frame-value"));
    console.log("框架未确认关闭时报告错误，新批次接管旧采集器并记录输入");
  });

  await scenario(`const originalReviewGet = IDBObjectStore.prototype.get;
    IDBObjectStore.prototype.get = function (...args) { if (this.name === "sessions" && this.transaction.mode === "readonly") return {}; return originalReviewGet.apply(this, args); };`, async ({ context, page, panel }) => {
    const id = await start(page, panel);
    const { worker, first } = await restart(context, panel);
    await worker.evaluate(() => {
      chrome.webNavigation.getAllFrames = () => Promise.reject(new Error("模拟框架枚举失败"));
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      globalThis.reviewBroadcast = false;
      chrome.tabs.sendMessage = (...args) => {
        if (args[1]?.type === "STOP_CAPTURE" && !args[2]) globalThis.reviewBroadcast = true;
        return original(...args);
      };
    });
    const stopped = await panel.evaluate((sessionId) => chrome.runtime.sendMessage({ type: "STOP", sessionId }), id);
    assert.equal(stopped.ok, false);
    assert.match(stopped.error, /页面框架检查/);
    assert.equal(await worker.evaluate(() => globalThis.reviewBroadcast), true);
    await first;
    console.log("无法枚举框架时尝试广播关闭并报告无法确认");
  });

  await scenario("", async ({ worker, page, panel }) => {
    const id = await start(page, panel);
    await page.locator("#value").fill("saved-before-interruption-write-failure");
    await page.waitForTimeout(1200);
    await worker.evaluate(() => {
      const originalSet = chrome.storage.session.set.bind(chrome.storage.session);
      chrome.storage.session.set = (...args) => args[0]?.active?.status === "stopping" ? Promise.reject(new Error("模拟停止状态写入失败")) : originalSet(...args);
      const originalPut = IDBObjectStore.prototype.put;
      globalThis.allowReviewInterruptionWrite = false;
      IDBObjectStore.prototype.put = function (...args) {
        if (this.name === "sessions" && args[0]?.status === "interrupted" && !globalThis.allowReviewInterruptionWrite) throw new Error("模拟中断状态写入失败");
        return originalPut.apply(this, args);
      };
    });
    await panel.getByRole("button", { name: "停止录制" }).click();
    await panel.getByText(/无法更新本地批次/).waitFor({ timeout: 20000 });
    assert.equal(await panel.getByRole("radio").count(), 0);
    await worker.evaluate(() => { globalThis.allowReviewInterruptionWrite = true; });
    await panel.getByRole("radio").first().waitFor({ timeout: 20000 });
    await panel.getByText(/无法更新本地批次/).waitFor({ state: "detached", timeout: 10000 });
    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    assert.equal(state.value.sessions.find((session) => session.id === id).status, "interrupted");
    const download = panel.waitForEvent("download", { timeout: 15000 });
    await panel.getByRole("button", { name: "导出记录包" }).click();
    const archive = unzipSync(await fs.readFile(await (await download).path()));
    const metadata = JSON.parse(strFromU8(archive["manifest.json"]));
    const events = metadata.eventChunks.flatMap((name) => strFromU8(archive[name]).split("\n").filter(Boolean).map(JSON.parse));
    assert.ok(events.some((event) => event.kind === "interaction.input" && event.payload.value === "saved-before-interruption-write-failure"));
    console.log("中断批次写入失败后自动重试，恢复后可导出既有事件");
  });
} finally {
  await new Promise((resolve) => server.close(resolve));
}
