import { chromium } from "playwright";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { unzipSync, strFromU8 } from "fflate";

const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end('{"ok":true}');
  } else {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end('<!doctype html><title>Stop lifecycle</title><input id="value"><button id="action">Action</button>');
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-stop-lifecycle-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-stop-lifecycle-extension-"));
let context;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  context = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CHROME_BIN || chromium.executablePath(), headless: true,
    viewport: null,
    args: ["--window-size=1000,700", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent("serviceworker", { timeout: 15000 });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/first`);
  let panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await page.bringToFront();
  await panel.waitForTimeout(2200);

  await worker.evaluate(() => {
    const original = chrome.scripting.executeScript.bind(chrome.scripting);
    let waiting = true;
    chrome.scripting.executeScript = async (options) => {
      if (waiting && options.files?.includes("content.js")) {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseOldInjection = resolve; });
      }
      return original(options);
    };
  });
  await panel.getByRole("button", { name: "开始录制" }).click();
  const injectionDeadline = Date.now() + 15000;
  while (Date.now() < injectionDeadline && !(await worker.evaluate(() => !!globalThis.releaseOldInjection)))
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseOldInjection), "function");
  await panel.getByText("准备中", { exact: true }).waitFor();
  const stop = panel.getByRole("button", { name: "停止录制" });
  assert.equal(await stop.isEnabled(), true, "准备期间应允许停止");
  await page.evaluate(() => fetch("/api?before-stop"));
  await page.waitForTimeout(400);
  await stop.click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  const first = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(first.value.active, null);
  assert.equal(first.value.sessions[0].status, "interrupted");
  const download = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const zip = unzipSync(await fs.readFile(await (await download).path()));
  const archiveManifest = JSON.parse(strFromU8(zip["manifest.json"]));
  const events = archiveManifest.eventChunks.flatMap((name) => strFromU8(zip[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(events.some((event) => event.kind === "network.request" && event.payload.url.includes("before-stop")),
    "准备阶段已保存的网络请求应可导出");

  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  const second = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.notEqual(second.value.active.id, first.value.sessions[0].id);
  await worker.evaluate(() => globalThis.releaseOldInjection());
  await page.locator("#value").fill("new-session");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  const final = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(final.value.active, null);
  assert.equal(final.value.sessions.find((item) => item.id === second.value.active.id)?.status, "ready");
  const secondDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const secondZip = unzipSync(await fs.readFile(await (await secondDownload).path()));
  const secondManifest = JSON.parse(strFromU8(secondZip["manifest.json"]));
  const secondEvents = secondManifest.eventChunks.flatMap((name) => strFromU8(secondZip[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(secondEvents.some((event) => event.kind === "interaction.input" && event.payload.value === "new-session"),
    "迟到注入不能阻止新批次记录输入");

  const another = await context.newPage();
  await another.goto(`http://127.0.0.1:${server.address().port}/second`);
  const third = await context.newPage();
  await third.goto(`http://127.0.0.1:${server.address().port}/third`);
  await third.bringToFront();
  await panel.waitForTimeout(2200);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    globalThis.restoreFlush = () => { chrome.tabs.sendMessage = original; };
    globalThis.flushWaiters = [];
    chrome.tabs.sendMessage = (...args) => {
      if (args[1]?.type !== "FLUSH") return original(...args);
      return new Promise((resolve, reject) => {
        globalThis.flushWaiters.push(() => original(...args).then(resolve, reject));
      });
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  const flushDeadline = Date.now() + 5000;
  while (Date.now() < flushDeadline && (await worker.evaluate(() => globalThis.flushWaiters.length)) < 3)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok((await worker.evaluate(() => globalThis.flushWaiters.length)) >= 3, "多个页面应并行收尾");
  await worker.evaluate(() => { for (const release of globalThis.flushWaiters) release(); });
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  await worker.evaluate(() => globalThis.restoreFlush());
  console.log("多个页面并行收尾");

  await another.close();
  await third.close();
  await worker.evaluate(() => {
    const original = chrome.scripting.registerContentScripts.bind(chrome.scripting);
    let waiting = true;
    chrome.scripting.registerContentScripts = async (...args) => {
      if (waiting) {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseOldRegistration = resolve; });
      }
      return original(...args);
    };
  });
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  const registrationDeadline = Date.now() + 10000;
  while (Date.now() < registrationDeadline && !(await worker.evaluate(() => !!globalThis.releaseOldRegistration)))
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseOldRegistration), "function");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  const current = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await worker.evaluate(() => globalThis.releaseOldRegistration());
  await page.waitForTimeout(500);
  const registered = await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts());
  assert.deepEqual(registered.map((item) => item.id), [current.value.active.scriptId], "旧录制的迟到注册应被清理");
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    let waiting = true;
    chrome.tabs.sendMessage = async (...args) => {
      if (waiting && args[1]?.type === "STOP_CAPTURE") {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseOldStop = resolve; });
      }
      return original(...args);
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  console.log("迟到的采集器注册不会干扰下一批录制");
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseOldStop), "function");
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  await worker.evaluate(() => globalThis.releaseOldStop());
  await page.locator("#value").fill("after-late-stop");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  const lateDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const lateZip = unzipSync(await fs.readFile(await (await lateDownload).path()));
  const lateManifest = JSON.parse(strFromU8(lateZip["manifest.json"]));
  const lateEvents = lateManifest.eventChunks.flatMap((name) => strFromU8(lateZip[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(lateEvents.some((event) => event.kind === "interaction.input" && event.payload.value === "after-late-stop"),
    "旧录制的迟到停止消息不能阻止新录制采集输入");
  console.log("迟到的停止消息不影响下一批录制");

  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  await worker.evaluate(() => {
    const original = chrome.tabs.sendMessage.bind(chrome.tabs);
    let waiting = true;
    chrome.tabs.sendMessage = async (...args) => {
      if (waiting && args[1]?.type === "FLUSH") {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseOldFlush = resolve; });
      }
      return original(...args);
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseOldFlush), "function");
  const timedOut = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(timedOut.value.sessions[0].status, "interrupted", "超时的批次应保留为中断状态");
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  await worker.evaluate(() => globalThis.releaseOldFlush());
  await page.locator("#value").fill("after-late-flush");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  const flushDownload = panel.waitForEvent("download", { timeout: 15000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const flushZip = unzipSync(await fs.readFile(await (await flushDownload).path()));
  const flushManifest = JSON.parse(strFromU8(flushZip["manifest.json"]));
  const flushEvents = flushManifest.eventChunks.flatMap((name) => strFromU8(flushZip[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.ok(flushEvents.some((event) => event.kind === "interaction.input" && event.payload.value === "after-late-flush"),
    "旧录制的迟到收尾消息不能停止新采集器");
  console.log("收尾超时后可重新录制，迟到收尾消息不会影响新批次");

  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  await worker.evaluate(() => {
    const original = chrome.storage.session.remove.bind(chrome.storage.session);
    let waiting = true;
    chrome.storage.session.remove = async (...args) => {
      if (waiting && Array.isArray(args[0]) && args[0].includes("active")) {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseStateCleanup = resolve; });
      }
      return original(...args);
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  const cleanupDeadline = Date.now() + 10000;
  while (Date.now() < cleanupDeadline && !(await worker.evaluate(() => !!globalThis.releaseStateCleanup)))
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseStateCleanup), "function");
  await panel.close();
  panel = await context.newPage();
  await panel.goto(`chrome-extension://${new URL(worker.url()).host}/sidepanel.html`);
  await panel.getByRole("button", { name: "正在结束…" }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "正在结束…" }).isDisabled(), true);
  const duringCleanup = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(duringCleanup.value.active?.status, "stopping", "状态清理期间不能提前开放下一批录制");
  await worker.evaluate(() => globalThis.releaseStateCleanup());
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 15000 });
  console.log("关闭并重开侧边栏不会打断停止收尾");

  await worker.evaluate(() => {
    const original = chrome.scripting.registerContentScripts.bind(chrome.scripting);
    let waiting = true;
    chrome.scripting.registerContentScripts = async (...args) => {
      if (waiting) {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseTimedOutRegistration = resolve; });
      }
      return original(...args);
    };
  });
  await page.bringToFront();
  await panel.waitForTimeout(2200);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 20000 });
  assert.equal(await panel.getByRole("button", { name: "停止录制" }).isEnabled(), true,
    "启动接口超时后仍应允许停止");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  const registrationTimeout = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(registrationTimeout.value.sessions[0].status, "interrupted");
  await worker.evaluate(() => globalThis.releaseTimedOutRegistration());
  await page.waitForTimeout(500);
  assert.deepEqual(await worker.evaluate(() => chrome.scripting.getRegisteredContentScripts()), [],
    "超时后迟到的采集器注册应被清理");
  console.log("启动接口超时后可停止并清理迟到注册");

  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  await worker.evaluate(() => {
    const original = chrome.storage.session.remove.bind(chrome.storage.session);
    let waiting = true;
    chrome.storage.session.remove = async (...args) => {
      let delayed = false;
      if (waiting && Array.isArray(args[0]) && args[0].includes("active")) {
        waiting = false;
        delayed = true;
        await new Promise((resolve) => { globalThis.releaseLateStateCleanup = resolve; });
      }
      const result = await original(...args);
      if (delayed) globalThis.lateStateRemoved = true;
      return result;
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseLateStateCleanup), "function");
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  const newState = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await worker.evaluate(() => globalThis.releaseLateStateCleanup());
  const stateDeadline = Date.now() + 5000;
  let storedId;
  while (Date.now() < stateDeadline) {
    storedId = await worker.evaluate(async () => globalThis.lateStateRemoved && (await chrome.storage.session.get("active")).active?.id);
    if (storedId === newState.value.active.id) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(storedId, newState.value.active.id, "迟到的旧状态清理不能删除新批次状态");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  console.log("迟到的状态清理不会删除新录制状态");

  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => item.textContent.includes("停止录制"));
    return button && !button.disabled && document.body.textContent.includes("录制中");
  }, null, { timeout: 20000 });
  const beforeDetach = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await worker.evaluate(() => {
    const original = chrome.debugger.detach.bind(chrome.debugger);
    let waiting = true;
    chrome.debugger.detach = async (...args) => {
      if (waiting) {
        waiting = false;
        await new Promise((resolve) => { globalThis.releaseLateDetach = resolve; });
      }
      return original(...args);
    };
  });
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseLateDetach), "function");
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  const attachDeadline = Date.now() + 5000;
  let waitingForDetach = false;
  while (Date.now() < attachDeadline && !waitingForDetach) {
    const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    waitingForDetach = !!state.value.active?.tabs?.[beforeDetach.value.active.tabId]?.attaching;
    if (!waitingForDetach) await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(waitingForDetach, true, "新录制应等待旧调试连接关闭");
  await worker.evaluate(() => globalThis.releaseLateDetach());
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 15000 });
  const afterDetach = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(afterDetach.value.active.tabs[beforeDetach.value.active.tabId].debuggerAttached, true);
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  console.log("迟到的调试连接关闭不会中断新录制");

  await worker.evaluate(() => {
    const original = chrome.storage.session.set.bind(chrome.storage.session);
    let waiting = true;
    chrome.storage.session.set = async (value) => {
      let delayed = false;
      if (waiting && value.active?.status === "recording") {
        waiting = false;
        delayed = true;
        await new Promise((resolve) => { globalThis.releaseLateStateWrite = resolve; });
      }
      const result = await original(value);
      if (delayed) globalThis.lateStateWritten = true;
      return result;
    };
  });
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  const lateWriteDeadline = Date.now() + 10000;
  while (Date.now() < lateWriteDeadline && !(await worker.evaluate(() => !!globalThis.releaseLateStateWrite)))
    await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(await worker.evaluate(() => typeof globalThis.releaseLateStateWrite), "function");
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 10000 });
  assert.equal(await panel.getByRole("button", { name: "停止录制" }).isEnabled(), true,
    "录制状态写入未完成时仍应允许停止");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 20000 });
  const afterWrite = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  await worker.evaluate(() => globalThis.releaseLateStateWrite());
  const writeDeadline = Date.now() + 5000;
  let storedAfterWrite;
  while (Date.now() < writeDeadline) {
    storedAfterWrite = await worker.evaluate(async () => globalThis.lateStateWritten && (await chrome.storage.session.get("active")).active?.id);
    if (storedAfterWrite === afterWrite.value.active.id) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(storedAfterWrite, afterWrite.value.active.id, "迟到的旧状态写入不能覆盖新批次");
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 25000 });
  console.log("录制状态写入未完成时可停止，迟到写入不会覆盖新批次");
  console.log("准备期间可停止并导出，迟到注入不影响下一批录制");
} finally {
  if (context) await context.close();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
