import { it } from "node:test";
import assert from "node:assert/strict";
import { createBrowserFieldSummary } from "../src/browser-field-summary.js";
import { observeBrowserData, browserObservationSource, incompleteBrowserObservation } from "../src/browser-observations.js";

// 验证状态：仅编写和静态复核，未运行（完整 OS 隔离尚未确认）。

function record(id, metadata = {}, payload = {}) {
  return { id, kind: "database.record", sessionId: "session", tabId: 1, frameId: 0, documentId: "document", ...metadata,
    payload: { url: "https://shop.example/page", database: "db", store: "items", graphCaptureId: `graph-${id}`, status: "captured",
      graph: { root: { type: "ref", id: 0 }, nodes: [
        { id: 0, type: "object", entries: [["name", { type: "string", value: "synthetic-record-secret" }]] },
      ] }, ...payload } };
}

function addRecord(summary, event, line = 1) {
  for (const row of observeBrowserData(event, { path: "timeline/events.jsonl", line })) summary.add(row);
}

const nameFields = (summary) => [...summary.results()].filter((row) => row.path === "/name");

it("按同一来源命名空间、数据库和仓库汇总字段样本、类型冲突及来源", () => {
  const summary = createBrowserFieldSummary();
  for (const [eventId, type] of [["a", "string"], ["b", "number"]]) {
    const base = { domain: "indexeddb", database: "db", store: "items", source: browserObservationSource(record(eventId),
      { path: "timeline/a.jsonl", line: eventId === "a" ? 1 : 2 }) };
    summary.add({ ...base, kind: "sample", status: "captured" });
    summary.add({ ...base, kind: "field-path", path: "/value/name", type });
  }
  summary.add({ domain: "indexeddb", database: "other", store: "items", source: { eventId: "c" }, kind: "sample", status: "unavailable" });
  const [field] = [...summary.results()];
  assert.deepEqual({ ...field.types }, { string: 1, number: 1 });
  assert.deepEqual(field.sampleCounts, { total: 2, available: 2 });
  assert.equal(field.observedSamples, 2);
  assert.equal(field.typeConflict, true);
  assert.deepEqual(field.evidence.map((item) => item.line), [1, 2]);
  assert.equal(field.schemaVersion, 2);
  assert.equal(field.namespace.scope, "document");
});

it("跨 origin 的同名 DB/store/字段不得并组或产生伪类型冲突", () => {
  const summary = createBrowserFieldSummary();
  const stringRecord = record("site-a", {}, { url: "https://a.example/page" });
  const numberRecord = record("site-b", {}, { url: "https://b.example/page", graph: {
    root: { type: "ref", id: 0 }, nodes: [{ id: 0, type: "object", entries: [["name", { type: "number", value: 12 }]] }],
  } });
  addRecord(summary, stringRecord, 1);
  addRecord(summary, numberRecord, 2);
  const fields = nameFields(summary);
  assert.equal(fields.length, 2);
  assert.deepEqual(new Set(fields.map((field) => field.namespace.origin)), new Set(["https://a.example", "https://b.example"]));
  for (const field of fields) {
    assert.equal(field.observedSamples, 1);
    assert.deepEqual(field.sampleCounts, { total: 1, available: 1 });
    assert.equal(field.typeConflict, false);
    assert.equal(field.evidence.length, 1);
  }
});

it("同 origin 不同明确 partition key 以及 unknown 分开，明确同 namespace 不永久按 frame/document 分裂", () => {
  const summary = createBrowserFieldSummary();
  for (const [id, metadata] of [
    ["partition-a-start", { storageKey: "key-A", documentId: "doc-a", tabId: 1, frameId: 0 }],
    ["partition-a-stop", { storageKey: "key-A", documentId: "doc-b", tabId: 2, frameId: 9 }],
    ["partition-b", { storageKey: "key-B", documentId: "doc-a", tabId: 1, frameId: 0 }],
    ["unknown", { documentId: "doc-a", tabId: 1, frameId: 0 }],
  ]) addRecord(summary, record(id, metadata));
  const fields = nameFields(summary);
  assert.equal(fields.length, 3);
  const a = fields.find((field) => field.namespace.storagePartition.storageKey === "key-A");
  assert.equal(a.namespace.scope, "storage-key");
  assert.equal(a.observedSamples, 2);
  assert.deepEqual(a.sampleCounts, { total: 2, available: 2 });
  assert.deepEqual(new Set(a.evidence.map((source) => source.identity.documentId)), new Set(["doc-a", "doc-b"]));
  assert.equal(fields.find((field) => field.namespace.storagePartition.storageKey === "key-B").observedSamples, 1);
  assert.equal(fields.find((field) => field.namespace.storagePartition.status === "unknown").observedSamples, 1);
});

it("partition unknown 时只合并同 document 的起止采样，不跨同 origin 的其他 document/session", () => {
  const summary = createBrowserFieldSummary();
  for (const [id, metadata] of [
    ["start", { documentId: "doc-one" }], ["stop", { documentId: "doc-one" }],
    ["other-document", { documentId: "doc-two" }], ["other-session", { documentId: "doc-one", sessionId: "other-session" }],
  ]) addRecord(summary, record(id, metadata));
  const fields = nameFields(summary);
  assert.equal(fields.length, 3);
  const repeated = fields.find((field) => field.namespace.documentId === "doc-one" && field.namespace.sessionId === "session");
  assert.equal(repeated.observedSamples, 2);
  assert.deepEqual(repeated.sampleCounts, { total: 2, available: 2 });
  assert.deepEqual(repeated.namespace.storagePartition, { status: "unknown" });
  assert.equal(repeated.namespace.scope, "document");
  assert.notEqual(repeated.evidence[0].identity.graphCaptureId, repeated.evidence[1].identity.graphCaptureId);
});

it("同一明确 storage instance 重复采样可合并，其他 instance 不能并入", () => {
  const summary = createBrowserFieldSummary();
  for (const [id, metadata] of [
    ["instance-start", { storageInstanceId: "instance-A", documentId: "doc-a", frameId: 0 }],
    ["instance-stop", { storageInstanceId: "instance-A", documentId: "doc-b", frameId: 4 }],
    ["different-instance", { storageInstanceId: "instance-B", documentId: "doc-a" }],
  ]) addRecord(summary, record(id, metadata));
  const fields = nameFields(summary);
  assert.equal(fields.length, 2);
  const repeated = fields.find((field) => field.namespace.storageInstance.id === "instance-A");
  assert.equal(repeated.namespace.scope, "storage-instance");
  assert.equal(repeated.observedSamples, 2);
  assert.deepEqual(repeated.namespace.storagePartition, { status: "unknown" });
});

it("缺 document 时按 capture 隔离，连 capture 也缺则按事件隔离，unknown origin 不合并", () => {
  const summary = createBrowserFieldSummary();
  for (const [id, metadata, payload] of [
    ["same-graph-a", { documentId: null }, { graphCaptureId: "same-graph" }],
    ["same-graph-b", { documentId: null }, { graphCaptureId: "same-graph" }],
    ["other-graph", { documentId: null }, { graphCaptureId: "other-graph" }],
    ["catalog-a", { documentId: null }, { graphCaptureId: null, catalogId: "catalog" }],
    ["catalog-b", { documentId: null }, { graphCaptureId: null, catalogId: "catalog" }],
    ["no-capture-a", { documentId: null }, { graphCaptureId: null }],
    ["no-capture-b", { documentId: null }, { graphCaptureId: null }],
    ["opaque-a", {}, { url: "about:blank", graphCaptureId: "opaque" }],
    ["opaque-b", {}, { url: "about:blank", graphCaptureId: "opaque" }],
  ]) addRecord(summary, record(id, metadata, payload));
  const fields = nameFields(summary);
  assert.equal(fields.length, 7);
  const graph = fields.find((field) => field.namespace.capture?.id === "same-graph");
  assert.equal(graph.observedSamples, 2);
  assert.equal(fields.find((field) => field.namespace.capture?.kind === "catalogId").observedSamples, 2);
  assert.equal(fields.filter((field) => field.namespace.scope === "event").length, 4);
});

it("历史缺 identity 的 row 以 event/evidence 保守隔离并标 legacy，不接入新 namespace", () => {
  const summary = createBrowserFieldSummary();
  const legacySources = [
    { eventId: "legacy-a", path: "timeline/legacy.jsonl", line: 1 },
    { eventId: "legacy-b", path: "timeline/legacy.jsonl", line: 2 },
    { eventId: "legacy-a", path: "timeline/other.jsonl", line: 1 },
  ];
  for (const source of legacySources) {
    const base = { domain: "indexeddb", database: "db", store: "items", source };
    summary.add({ ...base, kind: "sample", status: "captured" });
    summary.add({ ...base, kind: "field-path", path: "/name", type: "string" });
  }
  addRecord(summary, record("new"));
  const fields = nameFields(summary);
  assert.equal(fields.length, 4);
  const legacy = fields.filter((field) => field.namespace.legacy);
  assert.equal(legacy.length, 3);
  for (const field of legacy) {
    assert.equal(field.namespace.scope, "legacy-event");
    assert.deepEqual(field.sampleCounts, { total: 1, available: 1 });
    assert.equal(field.observedSamples, 1);
  }
});

it("失败/缺失 fragment sample 只影响同来源样本数，不伪造字段或泄露原值", () => {
  const summary = createBrowserFieldSummary();
  const complete = record("complete");
  const failed = record("failed", {}, { graphReference: { captureId: "f", field: "databaseGraph", parts: 1, length: 10 } });
  const missing = record("missing", {}, { graphReference: { captureId: "m", field: "databaseGraph", parts: 1, length: 10 } });
  const other = record("other-origin", {}, { url: "https://other.example/page" });
  addRecord(summary, complete, 1);
  summary.add(incompleteBrowserObservation(failed, { path: "timeline/events.jsonl", line: 2 }, "分段传输失败"));
  summary.add(incompleteBrowserObservation(missing, { path: "timeline/events.jsonl", line: 3 }, "未收到分段结束确认"));
  summary.add(incompleteBrowserObservation(other, { path: "timeline/events.jsonl", line: 4 }, "分段传输失败"));
  const [field] = nameFields(summary);
  assert.deepEqual(field.sampleCounts, { total: 3, available: 1 });
  assert.equal(field.observedSamples, 1);
  assert.equal(field.occurrences, 1);
  assert.doesNotMatch(JSON.stringify([...summary.results()]), /synthetic-record-secret|other\.example/);
  assert.equal(complete.payload.graph.nodes[0].entries[0][1].value, "synthetic-record-secret");
});

it("摘要 evidence 只保留来源白名单，不照抄历史 row/source 的原始内容", () => {
  const summary = createBrowserFieldSummary();
  const source = browserObservationSource(record("source"), { path: "timeline/events.jsonl", line: 6 });
  source.value = "synthetic-source-secret";
  source.payload = { token: "synthetic-payload-secret" };
  source.identity.raw = "synthetic-identity-secret";
  summary.add({ domain: "indexeddb", database: "db", store: "items", source, kind: "sample", status: "captured" });
  summary.add({ domain: "indexeddb", database: "db", store: "items", source, kind: "field-path", path: "/name", type: "string",
    value: "synthetic-row-secret" });
  const [field] = nameFields(summary);
  assert.equal(field.evidence[0].eventId, "source");
  assert.equal(field.evidence[0].line, 6);
  assert.doesNotMatch(JSON.stringify(field), /synthetic-(source|payload|identity|row)-secret/);
  assert.equal(source.value, "synthetic-source-secret");
});

it("路径预算coverage不伪装成完整字段或重复数据库样本", () => {
  const graph = { root: { type: "ref", id: 0 }, nodes: Array.from({ length: 300 }, (_, id) => ({
    id, type: "object", entries: id < 299 ? [["next", { type: "ref", id: id + 1 }]] : [],
  })) };
  const event = record("partial-paths", {}, { graph });
  const summary = createBrowserFieldSummary();
  let coverage;
  for (const row of observeBrowserData(event, { path: "timeline/synthetic.jsonl", line: 1 })) {
    summary.add(row);
    if (row.kind === "field-path-coverage") coverage = row;
  }
  assert.equal(coverage.status, "partial");
  assert.equal(coverage.reason, "depth_limit");
  const fields = [...summary.results()];
  assert.equal(fields.length, 257);
  assert.ok(fields.every(row => row.location.length <= 256));
  for (const field of fields) assert.deepEqual(field.sampleCounts, { total: 1, available: 1 });
});

