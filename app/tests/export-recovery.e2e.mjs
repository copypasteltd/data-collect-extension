// Synthetic only; native Chrome, owned temporary profile, production Export UI. Never builds or edits prod.
// CHROME_BIN="C:/Program Files/Google/Chrome/Application/chrome.exe" node tests/export-recovery.e2e.mjs
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const app = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = path.resolve(app, "..");
const runRoot = await fs.mkdtemp(path.join(app, "test-export-recovery-"));
const profile = await fs.mkdtemp(path.join(runRoot, "profile-")), extension = path.join(runRoot, "extension");
const reportPath = path.join(root, "docs/修复/2026-11-13-stop-export/export-recovery.json");
const result = { schemaVersion: 1, startedAt: new Date().toISOString(), runRoot, scenarios: [], assertions: [],
  scope: "knownDBstalled and legacy interrupted read-only export recovery; synthetic seed, no real user data" };
const check = (condition, label) => { assert.ok(condition, label); result.assertions.push(label); };
let browser, panel, downloadCount = 0;
const seed = (id, sealed) => {
  const base = 1794571200000, value = ("合成原值-SYNTHETIC-" + id + "-🙂").repeat(450).slice(0, 10000);
  const session = { id, producerVersion: sealed ? "0.3.1" : "0.3.0", title: "Synthetic export recovery",
    origin: "http://127.0.0.1", startedAt: base + (sealed ? 1 : 0), endedAt: base + 1000, status: sealed ? "ready" : "interrupted",
    eventCount: 181, lastSeq: 181, assetCount: 2, options: { scope: "site" }, tabs: {},
    ...(sealed ? { writeState: "sealed", revision: 2, seal: { revision: 2, lastSeq: 181, eventCount: 181, assetCount: 2, sealedAt: base + 1000 } }
      : { incomplete: true, notice: "Synthetic legacy interrupted terminal; retained for export" }) };
  const events = Array.from({ length: 180 }, (_, index) => ({ id: id + "-event-" + String(index + 1).padStart(4, "0"),
    sessionId: id, seq: index + 1, time: base + index, kind: "interaction.input", tabId: 1, frameId: 0, documentId: "synthetic-document",
    payload: { url: "http://127.0.0.1/synthetic", value: index + ":" + value, target: { tag: "INPUT", selector: "#synthetic" } } }));
  const nodes = Array.from({ length: 1501 }, (_, id) => ({ id, type: "object", entries: id < 1500
    ? [["next", { type: "ref", id: id + 1 }]] : [["rawLeaf", { type: "string", value }]] }));
  events.push({ id: id + "-deep-graph", sessionId: id, seq: 181, time: base + 180, kind: "database.record",
    tabId: 1, frameId: 0, documentId: "synthetic-document", payload: { url: "http://127.0.0.1/synthetic",
      database: "synthetic", store: "records", index: 0, status: "captured", graphCaptureId: id + "-graph",
      graph: { root: { type: "ref", id: 0 }, nodes } } });
  const assets = [new Uint8Array(32768).map((_, i) => i % 251), new TextEncoder().encode(value)].map((bytes, i) =>
    ({ id: id + "-asset-" + i, sessionId: id, type: "resource", mime: "application/octet-stream", bytes: [...bytes] }));
  return { session, events, assets };
};
async function snapshot() {
  return panel.evaluate(async () => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("logic-recorder"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    const hash = async bytes => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(x => x.toString(16).padStart(2, "0")).join("");
    try {
      const tx = db.transaction(["sessions", "events", "assets"]), names = ["sessions", "events", "assets"];
      const rows = await Promise.all(names.map(name => new Promise((ok, no) => { const r = tx.objectStore(name).getAll(); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); })));
      const [sessions, events, assets] = rows;
      const assetRows = await Promise.all(assets.map(async ({ blob, ...metadata }) => ({ ...metadata, bytes: blob.size, sha256: await hash(await blob.arrayBuffer()) })));
      return { sessions, eventCount: events.length, assetCount: assets.length,
        eventsSha256: await hash(new TextEncoder().encode(JSON.stringify(events))), assets: assetRows };
    } finally { db.close(); }
  });
}
async function beginObservation() {
  await panel.evaluate(() => {
    const trace = globalThis.__recoveryTrace = { changes: [], heartbeat: { intervalMs: 100, maxGapMs: 0, ticks: 0 } };
    let previous = "", last = performance.now();
    const observe = () => {
      const button = document.querySelector("button.export"), detail = document.querySelector(".batches [aria-live]");
      const text = (button?.textContent || "") + " | " + (detail?.textContent || "");
      if (text !== previous) { trace.changes.push({ at: Math.round(performance.now()), text }); previous = text; }
    };
    const watcher = new MutationObserver(observe); watcher.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    const timer = setInterval(() => { const now = performance.now(); trace.heartbeat.ticks++; trace.heartbeat.maxGapMs = Math.max(trace.heartbeat.maxGapMs, now - last); last = now; }, 100);
    globalThis.__endRecoveryObservation = () => { observe(); watcher.disconnect(); clearInterval(timer); return trace; }; observe();
  });
}
async function faultOn() {
  await panel.evaluate(() => {
    const originalIndex = IDBObjectStore.prototype.index, originalTimer = globalThis.setTimeout, originalAbort = IDBTransaction.prototype.abort;
    globalThis.__recoveryFault = { countCalls: 0, abortCalls: 0, timers: [] };
    IDBObjectStore.prototype.index = function (...args) {
      const index = originalIndex.apply(this, args);
      if (this.name === "events" && args[0] === "session") index.count = () => { globalThis.__recoveryFault.countCalls++; return {}; };
      return index;
    };
    IDBTransaction.prototype.abort = function (...args) { globalThis.__recoveryFault.abortCalls++; return originalAbort.apply(this, args); };
    globalThis.setTimeout = function (callback, delay, ...args) {
      const mapped = delay === 15000 ? 150 : delay === 45000 ? 1000 : delay;
      if (mapped !== delay) globalThis.__recoveryFault.timers.push({ original: delay, mapped });
      return originalTimer.call(this, callback, mapped, ...args);
    };
    globalThis.__restoreRecoveryFault = () => { IDBObjectStore.prototype.index = originalIndex; IDBTransaction.prototype.abort = originalAbort; globalThis.setTimeout = originalTimer; return globalThis.__recoveryFault; };
  });
}
function verifyZip(bytes, fixture) {
  const zip = unzipSync(bytes), manifest = JSON.parse(strFromU8(zip["manifest.json"])), integrity = JSON.parse(strFromU8(zip["integrity.json"]));
  const lines = paths => paths.flatMap(file => strFromU8(zip[file]).trim().split("\n").filter(Boolean).map(line => JSON.parse(line)));
  assert.deepEqual(manifest.session, fixture.session, "ZIP session/seal equals original seed");
  assert.deepEqual(lines(manifest.eventChunks), fixture.events, "every raw event, UI value and deep graph preserved exactly");
  assert.equal(manifest.eventCount, fixture.events.length); assert.equal(manifest.assetCount, fixture.assets.length);
  assert.equal(manifest.partial, fixture.session.status === "interrupted");
  assert.equal(manifest.provenance.exporterVersion, "0.3.1");
  for (const asset of fixture.assets) assert.deepEqual(zip["resources/" + asset.id + ".bin"], new Uint8Array(asset.bytes), "raw attachment bytes preserved");
  assert.deepEqual(new Set(integrity.map(row => row.path)), new Set(Object.keys(zip).filter(file => file !== "integrity.json")), "every other ZIP file covered exactly once by integrity");
  assert.equal(integrity.length, Object.keys(zip).length - 1);
  const fileSha256 = Object.fromEntries(Object.entries(zip).map(([file, content]) => [file, sha(content)]));
  for (const row of integrity) { assert.equal(row.size, zip[row.path].length); assert.equal(row.sha256, fileSha256[row.path], row.path); }
  const observations = lines(manifest.browserObservationChunks), graphId = fixture.events.at(-1).id;
  const graphRows = observations.filter(row => row.source?.eventId === graphId);
  const coverage = graphRows.filter(row => row.kind === "field-path-coverage");
  check(coverage.length > 0 && coverage.every(row => row.status === "partial" && row.pending > 0), "deep path budget explicitly reports partial coverage");
  assert.equal(graphRows.filter(row => row.kind === "graph-node").length, 1501, "all raw graph-node derivations retained");
  assert.equal(graphRows.filter(row => row.kind === "field").length, 1501, "all direct graph fields retained");
  return { zipBytes: bytes.length, zipSha256: sha(bytes), eventCount: manifest.eventCount, assetCount: manifest.assetCount,
    partial: manifest.partial, provenance: manifest.provenance, coverage, integrityFiles: integrity.length, fileSha256 };
}
try {
  const dist = path.resolve(app, process.env.EXPORT_RECOVERY_DIST || "dist");
  await fs.cp(dist, extension, { recursive: true });
  const manifest = JSON.parse(await fs.readFile(path.join(extension, "manifest.json"), "utf8"));
  assert.equal(manifest.version, "0.3.1", "wait for parent buildready; do not test stale dist");
  const files = async (dir, prefix = "") => (await Promise.all((await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name)).map(async e =>
    e.isDirectory() ? files(path.join(dir, e.name), prefix + e.name + "/") : [[prefix + e.name, sha(await fs.readFile(path.join(dir, e.name)))]]))).flat();
  result.sourceIdentity = { commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    testSha256: sha(await fs.readFile(new URL(import.meta.url))), copiedDistFiles: Object.fromEntries(await files(extension)) };
  console.log(JSON.stringify({ event: "run", runRoot, version: manifest.version, testSha256: result.sourceIdentity.testSha256 }));
  browser = await launchExtension(profile, extension, ["--window-size=900,800"]);
  panel = await browser.context.newPage(); await panel.goto("chrome-extension://" + browser.id + "/sidepanel.html");
  result.browser = await panel.evaluate(() => navigator.userAgent); check(result.browser.includes("Chrome/157."), "native Chrome 157 confirmed");
  const initial = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })); assert.equal(initial.ok, true); assert.equal(initial.value.active, null);
  const fixtures = [seed("legacy-recovery-synthetic", false), seed("sealed-recovery-synthetic", true)];
  await panel.evaluate(async fixtures => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("logic-recorder"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    try { await new Promise((ok, no) => { const tx = db.transaction(["sessions", "events", "assets"], "readwrite");
      for (const fixture of fixtures) { tx.objectStore("sessions").put(fixture.session);
        for (const event of fixture.events) tx.objectStore("events").put(event);
        for (const { bytes, ...asset } of fixture.assets) tx.objectStore("assets").put({ ...asset, blob: new Blob([new Uint8Array(bytes)], { type: asset.mime }) }); }
      tx.oncomplete = ok; tx.onabort = tx.onerror = () => no(tx.error); });
    } finally { db.close(); }
  }, fixtures);
  await panel.reload(); await panel.locator(".batch").first().waitFor();
  panel.on("download", () => downloadCount++);
  const before = await snapshot(); result.before = before;
  check(before.eventCount === 362 && before.assetCount === 4, "both legal terminal batches exist only in owned synthetic profile");
  for (const fixture of fixtures) {
    const row = { sessionId: fixture.session.id }; result.scenarios.push(row);
    await panel.locator(".batch").filter({ hasText: fixture.session.id.slice(0, 8) }).locator("input").check();
    await beginObservation(); await faultOn(); const countBefore = downloadCount, started = Date.now();
    await panel.getByRole("button", { name: "导出记录包", exact: true }).click();
    await panel.getByRole("alert").filter({ hasText: /读取记录数量超时|读取记录数量事务已中断/ }).waitFor({ timeout: 5000 });
    await panel.waitForFunction(() => !document.querySelector("button.export").disabled);
    row.fault = { elapsedMs: Date.now() - started, error: await panel.getByRole("alert").innerText(),
      instrumentation: await panel.evaluate(() => globalThis.__restoreRecoveryFault()), observation: await panel.evaluate(() => globalThis.__endRecoveryObservation()) };
    check(row.fault.instrumentation.countCalls > 0 && row.fault.instrumentation.abortCalls > 0, "stalled native events count triggers read guard and storage abort attempt");
    check(row.fault.instrumentation.timers.some(t => t.original === 15000 && t.mapped === 150), "actual 15s read guard accelerated exclusively for fault");
    check(downloadCount === countBefore, "stalled read never starts a download");
    assert.deepEqual(await snapshot(), before, "failed export changes no sessions/events/assets/seal");
    await beginObservation(); const pendingDownload = panel.waitForEvent("download", { timeout: 90000 }), retryAt = Date.now();
    await panel.getByRole("button", { name: "导出记录包", exact: true }).click();
    const download = await pendingDownload; assert.equal(await download.failure(), null);
    const bytes = await fs.readFile(await download.path()); await fs.writeFile(path.join(runRoot, fixture.session.id + ".zip"), bytes);
    await panel.getByText(/^记录包已保存/).waitFor({ timeout: 15000 });
    row.retry = { elapsedMs: Date.now() - retryAt, observation: await panel.evaluate(() => globalThis.__endRecoveryObservation()), ...verifyZip(bytes, fixture) };
    const changes = row.retry.observation.changes;
    check(changes.some(c => /分段|字段|附件|校验/.test(c.text)) && new Set(changes.map(c => c.text)).size >= 3, "real Export UI shows changing work-stage/count/elapsed progress");
    check(row.retry.observation.heartbeat.ticks > 0 && row.retry.observation.heartbeat.maxGapMs < 1000, "100ms UI heartbeat max gap remains below fixed 1000ms bound");
    assert.deepEqual(await snapshot(), before, "successful retry changes no sessions/events/assets/seal");
    row.passed = true; console.log(JSON.stringify({ event: "scenario", sessionId: row.sessionId, faultMs: row.fault.elapsedMs, retryMs: row.retry.elapsedMs, heartbeat: row.retry.observation.heartbeat }));
  }
  check(downloadCount === 2, "exactly one real successful download per restored retry"); result.passed = true;
} catch (error) {
  result.firstFailure = String(error.stack || error); result.passed = false; process.exitCode = 1;
  if (panel) { result.panelAtFailure = await panel.locator("body").innerText().catch(() => "unavailable");
    result.faultAtFailure = await panel.evaluate(() => ({ fault: globalThis.__recoveryFault, trace: globalThis.__recoveryTrace })).catch(() => null); }
  console.error(result.firstFailure);
} finally {
  if (browser) { try { result.cleanup = await browser.close(); } catch (e) { result.cleanupError = String(e); process.exitCode = 1; } }
  result.profileCleanup = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  result.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  let history = []; try { history = JSON.parse(await fs.readFile(reportPath, "utf8")).runs || []; } catch {}
  await fs.mkdir(path.dirname(reportPath), { recursive: true });
  await fs.writeFile(reportPath, JSON.stringify({ schemaVersion: 1, runs: [...history, result] }, null, 2));
  console.log(JSON.stringify({ event: "complete", passed: result.passed, reportPath, runRoot, cleanup: result.cleanup, profileCleanup: result.profileCleanup }));
}
