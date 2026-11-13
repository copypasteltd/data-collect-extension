import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
import { captureValidationIdentity } from "./validation-identity.mjs";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { unzipSync, strFromU8 } from "fflate";

// Native host test, NOT an OS sandbox, native host-permission prompt test or real ERP certification.
// No build, no production changes, no runtime-made capture events. Run after the parent builds dist.
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromeBinary = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const reportRoot = path.resolve(appRoot, "../docs/交付/2026-11-13/native-release");
const runFile = promisify(execFile);
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const before = { id: "SYN-001", name: "合成会员", contact: "13800001111", note: "原始备注🌿", balanceCents: 100000 };
const changed = { contact: "13900002222", note: "更新备注💆‍♀️✨ / 原值保留" };
const oracle = { member: structuredClone(before), writes: 0, writeAttempts: 0, ledger: [], errors: [] };
const report = { schemaVersion: 1, status: "running", startedAt: new Date().toISOString(), workflow: "synthetic-member-update-and-debit",
  environment: { platform: process.platform, arch: process.arch, nodeVersion: process.version, chromeBinary,
    mode: "native Windows host; headless=new; independent test-* profile prevents interference only; NOT OS sandbox",
    scope: "one local HTTP synthetic workflow; extension sidepanel opened as an extension tab",
    permissionTest: "NOT native permission test: only the temporary dist copy pre-grants http/https hosts for sidepanel START",
    noGuarantee: "Not every real ERP/site/frame/permission/encoding/timeout case. ZIP SHA-256 is consistency, not a digital signature or trusted-origin attestation." },
  checkpoints: [], assertions: [], cleanup: {}, evidence: {}, diagnostics: {} };
const fixture = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="icon" href="data:,"><title>合成ERP原生验收</title>' +
  '<style>body{font:18px system-ui;margin:32px;background:#f3f7f5;color:#17392c}main{max-width:800px;background:white;padding:28px;border:1px solid #adc6ba;border-radius:12px}label{display:block;margin:14px 0}input,textarea,button{font:inherit;padding:8px}textarea{width:90%;height:65px}button{margin:8px;background:#d1e8df;border:1px solid #689482}output{font-weight:700}pre{white-space:pre-wrap}</style>' +
  '<main><h1>合成会员工作流</h1><p>仅本地模拟数据，不连接真实ERP</p><label>会员号 <input id="memberQuery" value="SYN-001"></label><button id="query">查询会员</button>' +
  '<section id="member" hidden><h2 id="name"></h2><label>联系方式 <input id="contact"></label><label>备注 <textarea id="note"></textarea></label><button id="save">保存资料</button>' +
  '<p>余额（分） <output id="balance"></output></p><label>服务扣款（分） <input id="amount" type="number" min="1" step="1" value="12800"></label><button id="debit">提交服务扣款</button><button id="refresh">复查会员</button><p id="status" role="status">待查询</p><pre id="receipt"></pre></section></main>' +
  '<script>const $=id=>document.getElementById(id);let member;function render(data,stage){member=data;$("member").hidden=false;$("name").textContent=data.name+" / "+data.id;$("contact").value=data.contact;$("note").value=data.note;$("balance").textContent=String(data.balanceCents);document.body.dataset.stage=stage;}async function api(url,options){const r=await fetch(url,options);const body=await r.json();$("receipt").textContent=JSON.stringify({status:r.status,body});return {r,body};}$("query").onclick=async()=>{const {r,body}=await api("/api/members/"+encodeURIComponent($("memberQuery").value));render(body.member,"queried");$("status").textContent="查询完成 "+r.status;};$("save").onclick=async()=>{const {r,body}=await api("/api/members/"+member.id,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({contact:$("contact").value,note:$("note").value})});render(body.member,"saved");$("status").textContent="资料保存 "+r.status;};$("debit").onclick=async()=>{const {r,body}=await api("/api/members/"+member.id+"/debits",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({serviceId:"SYN-FACIAL",amountCents:Number($("amount").value)})});render(body.member,r.status===201?"debited":"rejected");$("status").textContent=r.status===201?"扣款成功 201":"余额不足 409";};$("refresh").onclick=async()=>{const {r,body}=await api("/api/members/"+member.id);render(body.member,"rechecked");$("status").textContent="复查完成 "+r.status;};</script></html>';

const server = http.createServer(async (request, response) => {
  const startedAt = Date.now(), chunks = [];
  try {
    for await (const chunk of request) chunks.push(chunk);
    const bodyText = Buffer.concat(chunks).toString("utf8"), url = new URL(request.url, "http://localhost");
    if (url.pathname === "/") { response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }); response.end(fixture); return; }
    if (!url.pathname.startsWith("/api/")) { response.writeHead(404); response.end(); return; }
    const old = structuredClone(oracle.member), method = request.method;
    if (["PUT", "POST"].includes(method)) oracle.writeAttempts++;
    let status = 404, result = { error: "unexpected endpoint", member: structuredClone(oracle.member) };
    if (url.pathname === "/api/members/SYN-001" && method === "GET") { status = 200; result = { member: structuredClone(oracle.member) }; }
    if (url.pathname === "/api/members/SYN-001" && method === "PUT") {
      const data = JSON.parse(bodyText);
      assert.deepEqual(data, changed, "oracle PUT exact original values");
      Object.assign(oracle.member, data); oracle.writes++; status = 200;
      result = { member: structuredClone(oracle.member), saved: true };
    }
    if (url.pathname === "/api/members/SYN-001/debits" && method === "POST") {
      const data = JSON.parse(bodyText);
      assert.equal(data.serviceId, "SYN-FACIAL"); assert.ok(Number.isSafeInteger(data.amountCents) && data.amountCents > 0);
      if (data.amountCents > oracle.member.balanceCents) { status = 409; result = { error: "insufficient_balance", member: structuredClone(oracle.member) }; }
      else { oracle.member.balanceCents -= data.amountCents; oracle.writes++; status = 201; result = { debitId: "SYN-D-001", amountCents: data.amountCents, member: structuredClone(oracle.member) }; }
    }
    const responseText = JSON.stringify(result);
    oracle.ledger.push({ ordinal: oracle.ledger.length + 1, method, path: url.pathname, requestText: bodyText, status, responseText,
      before: old, after: structuredClone(oracle.member), startedAt, respondedAt: Date.now() });
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }); response.end(responseText);
  } catch (error) { oracle.errors.push(String(error.stack || error)); response.writeHead(500); response.end(JSON.stringify({ error: "oracle_failed" })); }
});
let browser, context, page, panel, profile, extension, evidenceDir, bound = false, failure;
async function saveJson(name, value) { await fs.writeFile(path.join(evidenceDir, name), JSON.stringify(value, null, 2)); }
async function checkpoint(name) {
  const value = await page.evaluate(() => ({ at: Date.now(), stage: document.body.dataset.stage,
    contact: document.querySelector("#contact").value, note: document.querySelector("#note").value,
    balanceCents: Number(document.querySelector("#balance").textContent), amount: document.querySelector("#amount").value,
    status: document.querySelector("#status").textContent, receipt: document.querySelector("#receipt").textContent,
    sourceHtml: document.documentElement.outerHTML }));
  await saveJson("dom-" + name + ".json", value);
  await page.screenshot({ path: path.join(evidenceDir, "browser-" + name + ".png") });
  report.checkpoints.push({ name, at: value.at, stage: value.stage, contact: value.contact, note: value.note, balanceCents: value.balanceCents,
    dom: "dom-" + name + ".json", screenshot: "browser-" + name + ".png" });
  return value;
}
async function state() {
  const result = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" }));
  assert.equal(result.ok, true); return result.value;
}
// Read-only bounded DB polling; wait for real collector output, never manufacture events.
async function waitSnapshot(stage) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const present = await panel.evaluate(async (stage) => {
      const db = await new Promise((resolve, reject) => { const req = indexedDB.open("logic-recorder"); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      try {
        const rows = await new Promise((resolve, reject) => { const req = db.transaction("events").objectStore("events").getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
        return rows.some((event) => event.kind === "page.snapshot" && event.payload.sourceHtml?.includes('data-stage="' + stage + '"'));
      } finally { db.close(); }
    }, stage);
    if (present) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail("real collector snapshot not observed within 15s: " + stage);
}
async function userRequest(selector, method, suffix, status, stage) {
  const pending = page.waitForResponse((response) => response.url().endsWith(suffix) && response.request().method() === method);
  await page.locator(selector).click();
  const response = await pending;
  assert.equal(response.status(), status); await response.finished();
  await page.locator('body[data-stage="' + stage + '"]').waitFor();
  await waitSnapshot(stage);
}
async function replaceWithTrustedInput(selector, text) {
  await page.locator(selector).click(); await page.keyboard.press("Control+A"); await page.keyboard.insertText(text);
  assert.equal(await page.locator(selector).inputValue(), text);
}
function png(bytes) {
  return bytes?.length > 32 && Buffer.from(bytes.subarray(0, 8)).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    Buffer.from(bytes).readUInt32BE(16) > 0 && Buffer.from(bytes).readUInt32BE(20) > 0;
}
try {
  console.log("ERP native release test: start; no OS sandbox; no native permission prompt coverage");
  await fs.access(chromeBinary); process.env.CHROME_BIN = chromeBinary;
  evidenceDir = await fs.mkdtemp(path.join(appRoot, "test-native-erp-evidence-"));
  profile = await fs.mkdtemp(path.join(appRoot, "test-native-erp-profile-"));
  extension = await fs.mkdtemp(path.join(appRoot, "test-native-erp-testextension-"));
  report.evidence.directory = evidenceDir;
  await fs.cp(path.join(appRoot, "dist"), extension, { recursive: true });
  const manifestPath = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const packageVersion = JSON.parse(await fs.readFile(path.join(appRoot, "package.json"), "utf8")).version;
  assert.equal(manifest.version, packageVersion, "built dist must match the current release package version");
  report.environment.extensionVersion = manifest.version;
  report.evidence.originalDistManifestSha256 = hash(await fs.readFile(manifestPath));
  manifest.host_permissions = ["http://*/*", "https://*/*"]; // Test copy only: bypass prompt, NOT native permission test.
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  report.evidence.testCopyManifestSha256 = hash(await fs.readFile(manifestPath));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); bound = true;
  const origin = "http://127.0.0.1:" + server.address().port;
  report.environment.localOrigin = origin;
  browser = await launchExtension(profile, extension, ["--window-size=1100,850"]); context = browser.context;
  context.setDefaultTimeout(15000);
  const blocked = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    if (/^https?:/.test(url) && new URL(url).origin !== origin) { blocked.push(url); return route.abort(); }
    return route.continue();
  });
  report.environment.chromeVersion = context.browser().version();
  report.identity = await captureValidationIdentity({ appRoot, host: { nodeVersion: process.version, platform: process.platform, arch: process.arch,
    chromeBinaryPath: chromeBinary, chromeVersion: report.environment.chromeVersion, chromeBinarySha256: hash(await fs.readFile(chromeBinary)) } });
  await saveJson("validation-identity.json", report.identity);
  page = await context.newPage(); await page.goto(origin + "/");
  panel = await context.newPage(); await panel.goto("chrome-extension://" + browser.id + "/sidepanel.html");
  await page.bringToFront();
  assert.equal(await panel.getByRole("button", { name: "导出记录包" }).isDisabled(), true);
  await panel.getByRole("button", { name: "开始录制" }).click();
  await panel.getByText("录制中", { exact: true }).waitFor({ timeout: 30000 });
  console.log("ERP: sidepanel recording started; Chrome " + report.environment.chromeVersion);
  await userRequest("#query", "GET", "/api/members/SYN-001", 200, "queried");
  const initial = await checkpoint("before-edit");
  assert.equal(initial.contact, before.contact); assert.equal(initial.note, before.note); assert.equal(initial.balanceCents, 100000);
  await replaceWithTrustedInput("#contact", changed.contact); await replaceWithTrustedInput("#note", changed.note);
  const edited = await checkpoint("before-save");
  assert.equal(edited.contact, changed.contact); assert.equal(edited.note, changed.note); assert.equal(oracle.writes, 0);
  await userRequest("#save", "PUT", "/api/members/SYN-001", 200, "saved");
  const saved = await checkpoint("after-save");
  assert.equal(saved.contact, changed.contact); assert.equal(saved.note, changed.note); assert.equal(saved.balanceCents, 100000); assert.equal(oracle.writes, 1);
  await userRequest("#debit", "POST", "/api/members/SYN-001/debits", 201, "debited");
  assert.equal((await checkpoint("after-debit")).balanceCents, 87200);
  await replaceWithTrustedInput("#amount", "999999");
  await userRequest("#debit", "POST", "/api/members/SYN-001/debits", 409, "rejected");
  assert.equal((await checkpoint("after-rejection")).balanceCents, 87200);
  await userRequest("#refresh", "GET", "/api/members/SYN-001", 200, "rechecked");
  const final = await checkpoint("rechecked");
  assert.equal(final.contact, changed.contact); assert.equal(final.note, changed.note); assert.equal(final.balanceCents, 87200);
  assert.equal(oracle.writes, 2, "recorder must not issue extra business writes");
  assert.equal(oracle.writeAttempts, 3, "one PUT plus two user POST attempts only");
  assert.equal(oracle.errors.length, 0);
  assert.deepEqual(oracle.ledger.map((item) => [item.method, item.status]), [["GET",200],["PUT",200],["POST",201],["POST",409],["GET",200]]);
  assert.deepEqual(oracle.ledger[3].before, oracle.ledger[3].after, "409 cannot alter balance/member");
  report.oracle = structuredClone(oracle); await saveJson("oracle.json", oracle);
  console.log("ERP: oracle passed; successful writes=2, attempts=3; balance=87200");
  const stopAt = Date.now();
  await panel.getByRole("button", { name: "停止录制" }).click();
  await panel.getByRole("button", { name: "开始录制" }).waitFor({ timeout: 90000 }); // Existing UI STOP budget, not increased.
  report.stopElapsedMs = Date.now() - stopAt;
  await panel.getByRole("radio").first().waitFor();
  const stopped = await state(); assert.equal(stopped.active, null); assert.equal(stopped.sessions.length, 1);
  const session = stopped.sessions[0]; report.session = session;
  await saveJson("session-before-export.json", session);
  assert.equal(session.status, "ready"); assert.equal(session.writeState, "sealed"); assert.ok(session.seal);
  assert.equal(session.options.scope, "browser"); assert.equal(session.options.screenshots, true);
  const downloadPending = panel.waitForEvent("download", { timeout: 30000 });
  await panel.getByRole("button", { name: "导出记录包" }).click();
  const download = await downloadPending, zipPath = path.join(evidenceDir, "erp-workflow.zip");
  assert.match(download.url(), /^blob:chrome-extension:/, "download must be an actual extension Blob");
  await download.saveAs(zipPath); assert.equal(await download.failure(), null);
  report.evidence.download = { url: download.url(), suggestedFilename: download.suggestedFilename(), file: zipPath };
  const zipBytes = await fs.readFile(zipPath), files = unzipSync(zipBytes);
  report.evidence.zipSha256 = hash(zipBytes);
  const archive = JSON.parse(strFromU8(files["manifest.json"]));
  const evidence = new Map(), events = [];
  for (const chunk of archive.eventChunks) strFromU8(files[chunk]).split("\n").filter(Boolean).forEach((raw, index) => {
    const event = JSON.parse(raw); events.push(event); evidence.set(event.id, { path: chunk, line: index + 1 });
  });
  const ref = (event) => ({ eventId: event.id, kind: event.kind, seq: event.seq, time: event.time, tabId: event.tabId ?? null,
    frameId: event.frameId ?? null, documentId: event.documentId ?? null, evidence: evidence.get(event.id) });
  // First assert raw key evidence. Index/derived/reconstructed DOM must not substitute for business assertions.
  const inputEvidence = [];
  for (const [selector, old, next] of [["#contact", before.contact, changed.contact], ["#note", before.note, changed.note]]) {
    const event = events.find((event) => event.kind === "interaction.input" && event.payload.target?.selector === selector && event.payload.value === next);
    assert.ok(event, "raw input original missing: " + selector); assert.equal(event.payload.beforeValue, old);
    // Input schema has no trusted field; beforeValue requires a trusted beforeinput/input pair.
    assert.equal(event.payload.valueStatus, "captured"); assert.equal(event.payload.beforeValueStatus, "captured");
    inputEvidence.push({ selector, beforeValue: old, value: next, ...ref(event) });
  }
  const clicks = events.filter((event) => event.kind === "interaction.click" && ["#query", "#save", "#debit", "#refresh"].includes(event.payload.target?.selector));
  assert.deepEqual(clicks.map((event) => event.payload.target.selector), ["#query", "#save", "#debit", "#debit", "#refresh"]);
  for (const event of clicks) assert.equal(event.payload.trusted, true);
  const snapshots = events.filter((event) => event.kind === "page.snapshot" && event.payload.url === origin + "/");
  const domEvidence = [];
  for (const stage of ["queried", "saved", "debited", "rejected", "rechecked"]) {
    const snapshot = snapshots.find((event) => event.payload.sourceHtml?.includes('data-stage="' + stage + '"'));
    assert.ok(snapshot, "raw DOM snapshot missing: " + stage); assert.equal(snapshot.payload.sourceStatus, "captured");
    assert.ok(snapshot.payload.sourceHtml.includes('id="balance">' + (["queried", "saved"].includes(stage) ? "100000" : "87200") + "</output>"));
    domEvidence.push({ stage, ...ref(snapshot) });
  }
  const requests = events.filter((event) => event.kind === "network.request" && event.payload.url.startsWith(origin + "/api/"));
  assert.equal(requests.length, 5, "all and only expected business requests in raw capture");
  report.network = requests.map((request, index) => {
    const item = oracle.ledger[index]; assert.equal(request.payload.method, item.method); assert.equal(new URL(request.payload.url).pathname, item.path);
    assert.ok(request.payload.requestId); assert.equal(request.tabId, clicks[0].tabId);
    const responses = events.filter((event) => event.kind === "network.response" && event.payload.requestId === request.payload.requestId);
    const finished = events.filter((event) => event.kind === "network.finished" && event.payload.requestId === request.payload.requestId);
    assert.equal(responses.length, 1); assert.equal(responses[0].payload.status, item.status); assert.equal(finished.length, 1);
    assert.equal(finished[0].payload.body?.status, "captured"); assert.equal(finished[0].payload.body.value, item.responseText);
    if (item.requestText) {
      const body = events.find((event) => event.kind === "network.requestBody" && event.payload.requestId === request.payload.requestId)?.payload.body || request.payload.postData;
      assert.equal(body.status, "captured"); assert.equal(body.value, item.requestText);
    }
    assert.ok(!events.some((event) => ["network.failed", "network.incomplete"].includes(event.kind) && event.payload.requestId === request.payload.requestId));
    return { ordinal: item.ordinal, method: item.method, path: item.path, status: item.status, requestId: request.payload.requestId,
      request: ref(request), response: ref(responses[0]), finished: ref(finished[0]), balanceCents: JSON.parse(item.responseText).member.balanceCents };
  });
  const linkedScreenshots = events.filter((event) => event.kind === "screenshot" && event.payload.assetId &&
    event.payload.eventIds?.some((id) => clicks.some((click) => click.id === id)) && png(files["screenshots/" + event.payload.assetId + ".png"]));
  assert.ok(linkedScreenshots.length > 0, "at least one valid PNG linked to a real business click; coalesced/temporal screenshots permitted");
  for (const event of linkedScreenshots) await fs.writeFile(path.join(evidenceDir, "recorded-" + event.payload.assetId + ".png"), files["screenshots/" + event.payload.assetId + ".png"]);
  report.rawEvidence = { input: inputEvidence, clicks: clicks.map(ref), snapshots: domEvidence,
    screenshots: linkedScreenshots.map((event) => ({ ...ref(event), ...event.payload })) };
  assert.equal(new Set(events.map((event) => event.id)).size, events.length);
  assert.ok(events.every((event, index) => event.sessionId === session.id && (!index || event.seq > events[index - 1].seq)));
  const identity = ref(clicks[0]); assert.ok(identity.documentId); assert.ok(Number.isSafeInteger(identity.tabId)); assert.equal(identity.frameId, 0);
  for (const event of [...clicks, ...inputEvidence.map((item) => events.find((event) => event.id === item.eventId))]) {
    assert.equal(event.documentId, identity.documentId); assert.equal(event.tabId, identity.tabId); assert.equal(event.frameId, identity.frameId);
  }
  const indexed = archive.eventIndexChunks.flatMap((name) => strFromU8(files[name]).split("\n").filter(Boolean).map(JSON.parse));
  assert.equal(indexed.length, events.length);
  for (const row of indexed) {
    const original = events.find((event) => event.id === row.eventId); assert.ok(original);
    assert.deepEqual(row.evidence, evidence.get(original.id)); assert.equal(row.kind, original.kind);
    assert.equal(row.tabId, original.tabId ?? null); assert.equal(row.frameId, original.frameId ?? null); assert.equal(row.documentId, original.documentId ?? null);
  }
  const resources = JSON.parse(strFromU8(files["resources/index.json"]));
  assert.equal(archive.eventCount, events.length); assert.equal(archive.assetCount, resources.length);
  assert.deepEqual(archive.session.seal, session.seal); assert.equal(session.seal.revision, session.revision);
  assert.equal(session.seal.eventCount, events.length); assert.equal(session.eventCount, events.length);
  assert.equal(session.seal.assetCount, resources.length); assert.equal(session.assetCount, resources.length);
  assert.equal(session.seal.lastSeq, events.at(-1).seq); assert.equal(session.lastSeq, events.at(-1).seq);
  assert.equal(events.filter((event) => event.kind === "session.stop").length, 1);
  assert.equal(archive.provenance.producerVersion, manifest.version); assert.equal(archive.provenance.exporterVersion, manifest.version);
  assert.equal(archive.partial, false); assert.deepEqual((await state()).sessions[0].seal, session.seal);
  report.provenance = archive.provenance; report.timelineIdentity = identity;
  report.counters = { events: events.length, assets: resources.length, lastSeq: events.at(-1).seq, linkedPngs: linkedScreenshots.length, seal: session.seal };
  report.assertions.push("raw original before/after input, DOM, 5 trusted business clicks, request/response bytes/status/balances, no duplicate writes, PNG, seal/counters, provenance, timeline identity passed");
  const integrity = JSON.parse(strFromU8(files["integrity.json"]));
  assert.equal(integrity.length, Object.keys(files).length - 1);
  for (const file of integrity) { assert.equal(files[file.path].length, file.size); assert.equal(hash(files[file.path]), file.sha256); }
  const { readArchive } = await import("../src/archive.js");
  const consumer = await readArchive(new Blob([zipBytes])); assert.deepEqual(consumer.events, events);
  report.consumer = { api: "src/archive.js readArchive(Blob)", events: consumer.events.length, rawEventsUnchanged: true };
  const python = process.env.PYTHON_BIN || "python", script = path.join(appRoot, "skills/extension-logic-clone/scripts/index_archive.py"), indexPath = path.join(evidenceDir, "erp-workflow.sqlite3");
  const result = await runFile(python, [script, zipPath, "--output", indexPath], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, timeout: 30000 });
  report.pythonIndex = JSON.parse(result.stdout); assert.equal(report.pythonIndex.verification, "passed"); assert.equal(report.pythonIndex.events, events.length);
  const pyCheck = 'import json,sqlite3,sys,zipfile,hashlib\np=sys.argv[1];z=zipfile.ZipFile(sys.argv[2]);d=sqlite3.connect("file:"+p.replace("\\\\","/")+"?mode=ro",uri=True)\nrows=list(d.execute("select path,size,sha256 from files"))\nfor n,s,h in rows:\n b=z.read(n);assert len(b)==s and hashlib.sha256(b).hexdigest()==h\nassert d.execute("select count(*) from events").fetchone()[0]==int(sys.argv[3])\nprint(json.dumps({"eventCount":int(sys.argv[3]),"fileHashesVerified":len(rows)}))\nd.close();z.close()';
  const checked = await runFile(python, ["-c", pyCheck, indexPath, zipPath, String(events.length)], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, timeout: 30000 });
  report.pythonReadback = JSON.parse(checked.stdout); await saveJson("python-index.json", { index: report.pythonIndex, readback: report.pythonReadback });
  report.assertions.push("external packaged Python index validated every file SHA-256 and event count; read-only SQLite hash/count readback passed");
  report.evidence.indexPath = indexPath; report.diagnostics.blockedExternalPageRequests = blocked;
  assert.deepEqual(blocked, []); report.status = "passed";
  console.log("ERP: raw evidence, actual Blob ZIP, seal/counters, JS consumer and external Python index passed");
} catch (error) {
  failure = error; process.exitCode = 1; report.status = "failed";
  report.failure = { name: error.name, message: error.message, stack: error.stack, chromeStderr: error.chromeStderr, cleanup: error.cleanup };
  console.error(error.stack || error);
} finally {
  report.oracle ||= structuredClone(oracle);
  if (evidenceDir) await saveJson("oracle-final.json", oracle).catch(() => {});
  if (browser) try { report.cleanup.chrome = await browser.close(); } catch (error) { report.cleanup.chrome = { status: "unconfirmed", error: String(error) }; process.exitCode = 1; }
  if (bound) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); report.cleanup.server = "closed"; }
  if (profile) report.cleanup.profile = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }));
  if (extension) try { await fs.rm(extension, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 }); report.cleanup.testExtension = "removed"; } catch (error) { report.cleanup.testExtension = { status: "preserved", error: String(error) }; process.exitCode = 1; }
  if (process.exitCode && report.status === "passed") report.status = "failed_cleanup";
  report.actualExitCode = process.exitCode || 0; report.finishedAt = new Date().toISOString();
  if (evidenceDir) {
    const entries = [];
    for (const name of (await fs.readdir(evidenceDir)).sort()) {
      const bytes = await fs.readFile(path.join(evidenceDir, name)); entries.push({ path: name, size: bytes.length, sha256: hash(bytes) });
    }
    report.evidence.artifacts = entries;
  }
  await fs.mkdir(reportRoot, { recursive: true });
  await fs.writeFile(path.join(reportRoot, "erp-verification.json"), JSON.stringify(report, null, 2));
  const link = (file, label) => "[" + label + "](<" + file.replaceAll("\\", "/") + ">)";
  const lines = ["# Native ERP release verification", "", "- Actual result: **" + report.status + "**; code=" + report.actualExitCode + ".",
    "- Executed: " + report.startedAt + " → " + report.finishedAt + ".",
    "- Browser: " + (report.environment.chromeVersion || "not reached") + "; Node " + process.version + "; " + process.platform + "/" + process.arch + ".",
    "- Native host, headless Chrome. Separate test-* profile is interference prevention only, **not an OS sandbox**. No Docker/WSL/VM.",
    "- Only local synthetic HTTP page; temporary dist copy pre-grants host permissions: **not a native permission-prompt test**. Sidepanel HTML is opened as an extension tab; native drawer appearance is not validated.",
    "- UI: Start → query → trusted contact/emoji input → one PUT save → POST 12800 cents/201 → POST 999999 cents/409 → final GET → normal Stop (existing 90000 ms UI budget) → export button / real Blob download.",
    "- Oracle successful writes=" + oracle.writes + ", attempted writes=" + oracle.writeAttempts + "; final balance=" + oracle.member.balanceCents + " cents. 409 must leave state unchanged.",
    "- Stop elapsed: " + (report.stopElapsedMs ?? "not reached") + " ms.",
    "- Evidence: " + (evidenceDir ? link(evidenceDir, "local retained synthetic evidence directory") : "not created") + "; ZIP/SQLite/profiles are not commit deliverables.",
    "- Raw assertions precede JS/Python consumer checks. No reconstructed DOM is used as business acceptance; PNGs may be coalesced/temporally offset, not one-per-click.",
    "- Evidence: " + link(path.join(reportRoot, "erp-verification.json"), "machine-readable report and event/ZIP-path references") + ".",
    "- Identity: source=" + (report.identity?.sourceDigest || "not reached") + "; dist=" + (report.identity?.distDigest || "not reached") + ". Non-atomic hash snapshot, not source→dist attestation or a cryptographic signature.",
    "", "## Acceptance and limits", "", ...report.assertions.map((item) => "- " + item),
    "- This is **one workflow with hash-checked synthetic evidence**, not proof for all real ERPs or native authorization. No trusted digital signature is claimed.",
    "- Recorded session coverage/gaps/warnings are retained verbatim in JSON. ready/sealed does not imply every capability is gap-free.",
    "- Cleanup: only this test's owned Chrome handle, local server, testextension and guarded test profile; user Chrome is never closed. Full cleanup results are retained in JSON."];
  if (failure) lines.push("", "## Failure", "", "~~~text", failure.stack || String(failure), "~~~");
  await fs.writeFile(path.join(reportRoot, "erp-verification.md"), lines.join("\n") + "\n");
  console.log("ERP native release result=" + report.status + "; code=" + report.actualExitCode + "; evidence=" + evidenceDir);
}
