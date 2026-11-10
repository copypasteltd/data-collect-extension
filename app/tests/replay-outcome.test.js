import { it } from "node:test";
import assert from "node:assert/strict";
import { findReplayOutcome } from "../src/replay-outcome.js";

const step = { id: "step", kind: "interaction.click", time: 1, seq: 1, tabId: 1, frameId: 0, documentId: "old", payload: { url: "https://example.test/" } };
const snapshot = (id, time, extra = {}) => ({ id, kind: "page.snapshot", time, seq: time, tabId: 1, frameId: 0, documentId: "new", payload: { url: "https://example.test/next", html: "<html></html>" }, ...extra });

it("结束时选择同一页面框架中最后记录的快照", () => {
  const earlier = snapshot("earlier", 2), last = snapshot("last", 4, { payload: { url: "https://example.test/next", html: "<html></html>", reason: "stop" } });
  const unrelated = snapshot("other", 5, { tabId: 2 });
  const result = findReplayOutcome([unrelated, last, earlier], step);
  assert.equal(result.event.id, "last");
  assert.equal(result.label, "录制停止时的页面状态");
});

it("后续跳转没有新快照时不会展示跳转前的页面", () => {
  const navigation = { id: "nav", kind: "navigation.committed", time: 3, seq: 3, tabId: 1, frameId: 0, payload: {} };
  assert.equal(findReplayOutcome([snapshot("before-nav", 2), navigation], step), null);
  assert.equal(findReplayOutcome([navigation], step), null);
  assert.equal(findReplayOutcome([navigation, snapshot("after-nav", 4)], step).event.id, "after-nav");
});

it("没有后续快照时只使用同一页面的已记录变化", () => {
  const mutation = { id: "mutation", kind: "page.mutation", time: 2, seq: 2, tabId: 1, frameId: 0, documentId: "old", payload: { url: step.payload.url } };
  const other = { ...mutation, id: "other", time: 3, seq: 3, documentId: "other" };
  assert.equal(findReplayOutcome([other, mutation], step).event.id, "mutation");
  assert.equal(findReplayOutcome([other], step), null);
  assert.equal(findReplayOutcome([], { ...step, kind: "interaction.input" }).event.id, "step");
});

it("记录到新标签页被激活时显示该标签的后续页面", () => {
  const created = { kind: "tab.created", time: 2, seq: 2, payload: { tabId: 2, openerTabId: 1 } };
  const activated = { kind: "tab.activated", time: 3, seq: 3, payload: { tabId: 2 } };
  const child = snapshot("child", 4, { tabId: 2 });
  const original = snapshot("original", 5);
  assert.equal(findReplayOutcome([original, child, activated, created], step).event.id, "child");
  assert.equal(findReplayOutcome([original, activated, created], step), null);
  const back = { kind: "tab.activated", time: 6, seq: 6, payload: { tabId: 1 } };
  assert.equal(findReplayOutcome([original, child, activated, created, back], step).event.id, "original");
  const existing = findReplayOutcome([original, child, activated], step);
  assert.equal(existing.event.id, "child");
  assert.equal(existing.label, "后续激活的标签页状态");
});
