import { it } from "node:test";
import assert from "node:assert/strict";
import { indexComputedStyleEvidence } from "../src/computed-style-coverage.js";
import { packComputedEntries } from "../src/computed-style-encoder.js";

it("计算样式的缺批、重复批和缺失确认均作为缺口", () => {
  const batch = { kind: "page.computedStyle", seq: 1, payload: { snapshotId: "s", captureId: "c", batchIndex: 0, batchCount: 1,
    entries: [{ status: "captured" }] } };
  const end = { kind: "page.computedStyleEnd", seq: 2, payload: { snapshotId: "s", captureId: "c", status: "captured",
    enumerationStatus: "captured", total: 1, processed: 1, failures: 0 } };
  assert.equal(indexComputedStyleEvidence([end, batch])("s"), true);
  assert.equal(indexComputedStyleEvidence([end])("s"), false);
  assert.equal(indexComputedStyleEvidence([batch])("s"), false);
  assert.equal(indexComputedStyleEvidence([batch, batch, end])("s"), false);
  assert.equal(indexComputedStyleEvidence([batch, { ...end, seq: 0 }])("s"), false);
});

it("验证压缩批次，损坏内容不能标记为完整", async () => {
  const packed = await packComputedEntries([{ status: "captured", properties: [["--value", "x".repeat(3000)]] }]);
  const batch = { kind: "page.computedStyle", seq: 1, payload: { snapshotId: "s", captureId: "c", batchIndex: 0, batchCount: 1, ...packed } };
  const end = { kind: "page.computedStyleEnd", seq: 2, payload: { snapshotId: "s", captureId: "c", status: "captured", enumerationStatus: "captured", total: 1, processed: 1, failures: 0 } };
  assert.equal(indexComputedStyleEvidence([batch, end])("s"), true);
  assert.equal(indexComputedStyleEvidence([{ ...batch, payload: { ...batch.payload, entriesData: "invalid!" } }, end])("s"), false);
});
