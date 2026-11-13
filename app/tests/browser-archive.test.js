import { it } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { createArchive, readArchive } from "../src/archive.js";

// 验证状态：仅编写和静态复核，未运行（完整 OS 隔离尚未确认）。
// This in-memory read-only IDB test double never opens a profile, disk database or existing archive.
function syntheticDatabase(session, events) {
  const requestWith = (value) => {
    const request = { result: structuredClone(value) };
    queueMicrotask(() => request.onsuccess?.());
    return request;
  };
  return {
    close() {},
    transaction(storeName, mode = "readonly") {
      assert.equal(mode, "readonly");
      const tx = { objectStore(name) {
        assert.equal(name, storeName);
        return {
          get(id) { assert.equal(name, "sessions"); assert.equal(id, session.id); return requestWith(session); },
          index(indexName) {
            if (name === "assets") {
              assert.equal(indexName, "session");
              return { getAll: () => requestWith([]), count: () => requestWith(0) };
            }
            assert.equal(name, "events");
            if (indexName === "session") return { count: () => requestWith(events.length) };
            assert.equal(indexName, "sessionSeq");
            return { openCursor(range) {
              const request = {}, rows = events.filter((event) => event.sessionId === range.lower[0] && event.seq > range.lower[1]);
              let position = 0;
              const step = () => queueMicrotask(() => {
                const value = rows[position++];
                let continued = false;
                request.result = value ? { value: structuredClone(value), continue() { continued = true; step(); } } : null;
                request.onsuccess?.();
                if (!continued) queueMicrotask(() => tx.oncomplete?.());
              });
              step();
              return request;
            } };
          },
        };
      } };
      return tx;
    },
  };
}

async function exportSynthetic(events, sealed) {
  const session = { id: "synthetic-session", title: "synthetic", status: "ready", startedAt: 1 };
  if (sealed) Object.assign(session, { revision: 5, seal: { revision: 5, lastSeq: events.at(-1).seq,
    eventCount: events.length, assetCount: 0, sealedAt: 1700000000000 } });
  const names = ["indexedDB", "IDBKeyRange", "navigator", "crypto"];
  const descriptors = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const db = syntheticDatabase(session, events), before = JSON.stringify(events);
  const globals = {
    indexedDB: { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request; } },
    IDBKeyRange: { only: (value) => ({ only: value }), bound: (lower, upper) => ({ lower, upper }) },
    navigator: { locks: { request: (_name, _options, task) => task() } },
    crypto: webcrypto,
  };
  try {
    for (const name of names) Object.defineProperty(globalThis, name, { configurable: true, value: globals[name] });
    const result = await createArchive(session.id);
    assert.deepEqual(result.importIssues, []);
    const archive = await readArchive(result.blob);
    assert.equal(JSON.stringify(events), before);
    assert.deepEqual(archive.events, events);
    const readRows = (paths) => paths.flatMap((path) => new TextDecoder().decode(archive.files[path]).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)));
    return { archive, observations: readRows(archive.manifest.browserObservationChunks), fields: readRows(archive.manifest.browserFieldSummaryChunks) };
  } finally {
    db.onversionchange?.(); // Reset the real db.js cached connection between synthetic cases.
    for (const name of names) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

function stream(lateKind) {
  const metadata = { sessionId: "synthetic-session", tabId: 1, frameId: 0, documentId: "document" };
  const base = { url: "https://shop.example/page", database: "db", store: "items", status: "captured" };
  const graph = { root: { type: "ref", id: 0 }, nodes: [
    { id: 0, type: "object", entries: [["name", { type: "string", value: "synthetic-original-secret" }]] },
  ] };
  const text = JSON.stringify(graph), reference = { captureId: "capture", field: "databaseGraph", parts: 1, length: text.length };
  const raw = [
    { id: "baseline", kind: "database.record", payload: { ...base, graphCaptureId: "baseline", graph } },
    { id: "owner", kind: "database.record", payload: { ...base, status: "fragmented", graphCaptureId: "graph", graphReference: reference } },
    { id: "part", kind: "capture.fragment", payload: { ...reference, index: 0, data: text } },
    { id: "end", kind: "capture.fragmentEnd", payload: { ...reference, status: "confirmed" } },
  ];
  // Put contradictory evidence in a later eventPage, not merely later within one page.
  for (let index = 0; index < 22; index++) raw.push({ id: "unrelated-" + index, kind: "synthetic.noop", payload: {} });
  if (lateKind === "part") raw.push({ id: "late-part", kind: "capture.fragment", payload: { ...reference, index: 0, data: text } });
  if (lateKind === "failure") raw.push({ id: "late-failure", kind: "capture.fragmentFailure", payload: { captureId: reference.captureId, field: reference.field } });
  if (lateKind === "end") raw.push({ id: "late-end", kind: "capture.fragmentEnd", payload: { ...reference, status: "confirmed" } });
  return raw.map((event, index) => ({ ...metadata, ...event, seq: index + 1, time: index + 1 }));
}

it("createArchive 全流预扫否决 End 后同组 late part/Failure/End，字段与成功样本不先污染（未运行设计）", async () => {
  for (const sealed of [false, true]) for (const lateKind of ["part", "failure", "end"]) {
    const { observations, fields } = await exportSynthetic(stream(lateKind), sealed);
    const ownerRows = observations.filter((row) => row.source.eventId === "owner");
    assert.deepEqual(ownerRows.map((row) => row.kind), ["sample"]);
    assert.equal(ownerRows[0].status, "incomplete");
    assert.equal(ownerRows[0].source.identity.documentId, "document");
    assert.equal(ownerRows[0].source.identity.fragmentCaptureId, "capture");
    const name = fields.find((row) => row.path === "/name");
    assert.equal(name.observedSamples, 1);
    assert.deepEqual(name.sampleCounts, { total: 2, available: 1 });
    assert.doesNotMatch(JSON.stringify({ observations, fields }), /synthetic-original-secret/);
  }
});

it("createArchive 完整且无矛盾的 fragment 仍产生同源字段与成功样本（未运行设计）", async () => {
  const { observations, fields } = await exportSynthetic(stream(null), true);
  const ownerRows = observations.filter((row) => row.source.eventId === "owner");
  assert.equal(ownerRows[0].status, "fragmented");
  assert.ok(ownerRows.some((row) => row.kind === "field-path" && row.path === "/name"));
  const name = fields.find((row) => row.path === "/name");
  assert.equal(name.observedSamples, 2);
  assert.deepEqual(name.sampleCounts, { total: 2, available: 2 });
});
// Provenance-only additions; existing archive/fragment assertions above are unchanged.
// not-run / 未运行：未满足全 OS 隔离门，不在当前环境导入或执行这些测试。
async function exportSyntheticProvenance(producerVersion, chromeValue) {
  const session = { id: "synthetic-session", title: "synthetic-provenance", status: "ready", startedAt: 1 };
  if (producerVersion !== undefined) session.producerVersion = producerVersion;
  const events = [{ id: "provenance-event", kind: "synthetic.noop", sessionId: session.id, seq: 1, time: 1,
    payload: { content: "synthetic-raw-content" } }];
  const before = structuredClone({ session, events }), db = syntheticDatabase(session, events);
  const globals = {
    indexedDB: { open() { const request = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request; } },
    IDBKeyRange: { only: (value) => ({ only: value }), bound: (lower, upper) => ({ lower, upper }) },
    navigator: { locks: { request: (_name, _options, task) => task() } },
    crypto: webcrypto, chrome: chromeValue,
  };
  const descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  try {
    for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, value });
    const { blob } = await createArchive(session.id);
    const archive = await readArchive(blob);
    assert.equal(archive.manifest.version, 2);
    assert.deepEqual(archive.manifest.session, before.session);
    assert.deepEqual(archive.events, before.events);
    assert.deepEqual({ session, events }, before);
    assert.doesNotMatch(JSON.stringify(archive.manifest.provenance), /synthetic-raw-content/);
    return archive;
  } finally {
    db.onversionchange?.();
    for (const [name, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

it("createArchive/readArchive provenance preserves known old/new producers and leaves legacy unknown (not-run)", async () => {
  const derivations = { browserObservations: 2, browserFieldSummary: 2, fragmentValidation: 1, fragmentTerminals: 1 };
  for (const producerVersion of ["0.1.0", "0.2.0", undefined, "synthetic-invalid-version"]) {
    const archive = await exportSyntheticProvenance(producerVersion, { runtime: { getManifest: () => ({ version: "0.9.0" }) } });
    assert.deepEqual(archive.manifest.provenance, { schemaVersion: 1,
      producerVersion: ["0.1.0", "0.2.0"].includes(producerVersion) ? producerVersion : null, exporterVersion: "0.9.0", derivations });
    if (producerVersion === undefined) assert.equal(Object.hasOwn(archive.manifest.session, "producerVersion"), false);
  }
});

it("createArchive/readArchive provenance uses unknown for absent/broken runtime without relabeling producer (not-run)", async () => {
  for (const chromeValue of [undefined, null, {}, { runtime: { getManifest: null } },
    { runtime: { getManifest() { throw new Error("synthetic-runtime-error"); } } },
    { runtime: { getManifest: () => null } }, { runtime: { getManifest: () => ({ version: "invalid" }) } }]) {
    const archive = await exportSyntheticProvenance("0.1.0", chromeValue);
    assert.equal(archive.manifest.provenance.producerVersion, "0.1.0");
    assert.equal(archive.manifest.provenance.exporterVersion, null);
  }
});

