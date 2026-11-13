// Exclusive stop diagnosis. Never reads the user's Chrome profile or changes production sources.
// Native Windows: CHROME_BIN='C:/Program Files/Google/Chrome/Application/chrome.exe' node tests/stop-export-regression.e2e.mjs
// STOP_CASES=small,large,multi-frame,multi-tab,busy-idb | STOP_MODE=regression (default) / observe
// observe is diagnosis ONLY, not a passing product gate. regression checks lifecycle/evidence independently.
import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { unzipSync, strFromU8 } from "fflate";

const cases = (process.env.STOP_CASES || "small,large,multi-frame,multi-tab,busy-idb").split(",");
const mode = process.env.STOP_MODE || "regression";
assert.ok(["observe", "regression"].includes(mode), "STOP_MODE must be observe or regression");
const dist = path.resolve(process.env.STOP_DIST || "dist");
const runRoot = await fs.mkdtemp(path.resolve("test-stop-export-"));
const baseline = path.join(runRoot, "extension");
await fs.cp(dist, baseline, { recursive: true });
const manifestPath = path.join(baseline, "manifest.json");
const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
// Same test-only pregrant as existing stop tests. This fresh profile only visits loopback pages.
manifest.host_permissions = ["http://*/*", "https://*/*"];
await fs.writeFile(manifestPath, JSON.stringify(manifest));
const result = { schema: 1, generatedAt: new Date().toISOString(), mode, runRoot, platform: process.platform,
  chromeBin: process.env.CHROME_BIN || "playwright-default", producerVersion: manifest.version,
  baselineBackgroundSha256: createHash("sha256").update(await fs.readFile(path.join(baseline, "background.js"))).digest("hex"),
  baselineContentSha256: createHash("sha256").update(await fs.readFile(path.join(baseline, "content.js"))).digest("hex"),
  scenarios: [] };
console.log(JSON.stringify({ event: "run", runRoot, baseline: result.baselineBackgroundSha256, cases }));

const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1");
  if (u.pathname === "/api") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ ok: true, synthetic: true })); return; }
  const rows = Math.max(0, Math.min(12000, Number(u.searchParams.get("rows")) || 0));
  const frameCount = Math.max(0, Math.min(16, Number(u.searchParams.get("frames")) || 0));
  const html = '<!doctype html><meta charset="utf-8"><title>Synthetic normal Stop</title><style>body{font:14px Arial;background:#fff;color:#123}main{display:grid;grid-template-columns:repeat(4,1fr)}article{padding:4px;border:1px solid #ddd}iframe{width:360px;height:180px}</style>' +
    '<h1>Synthetic stop fixture</h1><input id="value"><button id="action">Save synthetic</button><main>' +
    Array.from({ length: rows }, (_, i) => '<article data-row="' + i + '"><label>Item ' + i + '</label><span>synthetic-value-' + i + '</span><button>Open ' + i + '</button></article>').join("") + '</main>' +
    Array.from({ length: frameCount }, (_, i) => '<iframe src="/child?rows=25&frame=' + i + '"></iframe>').join("");
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); res.end(html);
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + server.address().port;

async function persistedSummary(panel, sessionId) {
  return panel.evaluate(async (id) => {
    const db = await new Promise((resolve, reject) => { const r = indexedDB.open("logic-recorder"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    try {
      const session = await new Promise((resolve, reject) => { const r = db.transaction("sessions").objectStore("sessions").get(id); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
      const summary = { session, eventCount: 0, eventChars: 0, kinds: {}, warnings: [], captures: [], database: [], snapshots: [], styleEnds: [], fragmentEnds: [], fragmentFailures: [], interactionValues: [], seq: [], assets: { count: 0, bytes: 0 } };
      await new Promise((resolve, reject) => {
        const tx = db.transaction("events"), r = tx.objectStore("events").index("session").openCursor(id);
        r.onsuccess = () => {
          const cursor = r.result; if (!cursor) return;
          const e = cursor.value, p = e.payload || {}; summary.eventCount++; summary.eventChars += JSON.stringify(e).length;
          summary.kinds[e.kind] = (summary.kinds[e.kind] || 0) + 1; summary.seq.push(e.seq);
          const base = { kind: e.kind, seq: e.seq, time: e.time, frameId: e.frameId, tabId: e.tabId };
          if (e.kind === "warning") summary.warnings.push({ ...base, payload: p });
          if (e.kind === "state.capture") summary.captures.push({ ...base, payload: p });
          if (["database.snapshot", "database.recordsEnd", "database.catalogEnd"].includes(e.kind)) summary.database.push({ ...base, payload: { ...p, database: p.database && { ...p.database, stores: p.database.stores?.map(s => ({ ...s, records: undefined })) } } });
          if (e.kind === "page.snapshot") summary.snapshots.push({ ...base, payload: { reason: p.reason, status: p.status, truncatedNodes: p.truncatedNodes, sourceStatus: p.sourceStatus, htmlLength: p.html?.length, htmlReference: p.htmlReference, snapshotId: p.snapshotId, styles: p.styles } });
          if (e.kind === "page.computedStyleEnd") summary.styleEnds.push({ ...base, payload: p });
          if (e.kind === "capture.fragmentEnd") summary.fragmentEnds.push({ ...base, payload: p });
          if (e.kind === "capture.fragmentFailure") summary.fragmentFailures.push({ ...base, payload: p });
          if (e.kind === "interaction.input") summary.interactionValues.push(p.value);
          cursor.continue();
        };
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction("assets"), r = tx.objectStore("assets").index("session").openCursor(id);
        r.onsuccess = () => { const c = r.result; if (!c) return; summary.assets.count++; summary.assets.bytes += c.value.blob?.size || 0; c.continue(); };
        tx.oncomplete = resolve; tx.onabort = tx.onerror = () => reject(tx.error);
      });
      summary.seq.sort((a, b) => a - b);
      summary.sequenceComplete = summary.seq.every((n, i) => n === i + 1); delete summary.seq;
      return summary;
    } finally { db.close(); }
  }, sessionId);
}
async function runScenario(name) {
  const row = { name, startedAt: new Date().toISOString(), injectedFailures: false, synthetic: true, trace: [], console: [] };
  result.scenarios.push(row);
  const profile = await fs.mkdtemp(path.join(runRoot, "profile-" + name + "-"));
  let browser, panel, worker;
  try {
    browser = await launchExtension(profile, baseline, ["--window-size=1000,760"]);
    const context = browser.context;
    panel = await context.newPage(); await panel.goto("chrome-extension://" + browser.id + "/sidepanel.html");
    worker = context.serviceWorkers().find(w => w.url().includes(browser.id)) || await context.waitForEvent("serviceworker", { timeout: 20000 });
    row.browser = await panel.evaluate(() => navigator.userAgent);
    worker.on("console", m => row.console.push({ type: m.type(), text: m.text().slice(0, 2000) }));
    panel.on("pageerror", e => row.console.push({ type: "panel-error", text: String(e) }));
    // Transparent timing observer, no delays, no altered responses, no fabricated failures.
    await worker.evaluate(() => {
      globalThis.__stopDiagnosisTrace = [];
      const original = chrome.tabs.sendMessage.bind(chrome.tabs);
      chrome.tabs.sendMessage = async (...args) => {
        const watched = ["FLUSH", "STOP_CAPTURE"].includes(args[1]?.type), t = Date.now();
        const entry = watched ? { type: args[1].type, tabId: args[0], frameId: args[2]?.frameId, start: t } : null;
        if (entry) globalThis.__stopDiagnosisTrace.push(entry);
        try { const reply = await original(...args); if (entry) Object.assign(entry, { ms: Date.now() - t, reply }); return reply; }
        catch (e) { if (entry) Object.assign(entry, { ms: Date.now() - t, error: String(e) }); throw e; }
      };
    });
    const pages = [];
    const count = name === "multi-tab" ? Number(process.env.STOP_TABS || 6) : 1;
    for (let i = 0; i < count; i++) {
      const p = await context.newPage(); pages.push(p);
      const rows = name === "large" ? Number(process.env.STOP_ROWS || 2500) : name === "multi-tab" ? 250 : 10;
      await p.goto(origin + "/?rows=" + rows + "&frames=" + (name === "multi-frame" ? 10 : 0) + "&tab=" + i, { timeout: 30000 });
      if (name === "multi-frame") await p.waitForFunction(() => document.querySelectorAll("iframe").length === 10);
    }
    const page = pages[0]; await page.bringToFront();
    row.fixture = { tabs: count, rows: name === "large" ? Number(process.env.STOP_ROWS || 2500) : name === "multi-tab" ? 250 : 10, frames: name === "multi-frame" ? 10 : 0 };
    if (name === "busy-idb") {
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open("synthetic-busy", 1); r.onupgradeneeded = () => r.result.createObjectStore("rows"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        await new Promise((resolve, reject) => { const tx = db.transaction("rows", "readwrite"); for (let i = 0; i < 30; i++) tx.objectStore("rows").put({ id: i, marker: "synthetic" }, i); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
        db.close();
      });
    }
    const startAt = Date.now();
    await panel.getByRole("button", { name: "开始录制", exact: true }).click();
    await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 65000 });
    row.startMs = Date.now() - startAt;
    const status = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATUS" }));
    assert.equal(status.ok, true); const id = status.value.active.id; row.sessionId = id;
    await page.locator("#value").fill("synthetic-normal-stop-" + name);
    await page.evaluate(() => fetch("/api?synthetic-normal-stop").then(r => r.json()));
    if (name === "multi-frame") await page.frameLocator("iframe").nth(0).locator("#value").fill("synthetic-frame-value");
    await page.waitForTimeout(Number(process.env.STOP_SETTLE_MS || 3000));
    row.beforeStop = (await persistedSummary(panel, id)).session;
    if (name === "busy-idb") {
      // Genuine page-owned readwrite transaction, not a patched API or simulated timeout.
      row.busyTransaction = await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => { const r = indexedDB.open("synthetic-busy"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
        const tx = db.transaction("rows", "readwrite"), store = tx.objectStore("rows"), until = performance.now() + 14000;
        window.__syntheticBusy = { until, operations: 0, completed: false, startedAt: Date.now() };
        const again = () => { window.__syntheticBusy.operations++; const r = store.put({ marker: "synthetic-busy" }, 999); r.onsuccess = () => { if (performance.now() < until) again(); }; }; again();
        tx.oncomplete = () => { window.__syntheticBusy.completed = true; db.close(); }; tx.onabort = () => { window.__syntheticBusy.aborted = true; db.close(); };
        return { startedAt: window.__syntheticBusy.startedAt, durationMs: 14000 };
      });
    }
    const stopAt = Date.now(); row.stopRequestedAt = stopAt;
    await panel.getByRole("button", { name: "停止录制", exact: true }).click();
    await panel.getByRole("button", { name: "开始录制", exact: true }).waitFor({ timeout: 110000 });
    row.stopMs = Date.now() - stopAt;
    row.trace = await worker.evaluate(() => globalThis.__stopDiagnosisTrace);
    row.afterStop = await persistedSummary(panel, id);
    row.stopState = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
    row.panelAfterStop = await panel.locator("body").innerText();
    assert.equal(row.afterStop.session.writeState, "sealed", "normal Stop must reach a sealed terminal row");
    assert.equal(row.stopState.value.active, null, "normal Stop must clear active");
    assert.ok(row.afterStop.interactionValues.includes("synthetic-normal-stop-" + name), "saved synthetic input must remain");
    assert.equal(row.afterStop.kinds["session.stop"], 1, "normal Stop must persist exactly one final stop event");
    const downloadPromise = panel.waitForEvent("download", { timeout: Number(process.env.STOP_EXPORT_TIMEOUT_MS || 40000) }).then(download => ({ download }), e => ({ error: String(e) }));
    const exportAt = Date.now();
    await panel.getByRole("button", { name: "导出记录包", exact: true }).click();
    const outcome = await downloadPromise; row.exportMs = Date.now() - exportAt;
    row.export = { status: outcome.error ? "timeout_or_error" : "download", error: outcome.error };
    row.panelAfterExport = await panel.locator("body").innerText();
    if (outcome.download) {
      const bytes = await fs.readFile(await outcome.download.path());
      const zip = unzipSync(bytes), archiveManifest = JSON.parse(strFromU8(zip["manifest.json"]));
      row.export.bytes = bytes.length; row.export.manifest = archiveManifest;
      row.export.eventCount = (archiveManifest.eventChunks || []).reduce((n, file) => n + strFromU8(zip[file]).split("\n").filter(Boolean).length, 0);
      await fs.writeFile(path.join(runRoot, name + ".zip"), bytes);
      assert.equal(row.export.eventCount, row.afterStop.eventCount, "export cannot drop persisted events");
    }
    row.observation = { status: row.afterStop.session.status, incomplete: !!row.afterStop.session.incomplete,
      storageError: !!row.afterStop.session.storageError, communicationUnknown: !!row.afterStop.session.communicationUnknown,
      captureIncomplete: !!row.afterStop.session.captureIncomplete, beforeStopIncomplete: !!row.beforeStop.incomplete,
      exportStatus: row.export.status };
    const session = row.afterStop.session;
    const hasCoverageGaps = Object.values(session.coverage || {}).some(value => typeof value === "number" && value > 0) || session.coverage?.status === "unavailable";
    const hasGaps = !!session.captureIncomplete || !!session.needsVerification || !!session.incomplete || hasCoverageGaps;
    row.expected = { status: "ready", communicationUnknown: false,
      stopOutcome: { requestedBy: "user", result: hasGaps ? "completed_with_gaps" : "completed" },
      sealRequired: true, preserveCoverage: true, exportRequired: true };
    if (mode === "regression") {
      assert.equal(session.storageError || false, false, "fixture must not silently mask recorder storage errors");
      assert.equal(session.collectorFailedEvents || 0, 0, "fixture must not discard a failed event transport outcome");
      assert.equal(session.unknownEvents || 0, 0, "fixture must not discard unknown event transport");
      assert.equal(session.communicationUnknown || false, false, "a known producer gap must not become transport unknown");
      assert.equal(session.status, "ready", "a completed, sealed user Stop must not be lifecycle interrupted solely for capture gaps");
      assert.equal(session.stopOutcome?.schemaVersion, 1, "persist versioned stop outcome");
      assert.deepEqual({ requestedBy: session.stopOutcome?.requestedBy, result: session.stopOutcome?.result }, row.expected.stopOutcome, "persist explicit user Stop outcome separately from raw capture gaps");
      assert.ok(typeof session.stopOutcome?.reason === "string" && session.stopOutcome.reason.length > 0, "persist explicit stop reason");
      assert.equal(row.export.status, "download", "stopped synthetic evidence must remain exportable");
      assert.equal(row.afterStop.sequenceComplete, true, "seal must preserve the entire admitted event sequence");
      if (session.captureIncomplete) assert.ok(hasCoverageGaps || session.needsVerification, "never hide producer gap evidence to pass lifecycle gate");
    }
    row.completed = true;
    console.log(JSON.stringify({ event: "scenario", name, stopMs: row.stopMs, observation: row.observation, warnings: row.afterStop.warnings, trace: row.trace }));
  } catch (e) {
    row.error = String(e.stack || e); process.exitCode = 1;
    console.error(JSON.stringify({ event: "scenario_error", name, error: row.error }));
    if (panel) row.panelAtError = await panel.locator("body").innerText().catch(() => "unavailable");
    if (worker) row.trace = await worker.evaluate(() => globalThis.__stopDiagnosisTrace).catch(() => []);
  } finally {
    if (browser) {
      try { row.cleanup = await browser.close(); }
      catch (e) { row.cleanupError = String(e); process.exitCode = 1; }
    }
    row.profileCleanup = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
    await fs.writeFile(path.join(runRoot, name + ".json"), JSON.stringify(row, null, 2));
    await fs.writeFile(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2));
  }
}
try { for (const name of cases) { assert.ok(["small", "large", "multi-frame", "multi-tab", "busy-idb"].includes(name)); await runScenario(name); } }
finally { await new Promise(resolve => server.close(resolve)); await fs.writeFile(path.join(runRoot, "result.json"), JSON.stringify(result, null, 2)); }
console.log(JSON.stringify({ event: "complete", result: path.join(runRoot, "result.json"), scenarios: result.scenarios.map(s => ({ name: s.name, observation: s.observation, error: s.error })) }));
