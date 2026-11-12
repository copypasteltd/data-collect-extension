import { it } from "node:test";
import assert from "node:assert/strict";
import { rawMutationComplete } from "../src/mutation-coverage.js";

it("原始变更缺失、不可读或分段未确认时不标记完整", () => {
  const change = { type: "attribute", before: { status: "captured", value: null },
    value: { status: "fragmented", reference: { captureId: "v" } } };
  const event = { payload: { rawChanges: [change] } };
  assert.equal(rawMutationComplete(event, () => true), true);
  assert.equal(rawMutationComplete(event, () => false), false);
  assert.equal(rawMutationComplete({ payload: {} }, () => true), false);
  assert.equal(rawMutationComplete({ payload: { rawChanges: [{ type: "children", added: [{ status: "unavailable" }], removed: [] }] } }, () => true), false);
});
