import { it } from "node:test";
import assert from "node:assert/strict";
import { createEventDelivery } from "../src/delivery.js";

it("按顺序等待采集消息确认，并统计失败的事件", async () => {
  let release;
  const sent = [];
  const delivery = createEventDelivery(async (events) => {
    sent.push(events[0]);
    if (events[0] === "first")
      return await new Promise((resolve) => {
        release = resolve;
      });
    if (events[0] === "rejected") throw new Error("连接失败");
    return { ok: false };
  });
  delivery.enqueue(["first"]);
  delivery.enqueue(["rejected", "also-lost"]);
  delivery.enqueue(["unaccepted"]);
  await Promise.resolve();
  assert.deepEqual(sent, ["first"]);
  release({ ok: true, value: true });
  await delivery.flush();
  assert.deepEqual(sent, ["first", "rejected", "unaccepted"]);
  assert.equal(delivery.failedEvents, 3);
});

it("对部分写入失败只统计未确认的事件，拒绝不一致的确认", async () => {
  const delivery = createEventDelivery(async (events) => events[0] === "partial"
    ? { ok: true, value: { accepted: 2, failed: 1 } }
    : { ok: true, value: { accepted: 99, failed: 0 } });
  await delivery.enqueue(["partial", "saved", "failed"]);
  assert.equal(delivery.failedEvents, 1);
  await delivery.enqueue(["invalid", "unknown"]);
  assert.equal(delivery.failedEvents, 3);
});
