import { it } from "node:test";
import assert from "node:assert/strict";
import { createInterfaceIndex } from "../src/interface-index.js";

it("按方法和路径聚合请求并保留来源上下文，不推断因果", () => {
  const index = createInterfaceIndex();
  const base = { kind: "network.request", tabId: 1, payload: { method: "GET", url: "https://example.test/api?a=1&a=2", requestId: "r1", documentUrl: "https://example.test/page", frameId: "f1" } };
  index.add({ ...base, id: "one" }, "timeline/a", 1);
  index.add({ ...base, id: "two", tabId: 2, payload: { ...base.payload, url: "https://example.test/api?a=3", requestId: "r2" } }, "timeline/a", 2);
  index.add({ ...base, id: "post", payload: { ...base.payload, method: "POST", requestId: "r3" } }, "timeline/a", 3);
  index.add({ ...base, id: "bad", payload: { ...base.payload, url: "invalid" } }, "timeline/a", 4);
  const rows = [...index.results()];
  assert.equal(rows.length, 2);
  assert.equal(rows[0].requests, 2);
  assert.equal(rows[0].contexts.length, 2);
  assert.equal(rows[0].association, "recorded_context_only");
  assert.deepEqual(rows[0].evidence.map((item) => item.requestId), ["r1", "r2"]);
  assert.equal(index.unindexableCount, 1);
});
