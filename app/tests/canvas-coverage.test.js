import { it } from "node:test";
import assert from "node:assert/strict";
import { indexCanvasEvidence } from "../src/canvas-coverage.js";

it("画布像素缺失、重复或分段未确认时保留缺口", () => {
  const item = { kind: "canvas.capture", seq: 1, payload: { snapshotId: "s", nodeId: "n", status: "fragmented", size: 3,
    reference: { length: 4 } } };
  const end = { kind: "canvas.captureEnd", seq: 2, payload: { snapshotId: "s", status: "captured", total: 1, processed: 1, failed: 0 } };
  assert.equal(indexCanvasEvidence([end, item], () => true)("s"), true);
  assert.equal(indexCanvasEvidence([end], () => true)("s"), false);
  assert.equal(indexCanvasEvidence([item, end], () => false)("s"), false);
  assert.equal(indexCanvasEvidence([item, item, end], () => true)("s"), false);
});
