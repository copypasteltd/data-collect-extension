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
  }, { retryDelay: 0 });
  delivery.enqueue(["first"]);
  delivery.enqueue(["rejected", "also-lost"]);
  delivery.enqueue(["unaccepted"]);
  await new Promise(setImmediate);
  assert.deepEqual(sent, ["first"]);
  release({ ok: true, value: true });
  await delivery.flush();
  assert.deepEqual(sent, ["first", "rejected", "rejected", "rejected", "unaccepted"]);
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

it("限制待发送事件数量及估算体积，并在队列排空后恢复接收", async () => {
  let release;
  const notices = [], sent = [];
  const delivery = createEventDelivery(async (events) => {
    sent.push(events);
    if (events[0] === "first") await new Promise((resolve) => { release = resolve; });
    return { ok: true, value: true };
  }, { maxEvents: 2, maxBytes: 1000, onOverflow: (count) => notices.push(count) });
  delivery.enqueue(["first", "second"]);
  await new Promise(setImmediate);
  delivery.enqueue(["overflow"]);
  assert.equal(delivery.failedEvents, 1);
  assert.deepEqual(notices, [1]);
  release();
  await delivery.flush();
  await delivery.enqueue(["later"]);
  assert.deepEqual(sent, [["first", "second"], ["later"]]);
  const small = createEventDelivery(async () => ({ ok: true, value: true }), { maxEvents: 10, maxBytes: 20 });
  await small.enqueue(["x".repeat(100)]);
  assert.equal(small.failedEvents, 1);
});

it("通信异常时使用同一批次标识重试，明确拒绝时不重试", async () => {
  const ids = [];
  const delivery = createEventDelivery(async (_events, batchId) => {
    ids.push(batchId);
    if (ids.length < 3) throw new Error("连接中断");
    return { ok: true, value: { accepted: 1, failed: 0 } };
  }, { retryDelay: 0 });
  await delivery.enqueue(["event"]);
  assert.equal(delivery.failedEvents, 0);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1);
  let attempts = 0;
  const rejected = createEventDelivery(async () => { attempts++; return { ok: false }; }, { retryDelay: 0 });
  await rejected.enqueue(["event"]);
  assert.equal(attempts, 1);
  assert.equal(rejected.failedEvents, 1);
});

it("重试期间可接受先前请求迟到的确认", async () => {
  const pending = [], ids = [];
  const delivery = createEventDelivery((_events, batchId) => {
    ids.push(batchId);
    return new Promise((resolve) => pending.push(resolve));
  }, { timeoutMs: 15, retryDelay: 0 });
  const result = delivery.enqueue(["event"]);
  for (let i = 0; i < 100 && pending.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.equal(pending.length, 2);
  pending[0]({ ok: true, value: { accepted: 1, failed: 0 } });
  await result;
  assert.equal(delivery.failedEvents, 0);
  assert.equal(new Set(ids).size, 1);
  pending[1]({ ok: true, value: { accepted: 1, failed: 0 } });
});

it("无响应请求达到上限时停止新增请求，收到迟到结果后恢复", async () => {
  const pending = [], notices = [];
  let calls = 0;
  const delivery = createEventDelivery((events) => {
    calls++;
    if (events[0] === "later") return { ok: true, value: true };
    return new Promise((resolve) => pending.push(resolve));
  }, { timeoutMs: 10, retryDelay: 0, onUnresponsive: () => notices.push(true) });
  await delivery.enqueue(["stalled"]);
  assert.equal(calls, 3);
  assert.equal(delivery.failedEvents, 1);
  assert.equal(notices.length, 1);
  await delivery.enqueue(["blocked"]);
  assert.equal(calls, 3);
  assert.equal(delivery.failedEvents, 2);
  pending[0]({ ok: true, value: true });
  await new Promise(setImmediate);
  await delivery.enqueue(["later"]);
  assert.equal(calls, 4);
  assert.equal(delivery.failedEvents, 2);
  for (const resolve of pending.slice(1)) resolve({ ok: true, value: true });
});
