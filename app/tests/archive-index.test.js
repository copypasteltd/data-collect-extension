import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { indexEvent } from "../src/archive-index.js";

describe("归档事件索引", () => {
  it("保留原始证据位置和明确记录的关联", () => {
    const event = { id: "event-1", seq: 9, time: 123, kind: "screenshot", tabId: 0,
      frameId: 0, documentId: "doc-1", payload: { assetId: "img-1", eventIds: ["event-0"], status: "shared" } };
    const row = indexEvent(event, "timeline/events-00002.jsonl", 3);
    assert.deepEqual(row.evidence, { path: "timeline/events-00002.jsonl", line: 3 });
    assert.equal(row.tabId, 0);
    assert.equal(row.documentId, "doc-1");
    assert.deepEqual(row.relatedEventIds, ["event-0"]);
    assert.equal(row.assetId, "img-1");
    assert.equal(row.status, "shared");
    assert.equal(row.association, "recorded");
  });
  it("不把缺失上下文和关联推断成已知值", () => {
    const row = indexEvent({ id: "e", seq: 1, time: 2, kind: "network.failed", payload: {} }, "timeline/events-00001.jsonl", 1);
    assert.equal(row.category, "network");
    assert.equal(row.tabId, null);
    assert.equal(row.requestId, null);
    assert.deepEqual(row.relatedEventIds, []);
  });
});
