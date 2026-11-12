import { it } from "node:test";
import assert from "node:assert/strict";
import { indexRequestEntryEvidence } from "../src/request-entry-coverage.js";

it("请求体条目缺失、顺序错误或不可读时保留缺口", () => {
  const request = { kind: "network.request", seq: 1, payload: { requestId: "r", postDataEntriesCount: 1 } };
  const result = { kind: "network.requestDataEntries", seq: 2, payload: { requestId: "r", status: "captured",
    entries: [{ index: 0, status: "captured", assetId: "a", size: 3 }] } };
  assert.equal(indexRequestEntryEvidence([result])(request), true);
  assert.equal(indexRequestEntryEvidence([])(request), false);
  assert.equal(indexRequestEntryEvidence([result, result])(request), false);
  assert.equal(indexRequestEntryEvidence([{ ...result, seq: 0 }])(request), false);
});
