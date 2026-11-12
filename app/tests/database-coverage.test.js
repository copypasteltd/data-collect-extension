import { it } from "node:test";
import assert from "node:assert/strict";
import { indexDatabaseEvidence } from "../src/database-coverage.js";

it("数据库记录缺失、重复和分段未确认时不标记完整", () => {
  const row = { kind: "database.record", seq: 1, payload: { graphCaptureId: "g", index: 0, status: "captured", graph: { issues: [] } } };
  const end = { kind: "database.recordsEnd", seq: 2, payload: { graphCaptureId: "g", total: 1, saved: 1, failed: 0, omitted: 0, status: "captured" } };
  const check = (events) => indexDatabaseEvidence(events, () => false)("g");
  assert.equal(check([end, row]), true);
  assert.equal(check([row]), false);
  assert.equal(check([end]), false);
  assert.equal(check([row, row, end]), false);
  assert.equal(check([{ ...row, payload: { ...row.payload, status: "fragmented" } }, end]), false);
});
