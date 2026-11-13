/** A bounded, immutable result for one enqueue call, not collector-wide history. */
export function batchOutcome(batchId, accepted, failed, unknown, reason) {
  const status = unknown > 0 ? "unknown" : failed === 0 ? "confirmed" : accepted > 0 ? "partial" : "rejected";
  return Object.freeze({ batchId, status, accepted, failed, unknown, reason });
}

export function isBatchConfirmed(outcome) {
  return outcome?.status === "confirmed";
}

/** Delivery uncertainty is control flow, not a content/read failure. */
export function requireBatchConfirmed(outcome) {
  if (!isBatchConfirmed(outcome)) {
    const error = new Error("采集批次未确认");
    error.deliveryUnconfirmed = true;
    error.outcome = outcome;
    throw error;
  }
  return outcome;
}

/** Producer completion is independent of whether a late transport commit is reconciled. */
export function createCaptureCompletion() {
  let captureIncomplete = false;
  return {
    markIncomplete() { captureIncomplete = true; },
    requireConfirmed(outcome) {
      if (!isBatchConfirmed(outcome)) captureIncomplete = true;
      return requireBatchConfirmed(outcome);
    },
    summary(delivery) {
      const failedEvents = delivery.failedEvents, unknownEvents = delivery.unknownEvents;
      const needsVerification = captureIncomplete || failedEvents > 0 || unknownEvents > 0;
      return Object.freeze({ ok: !needsVerification, failedEvents, unknownEvents,
        captureIncomplete, needsVerification });
    },
    get incomplete() { return captureIncomplete; },
  };
}
