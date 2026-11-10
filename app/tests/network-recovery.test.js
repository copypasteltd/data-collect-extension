import { it } from "node:test";
import assert from "node:assert/strict";
import { recoverPendingRequests } from "../src/network-recovery.js";

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
