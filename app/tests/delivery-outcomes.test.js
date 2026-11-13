// Written for isolated verification; NOT RUN during the 2026-11-13 static-only repair.
import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEventDelivery } from "../src/delivery.js";
import { createCaptureCompletion, isBatchConfirmed, requireBatchConfirmed } from "../src/batch-outcome.js";

const turn = () => new Promise(setImmediate);
const accepted = { ok: true, value: true };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function counts(outcome) { return [outcome.accepted, outcome.failed, outcome.unknown]; }

it("unrelated E rejection cannot contaminate the queued F acknowledgement", async () => {
  const gate = deferred(), sent = [];
  const delivery = createEventDelivery((events) => {
    sent.push(events[0]);
    return events[0] === "E" ? gate.promise : accepted;
  });
  const e = delivery.enqueue(["E"]);
  const f = delivery.enqueue(["F"]);
  await turn();
  assert.deepEqual(sent, ["E"]);
  gate.resolve({ ok: true, value: false });
  const [rejected, confirmed] = await Promise.all([e, f]);
  assert.equal(rejected.status, "rejected");
  assert.deepEqual(counts(rejected), [0, 1, 0]);
  assert.equal(confirmed.status, "confirmed");
  assert.deepEqual(counts(confirmed), [1, 0, 0]);
  assert.notEqual(rejected.batchId, confirmed.batchId);
  assert.equal(delivery.failedEvents, 1);
  assert.equal(delivery.unknownEvents, 0);
});

it("partial counts and frozen bounded outcomes belong only to their batch", async () => {
  const delivery = createEventDelivery((events) => events.length === 3
    ? { ok: true, value: { accepted: 2, failed: 1 } } : accepted);
  const partial = await delivery.enqueue(["a", "b", "c"]);
  const next = await delivery.enqueue(["d"]);
  assert.equal(partial.status, "partial");
  assert.deepEqual(counts(partial), [2, 1, 0]);
  assert.equal(partial.reason, "write_rejection");
  assert.equal(next.status, "confirmed");
  assert.deepEqual(counts(next), [1, 0, 0]);
  assert.ok(Object.isFrozen(partial));
  assert.deepEqual(Object.keys(partial).sort(), ["accepted", "batchId", "failed", "reason", "status", "unknown"]);
  assert.match(partial.batchId, uuid);
  assert.match(next.batchId, uuid);
  assert.throws(() => { partial.failed = 0; }, TypeError);
});

it("explicit pre-append rejection stops without retry", async () => {
  for (const reply of [{ ok: true, value: false }]) {
    let calls = 0;
    const delivery = createEventDelivery(() => { calls++; return reply; }, { retryDelay: 0 });
    const outcome = await delivery.enqueue(["rejected"]);
    assert.equal(calls, 1);
    assert.equal(outcome.status, "rejected");
    assert.equal(outcome.reason, "explicit_rejection");
    assert.deepEqual(counts(outcome), [0, 1, 0]);
  }
});

it("bare error reply may follow commit, so it is unknown and is not retried", async () => {
  let calls = 0;
  const delivery = createEventDelivery(() => {
    calls++;
    return { ok: false, error: "synthetic post-commit error" };
  }, { retryDelay: 0 });
  const outcome = await delivery.enqueue(["maybe committed"]);
  assert.equal(calls, 1);
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.reason, "error_response");
  assert.deepEqual(counts(outcome), [0, 0, 1]);
  assert.equal(delivery.failedEvents, 0);
  assert.equal(delivery.unknownEvents, 1);
});

it("a rejection after a transport-unknown attempt cannot prove the whole batch was not committed", async () => {
  let calls = 0;
  const delivery = createEventDelivery(() => {
    if (++calls === 1) throw new Error("first reply lost");
    return { ok: true, value: false };
  }, { retryDelay: 0 });
  const outcome = await delivery.enqueue(["maybe committed"]);
  assert.equal(calls, 2);
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.reason, "retry_commit_unknown");
  assert.deepEqual(counts(outcome), [0, 0, 1]);
  assert.equal(delivery.failedEvents, 0);
});

it("exceptions exhaust bounded retries with one stable ID and unknown, not lost events", async () => {
  const ids = [];
  const delivery = createEventDelivery((_events, id) => {
    ids.push(id);
    throw new Error("reply lost after a possible commit");
  }, { retryDelay: 0 });
  const outcome = await delivery.enqueue(["a", "b"]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 1);
  assert.equal(outcome.batchId, ids[0]);
  assert.equal(outcome.status, "unknown");
  assert.equal(outcome.reason, "transport_error");
  assert.deepEqual(counts(outcome), [0, 0, 2]);
  assert.equal(delivery.failedEvents, 0);
  assert.equal(delivery.unknownEvents, 2);
});

it("late confirmation reconciles only diagnostics and does not mutate returned unknown or F", async () => {
  const pending = [], late = [];
  const delivery = createEventDelivery((events) => {
    if (events[0] === "F") return accepted;
    const gate = deferred(); pending.push(gate); return gate.promise;
  }, { timeoutMs: 1, retryDelay: 0, onLateOutcome: (value) => late.push(value) });
  const e = await delivery.enqueue(["E"]);
  assert.equal(e.status, "unknown");
  assert.equal(pending.length, 3);
  assert.equal(delivery.unknownEvents, 1);
  pending[0].resolve(accepted);
  await turn();
  const f = await delivery.enqueue(["F"]);
  assert.equal(f.status, "confirmed");
  assert.deepEqual(counts(f), [1, 0, 0]);
  assert.equal(e.status, "unknown");
  assert.deepEqual(counts(e), [0, 0, 1]);
  assert.equal(delivery.unknownEvents, 0);
  assert.equal(delivery.failedEvents, 0);
  assert.equal(late.length, 1);
  assert.equal(delivery.lastLateOutcome, late[0]);
  assert.equal(late[0].batchId, e.batchId);
  assert.equal(late[0].previous, e);
  assert.equal(late[0].outcome.status, "confirmed");
  pending[1].reject(new Error("late transport failure"));
  pending[2].resolve(accepted);
  await turn();
  assert.equal(late.length, 1);
  assert.equal(delivery.unknownEvents, 0);
});

it("late partial acknowledgement leaves failed entries unknown across retry attempts", async () => {
  const pending = [];
  const delivery = createEventDelivery(() => {
    const gate = deferred(); pending.push(gate); return gate.promise;
  }, { timeoutMs: 1, retryDelay: 0 });
  const unknown = await delivery.enqueue(["a", "b", "c"]);
  assert.deepEqual(counts(unknown), [0, 0, 3]);
  const reply = { ok: true, value: { accepted: 2, failed: 1 } };
  for (const gate of pending) gate.resolve(reply);
  await turn();
  assert.equal(delivery.unknownEvents, 1);
  assert.equal(delivery.failedEvents, 0);
  assert.deepEqual(counts(delivery.lastLateOutcome.outcome), [2, 0, 1]);
  assert.equal(delivery.lastLateOutcome.outcome.reason, "retry_commit_unknown");
  assert.equal(delivery.lastLateOutcome.previous, unknown);
  assert.equal(unknown.status, "unknown");
});

it("overflow resolves its own rejected batch before the old in-flight batch finishes", async () => {
  const gate = deferred(); let calls = 0;
  const delivery = createEventDelivery(() => { calls++; return gate.promise; }, { maxEvents: 1 });
  const first = delivery.enqueue(["first"]);
  await turn();
  const overflow = await delivery.enqueue(["overflow"]);
  assert.equal(calls, 1);
  assert.equal(overflow.status, "rejected");
  assert.equal(overflow.reason, "overflow");
  assert.deepEqual(counts(overflow), [0, 1, 0]);
  gate.resolve(accepted);
  const confirmed = await first;
  assert.equal(confirmed.status, "confirmed");
  assert.notEqual(overflow.batchId, confirmed.batchId);
  assert.notEqual(overflow, confirmed);
});

it("empty enqueue is its own zero-count result without sending or reusing an old outcome", async () => {
  let calls = 0;
  const delivery = createEventDelivery(() => { calls++; return { ok: true, value: false }; });
  const prior = await delivery.enqueue(["E"]);
  const empty = await delivery.enqueue([]);
  assert.equal(calls, 1);
  assert.equal(empty.status, "confirmed");
  assert.equal(empty.reason, "empty");
  assert.deepEqual(counts(empty), [0, 0, 0]);
  assert.notEqual(empty.batchId, prior.batchId);
});

it("flush is a snapshot barrier, excludes future work, and never returns another batch result", async () => {
  const e = deferred(), f = deferred(), sent = [];
  const delivery = createEventDelivery((events) => {
    sent.push(events[0]); return events[0] === "E" ? e.promise : f.promise;
  });
  const first = delivery.enqueue(["E"]);
  const boundary = delivery.flush();
  let fFinished = false;
  const future = delivery.enqueue(["F"]).then((value) => { fFinished = true; return value; });
  await turn();
  e.resolve({ ok: true, value: false });
  assert.equal(await boundary, undefined);
  await turn();
  assert.equal(fFinished, false);
  assert.deepEqual(sent, ["E", "F"]);
  assert.equal((await first).status, "rejected");
  f.resolve(accepted);
  assert.equal((await future).status, "confirmed");
  assert.equal(await delivery.flush(), undefined);
});

it("fire-and-forget, callback rejection, and late transport rejection do not escape unhandled", async () => {
  const unhandled = [], pending = [];
  const listen = (error) => unhandled.push(error);
  process.on("unhandledRejection", listen);
  try {
    const delivery = createEventDelivery(() => {
      const gate = deferred(); pending.push(gate); return gate.promise;
    }, { timeoutMs: 1, retryDelay: 0,
      onUnresponsive: async () => { throw new Error("diagnostic callback"); },
      onLateOutcome: async () => { throw new Error("late diagnostic callback"); },
    });
    delivery.enqueue(["ignored"]);
    await delivery.flush();
    pending[0].resolve(accepted);
    for (const gate of pending.slice(1)) gate.reject(new Error("late transport"));
    const overflow = createEventDelivery(() => accepted, { maxEvents: 0,
      onOverflow: async () => { throw new Error("overflow callback"); },
    });
    overflow.enqueue(["ignored overflow"]);
    await turn();
    await turn();
    assert.deepEqual(unhandled, []);
  } finally { process.off("unhandledRejection", listen); }
});

// Extract only the small producer closures. No browser, extension bootstrap, real files or DB.
const source = readFileSync(new URL("../src/content.js", import.meta.url), "utf8");
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert.ok(first >= 0 && last > first, "producer boundary remains identifiable");
  return source.slice(first, last);
}
function fragments(delivery, send = async () => null, completion = createCaptureCompletion()) {
  return new Function("delivery", "captureCompletion", "send", "fragmentTransfers", "stopped", "FRAGMENT_LENGTH",
    section("  function sendFragments(", "  let fileTransferChain") + "; return sendFragments;")
    (delivery, completion, send, new Set(), false, 100000);
}
function fileSender(delivery, emit, completion = createCaptureCompletion()) {
  return new Function("delivery", "captureCompletion", "send", "fragmentTransfers", "stopped", "emit", "btoa",
    section("  let fileTransferChain", "  function captureFiles(") + "; return sendFile;")
    (delivery, completion, async () => null, new Set(), false, emit,
      (value) => Buffer.from(value, "binary").toString("base64"));
}
const reference = { captureId: "synthetic", field: "test", parts: 1, length: 1 };

it("content send returns null for an empty barrier and only the current buffered outcome otherwise", async () => {
  const delivery = createEventDelivery((events) => events[0] === "E" ? { ok: true, value: false } : accepted);
  const make = new Function("delivery", "initialBuffer",
    "let buffer = initialBuffer, timer;" + section("  const send = () =>", "  const emit =") + "; return send;");
  await delivery.enqueue(["E"]);
  assert.equal(await make(delivery, [])(), null);
  const f = await make(delivery, ["F"])();
  assert.equal(f.status, "confirmed");
  assert.deepEqual(counts(f), [1, 0, 0]);
});

it("CSS and other generic fragment transfers survive unrelated E rejection", async () => {
  const kinds = [];
  const delivery = createEventDelivery((events) => {
    kinds.push(events[0].kind);
    return events[0].kind === "E" ? { ok: true, value: false } : accepted;
  });
  const e = delivery.enqueue([{ kind: "E" }]);
  const transfer = fragments(delivery, () => e)("x", reference);
  assert.equal(await transfer, true);
  assert.deepEqual(kinds, ["E", "capture.fragment", "capture.fragmentEnd"]);
  assert.equal(delivery.failedEvents, 1);
});

it("fragment End acknowledgement loss is unknown control flow, not a false confirmed return", async () => {
  const delivery = createEventDelivery((events) => {
    if (events[0].kind === "capture.fragmentEnd") throw new Error("End may already be committed");
    return accepted;
  }, { retryDelay: 0 });
  await assert.rejects(fragments(delivery)("x", reference), (error) => {
    assert.equal(error.deliveryUnconfirmed, true);
    assert.equal(error.outcome.status, "unknown");
    return true;
  });
  assert.equal(delivery.failedEvents, 0);
  assert.equal(delivery.unknownEvents, 1);
});

it("sendFile never appends fragmentFailure solely for an unconfirmed End", async () => {
  const emitted = [];
  const delivery = createEventDelivery((events) => {
    if (events[0].kind === "capture.fragmentEnd") throw new Error("End acknowledgement lost");
    return accepted;
  }, { retryDelay: 0 });
  const file = { slice: () => ({ arrayBuffer: async () => new Uint8Array([1]).buffer }) };
  await assert.rejects(fileSender(delivery, (...args) => emitted.push(args))(file, reference),
    (error) => error.deliveryUnconfirmed === true && error.outcome.status === "unknown");
  assert.deepEqual(emitted, []);
});

it("sendFile retains the existing Failure for an actual local file-read error", async () => {
  const emitted = [];
  const delivery = createEventDelivery(() => accepted);
  const file = { slice: () => { throw new Error("synthetic local read failure"); } };
  assert.equal(await fileSender(delivery, (...args) => emitted.push(args))(file, reference), false);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0][0], "capture.fragmentFailure");
  assert.equal(emitted[0][1].status, "failed");
});

it("producer interruption stays incomplete when a later accepted reply clears every unknown event", async () => {
  for (const interruptedKind of ["capture.fragment", "capture.fragmentEnd"]) {
    const firstAttempt = deferred(), kinds = [], completion = createCaptureCompletion();
    let attempts = 0, unresponsive = 0;
    const delivery = createEventDelivery((events) => {
      const kind = events[0].kind;
      kinds.push(kind);
      if (kind !== interruptedKind) return accepted;
      return ++attempts === 1 ? firstAttempt.promise : { ok: true, value: false };
    }, { timeoutMs: 1, retryDelay: 0, onUnresponsive: () => { unresponsive++; } });
    assert.deepEqual(completion.summary(delivery), { ok: true, failedEvents: 0, unknownEvents: 0,
      captureIncomplete: false, needsVerification: false });
    await assert.rejects(fragments(delivery, async () => null, completion)("x", reference), (error) => {
      assert.equal(error.deliveryUnconfirmed, true);
      assert.equal(error.outcome.reason, "retry_commit_unknown");
      return true;
    });
    assert.equal(attempts, 2);
    assert.equal(unresponsive, 0);
    assert.equal(delivery.unknownEvents, 1);
    assert.equal(completion.incomplete, true);
    firstAttempt.resolve(accepted);
    await turn();
    assert.equal(delivery.failedEvents, 0);
    assert.equal(delivery.unknownEvents, 0);
    assert.equal(delivery.lastLateOutcome.outcome.status, "confirmed");
    assert.deepEqual(completion.summary(delivery), { ok: false, failedEvents: 0, unknownEvents: 0,
      captureIncomplete: true, needsVerification: true });
    const later = await delivery.enqueue([{ kind: "unrelated" }]);
    completion.requireConfirmed(later);
    assert.equal(completion.summary(delivery).ok, false);
    if (interruptedKind === "capture.fragment") assert.equal(kinds.includes("capture.fragmentEnd"), false);
    assert.equal(kinds.includes("capture.fragmentFailure"), false);
  }
});

it("Cache delivery deadline stays incomplete even if every later transport result is confirmed", async () => {
  const completion = createCaptureCompletion(), gate = deferred();
  const wait = new Function("captureCompletion", "deadline",
    section("    const withinDeadline = (promise", "    try {\n      const names =") + "; return withinDeadline;")
    (completion, Date.now() - 1);
  const delivery = createEventDelivery(() => accepted);
  await assert.rejects(wait(gate.promise, true), (error) => error.deliveryUnconfirmed === true);
  gate.resolve(true);
  const confirmed = await delivery.enqueue(["all transport committed"]);
  completion.requireConfirmed(confirmed);
  await turn();
  assert.equal(delivery.failedEvents, 0);
  assert.equal(delivery.unknownEvents, 0);
  assert.deepEqual(completion.summary(delivery), { ok: false, failedEvents: 0, unknownEvents: 0,
    captureIncomplete: true, needsVerification: true });
});

it("deadline incompleteness is sticky without falsifying transmission counts", () => {
  const completion = createCaptureCompletion();
  const diagnostics = { failedEvents: 0, unknownEvents: 0 };
  completion.markIncomplete();
  completion.requireConfirmed({ status: "confirmed" });
  assert.deepEqual(completion.summary(diagnostics), { ok: false, failedEvents: 0, unknownEvents: 0,
    captureIncomplete: true, needsVerification: true });
  assert.ok(Object.isFrozen(completion.summary(diagnostics)));
});

it("content uses batch outcomes, isolates uncertainty from Failure, and retains all-settled finalization", () => {
  assert.doesNotMatch(source, /(?:failedBefore|before)\s*=\s*delivery\.failedEvents/);
  assert.match(source, /withinDeadline\(sendFragments\(data, reference\), true\)/);
  assert.match(source, /if \(deliveryPending\) \{\s*captureCompletion\.markIncomplete\(\);\s*error\.deliveryUnconfirmed = true/);
  assert.match(source, /reply\(captureCompletion\.summary\(delivery\)\)/);
  assert.match(source, /Promise\.allSettled\(\[\.\.\.fragmentTransfers\]\)/);
  assert.equal(isBatchConfirmed({ status: "confirmed" }), true);
  assert.throws(() => requireBatchConfirmed({ batchId: "synthetic", status: "unknown", unknown: 1 }),
    (error) => error.deliveryUnconfirmed === true);
  for (const producer of [
    section("  function captureShadowSources(", "  let canvasCaptureBusy"),
    section("  function captureComputedStyles(", "  function readComputedProperties("),
    section("  async function captureDatabases(", "  async function captureCache("),
    section("  async function captureCache(", "  function beginStateCapture("),
  ]) assert.match(producer, /if \(error\?\.deliveryUnconfirmed\) return;/);
});
