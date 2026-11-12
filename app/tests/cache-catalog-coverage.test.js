import { it } from "node:test";
import assert from "node:assert/strict";
import { indexCacheCatalogEvidence } from "../src/cache-catalog-coverage.js";

it("缓存目录必须完整记录每个缓存及结束确认", () => {
  const catalog = { kind: "cache.catalog", seq: 1, payload: { catalogId: "c", count: 1, names: ["raw-name"], status: "captured" } };
  const snapshot = { kind: "cache.snapshot", seq: 2, payload: { catalogId: "c", catalogIndex: 0, status: "unavailable" } };
  const end = { kind: "cache.catalogEnd", seq: 3, payload: { catalogId: "c", count: 1, processed: 1, status: "captured" } };
  assert.equal(indexCacheCatalogEvidence([catalog, snapshot, end], () => true)(catalog), true);
  assert.equal(indexCacheCatalogEvidence([catalog, end], () => true)(catalog), false);
  assert.equal(indexCacheCatalogEvidence([catalog, snapshot, snapshot, end], () => true)(catalog), false);
  assert.equal(indexCacheCatalogEvidence([catalog, snapshot], () => true)(catalog), false);
  const fragmented = { ...catalog, payload: { ...catalog.payload, status: "fragmented", reference: {} } };
  assert.equal(indexCacheCatalogEvidence([fragmented, snapshot, end], () => false)(fragmented), false);
});
