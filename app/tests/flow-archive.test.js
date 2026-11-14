import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { createFlowArchive } from "../src/flow-archive.js";
import { deriveFlowLimits, LEGACY_FLOW_SETTINGS } from "../src/flow-config.js";
import { createBudget } from "../src/flow-budget.js";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const bytes = new TextEncoder().encode("<html><body><input value=\"原值💆\"></body></html>"), sha256 = hash(bytes), id = "synthetic";
  const content = { id: id + ":" + sha256, sessionId: id, size: bytes.length, sha256, mime: "text/html", category: "dom", blob: new Blob([bytes]) };
  const ref = { contentId: content.id, size: content.size, sha256, mime: content.mime, category: "dom", status: "captured" };
  const events = [
    { id: "e1", seq: 1, time: 1, sessionId: id, kind: "page.snapshot", payload: { sourceHtml: ref, reason: "initial" } },
    { id: "e2", seq: 2, time: 2, sessionId: id, kind: "page.snapshot", payload: { sourceHtml: ref, reason: "submit" } },
    { id: "e3", seq: 3, time: 3, sessionId: id, kind: "session.stop", payload: {} },
  ];
  const session = { id, ownerToken: "do-not-export", profile: "business-flow-v1", status: "ready", revision: 6, lastSeq: 3, eventCount: 3, contentCount: 1,
    seal: { eventCount: 3, contentCount: 1, lastSeq: 3, revision: 6 }, capturePolicy: { version: 1 },
    budget: { usedBytes: bytes.length + events.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e) + "\n"), 0), limitBytes: 67108864 } };
  return { bytes, session, events, content, store: { getSession: async () => session, readEvents: async () => events, readContents: async () => [content] } };
}
it("pure packing preserves raw content once and all observation references without generating dictionaries", async () => {
  const f = fixture(), before = JSON.stringify(f.session), progress = [];
  const result = await createFlowArchive(f.store)(f.session.id, (p) => progress.push(p));
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer())), manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  assert.equal(manifest.version, 3); assert.equal(manifest.profile, "business-flow-v1"); assert.equal(manifest.derivations, "none");
  assert.equal(Object.hasOwn(manifest.session, "ownerToken"), false);
  assert.equal(Object.keys(files).length, 4);
  assert.deepEqual(files[manifest.contents[0].path], f.bytes);
  const recorded = new TextDecoder().decode(files[manifest.eventChunks[0]]).trim().split("\n").map(JSON.parse);
  assert.deepEqual(recorded, f.events); assert.equal(recorded[0].payload.sourceHtml.contentId, recorded[1].payload.sourceHtml.contentId);
  const integrity = JSON.parse(new TextDecoder().decode(files["integrity.json"]));
  assert.equal(integrity.length, 3);
  for (const item of integrity) { assert.equal(files[item.path].length, item.size); assert.equal(hash(files[item.path]), item.sha256); }
  assert.ok(result.metrics.metadataOverheadBytes <= 1024 * 1024);
  assert.equal(JSON.stringify(f.session), before); assert.ok(progress.length > 4);
  assert.ok(!Object.keys(files).some((name) => /styles|dictionary|browser-data|indexes/.test(name)));
});
it("mismatched byte ledger, missing content and modified seal fail rather than creating a successful archive", async () => {
  const ledger = fixture(); ledger.session.budget.usedBytes++;
  await assert.rejects(createFlowArchive(ledger.store)(ledger.session.id), /容量账本/);
  const missing = fixture(); missing.content.size++;
  await assert.rejects(createFlowArchive(missing.store)(missing.session.id), /内容索引/);
  const changing = fixture(); let calls = 0;
  changing.store.getSession = async () => { calls++; return calls === 1 ? changing.session : { ...changing.session, revision: 9 }; };
  await assert.rejects(createFlowArchive(changing.store)(changing.session.id), /封存已改变/);
});
it("legacy batches are not migrated or read via the new format and abort is read-only", async () => {
  const f = fixture(); f.session.profile = "legacy";
  await assert.rejects(createFlowArchive(f.store)(f.session.id), /不迁移旧数据/);
  const controller = new AbortController(); controller.abort(new Error("synthetic abort"));
  await assert.rejects(createFlowArchive(f.store)(f.session.id, undefined, { signal: controller.signal }), /synthetic abort/);
});

function pagedFixture({ contents = 3, events = 1005, settings = { schemaVersion: 1, budgetMultiplier: 20, queueMultiplier: 20, samplingMultiplier: 20 } } = {}) {
  const f = fixture(), id = f.session.id, rows = [], records = [], calls = { events: [], contents: [] };
  for (let n = 0; n < contents; n++) {
    const bytes = new TextEncoder().encode("synthetic content " + n), sha256 = hash(bytes);
    const blob = new Blob([bytes]); blob.arrayBuffer = () => { throw new Error("whole content arrayBuffer forbidden"); };
    rows.push({ id: id + ":" + sha256, sessionId: id, sha256, size: bytes.length, mime: "text/plain", category: "dom", blob });
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  const budget = createBudget(settings), limits = deriveFlowLimits(settings);
  for (let n = 1; n <= events; n++) {
    const item = rows[(n - 1) % rows.length];
    const ref = item ? { status: "captured", contentId: item.id, sha256: item.sha256, size: item.size, mime: "text/html", category: n % 2 ? "dom" : "resource" } : undefined;
    records.push({ id: "event:" + n, seq: n, sessionId: id, time: n, kind: n === events ? "session.stop" : "page.snapshot", payload: ref ? { original: ref } : {} });
  }
  const rawBytes = records.reduce((sum, e) => sum + Buffer.byteLength(JSON.stringify(e) + "\n"), 0);
  budget.usedBytes = rows.reduce((sum, item) => sum + item.size, rawBytes); budget.byCategory.meta = rawBytes;
  for (const item of rows) {
    for (const category of ["dom", "resource"]) if (records.some((event) => event.payload.original?.contentId === item.id && event.payload.original.category === category)) budget.byCategory[category] += item.size;
  }
  f.session = { ...f.session, budget, eventCount: records.length, contentCount: rows.length, lastSeq: records.length,
    capturePolicy: { settings: limits.settings, limits: limits.budget, runtimeLimits: { background: limits.background, content: limits.content } },
    seal: { ...f.session.seal, eventCount: records.length, contentCount: rows.length, lastSeq: records.length } };
  f.contents = rows; f.events = records; f.calls = calls;
  f.store = {
    async getSession() { return f.session; },
    readEvents() { throw new Error("full events read forbidden"); }, readContents() { throw new Error("full contents read forbidden"); },
    async flowContentPage(sessionId, afterId, options) {
      assert.equal(sessionId, id); assert.equal(options.limit, 50); assert.ok(options.signal); calls.contents.push(afterId);
      const remaining = f.contents.filter((row) => row.id > afterId), page = remaining.slice(0, 2);
      return { contents: page, nextId: page.at(-1)?.id ?? afterId, done: remaining.length <= page.length };
    },
    async flowEventPage(sessionId, afterSeq, options) {
      assert.equal(sessionId, id); assert.equal(options.limit, 500); assert.equal(options.maxBytes, 8 * 1024 * 1024); assert.ok(options.signal); calls.events.push(afterSeq);
      const remaining = f.events.filter((row) => row.seq > afterSeq), page = remaining.slice(0, options.limit);
      return { events: page, nextSeq: page.at(-1)?.seq ?? afterSeq, done: remaining.length <= page.length };
    },
  };
  return f;
}
function diskStorage({ failWrite = false } = {}) {
  const state = { files: new Map(), removed: [], writes: 0, maxBlock: 0, closed: false, gotFile: false };
  let blocks = [];
  state.storage = { async getDirectory() { return {
    async getFileHandle(name) { state.files.set(name, true); return {
      async createWritable() { return {
        async write(bytes) { if (failWrite) throw new Error("synthetic disk full"); state.writes++; state.maxBlock = Math.max(state.maxBlock, bytes.length); blocks.push(bytes.slice()); },
        async close() { state.closed = true; }, async abort() { blocks = []; },
      }; },
      async getFile() { assert.equal(state.closed, true); state.gotFile = true; return new Blob(blocks); },
    }; },
    async removeEntry(name) { assert.ok(state.files.has(name)); state.removed.push(name); state.files.delete(name); blocks = []; },
  }; } };
  return state;
}
it("cursor pages preserve 1..N events, cross-category MIME references and streaming-only Blob contents", async () => {
  const f = pagedFixture(), result = await createFlowArchive(f.store)(f.session.id, undefined, { storage: null });
  assert.deepEqual(f.calls.events, [0, 500, 1000]); assert.equal(f.calls.contents.length, 4);
  const files = unzipSync(new Uint8Array(await result.blob.arrayBuffer())), manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  const events = manifest.eventChunks.flatMap((name) => new TextDecoder().decode(files[name]).trim().split("\n").map(JSON.parse));
  assert.deepEqual(events, f.events); assert.equal(manifest.contents.length, f.contents.length);
  assert.equal(result.metrics.storedLogicalBytes, f.session.budget.usedBytes); assert.equal(result.metrics.storageMode, "memory");
  for (const item of manifest.contents) assert.equal(hash(files[item.path]), item.sha256);
  await result.cleanup(); await result.cleanup();
});
it("empty-content sealed sessions and legacy multiplier one do not inherit current defaults", async () => {
  const f = pagedFixture({ contents: 0, events: 1, settings: LEGACY_FLOW_SETTINGS });
  delete f.session.capturePolicy.settings; delete f.session.capturePolicy.limits; delete f.session.capturePolicy.runtimeLimits;
  delete f.session.budget.settings;
  const result = await createFlowArchive(f.store)(f.session.id, undefined, { storage: null }); assert.equal(result.metrics.contentCount, 0); await result.cleanup();
  f.session.budget.limitBytes *= 20;
  await assert.rejects(createFlowArchive(f.store)(f.session.id), /设置上限/);
});
it("twenty multiplier output uses OPFS with deferred cleanup and abort removes only owned temporary data", async () => {
  const f = pagedFixture({ events: 5 }), disk = diskStorage();
  const result = await createFlowArchive(f.store)(f.session.id, undefined, { storage: disk.storage });
  assert.equal(result.metrics.storageMode, "opfs"); assert.equal(disk.files.size, 1); assert.equal(disk.removed.length, 0); assert.equal(disk.gotFile, true);
  assert.ok(disk.maxBlock <= 1024 * 1024); await result.cleanup(); assert.equal(disk.files.size, 0); assert.equal(disk.removed.length, 1);
  const failed = diskStorage({ failWrite: true }); await assert.rejects(createFlowArchive(f.store)(f.session.id, undefined, { storage: failed.storage }), /synthetic disk full/);
  assert.equal(failed.files.size, 0); assert.equal(failed.removed.length, 1); assert.equal(failed.gotFile, false);
  const aborted = diskStorage(), controller = new AbortController();
  await assert.rejects(createFlowArchive(f.store)(f.session.id, (p) => { if (p.phase === "整理操作与页面") controller.abort(new Error("synthetic export abort")); }, { storage: aborted.storage, signal: controller.signal }), /synthetic export abort/);
  assert.equal(aborted.files.size, 0); assert.equal(aborted.removed.length, 1);
});
it("bad SHA, missing references, zero references, cursor stalls, category ledger and settings mismatches fail", async () => {
  const badHash = pagedFixture({ events: 5 });
  badHash.contents[0].blob = new Blob([new Uint8Array(badHash.contents[0].size)]);
  const disk = diskStorage(); await assert.rejects(createFlowArchive(badHash.store)(badHash.session.id, undefined, { storage: disk.storage }), /校验失败/); assert.equal(disk.files.size, 0);
  const missing = pagedFixture({ events: 5 }); missing.events[0].payload.original.contentId += "x";
  await assert.rejects(createFlowArchive(missing.store)(missing.session.id), /引用的原始内容/);
  const orphan = pagedFixture({ contents: 2, events: 1 }); await assert.rejects(createFlowArchive(orphan.store)(orphan.session.id), /未引用/);
  const stalled = pagedFixture(); stalled.store.flowEventPage = async () => ({ events: [], nextSeq: 0, done: false });
  await assert.rejects(createFlowArchive(stalled.store)(stalled.session.id), /分页游标/);
  const category = pagedFixture(); category.session.budget.byCategory.dom++;
  await assert.rejects(createFlowArchive(category.store)(category.session.id), /分类容量账本/);
  const limits = pagedFixture(); limits.session.capturePolicy.limits = { ...limits.session.capturePolicy.limits, totalBytes: limits.session.capturePolicy.limits.totalBytes + 1 };
  await assert.rejects(createFlowArchive(limits.store)(limits.session.id), /限额快照/);
});
it("changed seal after disk flush returns no successful Blob and removes temporary file", async () => {
  const f = pagedFixture({ events: 5 }), disk = diskStorage(); let reads = 0;
  f.store.getSession = async () => { if (++reads > 1) f.session.seal.revision++; return f.session; };
  await assert.rejects(createFlowArchive(f.store)(f.session.id, undefined, { storage: disk.storage }), /封存已改变/);
  assert.equal(disk.gotFile, true); assert.equal(disk.files.size, 0); assert.equal(disk.removed.length, 1);
});
it("no OPFS explicitly rejects a large declared batch before reading any content", async () => {
  const f = pagedFixture(); f.session.budget.usedBytes = 129 * 1024 * 1024;
  await assert.rejects(createFlowArchive(f.store)(f.session.id, undefined, { storage: null }), /128MiB/);
  assert.equal(f.calls.events.length, 0); assert.equal(f.calls.contents.length, 0);
});
it("ordinary business payload markers stay unchanged and do not become recorder content references", async () => {
  const f = fixture();
  f.events[0].payload.captureState = { status: "captured", detail: "business state" };
  f.events[0].payload.businessRecord = { contentId: "business-object-id", status: "draft" };
  f.session.budget.usedBytes = f.content.size + f.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event) + "\n"), 0);
  const result = await createFlowArchive(f.store)(f.session.id), files = unzipSync(new Uint8Array(await result.blob.arrayBuffer()));
  const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
  const first = JSON.parse(new TextDecoder().decode(files[manifest.eventChunks[0]]).split("\n")[0]);
  assert.deepEqual(first, f.events[0]); await result.cleanup();
});
