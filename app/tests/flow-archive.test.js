import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { createFlowArchive } from "../src/flow-archive.js";
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
