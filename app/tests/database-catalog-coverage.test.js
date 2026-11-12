import { it } from "node:test";
import assert from "node:assert/strict";
import { indexDatabaseCatalogEvidence } from "../src/database-catalog-coverage.js";

it("数据库目录必须确认每一项及结束记录，空目录与中断可区分", () => {
  const catalog = { seq: 1, kind: "database.catalog", payload: { catalogId: "c", count: 1, status: "captured", databases: [{ name: "a", version: 1 }] } };
  const snapshot = { seq: 2, kind: "database.snapshot", payload: { catalogId: "c", catalogIndex: 0 } };
  const end = { seq: 3, kind: "database.catalogEnd", payload: { catalogId: "c", count: 1, processed: 1, status: "captured" } };
  const complete = (events) => indexDatabaseCatalogEvidence(events, () => true)(catalog);
  assert.equal(complete([catalog, snapshot, end]), true);
  assert.equal(complete([catalog, snapshot]), false);
  assert.equal(complete([catalog, snapshot, { ...snapshot, seq: 2.5 }, end]), false);
  assert.equal(complete([catalog, { ...snapshot, payload: { ...snapshot.payload, catalogIndex: 1 } }, end]), false);
  assert.equal(complete([catalog, snapshot, end, end]), false);
  const empty = { ...catalog, payload: { ...catalog.payload, count: 0, databases: [] } };
  const emptyEnd = { ...end, payload: { ...end.payload, count: 0, processed: 0 } };
  assert.equal(indexDatabaseCatalogEvidence([empty, emptyEnd], () => true)(empty), true);
  assert.equal(indexDatabaseCatalogEvidence([empty], () => true)(empty), false);
  const fragmented = { ...catalog, payload: { ...catalog.payload, status: "fragmented", reference: { captureId: "r" } } };
  assert.equal(indexDatabaseCatalogEvidence([fragmented, snapshot, end], () => false)(fragmented), false);
});
