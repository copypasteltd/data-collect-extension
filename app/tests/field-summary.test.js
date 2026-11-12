import { it } from "node:test";
import assert from "node:assert/strict";
import { createFieldSummary } from "../src/field-summary.js";

it("汇总观察次数、样本数和类型冲突，不把未解析样本当作字段缺失", () => {
  const summary = createFieldSummary();
  const endpoint = { method: "GET", url: "https://example.test/api" };
  const source = (eventId) => ({ endpoint, direction: "response", eventId });
  summary.add({ kind: "sample", source: source("a"), status: "parsed_json" });
  summary.add({ kind: "field", source: source("a"), location: [{ key: "x", occurrence: 0 }], type: "number" });
  summary.add({ kind: "field", source: source("a"), location: [{ key: "x", occurrence: 1 }], type: "number" });
  summary.add({ kind: "sample", source: source("b"), status: "parsed_json" });
  summary.add({ kind: "field", source: source("b"), location: [{ key: "x", occurrence: 0 }], type: "null" });
  summary.add({ kind: "sample", source: source("c"), status: "not_parsed_as_json" });
  const [row] = [...summary.results()];
  assert.equal(row.occurrences, 3);
  assert.equal(row.observedSamples, 2);
  assert.deepEqual(row.sampleCounts, { total: 3, parsed: 2 });
  assert.equal(row.typeConflict, true);
  assert.deepEqual({ ...row.types }, { number: 2, null: 1 });
  assert.equal(row.evidence, "fieldObservationChunks");
});
