// Lifecycle termination is distinct from best-effort producer coverage.
export function collectorFlushOutcome(result) {
  const valid = result && typeof result === "object" && typeof result.ok === "boolean" &&
    Number.isSafeInteger(result.failedEvents) && result.failedEvents >= 0 &&
    Number.isSafeInteger(result.unknownEvents) && result.unknownEvents >= 0;
  const failed = valid ? result.failedEvents : 0, unknown = valid ? result.unknownEvents : 0;
  const captureIncomplete = !!result?.captureIncomplete;
  const needsVerification = !!result?.needsVerification || captureIncomplete;
  // A negative completion caused solely by an explicitly reported producer gap
  // is not an unacknowledged transport. Invalid/negative unexplained replies are.
  const producerOnly = valid && !result.ok && failed === 0 && unknown === 0 && needsVerification;
  return { failed, unknown, captureIncomplete, needsVerification,
    transportUnknown: !valid || unknown > 0 || (!result.ok && !producerOnly && failed === 0),
    failedDelivery: failed > 0, producerOnly };
}

export function normalStopOutcome(session, { stoppedDuringPreparation = false, finalizationFailed = false } = {}) {
  let reason;
  if (session.storageError) reason = "storage_failure";
  else if (stoppedDuringPreparation) reason = "stopped_during_preparation";
  else if (session.communicationUnknown || (session.unknownEvents || 0) > 0 || session.collectorUnresponsive) reason = "transport_unconfirmed";
  else if ((session.collectorFailedEvents || 0) > 0 || (session.droppedEvents || 0) > 0) reason = "delivery_failed";
  else if (finalizationFailed) reason = "finalization_unconfirmed";
  else if (session.coverage?.status === "unavailable") reason = "coverage_check_unavailable";
  // Preserve unexplained legacy incomplete state. Only known producer coverage
  // is separated; it must never clear a simultaneous real lifecycle failure.
  else if (session.incomplete && !session.captureIncomplete && !session.needsVerification) reason = "recording_incomplete";
  const coverageGap = session.coverage && Object.entries(session.coverage).some(([key, value]) =>
    /(?:Gaps$|Unavailable$|^warnings$|^pendingRequests$|^canvasContextUnknown$)/.test(key) && Number.isFinite(value) && value > 0);
  const gap = session.incomplete || session.captureIncomplete || session.needsVerification || coverageGap;
  return { schemaVersion: 1, requestedBy: "user", result: reason ? "interrupted" : gap ? "completed_with_gaps" : "completed",
    reason: reason || (gap ? "capture_incomplete" : "user_stop_completed") };
}
