import { it } from "node:test";
import assert from "node:assert/strict";
import { countFullPageGaps } from "../src/full-page-coverage.js";

it("分片缺失、重复及结束记录缺失均标记截图缺口", () => {
  const start = { kind: "screenshot.fullPageStarted", payload: { captureRequestId: "r" } };
  const end = { kind: "screenshot.fullPage", payload: { captureRequestId: "r", captureId: "c", captureMode: "tiles", status: "captured", capturedTiles: 2, totalTiles: 2 } };
  const tile = (index) => ({ kind: "screenshot.fullPageTile", payload: { captureId: "c", index, assetId: `a${index}`, status: "captured" } });
  assert.equal(countFullPageGaps([start, tile(0), tile(1), end]), 0);
  assert.equal(countFullPageGaps([start, tile(0), end]), 1);
  assert.equal(countFullPageGaps([start, tile(0), tile(0), end]), 1);
  assert.equal(countFullPageGaps([start, start, tile(0), tile(1), end]), 1);
  assert.equal(countFullPageGaps([start, tile(0)]), 1);
  assert.equal(countFullPageGaps([{ kind: "screenshot.fullPage", payload: { status: "unavailable" } }]), 1);
});
