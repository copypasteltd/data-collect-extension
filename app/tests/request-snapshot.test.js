import { it } from "node:test";
import assert from "node:assert/strict";
import { matchesRequestSnapshot, requestSnapshotCursor } from "../src/request-snapshot.js";

const snapshot = { id: "snapshot", tabId: 1, frameId: 0, documentId: "doc-a", time: 10, seq: 10,
  payload: { url: "https://example.test/a#list" } };
const request = { id: "request", tabId: 1, time: 20, seq: 20,
  payload: { documentUrl: "https://example.test/a" } };

it("仅关联同一标签和可确认的请求页面", () => {
  assert.equal(matchesRequestSnapshot([], snapshot, request), true);
  assert.equal(matchesRequestSnapshot([], snapshot, { ...request, tabId: 2 }), false);
  assert.equal(matchesRequestSnapshot([], snapshot, { ...request, payload: { documentUrl: "https://example.test/b" } }), false);
  assert.equal(matchesRequestSnapshot([], { ...snapshot, documentId: undefined }, request), true);
});

it("同页完成时保留完成时刻，跳转后的延迟响应回到请求时刻", () => {
  const response = { id: "response", tabId: 1, time: 30, seq: 30 };
  const nav = { tabId: 1, frameId: 0, kind: "navigation.committed", time: 25, seq: 25 };
  assert.equal(requestSnapshotCursor([], request, response), response);
  assert.equal(requestSnapshotCursor([nav], request, response), request);
  assert.equal(requestSnapshotCursor([{ ...nav, tabId: 2 }], request, response), response);
  assert.equal(requestSnapshotCursor([{ ...nav, time: 31 }], request, response), response);
});

it("遇到后续导航或不同页面实例时不复用旧快照", () => {
  const nav = { tabId: 1, frameId: 0, kind: "navigation.committed", time: 15, seq: 15,
    payload: { documentId: "doc-b" } };
  assert.equal(matchesRequestSnapshot([nav], snapshot, request), false);
  assert.equal(matchesRequestSnapshot([{ ...nav, payload: {} }], snapshot, request), false);
  assert.equal(matchesRequestSnapshot([{ ...nav, payload: { documentId: "doc-a" } }], snapshot, request), true);
  assert.equal(matchesRequestSnapshot([{ ...nav, time: 9, payload: { documentId: "doc-b" } }], snapshot, request), false);
  assert.equal(matchesRequestSnapshot([{ ...nav, tabId: 2 }], snapshot, request), true);
  assert.equal(matchesRequestSnapshot([{ ...nav, time: 21 }], snapshot, request), true);
  for (const kind of ["navigation", "navigation.spa", "navigation.hash", "navigation.popstate"])
    assert.equal(matchesRequestSnapshot([{ ...nav, kind, frameId: null }], snapshot, request), false, kind);
});
