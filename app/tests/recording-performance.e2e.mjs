import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync, strFromU8 } from "fflate";

const execFileAsync = promisify(execFile);
const duration = Number(process.env.TEST_PERFORMANCE_MS || 60000);
const nodeCount = Number(process.env.TEST_PERFORMANCE_NODES || 0);
const responseBytes = Number(process.env.TEST_PERFORMANCE_RESPONSE_BYTES || 0);
const interval = Number(process.env.TEST_PERFORMANCE_INTERVAL_MS || 1500);
for (const [name, value, max] of [["duration", duration, 3600000], ["nodes", nodeCount, 10000],
  ["response bytes", responseBytes, 1000000], ["interval", interval, 60000]]) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max || (name === "duration" && value === 0))
    throw new Error(`无效的压力测试参数: ${name}`);
}
const server = http.createServer((request, response) => {
  if (request.url.startsWith("/api")) {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ value: request.url, payload: "x".repeat(responseBytes) }));
    return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><title>Recording performance</title><input id="value"><button id="action">Action</button>
    <div id="result"></div><script>
    document.querySelector('#action').onclick = async () => {
      const value = document.querySelector('#value').value;
      document.querySelector('#result').textContent = await (await fetch('/api?value=' + value)).text();
    };</script>`);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const profile = await fs.mkdtemp(path.resolve("test-performance-profile-"));
const extension = await fs.mkdtemp(path.resolve("test-performance-extension-"));
let browser, root;
try {
  await fs.cp(path.resolve("dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.host_permissions = ["http://*/*", "https://*/*"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  browser = await launchExtension(profile, extension, ["--window-size=1000,700"]);
  const context = browser.context;
  root = await context.browser().newBrowserCDPSession();
  const memorySamples = [];
  async function sampleMemory() {
    if (process.platform !== "win32") return;
    const { processInfo } = await root.send("SystemInfo.getProcessInfo");
    const ids = processInfo.map((item) => item.id).filter(Number.isSafeInteger);
    if (!ids.length) return;
    const command = `Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum`;
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], { timeout: 10000 });
    const bytes = Number(stdout.trim());
    if (Number.isFinite(bytes) && bytes > 0) memorySamples.push(bytes);
  }
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  if (nodeCount) await page.evaluate((count) => {
    const fragment = document.createDocumentFragment();
    for (let index = 0; index < count; index++) {
      const node = document.createElement("div");
      node.textContent = `sample-${index}`;
      node.style.color = index % 2 ? "rgb(13, 79, 131)" : "rgb(137, 47, 29)";
      fragment.append(node);
    }
    document.body.append(fragment);
  }, nodeCount);
  const panel = await context.newPage();
  await panel.goto(`chrome-extension://${browser.id}/sidepanel.html`);
  await page.bringToFront();
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 30000 });
  await sampleMemory();
  const started = Date.now();
  let iterations = 0, nextSample = started + 10000, slowestStatus = 0;
  while (Date.now() - started < duration) {
    const value = String(iterations++);
    await page.locator("#value").fill(value);
    await Promise.all([page.waitForResponse((response) => response.url().includes(`/api?value=${value}`)), page.locator("#action").click()]);
    const statusStarted = Date.now();
    const status = await panel.evaluate(() => Promise.race([
      chrome.runtime.sendMessage({ type: "GET_STATUS" }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("状态读取超时")), 5000)),
    ]));
    assert.ok(status?.ok, "录制期间状态读取失败");
    slowestStatus = Math.max(slowestStatus, Date.now() - statusStarted);
    if (Date.now() >= nextSample) {
      await sampleMemory();
      nextSample = Date.now() + 10000;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  const stopStarted = Date.now();
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 45000 });
  const stopMs = Date.now() - stopStarted;
  await panel.getByRole("radio").first().waitFor();
  await panel.getByRole("radio").first().check();
  let profiler;
  if (process.env.TEST_PERFORMANCE_PROFILE === "1") {
    profiler = await context.newCDPSession(panel);
    await profiler.send("Profiler.enable");
    await profiler.send("Profiler.start");
  }
  const exportStarted = Date.now();
  const downloadPromise = panel.waitForEvent("download", { timeout: 180000 }).catch(async (error) => {
    const state = await panel.locator("body").innerText().catch(() => "侧边栏不可读取");
    throw new Error(`等待导出下载超时或失败；侧边栏状态：${state}`, { cause: error });
  });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await downloadPromise;
  const archivePath = path.join(profile, "performance.zip");
  await download.saveAs(archivePath);
  const exportMs = Date.now() - exportStarted;
  if (profiler) {
    const { profile } = await profiler.send("Profiler.stop");
    const hotspots = profile.nodes.filter((node) => node.hitCount).sort((a, b) => b.hitCount - a.hitCount).slice(0, 15)
      .map((node) => ({ functionName: node.callFrame.functionName, url: node.callFrame.url, line: node.callFrame.lineNumber + 1, samples: node.hitCount }));
    console.log("导出 CPU 采样", JSON.stringify(hotspots));
    await profiler.detach();
  }
  const archiveBytes = (await fs.stat(archivePath)).size;
  const files = unzipSync(await fs.readFile(archivePath));
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const events = archive.eventChunks.flatMap((chunk) => strFromU8(files[chunk]).split("\n").filter(Boolean).map(JSON.parse));
  assert.equal(events.filter((event) => event.kind === "interaction.input").length, iterations);
  assert.equal(events.filter((event) => event.kind === "network.request" && event.payload.url.includes("/api?value=")).length, iterations);
  assert.ok(memorySamples.length || process.platform !== "win32", "未取得 Chrome 内存样本");
  let skillIndexMs = null;
  if (process.env.TEST_PERFORMANCE_SKILL === "1") {
    const startIndex = Date.now();
    const { stdout } = await execFileAsync(process.env.PYTHON_BIN || "python", [
      path.resolve("skills/extension-logic-clone/scripts/index_archive.py"), archivePath, "--output", path.join(profile, "index.sqlite3"),
    ], { timeout: 300000, maxBuffer: 2000000, env: { ...process.env, PYTHONUTF8: "1" } });
    const result = JSON.parse(stdout);
    assert.equal(result.verification, "passed");
    assert.equal(result.events, events.length);
    skillIndexMs = Date.now() - startIndex;
  }
  console.log(JSON.stringify({ durationMs: Date.now() - started, requestedDurationMs: duration, nodeCount, responseBytes, intervalMs: interval,
    iterations, slowestStatusMs: slowestStatus,
    stopMs, exportMs, archiveBytes, skillIndexMs, chromeWorkingSetSamplesBytes: memorySamples }));
} finally {
  if (root) await root.detach().catch(() => {});
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
}
