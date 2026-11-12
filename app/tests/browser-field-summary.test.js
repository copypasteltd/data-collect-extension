import { it } from "node:test";
import assert from "node:assert/strict";
import { createBrowserFieldSummary } from "../src/browser-field-summary.js";

it("按数据库和仓库汇总字段样本、类型冲突及来源", () => {
  const summary = createBrowserFieldSummary();
  for (const [eventId, type] of [["a", "string"], ["b", "number"]]) {
    const base = { domain: "indexeddb", database: "db", store: "items", source: { eventId, path: "timeline/a.jsonl", line: eventId === "a" ? 1 : 2 } };
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
});
