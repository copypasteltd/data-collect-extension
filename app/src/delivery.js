import { batchOutcome } from "./batch-outcome.js";

function createBatchId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function createEventDelivery(sendBatch, options = {}) {
  // The queue boundary carries no batch result; enqueue owns its own promise.
  let chain = Promise.resolve();
  let failedEvents = 0, unknownEvents = 0;
  let pendingEvents = 0, pendingBytes = 0;
  let outstandingRequests = 0, blocked = false;
  let lastLateOutcome = null;
  const maxEvents = options.maxEvents ?? 2000, maxBytes = options.maxBytes ?? 32000000;
  function notify(callback, value) {
    try { Promise.resolve(callback?.(value)).catch(() => {}); } catch {}
  }
  function unresponsive() {
    if (outstandingRequests >= 3) blocked = true;
    notify(options.onUnresponsive);
  }
  function acknowledgement(result, batchId, count) {
    if (result?.ok === true && result.value === true)
      return batchOutcome(batchId, count, 0, 0, "accepted");
    // The background catch can run after committing; a bare error is not a non-commit proof.
    if (result?.ok === false) return batchOutcome(batchId, 0, 0, count, "error_response");
    if (result?.ok === true && result.value === false)
      return batchOutcome(batchId, 0, count, 0, "explicit_rejection");
    const value = result?.value;
    if (result?.ok === true && Number.isSafeInteger(value?.accepted) && value.accepted >= 0 &&
        Number.isSafeInteger(value?.failed) && value.failed >= 0 && value.accepted + value.failed === count)
      return batchOutcome(batchId, value.accepted, value.failed, 0, value.failed ? "write_rejection" : "accepted");
    // A missing/malformed acknowledgement cannot establish whether a commit occurred.
    return batchOutcome(batchId, 0, 0, count, "invalid_acknowledgement");
  }
  async function sendWithRetries(events, batchId, observe) {
    if (blocked && outstandingRequests >= 3)
      return batchOutcome(batchId, 0, events.length, 0, "inflight_limit");
    const attempts = [];
    let reason = "transport_error";
    for (let attempt = 0; attempt < 3; attempt++) {
      // A reply arriving during retry delay ends this batch before another attempt is admitted.
      const settled = attempts.find((item) => item.outcome);
      if (settled) return settled.outcome;
      if (outstandingRequests >= 3) {
        unresponsive();
        return attempts.length
          ? batchOutcome(batchId, 0, 0, events.length, "inflight_limit")
          : batchOutcome(batchId, 0, events.length, 0, "inflight_limit");
      }
      const entry = { consumed: false };
      outstandingRequests++;
      entry.promise = Promise.resolve().then(() => sendBatch(events, batchId)).then(
        (value) => {
          let outcome = acknowledgement(value, batchId, events.length);
          // Another attempt may already have committed or still commit these failed entries.
          if (attempts.length > 1 && outcome.failed)
            outcome = batchOutcome(batchId, outcome.accepted, 0, outcome.failed, "retry_commit_unknown");
          entry.outcome = outcome;
          return { entry, outcome: observe(outcome) };
        },
        () => ({ entry, error: true }),
      ).finally(() => {
        outstandingRequests--;
        if (outstandingRequests < 3) blocked = false;
      });
      attempts.push(entry);
      const deadline = performance.now() + (options.timeoutMs ?? 2000);
      while (true) {
        const waiting = attempts.filter((item) => !item.consumed);
        if (!waiting.length) break;
        let timer;
        const result = await Promise.race([
          ...waiting.map((item) => item.promise),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now())); }),
        ]);
        clearTimeout(timer);
        if (!result) { reason = "timeout"; break; }
        result.entry.consumed = true;
        if (result.outcome) return result.outcome;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, options.retryDelay ?? 100));
    }
    unresponsive();
    return batchOutcome(batchId, 0, 0, events.length, reason);
  }
  return {
    enqueue(events) {
      const batchId = createBatchId();
      if (!events.length) return Promise.resolve(batchOutcome(batchId, 0, 0, 0, "empty"));
      let size;
      try { size = JSON.stringify(events).length * 2; }
      catch { size = Infinity; }
      if (pendingEvents + events.length > maxEvents || pendingBytes + size > maxBytes) {
        failedEvents += events.length;
        notify(options.onOverflow, events.length);
        return Promise.resolve(batchOutcome(batchId, 0, events.length, 0, "overflow"));
      }
      pendingEvents += events.length;
      pendingBytes += size;
      const result = chain.then(async () => {
        let reported = null, observed = null, reconciled = null, lateRecorded = false;
        const observe = (outcome) => {
          if (outcome.status !== "unknown" && !observed) observed = outcome;
          if (reported) {
            const previous = reconciled || reported;
            const improves = outcome.accepted > previous.accepted ||
              (previous.unknown > 0 && outcome.status !== "unknown");
            if (improves) {
              // Never mutate a returned result; reconcile only supported diagnostic counts.
              unknownEvents += outcome.unknown - previous.unknown;
              failedEvents += outcome.failed - previous.failed;
              reconciled = outcome;
            }
            if (!lateRecorded || improves) {
              lateRecorded = true;
              lastLateOutcome = Object.freeze({ batchId, previous: reported, outcome });
              notify(options.onLateOutcome, lastLateOutcome);
            }
          }
          return outcome;
        };
        try {
          let outcome;
          try { outcome = await sendWithRetries(events, batchId, observe); }
          catch { outcome = batchOutcome(batchId, 0, 0, events.length, "transport_error"); }
          // A definitive response may have arrived between the deadline and this continuation.
          reported = observed || outcome;
          failedEvents += reported.failed;
          unknownEvents += reported.unknown;
          return reported;
        } finally {
          pendingEvents -= events.length;
          pendingBytes -= size;
        }
      });
      chain = result.then(() => undefined, () => undefined);
      return result;
    },
    // Snapshot only the work enqueued before this call; do not return another batch's result.
    flush() { return chain; },
    get failedEvents() { return failedEvents; },
    get unknownEvents() { return unknownEvents; },
    // One bounded diagnostic slot, not an unbounded per-batch journal.
    get lastLateOutcome() { return lastLateOutcome; },
  };
}
