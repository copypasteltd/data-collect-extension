export function createEventDelivery(sendBatch, options = {}) {
  let chain = Promise.resolve();
  let failedEvents = 0;
  let pendingEvents = 0, pendingBytes = 0;
  const maxEvents = options.maxEvents ?? 2000, maxBytes = options.maxBytes ?? 32000000;
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
          let result;
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              result = await sendBatch(events, batchId);
              break;
            } catch (error) {
              if (attempt === 2) throw error;
              await new Promise((resolve) => setTimeout(resolve, options.retryDelay ?? 100));
            }
          }
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
