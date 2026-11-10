import { it } from "node:test";
import assert from "node:assert/strict";
import { recoverPendingRequests, recoverRootSockets, recoverChildSockets } from "../src/network-recovery.js";

const tabs = { 1: { debuggerAttached: true }, 2: { debuggerAttached: true, closed: true }, 3: { debuggerAttached: false } };
const request = (id, seq, tabId = 1, postData = { status: "empty" }) => ({
  kind: "network.request", seq, tabId,
  payload: { requestId: id, tabId, protocolSessionId: "[已隐藏]", postData },
});
const event = (kind, id, seq, extra = {}) => ({ kind, seq, payload: { requestId: id, ...extra } });

it("按保存顺序恢复未完成请求及其响应和请求体", () => {
  const events = [
    request("1:root:pending", 1, 1, { status: "pending" }),
    event("network.response", "1:root:pending", 2, { mimeType: "application/json" }),
    event("network.requestBody", "1:root:pending", 3, { body: { status: "captured_redacted", value: "body" } }),
    request("1:root:done", 4),
    event("network.finished", "1:root:done", 5),
    request("1:child-session:active", 6),
    request("2:root:closed", 7, 2),
    request("3:root:detached", 8, 3),
    request("invalid-id", 9),
  ];
  const restored = recoverPendingRequests(events.reverse(), tabs);
  assert.deepEqual([...restored.keys()].sort(), ["1:child-session:active", "1:root:pending"]);
  assert.equal(restored.get("1:root:pending").response.mimeType, "application/json");
  assert.equal(restored.get("1:root:pending").postData.value, "body");
});

it("重定向和请求标识复用不会混入已结束的请求", () => {
  const base = "1:root:redirected";
  const redirected = `${base}:redirect:01234567-89ab-cdef-0123-456789abcdef`;
  const events = [
    request(base, 1),
    event("network.finished", base, 2),
    request(redirected, 3),
    event("network.response", redirected, 4, { mimeType: "text/plain" }),
    event("network.failed", base, 5),
  ];
  const restored = recoverPendingRequests(events, tabs);
  assert.equal(restored.size, 1);
  assert.equal(restored.get(base).requestId, redirected);
  assert.equal(restored.get(base).response.mimeType, "text/plain");
  events.push(event("network.finished", redirected, 6));
  assert.equal(recoverPendingRequests(events, tabs).size, 0);
});

it("只恢复当前页面实例中已验证且未关闭的顶层连接", () => {
  const currentTabs = { 1: { debuggerAttached: true, inScope: true } };
  const documents = new Map([[1, "doc-a"]]);
  const snapshot = { kind: "page.snapshot", tabId: 1, frameId: 0, documentId: "doc-a", time: 10, seq: 1, payload: {} };
  const created = { kind: "network.websocket", tabId: 1, time: 20, seq: 2,
    payload: { requestId: "1:root:socket", type: "webSocketCreated", url: "ws://example.test/" } };
  const events = [snapshot, created];
  assert.equal(recoverRootSockets(events, currentTabs, documents).get("1:root:socket").allowed, true);
  assert.equal(recoverRootSockets(events, currentTabs, new Map([[1, "doc-b"]])).size, 0);
  assert.equal(recoverRootSockets(events, { 1: { ...currentTabs[1], inScope: false } }, documents).size, 0);
  assert.equal(recoverRootSockets(events, { 1: { ...currentTabs[1], closed: true } }, documents).size, 0);
  assert.equal(recoverRootSockets([created], currentTabs, documents).size, 0);
  assert.equal(recoverRootSockets([{ ...snapshot, time: 20 }, created], currentTabs, documents).size, 0);
  assert.equal(recoverRootSockets([snapshot, { ...created, payload: { ...created.payload, requestId: "1:child:socket" } }], currentTabs, documents).size, 0);
  assert.equal(recoverRootSockets([...events, { ...created, seq: 3, time: 30,
    payload: { ...created.payload, type: "webSocketClosed" } }], currentTabs, documents).size, 0);
});

it("导航后或发生时间无法区分时不恢复旧连接", () => {
  const currentTabs = { 1: { debuggerAttached: true, inScope: true } };
  const documents = new Map([[1, "doc-a"]]);
  const snapshot = { kind: "page.snapshot", tabId: 1, frameId: 0, documentId: "doc-a", time: 10, seq: 1, payload: {} };
  const created = { kind: "network.websocket", tabId: 1, time: 20, seq: 2,
    payload: { requestId: "1:root:socket", type: "webSocketCreated" } };
  const nav = { kind: "navigation.committed", tabId: 1, frameId: 0, time: 30, seq: 3,
    payload: { documentId: "doc-b" } };
  assert.equal(recoverRootSockets([snapshot, created, nav], currentTabs, documents).size, 0);
  assert.equal(recoverRootSockets([snapshot, created, { ...nav, time: 20 }], currentTabs, documents).size, 0);
  assert.equal(recoverRootSockets([snapshot, created, { ...nav, time: 15 }], currentTabs, documents).size, 0);
  assert.equal(recoverRootSockets([snapshot, created, { ...nav, tabId: 2 }], currentTabs, documents).size, 1);
});

it("仅恢复经过授权且页面实例未变化的跨进程框架连接", () => {
  const frameTabs = { 1: { debuggerAttached: true, inScope: true } };
  const targets = new Map([["child", 1]]);
  const documents = new Map([["child", { loaderId: "loader-a", url: "https://frame.test/current" }]]);
  const created = { kind: "network.websocket", tabId: 1, time: 10, seq: 1, payload: {
    requestId: "1:child:socket", type: "webSocketCreated", url: "wss://socket.test/",
    frameLoaderId: "loader-a", frameUrl: "https://frame.test/initial",
  } };
  assert.equal(recoverChildSockets([created], frameTabs, targets, documents).get("1:child:socket").allowed, true);
  assert.equal(recoverChildSockets([created], frameTabs, targets, new Map([["child", { loaderId: "loader-b", url: "https://frame.test/" }]])).size, 0);
  assert.equal(recoverChildSockets([created], frameTabs, targets, new Map([["child", { loaderId: "loader-a", url: "https://other.test/" }]])).size, 0);
  assert.equal(recoverChildSockets([created], frameTabs, new Map([["child", 2]]), documents).size, 0);
  assert.equal(recoverChildSockets([created], { 1: { ...frameTabs[1], inScope: false } }, targets, documents).size, 0);
  assert.equal(recoverChildSockets([{ ...created, payload: { ...created.payload, frameLoaderId: undefined } }], frameTabs, targets, documents).size, 0);
  assert.equal(recoverChildSockets([created, { ...created, seq: 2, payload: { ...created.payload, type: "webSocketClosed" } }], frameTabs, targets, documents).size, 0);
});
