import { it } from "node:test";
import assert from "node:assert/strict";
import { indexCacheEvidence } from "../src/cache-coverage.js";

it("缓存条目或正文缺失、重复和不可读时不能标记完整", () => {
  const item = { kind: "cache.entry", seq: 1, payload: { snapshotId: "s", index: 0, status: "captured",
    body: { status: "captured", encoding: "base64", size: 3, data: "YWJj" } } };
  const snapshot = { kind: "cache.snapshot", seq: 2, payload: { snapshotId: "s", status: "captured", total: 1 } };
  const check = (events) => indexCacheEvidence(events, () => false)(snapshot);
  assert.equal(check([item]), true);
  assert.equal(check([]), false);
  assert.equal(check([item, item]), false);
  assert.equal(check([{ ...item, payload: { ...item.payload, status: "opaque" } }]), false);
  assert.equal(check([{ ...item, payload: { ...item.payload, body: { ...item.payload.body, data: "bad" } } }]), false);
});
