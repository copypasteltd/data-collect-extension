import { it } from "node:test";
import assert from "node:assert/strict";
import { directRelationships } from "../src/relationships.js";

it("仅输出事件直接记录的关系并保留证据位置", () => {
  const screenshot = { id: "shot", kind: "screenshot", payload: { eventIds: ["click-a", "click-b"], assetId: "asset" } };
  const rows = [...directRelationships(screenshot, { path: "timeline/events-00001.jsonl", line: 4 })];
  assert.deepEqual(rows.map((row) => [row.relation, row.targetId]), [["screenshot_of", "click-a"], ["screenshot_of", "click-b"], ["asset", "asset"]]);
  assert.ok(rows.every((row) => row.confidence === "recorded" && row.source.line === 4));
  const tree = { id: "tree", tabId: 7, kind: "frame.tree", payload: { frames: [
    { frameId: 0, parentFrameId: -1 }, { frameId: 2, parentFrameId: 0, documentId: "child" },
  ] } };
  const [frame] = [...directRelationships(tree, { path: "t", line: 1 })];
  assert.equal(frame.frameId, 2);
  assert.equal(frame.parentFrameId, 0);
  assert.equal(frame.tabId, 7);
});

it("区分数据库与缓存目录，其他事件不会产生错误目录关系", () => {
  const make = (kind) => [...directRelationships({ id: "e", kind, payload: { catalogId: "c" } }, { path: "t", line: 1 })];
  assert.deepEqual(make("database.snapshot").map((edge) => [edge.relation, edge.targetType]), [["database_catalog", "database-catalog"]]);
  assert.deepEqual(make("database.catalogEnd").map((edge) => edge.relation), ["database_catalog"]);
  assert.deepEqual(make("cache.snapshot").map((edge) => [edge.relation, edge.targetType]), [["cache_catalog", "cache-catalog"]]);
  assert.equal(make("database.catalog").length, 0);
  assert.equal(make("cache.catalog").length, 0);
  assert.equal(make("other.event").length, 0);
});
