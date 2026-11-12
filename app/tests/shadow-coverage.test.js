import { it } from "node:test";
import assert from "node:assert/strict";
import { indexShadowEvidence } from "../src/shadow-coverage.js";

it("关闭式组件结构缺失、重复或分段未确认时记录缺口", () => {
  const snapshot = { payload: { snapshotId: "s", shadowSourceCaptureId: "c" } };
  const root = { kind: "page.shadowRoot", seq: 1, payload: { snapshotId: "s", captureId: "c", rootNodeId: "r", hostNodeId: "h", length: 2, html: "ok", status: "captured" } };
  const end = { kind: "page.shadowRootEnd", seq: 2, payload: { snapshotId: "s", captureId: "c", total: 1, processed: 1, failures: 0, status: "captured" } };
  assert.equal(indexShadowEvidence([root, end], () => true)(snapshot), true);
  assert.equal(indexShadowEvidence([root], () => true)(snapshot), false);
  assert.equal(indexShadowEvidence([root, root, end], () => true)(snapshot), false);
  const fragmented = { ...root, payload: { ...root.payload, status: "fragmented", reference: { length: 2 } } };
  assert.equal(indexShadowEvidence([fragmented, end], () => false)(snapshot), false);
});
