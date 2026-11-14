// Focused native v0.5.0 acceptance. Run from app only after BUILDREADY.
// Fresh owned profile and temporary localhost host pregrant are not a permission-prompt test.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";

const MiB = 1048576, sha = value => createHash("sha256").update(value).digest("hex");
const labels = ["容量倍率", "待处理队列倍率", "页面采样倍率"];
const settings = n => ({ schemaVersion: 1, budgetMultiplier: n, queueMultiplier: n, samplingMultiplier: n });
// The first high surrogate lands exactly on the262144-character transport boundary.
const before = "a".repeat(262143) + "💆汉字".repeat(90000) + "before";
const after = "b".repeat(262143) + "🧾预约".repeat(90000) + "after";
const prefix = '{"sample":"settings-3MiB","padding":"', suffix = '"}';
const responseBody = prefix + "x".repeat(3 * MiB - Buffer.byteLength(prefix + suffix)) + suffix;
const oracle = new Map(), state = batch => {
  if (!oracle.has(batch)) oracle.set(batch, { writes: 0, reads: 0, noteBytes: 0, noteSha256: null });
  return oracle.get(batch);
};
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1"), batch = url.searchParams.get("batch") || "0", s = state(batch);
  res.setHeader("Cache-Control", "no-store");
  if (url.pathname === "/body") { s.reads++; res.writeHead(200, { "Content-Type": "application/json;charset=utf-8", "Content-Length": Buffer.byteLength(responseBody) }); res.end(responseBody); return; }
  if (url.pathname === "/write") {
    const parts = []; for await (const part of req) parts.push(part);
    const note = JSON.parse(Buffer.concat(parts).toString("utf8")).note;
    s.writes++; s.noteBytes = Buffer.byteLength(note); s.noteSha256 = sha(note);
    res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ saved: true, writes: s.writes, noteBytes: s.noteBytes })); return;
  }
  const unrelated = url.pathname === "/unrelated", padding = !unrelated && batch === "2" ? "p".repeat(3 * MiB) : "";
  res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" });
  res.end('<!doctype html><meta charset="utf-8"><title>Settings synthetic ' + batch + '</title><style>body{font:16px Arial}textarea{width:500px;height:60px}#padding{display:none}</style><h1>' + (unrelated ? "UNRELATED_SETTINGS_SENTINEL" : "Synthetic settings business") + '</h1><label>Note<textarea wrap="off" id="note">small-before</textarea></label><button id="read">Read 3MiB sample</button><button id="write">Save note once</button><output id="result"></output><pre id="padding">' + padding + '</pre><script>const q=id=>document.getElementById(id);q("read").onclick=async()=>{const r=await fetch("/body?batch=' + batch + '");q("result").textContent="read:"+(await r.text()).length};q("write").onclick=async()=>{const r=await fetch("/write?batch=' + batch + '",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({note:q("note").value})});q("result").textContent="saved:"+(await r.json()).writes};</script>');
});
async function identity(dir) {
  const files = [];
  async function visit(at, relative = "") {
    for (const e of (await fs.readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.ok(!e.isSymbolicLink(), "candidate symlink"); const name = relative + e.name;
      if (e.isDirectory()) await visit(path.join(at, e.name), name + "/");
      else { const bytes = await fs.readFile(path.join(at, e.name)); files.push({ path: name, size: bytes.length, sha256: sha(bytes) }); }
    }
  }
  await visit(dir); return { sha256: sha(JSON.stringify(files)), files };
}
async function call(panel, type) {
  const reply = await panel.evaluate(type => chrome.runtime.sendMessage({ type }), type);
  assert.equal(reply.ok, true, type + ": " + reply.error); return reply.value;
}
async function openSettings(panel) {
  await panel.locator("summary").filter({ hasText: "录制限额设置" }).click();
  await panel.waitForFunction(() => !document.getElementById("limit-budgetMultiplier")?.disabled || [...document.querySelectorAll("[role=alert]")].some(e => e.textContent.includes("读取设置失败")));
}
async function fillSettings(panel, n) { for (const label of labels) await panel.getByLabel(label, { exact: true }).fill(String(n)); }
async function saveSettings(panel, n) {
  await fillSettings(panel, n); await panel.getByRole("button", { name: "保存到本机", exact: true }).click();
  await panel.getByText("已保存到本机；仅下一批生效。", { exact: true }).waitFor();
  assert.deepEqual((await call(panel, "GET_LIMIT_SETTINGS")).settings, settings(n));
}
async function waitEvent(panel, sessionId, spec) {
  await panel.waitForFunction(async ({ sessionId, spec }) => {
    const db = await new Promise((ok, no) => { const r = indexedDB.open("logic-recorder-flow-v1"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
    try {
      const events = await new Promise((ok, no) => { const r = db.transaction("events").objectStore("events").index("session").getAll(sessionId); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
      return events.some(e => e.kind === spec.kind && (!spec.selector || e.payload.target?.selector === spec.selector) && (!spec.path || e.payload.url?.includes(spec.path)) && (!spec.field || e.payload[spec.field]?.status === "captured"));
    } finally { db.close(); }
  }, { sessionId, spec }, { timeout: 20000 });
}
async function wireObserve(panel, tabId, read = false) {
  return panel.evaluate(async ({ tabId, read }) => (await chrome.scripting.executeScript({ target: { tabId }, world: "ISOLATED", args: [read], func: read => {
    if (read) return globalThis.__settingsWire;
    const s = globalThis.__settingsWire = { parts: 0, events: 0, maxPartJson: 0, maxEventsJson: 0, surrogateSplits: 0, fields: {} };
    const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    const wrapped = (...args) => { const m = args[0];
      if (m.type === "FLOW_CONTENT_PART") { s.parts++; s.fields[m.field] = (s.fields[m.field] || 0) + 1; s.maxPartJson = Math.max(s.maxPartJson, new TextEncoder().encode(JSON.stringify(m)).length); if (/[\uD800-\uDBFF]$/.test(m.text) || /^[\uDC00-\uDFFF]/.test(m.text)) s.surrogateSplits++; }
      if (m.type === "FLOW_EVENTS") { s.events++; s.maxEventsJson = Math.max(s.maxEventsJson, new TextEncoder().encode(JSON.stringify(m)).length); }
      return original(...args);
    }; chrome.runtime.sendMessage = wrapped; return { installed: chrome.runtime.sendMessage === wrapped };
  } }))[0].result, { tabId, read });
}
async function exportFiles(panel) {
  return panel.evaluate(async () => { const names = []; for await (const [name] of (await navigator.storage.getDirectory()).entries()) if (name.startsWith("logic-recorder-export-")) names.push(name); return names.sort(); });
}
const VERIFY = "import sys, json, zipfile, hashlib\nfrom pathlib import Path\ndef check(condition, message):\n    if not condition: raise AssertionError(message)\nexpected = json.loads(Path(sys.argv[2]).read_text(encoding=\"utf-8\"))\nwith zipfile.ZipFile(sys.argv[1]) as z:\n    check(z.testzip() is None, \"standard zipfile CRC failure\")\n    m = json.loads(z.read(\"manifest.json\"))\n    check(m[\"version\"] == 3 and m[\"profile\"] == \"business-flow-v1\" and m[\"derivations\"] == \"none\", \"v3 business profile\")\n    events = [json.loads(line) for chunk in m[\"eventChunks\"] for line in z.read(chunk).splitlines()]\n    contents = {c[\"contentId\"]: c for c in m[\"contents\"]}\n    def raw(ref):\n        check(isinstance(ref, dict) and ref.get(\"status\") == \"captured\", \"expected real captured reference\")\n        c = contents[ref[\"contentId\"]]; b = z.read(c[\"path\"])\n        check(len(b) == ref[\"size\"] == c[\"size\"] and hashlib.sha256(b).hexdigest() == ref[\"sha256\"] == c[\"sha256\"], \"raw bytes/size/hash mismatch\")\n        return b\n    def value_hash(v):\n        return hashlib.sha256(raw(v) if isinstance(v, dict) else v.encode(\"utf-8\")).hexdigest()\n    check(m[\"capturePolicy\"][\"settings\"] == expected[\"settings\"] == m[\"session\"][\"capturePolicy\"][\"settings\"] == m[\"budget\"][\"settings\"], \"settings snapshot\")\n    check(m[\"budget\"][\"limitBytes\"] == m[\"capturePolicy\"][\"limits\"][\"totalBytes\"] == expected[\"limitBytes\"], \"frozen budget\")\n    logical = sum(len(z.read(p)) for p in m[\"eventChunks\"]) + sum(c[\"size\"] for c in contents.values())\n    check(logical == m[\"budget\"][\"usedBytes\"] == m[\"session\"][\"budget\"][\"usedBytes\"] == m[\"byteAccounting\"][\"storedLogicalBytes\"], \"raw metadata + unique contents ledger\")\n    for c in contents.values():\n        b = z.read(c[\"path\"]); check(len(b) == c[\"size\"] and hashlib.sha256(b).hexdigest() == c[\"sha256\"], \"content integrity\")\n        check(b\"UNRELATED_SETTINGS_SENTINEL\" not in b, \"unrelated content mixed\")\n    check(m[\"session\"][\"scope\"][\"tabIds\"] == [expected[\"rootTabId\"]], \"root-only scope\")\n    check(all(e.get(\"tabId\", expected[\"rootTabId\"]) == expected[\"rootTabId\"] for e in events), \"unrelated tab event mixed\")\n    check(not any(e[\"kind\"].split(\".\")[0] in {\"database\", \"cache\", \"theme\", \"storage\", \"browser\"} for e in events), \"forbidden derived channel\")\n    check(all(p in {\"manifest.json\", \"integrity.json\"} or p.startswith((\"contents/\", \"timeline/\")) for p in z.namelist()), \"extra archive channel\")\n    responses = [e for e in events if e[\"kind\"] == \"network.response\" and \"/body?\" in e[\"payload\"].get(\"url\", \"\")]\n    check(len(responses) == 1, \"one body request per business batch\")\n    p = responses[0][\"payload\"]\n    if expected[\"multiplier\"] == 1:\n        check(p.get(\"bodyStatus\", {}).get(\"status\") == \"not_collected_policy\" and p[\"bodyStatus\"][\"reason\"] in {\"known_body_limit\", \"decoded_body_limit\"}, \"1x oversize must be policy skip\")\n        check(p.get(\"body\", {}).get(\"status\") != \"captured\", \"1x fake captured body\")\n    else:\n        check(hashlib.sha256(raw(p[\"body\"])).hexdigest() == expected[\"bodySha256\"] and p[\"body\"][\"size\"] == 3*1048576, \"20x original 3MiB body\")\n        matches = [e for e in events if e[\"kind\"] in {\"ui.input\", \"ui.change\"} and e[\"payload\"].get(\"target\", {}).get(\"selector\") == \"#note\" and value_hash(e[\"payload\"][\"value\"]) == expected[\"afterSha256\"]]\n        check(matches and any(value_hash(e[\"payload\"].get(\"beforeValue\", \"\")) == expected[\"beforeSha256\"] for e in matches), \"long Unicode before/after values\")\n        snapshots = [e for e in events if e[\"kind\"] == \"page.snapshot\" and e[\"payload\"].get(\"sourceHtml\", {}).get(\"status\") == \"captured\"]\n        check(any(3*1048576 <= e[\"payload\"][\"sourceHtml\"][\"size\"] < 4*1048576 for e in snapshots), \"bounded 3MiB snapshot at20\")\n        check(any(value_hash(e[\"payload\"][f[\"value\"][\"field\"]]) == expected[\"afterSha256\"] for e in snapshots for f in e[\"payload\"].get(\"forms\", []) if isinstance(f.get(\"value\"), dict) and \"field\" in f[\"value\"]), \"form value reference resolves original after bytes\")\n    check(events[-1][\"kind\"] == \"session.stop\" and sum(e[\"kind\"] == \"session.stop\" for e in events) == 1, \"unique final stop\")\n    print(json.dumps({\"events\": len(events), \"contents\": len(contents), \"logicalBytes\": logical, \"budgetLimitBytes\": m[\"budget\"][\"limitBytes\"], \"body\": p.get(\"bodyStatus\", {}).get(\"status\", p.get(\"body\", {}).get(\"status\")), \"standardZipfile\": True, \"settings\": m[\"capturePolicy\"][\"settings\"]}))\n";

assert.equal(process.platform, "win32", "native Windows required");
process.env.CHROME_BIN ||= "C:/Program Files/Google/Chrome/Application/chrome.exe";
const dist = path.resolve(process.env.FLOW_DIST || "dist"), runRoot = await fs.mkdtemp(path.resolve("test-flow-settings-"));
const profile = path.join(runRoot, "owned-profile"), extension = path.join(runRoot, "extension");
const reportPath = path.resolve(process.env.FLOW_SETTINGS_REPORT || "../docs/设置/2026-11-14-v0.5.0/settings-acceptance.json");
const indexScript = path.resolve(process.env.FLOW_SETTINGS_INDEX || "skills/extension-logic-clone/scripts/index_archive.py");
const report = { schema: 1, status: "running", generatedAt: new Date().toISOString(), runRoot, nativePermissionTest: false, syntheticOnly: true, profile: "fresh-owned", hostPregrant: "temporary dist-copy localhost only", rows: [], gates: [], limitations: ["1.25GiB full payload not exercised", ">64MiB real export is parent-owned separate acceptance", "optional-host permission prompt not exercised", "Stop settings loading/save I/O failure covered separately by UI source-VM owner"] };
let browser, panel;
try {
  report.candidate = await identity(dist); await fs.cp(dist, extension, { recursive: true }); await fs.mkdir(profile);
  const manifestPath = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, "0.5.0"); assert.ok(manifest.permissions.includes("unlimitedStorage"), "packaged unlimitedStorage permission");
  manifest.host_permissions = ["http://127.0.0.1/*"]; await fs.writeFile(manifestPath, JSON.stringify(manifest));
  report.loadedCandidate = await identity(extension);
  report.versions = { node: process.version, extension: manifest.version, package: JSON.parse(await fs.readFile("package.json", "utf8")).version, python: execFileSync(process.env.PYTHON_BIN || "python", ["--version"], { encoding: "utf8" }).trim() };
  report.test = { path: "tests/flow-settings.e2e.mjs", sha256: sha(await fs.readFile(new URL(import.meta.url))) };
  report.indexScript = { path: indexScript, sha256: sha(await fs.readFile(indexScript)) };
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); const origin = "http://127.0.0.1:" + server.address().port;
  browser = await launchExtension(profile, extension, ["--window-size=1100,820"]); const { context } = browser; context.setDefaultTimeout(20000);
  const openPanel = async () => { const p = await context.newPage(); await p.goto("chrome-extension://" + browser.id + "/sidepanel.html"); return p; };
  panel = await openPanel(); await call(panel, "GET_STATE"); await openSettings(panel);
  await panel.evaluate(() => {
    globalThis.__settingsSaves = 0; const original = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (...args) => { if (args[0]?.type === "SAVE_LIMIT_SETTINGS") globalThis.__settingsSaves++; return original(...args); };
  });
  report.versions.userAgent = await panel.evaluate(() => navigator.userAgent);
  for (const label of labels) assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), "20");
  assert.match((await panel.getByRole("definition").allTextContents()).join(" "), /1.25 GiB/);
  assert.deepEqual((await call(panel, "GET_LIMIT_SETTINGS")).settings, settings(20));
  const savesBefore = await panel.evaluate(() => globalThis.__settingsSaves);
  for (const label of labels) for (const invalid of ["21", "1.5", ""]) {
    const input = panel.getByLabel(label, { exact: true }); await input.fill(invalid);
    assert.equal(await input.getAttribute("aria-invalid"), "true", label + " invalid " + invalid);
    assert.equal(await panel.getByRole("button", { name: "保存到本机", exact: true }).isDisabled(), true);
    assert.match(await panel.locator("#" + await input.getAttribute("id") + "-error").innerText(), /1–20/);
    await input.press("Enter"); assert.deepEqual((await call(panel, "GET_LIMIT_SETTINGS")).settings, settings(20)); await input.fill("20");
  }
  assert.equal(await panel.evaluate(() => globalThis.__settingsSaves), savesBefore, "invalid UI emitted SAVE");
  report.gates.push("default three20 and1.25GiB preview;21/fraction/empty inline errors with no SAVE");
  await saveSettings(panel, 1); await panel.close(); panel = await openPanel(); await openSettings(panel);
  for (const label of labels) assert.equal(await panel.getByLabel(label, { exact: true }).inputValue(), "1");
  report.gates.push("UI saves1 and new panel reloads persisted1");
  const unrelatedPages = [];
  for (let n = 0; n < 3; n++) { const p = await context.newPage(); await p.goto(origin + "/unrelated?existing=" + n); unrelatedPages.push(p); }
  let firstSession;
  for (const multiplier of [1, 20]) {
    const batch = multiplier === 1 ? "1" : "2", row = { multiplier, status: "running" }; report.rows.push(row);
    const page = await context.newPage(); await page.goto(origin + "/root?batch=" + batch);
    if (multiplier === 20) await page.locator("#note").evaluate((e, value) => { e.value = value; }, before);
    await page.bringToFront(); const target = await panel.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0]);
    assert.equal(target.url, page.url()); row.rootTabId = target.id;
    assert.equal((await wireObserve(panel, target.id)).installed, true);
    await panel.getByRole("button", { name: "开始录制", exact: true }).click(); await panel.getByText("录制中", { exact: true }).waitFor();
    const active = (await call(panel, "GET_STATUS")).active; row.sessionId = active.id;
    assert.deepEqual(active.capturePolicy.settings, settings(multiplier)); assert.equal(active.budget.limitBytes, 64 * MiB * multiplier);
    await waitEvent(panel, active.id, { kind: "page.snapshot", field: "sourceHtml" });
    if (multiplier === 1) {
      const extra = context.waitForEvent("page"); await panel.evaluate(url => chrome.tabs.create({ url, active: false }), origin + "/unrelated?new-no-opener=1");
      const p = await extra; await p.waitForLoadState("load"); assert.equal(await p.opener(), null); unrelatedPages.push(p); await page.bringToFront();
    }
    if (multiplier === 1) await page.locator("#note").fill("batch-one-note");
    else {
      await page.locator("#note").evaluate((e, value) => { e.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText" })); e.value = value; e.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" })); e.dispatchEvent(new Event("change", { bubbles: true })); }, after);
      row.longInput = "synthetic DOM beforeinput/value/input/change;not trusted typing";
    }
    await page.locator("#write").click();
    await page.locator("#result").filter({ hasText: "saved:1" }).waitFor();
    await page.locator("#read").click(); await page.locator("#result").filter({ hasText: "read:" }).waitFor();
    await waitEvent(panel, active.id, { kind: "network.response", path: "/body?" });
    await waitEvent(panel, active.id, { kind: "ui.change", selector: "#note" });
    if (multiplier === 20) await waitEvent(panel, active.id, { kind: "page.snapshot", field: "formValue0" });
    if (multiplier === 1) {
      await saveSettings(panel, 20); const frozen = (await call(panel, "GET_STATUS")).active;
      assert.equal(frozen.id, active.id); assert.deepEqual(frozen.capturePolicy, active.capturePolicy); assert.equal(frozen.budget.limitBytes, 64 * MiB);
      report.gates.push("save20 during1x recording keeps active1x/64MiB snapshot");
    } else {
      await panel.evaluate(() => chrome.storage.local.set({ businessFlowLimitSettingsV1: { schemaVersion: 999 } }));
      await panel.close(); panel = await openPanel(); await openSettings(panel);
      await panel.getByRole("alert").filter({ hasText: "读取设置失败" }).waitFor();
      assert.equal(await panel.getByRole("button", { name: "停止录制", exact: true }).isEnabled(), true, "read-error settings disabled Stop");
      await panel.evaluate(value => chrome.storage.local.set({ businessFlowLimitSettingsV1: value }), settings(20));
      await panel.getByRole("button", { name: "重新读取设置", exact: true }).click();
      await panel.getByLabel(labels[0], { exact: true }).waitFor({ state: "visible" });
      await panel.waitForFunction(() => !document.getElementById("limit-budgetMultiplier").disabled);
      report.gates.push("owned-profile invalid stored schema shows real GET error while Stop remains enabled;restored20");
    }
    await panel.getByLabel(labels[1], { exact: true }).fill("19");
    assert.equal(await panel.getByRole("button", { name: "停止录制", exact: true }).isEnabled(), true, "dirty settings disabled Stop");
    let begin = Date.now(); await panel.getByRole("button", { name: "停止录制", exact: true }).click(); await panel.getByRole("button", { name: "开始录制", exact: true }).waitFor(); row.stopMs = Date.now() - begin;
    await fillSettings(panel, 20); const stopped = await call(panel, "GET_STATE"); assert.equal(stopped.active, null);
    const sealed = stopped.sessions.find(s => s.id === active.id); assert.equal(sealed.status, "ready"); row.seal = sealed.seal;
    if (multiplier === 1) firstSession = structuredClone(sealed);
    else assert.deepEqual(stopped.sessions.find(s => s.id === firstSession.id), firstSession, "next20 batch rewrote old1 batch");
    await panel.getByRole("radio", { name: new RegExp(active.id.slice(0, 8)) }).check(); row.opfsBefore = await exportFiles(panel); assert.deepEqual(row.opfsBefore, []);
    const downloadPromise = panel.waitForEvent("download", { timeout: 60000 }); begin = Date.now();
    await panel.getByRole("button", { name: "导出记录包", exact: true }).click(); const download = await downloadPromise;
    const archive = path.join(runRoot, "batch-" + multiplier + ".zip"); await download.saveAs(archive); assert.equal(await download.failure(), null);
    await panel.getByRole("button", { name: "导出记录包", exact: true }).waitFor(); row.exportMs = Date.now() - begin;
    row.opfsAfter = await exportFiles(panel); assert.deepEqual(row.opfsAfter, [], "successful download retained active OPFS export");
    row.oracle = structuredClone(state(batch)); assert.equal(row.oracle.writes, 1); assert.equal(row.oracle.reads, 1);
    assert.equal(row.oracle.noteSha256, sha(multiplier === 1 ? "batch-one-note" : after));
    const expected = { multiplier, settings: settings(multiplier), limitBytes: 64 * MiB * multiplier, rootTabId: target.id, bodySha256: sha(responseBody), beforeSha256: sha(before), afterSha256: sha(after) };
    const expectedPath = path.join(runRoot, "expected-" + multiplier + ".json"); await fs.writeFile(expectedPath, JSON.stringify(expected));
    const options = { encoding: "utf8", timeout: 60000, env: { ...process.env, PYTHONUTF8: "1" } };
    row.zipVerification = JSON.parse(execFileSync(process.env.PYTHON_BIN || "python", ["-c", VERIFY, archive, expectedPath], options));
    row.pythonIndex = JSON.parse(execFileSync(process.env.PYTHON_BIN || "python", [indexScript, archive, "--output", path.join(runRoot, "batch-" + multiplier + ".sqlite3")], options));
    assert.equal(row.pythonIndex.events, row.zipVerification.events); row.archive = { path: archive, bytes: (await fs.stat(archive)).size, sha256: sha(await fs.readFile(archive)) };
    row.wire = await wireObserve(panel, target.id, true); row.status = "pass"; console.log(JSON.stringify({ event: "batch-pass", multiplier, ...row.zipVerification, wire: row.wire })); await page.close();
  }
  const second = report.rows[1]; assert.equal(second.zipVerification.budgetLimitBytes, 1280 * MiB);
  report.wire = report.rows[1].wire;
  assert.ok(report.wire.parts > 4 && report.wire.fields.value > 1 && report.wire.fields.beforeValue > 1, "long values bypassed part transport");
  assert.ok(report.wire.maxPartJson <= MiB && report.wire.maxEventsJson < MiB, "giant JSON content transport"); assert.equal(report.wire.surrogateSplits, 0);
  report.gates.push("two native business batches;1x body policy skip;20x exact3MiB body;longUnicode before/after+forms+3MiB DOM;small parts", "root-only with3existing+1new unrelated pages", "UI ZIP downloads;standard zipfile+skill index;ledger and settings snapshot;OPFS cleanup");
  await panel.setViewportSize({ width: 320, height: 820 });
  const preview = panel.locator('[aria-label="限额预览"]'); await preview.waitFor();
  assert.match(await preview.innerText(), /1.25 GiB/);
  const layout = await panel.evaluate(() => ({ viewport: innerWidth, width: document.documentElement.scrollWidth }));
  assert.ok(layout.width <= layout.viewport, "320px panel has horizontal overflow");
  const screenshot = path.resolve("../docs/media/v0.5.0-01-settings.png"); await fs.mkdir(path.dirname(screenshot), { recursive: true });
  await panel.screenshot({ path: screenshot, fullPage: true }); report.screenshot = { path: screenshot, sha256: sha(await fs.readFile(screenshot)), layout, actualExtensionPage: true, fullPage: true };
  report.gates.push("actual extension page at320px has no horizontal overflow;full-page settings screenshot");
  assert.deepEqual(await identity(dist), report.candidate, "dist changed during native run"); report.status = "pass";
} catch (error) {
  const boundedError = value => typeof value === "string" && value.length > 4000 ? value.slice(0, 1200) + " [omitted synthetic payload] " + value.slice(-1800) : value;
  report.status = "fail"; report.firstFailure = { message: boundedError(error.message), expected: error.expected, actual: error.actual, stack: boundedError(error.stack) };
  if (report.rows.at(-1)?.status === "running") report.rows.at(-1).status = "fail";
  if (panel && !panel.isClosed()) report.panelTextAtFailure = await panel.locator("body").innerText().catch(() => "unreadable");
  console.error(JSON.stringify({ event: "FIRST_FAILURE", ...report.firstFailure })); process.exitCode = 1;
} finally {
  try { if (browser) { await browser.close(); report.cleanup = "owned-browser-closed"; } } catch (error) { report.cleanup = "unconfirmed"; report.cleanupError = String(error); report.status = "fail"; process.exitCode = 1; }
  const gone = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  report.profileCleanup = gone.status; if (gone.status === "preserved") { report.status = "fail"; process.exitCode = 1; }
  if (report.cleanup === "owned-browser-closed") await fs.rm(extension, { recursive: true, force: true });
  await new Promise(resolve => server.listening ? server.close(resolve) : resolve()); report.finishedAt = new Date().toISOString();
  await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  const md = ["# v0.5.0 设置 focused native 验收", "", "状态：**" + report.status.toUpperCase() + "**。实际执行后生成；不替代父级发布门。", "", "候选 dist SHA256：" + (report.candidate?.sha256 || "unavailable") + "。完整文件身份、版本、首失败和统计见 [JSON](<settings-acceptance.json>)。", "", "原生 Windows Chrome，独立己有临时 profile、合成 localhost 页面。仅临时扩展副本预授 localhost hosts；不是原生可选权限弹窗验证。", "", ...report.gates.map(g => "- " + g), "", "| 倍率 | 状态 | 实存字节 | 预算字节 | ZIP字节 | Stop毫秒 | 导出毫秒 |", "| --- | --- | --- | --- | --- | --- | --- |", ...report.rows.map(r => "| " + [r.multiplier, r.status, r.zipVerification?.logicalBytes ?? "未完成", r.zipVerification?.budgetLimitBytes ?? "未完成", r.archive?.bytes ?? "未完成", r.stopMs ?? "未完成", r.exportMs ?? "未完成"].join(" | ") + " |"), "", "局限：" + report.limitations.join("；") + "。最大设置1280MiB=1.25GiB（约1.2GB）仅验证实际配置与较小录制；未宣称实际录满1.25GiB。", "", "清理：" + report.cleanup + "; profile=" + report.profileCleanup + "。录制ZIP和SQLite仅保留在临时测试目录，不提交。", ...(report.firstFailure ? ["", "首失败：" + report.firstFailure.message] : []), ""].join("\n");
  await fs.writeFile(reportPath.replace(/\.json$/, ".md"), md); console.log(JSON.stringify({ event: "report", status: report.status, reportPath }));
}
