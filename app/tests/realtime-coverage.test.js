import { it } from "node:test";
import assert from "node:assert/strict";
import { countRealtimeGaps } from "../src/realtime-coverage.js";

it("实时消息附件需要唯一的成功结束记录", () => {
  const start = { kind: "network.websocketFrame", seq: 1, payload: { data: { status: "pending_asset", captureId: "c" } } };
  const end = { kind: "network.realtimePayload", seq: 2, payload: { captureId: "c", status: "captured_asset", assetId: "a" } };
  assert.equal(countRealtimeGaps([start, end]), 0);
  assert.equal(countRealtimeGaps([start]), 1);
  assert.equal(countRealtimeGaps([start, end, end]), 1);
  assert.equal(countRealtimeGaps([start, { ...end, payload: { ...end.payload, status: "unavailable" } }]), 1);
  assert.equal(countRealtimeGaps([{ kind: "network.eventSourceMessage", payload: { data: { status: "omitted_size" } } }]), 1);
});
