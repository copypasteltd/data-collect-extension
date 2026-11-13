import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { observeBrowserData, browserObservationSource, browserStorageNamespace, incompleteBrowserObservation } from "../src/browser-observations.js";

// 验证状态：仅编写和静态复核，未运行（完整 OS 隔离尚未确认）。

it("为 Cookie、存储键和数据库图保留来源及原始类型", () => {
  const evidence = { path: "timeline/events-00001.jsonl", line: 4 };
  const cookie = { id: "c", kind: "cookie.initial", payload: { items: [{ name: "sid", value: "raw", secure: true }] } };
  const cookieRows = [...observeBrowserData(cookie, evidence)];
  assert.ok(cookieRows.some((row) => row.key === "secure" && row.type === "boolean" && row.source.eventId === "c"));
  const storage = { id: "s", kind: "storage.snapshot", payload: { stores: { localStorage: JSON.parse('{"__proto__":"raw"}') } } };
  assert.ok([...observeBrowserData(storage, evidence)].some((row) => row.key === "__proto__" && row.type === "string"));
  const database = { id: "d", kind: "database.record", payload: { database: "db", store: "store", index: 0, status: "captured",
    graph: { nodes: [{ id: 0, type: "object", entries: [["file", { type: "ref", id: 1 }]] }, { id: 1, type: "blob", size: 3 }] } } };
  const rows = [...observeBrowserData(database, evidence)];
  assert.ok(rows.some((row) => row.kind === "field" && row.key === "file" && row.type === "blob"));
  assert.ok(rows.some((row) => row.kind === "graph-node" && row.type === "blob" && row.size === 3));
});

it("保留 Map 和 Set 的类型化字段位置并标记集合内的循环", () => {
  const event = { id: "collections", kind: "database.record", payload: { status: "captured", graph: {
    root: { type: "ref", id: 0 }, nodes: [
      { id: 0, type: "object", entries: [["value", { type: "ref", id: 1 }]] },
      { id: 1, type: "map", entries: [[{ type: "string", value: "key" }, { type: "ref", id: 2 }]] },
      { id: 2, type: "set", values: [{ type: "ref", id: 3 }, { type: "ref", id: 1 }] },
      { id: 3, type: "object", entries: [["name", { type: "string", value: "raw" }]] },
    ] } } };
  const rows = [...observeBrowserData(event, {})].filter((row) => row.kind === "field-path");
  const nested = rows.find((row) => row.type === "string" && row.location.some((part) => part.key === "name"));
  assert.equal(nested.path, null);
  assert.deepEqual(nested.location, [{ key: "value" }, { mapEntry: 0, part: "value" }, { setEntry: 0 }, { key: "name" }]);
  assert.ok(rows.some((row) => row.cycle && row.location.at(-1).setEntry === 1));
});

it("为数据库嵌套字段生成可追溯路径并终止循环引用", () => {
  const event = { id: "d", kind: "database.record", payload: { database: "db", store: "items", index: 1,
    status: "captured", graph: { root: { type: "ref", id: 0 }, nodes: [
      { id: 0, type: "object", entries: [["value", { type: "ref", id: 1 }]] },
      { id: 1, type: "object", entries: [["a/b~c", { type: "ref", id: 2 }], ["again", { type: "ref", id: 2 }], ["self", { type: "ref", id: 1 }]] },
      { id: 2, type: "array", entries: [["0", { type: "string", value: "original" }]] }
    ] } } };
  const rows = [...observeBrowserData(event, { path: "timeline/events.jsonl", line: 3 })];
  const paths = rows.filter((row) => row.kind === "field-path");
  assert.ok(paths.some((row) => row.path === "/value/a~1b~0c/0" && row.type === "string" && row.source.line === 3));
  assert.ok(paths.some((row) => row.path === "/value/again/0" && row.type === "string"));
  assert.ok(paths.some((row) => row.path === "/value/self" && row.cycle === true));
  assert.ok(paths.length < 10);
});

it("为所有浏览器观察行投影同一来源身份而不复制 URL 路径和原值", () => {
  const metadata = { sessionId: "session", tabId: 7, frameId: 0, documentId: "document" };
  const evidence = { path: "timeline/events-00001.jsonl", line: 8 };
  const url = "https://user:credential@SHOP.example:443/private?token=synthetic-url-secret#private";
  const events = [
    { ...metadata, id: "cookie", kind: "cookie.initial", payload: { url, items: [{ name: "sid", value: "synthetic-cookie-secret" }] } },
    { ...metadata, id: "storage", kind: "storage.snapshot", payload: { url, stores: { localStorage: { token: "synthetic-storage-secret" } } } },
    { ...metadata, id: "database", kind: "database.record", payload: { url, database: "db", store: "items", graphCaptureId: "graph",
      catalogId: "catalog", status: "captured", graph: { root: { type: "ref", id: 0 }, nodes: [
        { id: 0, type: "object", entries: [["name", { type: "string", value: "synthetic-record-secret" }]] },
      ] } } },
  ];
  const before = JSON.stringify(events);
  for (const event of events) {
    const rows = [...observeBrowserData(event, evidence)];
    assert.ok(rows.length > 1);
    for (const row of rows) {
      assert.equal(row.schemaVersion, 2);
      assert.deepEqual(row.source, browserObservationSource(event, evidence));
      assert.equal(row.source.eventId, event.id);
      assert.equal(row.source.path, evidence.path);
      assert.equal(row.source.line, 8);
      assert.equal(row.source.identity.origin, "https://shop.example");
      assert.equal(row.source.identity.sessionId, "session");
      assert.equal(row.source.identity.tabId, 7);
      assert.equal(row.source.identity.frameId, 0);
      assert.equal(row.source.identity.documentId, "document");
      assert.deepEqual(row.source.identity.storagePartition, { status: "unknown" });
      assert.deepEqual(row.source.identity.storageInstance, { status: "unknown" });
    }
    assert.doesNotMatch(JSON.stringify(rows), /credential|synthetic-.*-secret|\/private/);
  }
  assert.equal(JSON.stringify(events), before);
});

it("缺失、相对及 opaque URL 不推造 origin 或存储 partition", () => {
  for (const url of [undefined, "", "/relative", "not a url", "about:blank", "data:text/plain,opaque", "file:///synthetic", "blob:https://shop.example/id"]) {
    const event = { id: "unknown", sessionId: "session", tabId: 2, frameId: 0, documentId: "doc", url: "https://not-document.example",
      kind: "storage.snapshot", payload: { url, origin: "https://invented.example", storageKey: "untrusted-key", partitionKey: { topLevelSite: "https://top.example" } } };
    const source = browserObservationSource(event, { path: "timeline/events.jsonl", line: 2 });
    assert.equal(source.identity.origin, null);
    assert.equal(source.identity.originBasis, "unknown");
    assert.deepEqual(source.identity.storagePartition, { status: "unknown" });
    assert.equal(browserStorageNamespace(source).scope, "event");
  }
});

it("只接受明确事件 metadata 的可选 storage key/instance，缺失或非字符串标 unknown", () => {
  const event = { id: "observed", sessionId: "session", tabId: 1, frameId: 0, documentId: "doc", storageKey: "observed-key-A",
    storageInstanceId: "observed-instance-A", payload: { url: "https://shop.example/path", graphCaptureId: "graph", catalogId: "catalog" } };
  const source = browserObservationSource(event, {});
  assert.deepEqual(source.identity.storagePartition, { status: "observed", storageKey: "observed-key-A", basis: "event.storageKey" });
  assert.deepEqual(source.identity.storageInstance, { status: "observed", id: "observed-instance-A", basis: "event.storageInstanceId" });
  assert.equal(source.identity.graphCaptureId, "graph");
  assert.equal(source.identity.catalogId, "catalog");
  assert.equal(browserStorageNamespace(source).scope, "storage-key");
  for (const value of [null, "", {}, 0, false]) {
    const unknown = browserObservationSource({ ...event, storageKey: value, storageInstanceId: value });
    assert.deepEqual(unknown.identity.storagePartition, { status: "unknown" });
    assert.deepEqual(unknown.identity.storageInstance, { status: "unknown" });
  }
});

it("分段重组与失败/缺失终态 fallback 保留完全相同的来源投影", () => {
  for (const kind of ["database.record", "storage.snapshot"]) {
    const field = kind === "database.record" ? "databaseGraph" : "storage";
    const reference = { captureId: "fragment", field, parts: 1, length: 10 };
    const event = { id: "record", sessionId: "session", tabId: 4, frameId: 3, documentId: "document", kind,
      payload: { url: "https://shop.example/start", database: "db", store: "items", index: 5, graphCaptureId: "graph", catalogId: "catalog",
        status: "fragmented", ...(kind === "database.record" ? { graphReference: reference } : { storageReference: reference }) } };
    const evidence = { path: "timeline/events.jsonl", line: 9, fragmentCaptureId: "fragment" };
    const decoded = kind === "database.record" ? { root: { type: "string", value: "synthetic-decoded-secret" }, nodes: [] }
      : { url: "https://other.example/ignored", storageKey: "ignored", stores: { localStorage: { token: "synthetic-decoded-secret" } } };
    const before = JSON.stringify({ event, decoded, evidence });
    const rows = [...observeBrowserData(event, evidence, decoded)];
    for (const reason of ["分段传输失败", "未收到分段结束确认"]) {
      const fallback = incompleteBrowserObservation(event, evidence, reason);
      assert.deepEqual(fallback.source, rows[0].source);
      assert.equal(fallback.schemaVersion, 2);
      assert.equal(fallback.status, "incomplete");
      assert.equal(fallback.reason, reason);
      assert.equal(fallback.source.identity.fragmentCaptureId, "fragment");
      assert.equal(fallback.source.identity.origin, "https://shop.example");
      assert.doesNotMatch(JSON.stringify(fallback), /synthetic-decoded-secret|other\.example/);
      assert.equal(fallback.domain, kind === "database.record" ? "indexeddb" : "storage");
      if (kind === "database.record") assert.equal(fallback.index, 5);
    }
    assert.equal(JSON.stringify({ event, decoded, evidence }), before);
  }
});

it("archive 的失败和缺少结束确认分支共用 incomplete 来源 helper（静态连线检查）", async () => {
  const code = await readFile(new URL("../src/archive.js", import.meta.url), "utf8");
  assert.match(code, /incompleteBrowserObservation\(pending\.event, pending\.evidence, String\(error\)\)/);
  assert.match(code, /incompleteBrowserObservation\(pending\.event, pending\.evidence, "未收到分段结束确认"\)/);
  assert.doesNotMatch(code, /source: \{ eventId: pending\.event\.id/);
});
