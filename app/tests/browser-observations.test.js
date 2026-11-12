import { it } from "node:test";
import assert from "node:assert/strict";
import { observeBrowserData } from "../src/browser-observations.js";

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
