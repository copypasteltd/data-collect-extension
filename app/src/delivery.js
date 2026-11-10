export function createEventDelivery(sendBatch, options = {}) {
  let chain = Promise.resolve();
  let failedEvents = 0;
  let pendingEvents = 0, pendingBytes = 0;
  let outstandingRequests = 0, blocked = false;
  const maxEvents = options.maxEvents ?? 2000, maxBytes = options.maxBytes ?? 32000000;
  function unresponsive() {
    if (outstandingRequests >= 3) blocked = true;
    try { options.onUnresponsive?.(); } catch {}
  }
  async function sendWithRetries(events, batchId) {
    if (blocked && outstandingRequests >= 3) throw new Error("采集通信未响应");
    const attempts = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      if (outstandingRequests >= 3) { unresponsive(); throw new Error("采集通信未响应"); }
      const entry = { consumed: false };
      outstandingRequests++;
      entry.promise = Promise.resolve().then(() => sendBatch(events, batchId)).then(
        (value) => ({ entry, value }),
        (error) => ({ entry, error }),
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
        const outcome = await Promise.race([
          ...waiting.map((item) => item.promise),
          new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - performance.now())); }),
        ]);
        clearTimeout(timer);
        if (!outcome) break;
        outcome.entry.consumed = true;
        if ("value" in outcome) return outcome.value;
      }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, options.retryDelay ?? 100));
    }
    unresponsive();
    throw new Error("采集通信未确认");
  }
  return {
    enqueue(events) {
      let size;
      try { size = JSON.stringify(events).length * 2; }
      catch { size = Infinity; }
      if (pendingEvents + events.length > maxEvents || pendingBytes + size > maxBytes) {
        failedEvents += events.length;
        try { options.onOverflow?.(events.length); } catch {}
        return chain;
      }
      pendingEvents += events.length;
      pendingBytes += size;
      const batchId = crypto.randomUUID();
      chain = chain.then(async () => {
        try {
          const result = await sendWithRetries(events, batchId);
          if (result?.ok && result.value === true) return;
          const value = result?.value;
          if (result?.ok && Number.isSafeInteger(value?.accepted) && value.accepted >= 0 &&
              Number.isSafeInteger(value?.failed) && value.failed >= 0 && value.accepted + value.failed === events.length) {
            failedEvents += value.failed;
            return;
          }
          throw new Error("采集事件未确认");
        } catch {
          failedEvents += events.length;
        } finally {
          pendingEvents -= events.length;
          pendingBytes -= size;
        }
      });
      return chain;
    },
    flush() {
      return chain;
    },
    get failedEvents() {
      return failedEvents;
    },
  };
}
