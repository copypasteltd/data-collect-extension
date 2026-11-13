// Native, synthetic-only v0.4.0 acceptance. Run from app after the parent announces BUILDREADY.
// Temporary dist-copy host pregrant is NOT a native optional-permission test.
import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { unzipSync, strFromU8 } from "fflate";
import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
const MiB = 1024 * 1024, hash = (v) => createHash("sha256").update(v).digest("hex");
const TRANSIENT_ALERT = "Synthetic approval required — visible for 200ms ⚠️", AFTER_FRAME_CONTACT = "13700005678", CONTACT = "13900001234", NOTE = "预约💆‍♀️ — synthetic note 🧾", TRAP = "CACHE_IDB_SENTINEL_NOT_PAGE_CONTENT";
const CSS = ":root{" + Array.from({ length: 5000 }, (_, i) => "--fixture-" + i + ":" + i + ";").join("") + "}body{font:16px Arial;background:#fff;color:#123}#clock{animation:pulse 1s infinite}dialog{border:2px solid #456}@keyframes pulse{50%{opacity:.6}}";
const seed =   "window.fixtureReady=(async()=>{const db=await new Promise((ok,no)=>{const r=indexedDB.open('synthetic-cache-trap',1);r.onupgradeneeded=()=>r.result.createObjectStore('seed');r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error)});await new Promise((ok,no)=>{const t=db.transaction('seed','readwrite');t.objectStore('seed').put('" + TRAP + "','fixture');t.oncomplete=ok;t.onerror=no});db.close();const c=await caches.open('synthetic-cache-trap');await c.put('/cache-only-never-http',new Response('" + TRAP + "'));return true})().catch(e=>{window.seedError=String(e);return false});setInterval(()=>{document.getElementById('clock').textContent=String(++window.clockTicks)},100);window.clockTicks=0;";
const head = (title) => '<!doctype html><meta charset="utf-8"><title>' + title + '</title><style>' + CSS + '</style><span id="clock">0</span><script src="/seed.js"></script>';
function fixturePage(kind, round) {
  if (kind === "unrelated") return head("unrelated-origin-marker") + '<h1>UNRELATED_ORIGIN_MARKER</h1><input value="unrelated-value"><script>' + '</script>';
  if (kind === "frame") return head("Authorized frame") + '<label>Authorized frame<input id="frameValue" value="frame-before"></label><button id="frameQuery">Frame lookup</button><output id="frameResult"></output><script>' + "document.getElementById('frameQuery').onclick=async()=>{const r=await fetch('/api/frame?round=" + round + "');document.getElementById('frameResult').textContent=await r.text()};</script>";
  if (kind === "child") return head("Attributed child") + '<h1>Attributed child business</h1><input id="childValue" value="child-before"><button id="childQuery">Child lookup</button><output id="childResult"></output><script>' + "document.getElementById('childQuery').onclick=async()=>{const r=await fetch('/api/member?round=" + round + "');document.getElementById('childResult').textContent=await r.text()};</script>";
  return head("Synthetic ERP flow") + '<h1>Member synthetic-001</h1><button id="query">Query member</button><form id="memberForm"><label>Contact<input id="contact" value="13800000000" required></label><label>Note<textarea id="note"></textarea></label><label>Operator<input id="operator" required></label><button id="save">Save member</button></form><button id="transient">Transient alert 200ms</button><button id="details">Service dropdown</button><dialog id="serviceDialog"><label>Service<select id="service"><option value="">Choose</option><option value="facial">Facial synthetic</option></select></label><button id="closeDialog">Confirm selection</button></dialog><button id="debit">Debit 12800</button><button id="overdraft">Reject excessive debit</button><button id="frameNavigate">Reload embedded lookup</button><button id="childOpen">Open attributed child</button><button id="verify">Recheck member</button><output id="result" role="status"></output><iframe title="Authorized business frame" src="/frame?round=' + round + '"></iframe><script>' +
    "const q=id=>document.getElementById(id),api=async(url,method='GET',body)=>{const r=await fetch('/api/'+url+'?round=" + round + "',{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();q('result').textContent=JSON.stringify(v);q('result').dataset.status=r.status;return v};q('query').onclick=()=>api('member');q('verify').onclick=()=>api('member');q('memberForm').onsubmit=e=>{e.preventDefault();api('member','PUT',{contact:q('contact').value,note:q('note').value,operator:q('operator').value})};q('transient').onclick=()=>{const a=document.createElement('div');a.setAttribute('role','alert');a.textContent='" + TRANSIENT_ALERT + "';document.body.append(a);setTimeout(()=>a.remove(),200)};q('details').onclick=()=>q('serviceDialog').showModal();q('closeDialog').onclick=()=>q('serviceDialog').close();q('debit').onclick=()=>api('debit','POST',{amount:12800});q('overdraft').onclick=()=>api('debit','POST',{amount:9000000});q('frameNavigate').onclick=()=>document.querySelector('iframe').src='/frame?round=" + round + "&nav=after';q('childOpen').onclick=()=>window.open('/child?round=" + round + "','_blank');</script>";
}
function createFixture() {
  const states = new Map(), state = (id) => { if (!states.has(id)) states.set(id, { contact: "13800000000", note: "", balance: 100000, writes: 0, attempts: 0, requests: [] }); return states.get(id); };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1"), id = url.searchParams.get("round") || "0", s = state(id);
    if (url.pathname === "/seed.js") { res.writeHead(200, { "Content-Type": "text/javascript" }); res.end(seed); return; }
    if (!url.pathname.startsWith("/api/")) { res.writeHead(200, { "Content-Type": "text/html;charset=utf-8" }); res.end(fixturePage(url.pathname.slice(1), id)); return; }
    let body = ""; for await (const part of req) body += part;
    const input = body ? JSON.parse(body) : {}, record = { method: req.method, path: url.pathname, body: input }; s.requests.push(record);
    let status = 200, value;
    if (req.method !== "GET") s.attempts++;
    if (url.pathname === "/api/member" && req.method === "PUT") { s.contact = input.contact; s.note = input.note; s.writes++; }
    if (url.pathname === "/api/debit") {
      if (input.amount > s.balance) { status = 409; value = { error: "INSUFFICIENT_BALANCE", balance: s.balance }; }
      else { s.balance -= input.amount; s.writes++; status = 201; value = { debit: input.amount, balance: s.balance }; }
    }
    value ||= url.pathname === "/api/frame" ? { authorizedFrame: true, balance: s.balance } : { id: "synthetic-001", contact: s.contact, note: s.note, balance: s.balance };
    record.status = status; record.response = value;
    const text = JSON.stringify(value); res.writeHead(status, { "Content-Type": "application/json;charset=utf-8", "Cache-Control": "no-store", "Content-Length": Buffer.byteLength(text) }); res.end(text);
  });
  return { server, state };
}
async function candidateIdentity(dist) {
  const files = [];
  async function visit(dir, rel = "") { for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    assert.ok(!e.isSymbolicLink(), "candidate contains a symlink"); const name = rel + e.name;
    if (e.isDirectory()) await visit(path.join(dir, e.name), name + "/");
    else { const b = await fs.readFile(path.join(dir, e.name)); files.push({ path: name, size: b.length, sha256: hash(b) }); }
  } }
  await visit(dist); const packageBytes = await fs.readFile(path.resolve("package.json"));
  return { candidateHash: hash(JSON.stringify(files)), files, package: { version: JSON.parse(packageBytes).version, sha256: hash(packageBytes) } };
}
async function traps(panel, ids) {
  return panel.evaluate(async (tabIds) => { const values = [];
    for (const tabId of tabIds) values.push(...await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, world: "ISOLATED", func: () => {
      if (!globalThis.__flowAcceptanceTrap) {
        const c = globalThis.__flowAcceptanceTrap = { indexedDB: 0, caches: 0, computedStyle: 0 };
        for (const name of ["indexedDB", "caches"]) { const value = globalThis[name]; Object.defineProperty(globalThis, name, { configurable: true, get() { c[name]++; return value; } }); }
        const native = globalThis.getComputedStyle; globalThis.getComputedStyle = function (...args) { c.computedStyle++; return native.apply(this, args); };
      } return { ...globalThis.__flowAcceptanceTrap };
    } })); return values.map(v => ({ tabId: v.tabId, frameId: v.frameId, ...v.result }));
  }, ids);
}
async function tabId(panel, page) { return panel.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url)?.id, page.url()); }
async function waitObserved(panel, tabId, url = null) {
  await panel.evaluate(async ({ id, url }) => {
    const until = Date.now() + 7000;
    while (Date.now() < until) {
      const reply = await chrome.runtime.sendMessage({ type: "GET_STATUS" }), session = reply.value?.active;
      if (reply.ok && session?.scope?.tabIds.includes(id)) {
        const db = await new Promise((ok, no) => { const r = indexedDB.open("logic-recorder-flow-v1"); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
        try { const rows = await new Promise((ok, no) => { const r = db.transaction("events").objectStore("events").index("session").getAll(session.id); r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });
          if (rows.some(e => e.tabId === id && e.kind === "page.snapshot" && e.payload.sourceHtml?.status === "captured" && (!url || e.payload.url === url))) return true;
        } finally { db.close(); }
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error("collector admission/baseline not ready for tab " + id);
  }, { id: tabId, url });
}
async function clickResponse(page, selector, pathname, status) {
  const [r] = await Promise.all([page.waitForResponse(r => new URL(r.url()).pathname === pathname), page.locator(selector).click()]);
  assert.equal(r.status(), status, selector + " HTTP status"); return r.json();
}
async function businessCycle({ root, panel, context, round, stepMs, row, relatedIds }) {
  const began = Date.now(); let step = 0;
  const pace = async (name) => { row.steps.push(name); const ms = began + (++step) * stepMs - Date.now(); if (ms > 0) await new Promise(resolve => setTimeout(resolve, ms)); };
  assert.equal((await clickResponse(root, "#query", "/api/member", 200)).balance, 100000);
  assert.equal((await clickResponse(root, "#query", "/api/member", 200)).balance, 100000); await pace("initial query + identical response");
  await root.locator("#contact").fill(CONTACT); await root.locator("#note").fill(NOTE); await root.locator("#operator").focus(); await pace("contact + emoji note before/after");
  await root.locator("#save").click(); assert.equal(await root.locator("#operator").evaluate(e => e.validity.valueMissing), true); await root.locator("#transient").click(); await root.getByRole("alert").waitFor({ state: "visible" }); await pace("required validation + transient 200ms alert");
  await root.locator("#details").click(); await root.locator("#service").selectOption("facial"); await pace("modal + dropdown open"); await root.locator("#closeDialog").click();
  await root.locator("#operator").fill("synthetic-operator"); assert.equal((await clickResponse(root, "#save", "/api/member", 200)).contact, CONTACT); await pace("PUT save");
  assert.equal((await clickResponse(root, "#debit", "/api/debit", 201)).balance, 87200); await pace("POST debit 201: 100000 to 87200");
  assert.equal((await clickResponse(root, "#overdraft", "/api/debit", 409)).balance, 87200); await pace("POST excessive debit 409: unchanged");
  const frame = root.frameLocator("iframe"); await frame.locator("#frameValue").fill("frame-after");
  const [fr] = await Promise.all([root.waitForResponse(r => new URL(r.url()).pathname === "/api/frame"), frame.locator("#frameQuery").click()]); assert.equal(fr.status(), 200);
  const navigated = root.waitForEvent("framenavigated", f => f.url().includes("nav=after")); await root.locator("#frameNavigate").click(); const refreshed = await navigated; await refreshed.waitForLoadState("load");
  await waitObserved(panel, relatedIds[0], refreshed.url()); await root.locator("#contact").fill(AFTER_FRAME_CONTACT); await root.locator("#operator").focus();
  row.afterFrameValue = AFTER_FRAME_CONTACT; await pace("authorized frame lookup + frame navigation + second root value");
  const childPromise = context.waitForEvent("page"); await root.locator("#childOpen").click(); const child = await childPromise;
  await child.waitForLoadState("load"); assert.equal(await child.opener(), root, "trusted window.open opener belongs to root");
  const childId = await tabId(panel, child); relatedIds.push(childId); await traps(panel, [childId]); await waitObserved(panel, childId);
  await child.locator("#childValue").fill("child-after"); await clickResponse(child, "#childQuery", "/api/member", 200); await pace("trusted attributed child + lookup");
  await root.bringToFront(); assert.equal((await clickResponse(root, "#verify", "/api/member", 200)).balance, 87200); await pace("return root GET recheck");
  row.businessDurationMs = Date.now() - began; assert.equal(row.steps.length, 10); return child;
}
function verifyArchive(bytes, row, oracle, relatedIds, excludedOrigin) {
  const files = unzipSync(bytes), manifest = JSON.parse(strFromU8(files["manifest.json"]));
  const events = manifest.eventChunks.flatMap(p => strFromU8(files[p]).trim().split("\n").filter(Boolean).map(JSON.parse));
  const contents = new Map(manifest.contents.map(c => [c.contentId, c]));
  row.rawSummary = { scope: manifest.session.scope, stopOutcome: manifest.session.stopOutcome, coverage: manifest.session.coverage, kinds: Object.fromEntries([...new Set(events.map(e => e.kind))].map(k => [k, events.filter(e => e.kind === k).length])), notices: events.filter(e => /notice/.test(e.kind)).map(e => ({ seq: e.seq, payload: e.payload })) };
  const refText = (r) => { assert.equal(r?.status, "captured", "missing v3 content ref"); const c = contents.get(r.contentId); assert.ok(c && files[c.path], "missing manifest.contents path"); return strFromU8(files[c.path]); };
  const gate = (name, fn) => { fn(); row.gates.push({ name, status: "pass" }); };
  gate("1 raw v3 content refs and pure archive", () => {
    assert.equal(manifest.version, 3); assert.equal(manifest.format, "logic-recorder"); assert.equal(manifest.profile, "business-flow-v1"); assert.equal(manifest.derivations, "none");
    assert.ok(Object.keys(files).every(p => /^(manifest\.json|integrity\.json|timeline\/events-\d+\.jsonl|contents\/[a-f0-9]{64}\.bin)$/.test(p)), "unexpected derived file");
    for (const c of contents.values()) { assert.equal(files[c.path].length, c.size); assert.equal(hash(files[c.path]), c.sha256); }
    for (const e of events) for (const r of Object.values(e.payload || {})) if (r?.contentId) { refText(r); assert.equal(r.sha256, contents.get(r.contentId).sha256); }
    for (const i of JSON.parse(strFromU8(files["integrity.json"]))) { assert.equal(files[i.path].length, i.size); assert.equal(hash(files[i.path]), i.sha256); }
  });
  gate("2 bounded scope root child and authorized frame only", () => {
    assert.deepEqual([...manifest.session.scope.tabIds].sort(), [...relatedIds].sort()); assert.equal(relatedIds.length, 2);
    assert.ok(events.every(e => e.tabId == null || relatedIds.includes(e.tabId)), "unrelated tab entered timeline");
    assert.ok(events.some(e => e.kind === "page.snapshot" && e.tabId === relatedIds[0] && e.frameId > 0), "authorized frame missing");
    assert.ok(events.some(e => e.kind === "scope.child" && e.payload.type === "child_opened" && e.payload.openerTabId === relatedIds[0]), "attributed child navigation missing");
    assert.ok(events.some(e => e.kind === "page.snapshot" && e.tabId === relatedIds[1]), "child snapshot missing");
    const text = JSON.stringify(events); assert.ok(!text.includes(excludedOrigin) && !text.includes("UNRELATED_ORIGIN_MARKER"), "unrelated origin leaked");
  });
  const snapshots = events.filter(e => e.kind === "page.snapshot"), html = snapshots.map(e => refText(e.payload.sourceHtml));
  const formHas = (snapshot, id, value) => { const source = refText(snapshot.payload.sourceHtml), node = source.match(new RegExp('<[^>]*id="' + id + '"[^>]*>'))?.[0];
    const marker = node?.match(/data-flow-node="([^"]+)"/)?.[1]; return snapshot.payload.forms?.some(f => f.selector === '[data-flow-node="' + marker + '"]' && f.value === value); };
  gate("3 true key DOM and stable form before after values", () => {
    assert.ok(html.some(s => s.includes('id="memberForm"') && s.includes('id="contact"')), "key HTML absent");
    assert.ok(snapshots.some(s => formHas(s, "contact", CONTACT) && formHas(s, "note", NOTE)), "real form properties missing");
    assert.ok(events.some(e => ["ui.input", "ui.change"].includes(e.kind) && e.payload.target?.id === "contact" && e.payload.beforeValue === "13800000000" && e.payload.value === CONTACT), "contact before/after missing");
    assert.ok(events.some(e => ["ui.input", "ui.change"].includes(e.kind) && e.payload.target?.id === "note" && e.payload.beforeValue === "" && e.payload.value === NOTE), "emoji input missing");
    assert.ok(events.some(e => ["ui.input", "ui.change"].includes(e.kind) && e.payload.target?.id === "contact" && e.payload.beforeValue === CONTACT && e.payload.value === AFTER_FRAME_CONTACT), "post-frame-navigation root second before/after value swallowed");
    assert.ok(snapshots.some(s => s.tabId === relatedIds[0] && s.frameId === 0 && formHas(s, "contact", AFTER_FRAME_CONTACT)), "post-frame root DOM form value absent");
    assert.ok(events.some(e => ["ui.input", "ui.change"].includes(e.kind) && e.payload.target?.id === "frameValue" && e.payload.value === "frame-after"));
  });
  gate("4 validation modal dropdown and viewport PNG", () => {
    assert.ok(events.some(e => e.kind === "recorder.notice" && e.payload.reason === "validation"), "required validation evidence missing");
    assert.ok(events.some(e => e.kind === "recorder.notice" && e.payload.reason === "transient_state" && e.payload.role === "alert" && (typeof e.payload.text === "string" ? e.payload.text : refText(e.payload.text)) === TRANSIENT_ALERT), "transient role alert original text missing");
    assert.ok(html.some(s => /<dialog[^>]*\sopen(?:\s|=|>)/.test(s)), "open dialog state absent");
    assert.ok(events.some(e => e.kind === "ui.change" && e.payload.target?.id === "service" && e.payload.value === "facial"), "dropdown change absent");
    assert.ok(events.some(e => { if (e.kind !== "screenshot" || e.payload.viewportOnly !== true) return false; const c = contents.get(e.payload.image?.contentId), b = c && files[c.path]; return b?.[0] === 137 && b?.[1] === 80 && b?.[2] === 78 && b?.[3] === 71; }), "viewport PNG ref absent");
  });
  const responses = events.filter(e => e.kind === "network.response" && e.payload.url?.includes("/api/"));
  gate("5 server oracle and exact observed business HTTP", () => {
    assert.equal(oracle.writes, 2); assert.equal(oracle.attempts, 3); assert.equal(oracle.balance, 87200); assert.equal(oracle.contact, CONTACT); assert.equal(oracle.note, NOTE);
    assert.equal(oracle.requests.length, 8, "recorder added or duplicated API calls"); assert.equal(responses.length, oracle.requests.length, "missing observed HTTP response");
    assert.ok(responses.some(e => e.payload.status === 201 && JSON.parse(refText(e.payload.body)).balance === 87200));
    assert.ok(responses.some(e => e.payload.status === 409 && JSON.parse(refText(e.payload.body)).error === "INSUFFICIENT_BALANCE"));
    assert.equal(JSON.parse(refText(responses.at(-1).payload.body)).balance, 87200);
  });
  gate("6 CSS and repeated bodies dedup without conflating changes", () => {
    assert.equal(new Set(manifest.contents.map(c => c.sha256)).size, manifest.contents.length);
    const css = events.filter(e => e.kind === "page.stylesheet").map(e => e.payload.text); assert.ok(css.length >= 2, "root/frame/child CSS observations absent");
    assert.equal(new Set(css.map(c => c.sha256)).size, 1, "same CSS not shared"); assert.ok(refText(css[0]).includes("--fixture-4999"));
    const queries = responses.filter(e => new URL(e.payload.url).pathname === "/api/member");
    assert.equal(queries[0].payload.body.sha256, queries[1].payload.body.sha256, "identical body not shared");
    assert.notEqual(queries[0].payload.body.sha256, queries.at(-1).payload.body.sha256, "different balance/body conflated");
  });
  gate("7 no heavy storage cookie computed theme or script uploads", () => {
    assert.ok(!events.some(e => /computed|theme|dictionary|database|cache|cookie/i.test(e.kind)), "heavy event collected");
    assert.ok(!JSON.stringify(events).includes(TRAP)); assert.ok(html.every(s => !s.includes("window.fixtureReady") && !s.includes(TRAP)), "script buffer or seeded storage leaked");
    for (const c of contents.values()) if (/text|json|xml/.test(c.mime)) assert.ok(!strFromU8(files[c.path]).includes(TRAP), "storage seed exported");
    for (const t of row.traps) assert.deepEqual([t.indexedDB, t.caches, t.computedStyle], [0, 0, 0], "collector called a storage/computed trap");
    assert.ok(!row.cdpMethods.some(m => /IndexedDB|CacheStorage|Cookies|ComputedStyle|DOMSnapshot/.test(m)), "forbidden CDP collection");
  });
  gate("8 single final stop sealed exact bytes and bounded ZIP", () => {
    const s = manifest.session; assert.equal(s.status, "ready"); assert.equal(s.writeGate, "sealed"); assert.ok(s.seal); assert.equal(manifest.partial, false);
    assert.equal(events.filter(e => e.kind === "session.stop").length, 1); assert.equal(events.at(-1).kind, "session.stop");
    assert.ok(events.every((e, i) => e.seq === i + 1 && e.sessionId === s.id)); assert.equal(s.eventCount, events.length); assert.equal(s.contentCount, contents.size);
    assert.equal(s.seal.eventCount, events.length); assert.equal(s.seal.contentCount, contents.size); assert.equal(s.seal.lastSeq, events.length);
    const eventBytes = manifest.eventChunks.reduce((n, p) => n + files[p].length, 0), contentBytes = manifest.contents.reduce((n, c) => n + c.size, 0), logical = eventBytes + contentBytes;
    assert.equal(s.budget.usedBytes, logical); assert.equal(manifest.budget.usedBytes, logical); assert.equal(manifest.byteAccounting.storedLogicalBytes, logical);
    const expanded = Object.values(files).reduce((n, b) => n + b.length, 0); assert.ok(expanded <= logical + Math.max(MiB, Math.ceil(logical * .05))); assert.ok(bytes.length < 20 * MiB, "small scenario ZIP >=20MiB");
    Object.assign(row, { eventCount: events.length, contentCount: contents.size, expandedBytes: expanded, logicalBytes: logical, zipBytes: bytes.length, sessionId: s.id });
  });
  return manifest;
}
export async function runAcceptance({ mode = "acceptance", rounds = 1, durationMs = 60000 } = {}) {
  assert.equal(process.platform, "win32", "native Windows run required");
  process.env.CHROME_BIN ||= "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const dist = path.resolve(process.env.FLOW_DIST || "dist"), runRoot = await fs.mkdtemp(path.resolve("test-flow-" + mode + "-"));
  const extension = path.join(runRoot, "extension"), profile = path.join(runRoot, "owned-profile"), reportPath = path.resolve(process.env.FLOW_REPORT || "../docs/精简/2026-11-14-v0.4.0/" + (mode === "acceptance" ? "acceptance" : "performance") + (process.env.FLOW_REPORT_SUFFIX || "") + ".json");
  const report = { schema: 1, mode, generatedAt: new Date().toISOString(), status: "running", nativePermissionTest: false, profile: "fresh-owned-synthetic-only", hostPregrant: "temporary extension-copy manifest http/https", durationPerRoundMs: durationMs, roundsRequested: rounds, runRoot, rows: [], deferred: ["budget edge/unit gates owned by parent", "blind reconstruction owned by consumer", "optional-host native permission prompt not tested"] };
  const fixture = createFixture(), unrelated = createFixture(); let browser;
  try {
    report.candidate = await candidateIdentity(dist); await fs.cp(dist, extension, { recursive: true }); await fs.mkdir(profile);
    const manifestPath = path.join(extension, "manifest.json"), manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")); assert.equal(manifest.version, "0.4.0");
    manifest.host_permissions = ["http://*/*", "https://*/*"]; await fs.writeFile(manifestPath, JSON.stringify(manifest)); report.loadedManifestSha256 = hash(await fs.readFile(manifestPath));
    await new Promise(r => fixture.server.listen(0, "127.0.0.1", r)); await new Promise(r => unrelated.server.listen(0, "127.0.0.1", r));
    const origin = "http://127.0.0.1:" + fixture.server.address().port, excluded = "http://127.0.0.1:" + unrelated.server.address().port;
    browser = await launchExtension(profile, extension, ["--window-size=1100,820"]); const { context } = browser; context.setDefaultTimeout(15000);
    const panel = await context.newPage(); await panel.goto("chrome-extension://" + browser.id + "/sidepanel.html");
    await panel.waitForFunction(async () => { try { return (await chrome.runtime.sendMessage({ type: "GET_STATE" })).ok === true; } catch { return false; } }, null, { timeout: 10000 });
    const worker = context.serviceWorkers().find(w => w.url() === "chrome-extension://" + browser.id + "/background.js") || await context.waitForEvent("serviceworker", { predicate: w => w.url() === "chrome-extension://" + browser.id + "/background.js" });
    report.worker = await worker.evaluate(async () => { const until = Date.now() + 5000; while (typeof chrome.debugger?.sendCommand !== "function" && Date.now() < until) await new Promise(r => setTimeout(r, 50)); return { url: self.location.href, id: chrome.runtime?.id, debuggerApi: typeof chrome.debugger?.sendCommand }; });
    assert.equal(report.worker.debuggerApi, "function", "extension worker debugger API unavailable after ready");
    await worker.evaluate(() => { globalThis.__flowAcceptanceCdp = []; const original = chrome.debugger.sendCommand.bind(chrome.debugger); chrome.debugger.sendCommand = (...args) => { globalThis.__flowAcceptanceCdp.push(args[1]); return original(...args); }; });
    report.userAgent = await panel.evaluate(() => navigator.userAgent);
    const unrelatedPages = [];
    for (let n = 0; n < 20; n++) { const p = await context.newPage(); await p.goto(excluded + "/unrelated?round=" + n); unrelatedPages.push(p); }
    report.unrelatedTabsAtStart = unrelatedPages.length;
    for (let round = 1; round <= rounds; round++) {
      const row = { round, status: "running", steps: [], gates: [] }; report.rows.push(row); console.log(JSON.stringify({ event: "round-start", mode, round, durationMs }));
      const root = await context.newPage(); await root.goto(origin + "/root?round=" + round); assert.equal(await root.evaluate(() => window.fixtureReady), true);
      const rootId = await tabId(panel, root), relatedIds = [rootId]; await traps(panel, [rootId]);
      await root.bringToFront(); await panel.getByRole("button", { name: "开始录制", exact: true }).click();
      await panel.getByText("录制中", { exact: true }).waitFor(); await waitObserved(panel, rootId); row.startedAt = new Date().toISOString();
      const detachedPromise = context.waitForEvent("page");
      row.noOpenerTab = await panel.evaluate(async url => { const t = await chrome.tabs.create({ url, active: false }); return { id: t.id, openerTabId: t.openerTabId ?? null }; }, excluded + "/unrelated?round=new-" + round);
      const noOpener = await detachedPromise; await noOpener.waitForLoadState("load"); assert.equal(row.noOpenerTab.openerTabId, null, "Chrome no-opener prerequisite"); assert.equal(await noOpener.opener(), null); await root.bringToFront();
      const futurePromise = context.waitForEvent("page");
      row.futureGestureTab = await panel.evaluate(async ({ url, openerTabId }) => { const t = await chrome.tabs.create({ url, openerTabId, active: false }); return { id: t.id, openerTabId: t.openerTabId, createdAt: Date.now() }; }, { url: excluded + "/unrelated?round=future-" + round, openerTabId: rootId });
      assert.equal(row.futureGestureTab.openerTabId, rootId); const futurePage = await futurePromise;
      const child = await businessCycle({ root, panel, context, round, stepMs: durationMs / 10, row, relatedIds });
      row.traps = await traps(panel, relatedIds); row.cdpMethods = await worker.evaluate(() => [...new Set(globalThis.__flowAcceptanceCdp)]);
      let begin = Date.now(); await panel.getByRole("button", { name: "停止录制", exact: true }).click();
      await panel.getByRole("button", { name: "开始录制", exact: true }).waitFor(); row.stopMs = Date.now() - begin;
      const state = await panel.evaluate(() => chrome.runtime.sendMessage({ type: "GET_STATE" })); assert.equal(state.ok, true); assert.equal(state.value.active, null);
      const downloadPromise = panel.waitForEvent("download", { timeout: 30000 }); begin = Date.now(); await panel.getByRole("button", { name: "导出记录包", exact: true }).click();
      const download = await downloadPromise; row.exportMs = Date.now() - begin; const archivePath = path.join(runRoot, "round-" + round + ".zip"); await download.saveAs(archivePath);
      row.oracle = structuredClone(fixture.state(String(round))); row.archiveSha256 = hash(await fs.readFile(archivePath)); row.archivePath = archivePath;
      verifyArchive(await fs.readFile(archivePath), row, row.oracle, relatedIds, excluded);
      if (process.env.FLOW_PYTHON_INDEX === "1") {
        const out = execFileSync(process.env.PYTHON_BIN || "python", [path.resolve("skills/extension-logic-clone/scripts/index_archive.py"), archivePath, "--output", path.join(runRoot, "round-" + round + ".sqlite3")], { encoding: "utf8", env: { ...process.env, PYTHONUTF8: "1" }, timeout: 30000 });
        row.pythonIndex = JSON.parse(out); assert.equal(row.pythonIndex.events, row.eventCount);
      }
      row.status = "pass"; console.log(JSON.stringify({ event: "round-pass", round, stopMs: row.stopMs, exportMs: row.exportMs, zipBytes: row.zipBytes }));
      await child.close(); await root.close(); await noOpener.close(); await futurePage.close();
    }
    const p95 = key => [...report.rows.map(r => r[key])].sort((a, b) => a - b)[Math.ceil(rounds * .95) - 1];
    report.metrics = { stopP95Ms: p95("stopMs"), exportP95Ms: p95("exportMs"), workload: rounds + " x " + durationMs + "ms, same 10 business interaction groups; not 20 x 60s" };
    if (mode === "performance") { assert.equal(rounds, 20, "formal P95 gate requires 20 completed rounds"); assert.ok(report.metrics.stopP95Ms <= 5000, "Stop P95 >5s"); assert.ok(report.metrics.exportP95Ms <= 10000, "Export P95 >10s"); }
    assert.deepEqual(await candidateIdentity(dist), report.candidate, "candidate changed while running"); report.status = "pass";
  } catch (error) {
    report.status = "fail"; report.firstFailure = { message: error.message, stack: error.stack }; if (report.rows.at(-1)?.status === "running") report.rows.at(-1).status = "fail"; console.error(error.stack); process.exitCode = 1;
  } finally {
    try { if (browser) { await browser.close(); report.cleanup = "confirmed-owned-browser-closed"; } } catch (e) { report.cleanup = "unconfirmed"; report.status = "fail"; report.cleanupError = String(e); process.exitCode = 1; }
    const cleanup = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true }));
    if (cleanup.status === "preserved") { report.status = "fail"; report.cleanup = "unconfirmed-profile-preserved"; }
    await Promise.all([fixture.server, unrelated.server].map(s => new Promise(resolve => s.listening ? s.close(resolve) : resolve())));
    if (report.cleanup === "confirmed-owned-browser-closed") await fs.rm(extension, { recursive: true, force: true });
    report.finishedAt = new Date().toISOString(); await fs.mkdir(path.dirname(reportPath), { recursive: true }); await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    const markdown = ["# v0.4.0 " + mode + " 实测", "", "- 状态：**" + report.status.toUpperCase() + "**（执行后生成，不代替父级发布门）",
      "- 原生 Chrome、独立己有 profile；仅临时扩展副本预授 hosts，**不是 native permission test**。",
      "- 候选 SHA256：" + (report.candidate?.candidateHash || "unavailable"),
      "- 工作负载：" + rounds + "轮 × " + durationMs + "ms、相同10组交互，20既有无关页与1个无 opener 新页。",
      "- P95：Stop " + (report.metrics?.stopP95Ms ?? "未完成") + "ms / Export " + (report.metrics?.exportP95Ms ?? "未完成") + "ms。短轮P95不冒充20次60秒。",
      "- 结果：[JSON](<" + path.basename(reportPath) + ">)；含每轮首失败、HTTP oracle、8核心门、账本与候选哈希。",
      "- 实时表单 property 与 sourceHtml 节点标记关联，不伪装初始 attribute 为实时值。",
      "- 未覆盖：预算边界（父级）、盲重建（consumer）、原生可选权限弹窗。",
      ...(report.firstFailure ? ["", "## 首失败", "", report.firstFailure.message] : []), ""].join("\n");
    await fs.writeFile(reportPath.replace(/\.json$/, ".md"), markdown); console.log(JSON.stringify({ event: "report", status: report.status, reportPath }));
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await runAcceptance({ durationMs: Number(process.env.FLOW_DURATION_MS || 60000) });
