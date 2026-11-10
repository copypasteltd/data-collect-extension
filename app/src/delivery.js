export function createEventDelivery(sendBatch) {
  let chain = Promise.resolve();
  let failedEvents = 0;
  return {
    enqueue(events) {
      chain = chain.then(async () => {
        try {
          const result = await sendBatch(events);
          if (!result?.ok || result.value !== true)
            throw new Error("采集事件未被接收");
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
