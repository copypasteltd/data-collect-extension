export function createEventDelivery(sendBatch) {
  let chain = Promise.resolve();
  let failedEvents = 0;
  return {
    enqueue(events) {
      chain = chain.then(async () => {
        try {
          const result = await sendBatch(events);
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
