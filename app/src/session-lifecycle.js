import { mergeStorageDiagnostics } from "./storage-diagnostics.js";

export const ACTIVE_SESSION_STATUSES = ["preparing", "recording", "stopping"];

export function isActiveSession(session) {
  return !!session && ACTIVE_SESSION_STATUSES.includes(session.status) && !session.seal;
}

export function createSessionLifecycle() {
  let phase = "accepting";
  return {
    get phase() { return phase; },
    acceptsExternal() { return phase === "accepting" || phase === "finishing"; },
    canWrite() { return ["accepting", "finishing", "draining"].includes(phase); },
    beginStop() { if (phase === "accepting") phase = "finishing"; },
    closeAdmission() { if (["accepting", "finishing"].includes(phase)) phase = "draining"; },
    closeWrites() { if (phase !== "sealed") phase = "closed"; },
    seal() { phase = "sealed"; },
  };
}

// Used inside the same IDB transaction as each evidence write. An absent owner
// is accepted only for legacy active sessions which never had an owner token.
export function sessionWriteError(session, ownerId, finalEvent = false) {
  if (!session) return "session_missing";
  if (!isActiveSession(session)) return "session_finalized";
  if (session.ownerId !== ownerId) return "session_owner_mismatch";
  if (session.writeState === "closed" &&
      !(finalEvent && session.status === "stopping" && !session.finalStopEventId))
    return "session_writes_closed";
  if (session.writeState === "sealed") return "session_finalized";
  return null;
}

export function mergeInterruptionDiagnostics(existing, session, reason) {
  const base = existing || session;
  const result = { ...base };
  const storageDiagnostic = mergeStorageDiagnostics(base.storageDiagnostic, session.storageDiagnostic);
  if (storageDiagnostic) result.storageDiagnostic = storageDiagnostic;
  else delete result.storageDiagnostic;
  for (const key of ["incomplete", "storageError", "communicationUnknown", "captureIncomplete", "needsVerification", "collectorQueueOverflow", "collectorUnresponsive", "retryScreenshotGap"])
    if (base[key] || session[key]) result[key] = true;
  for (const key of ["droppedEvents", "unknownEvents", "collectorFailedEvents"])
    if (base[key] != null || session[key] != null) result[key] = Math.max(base[key] || 0, session[key] || 0);
  const notices = [...new Set([base.notice, session.notice, reason].filter(Boolean))];
  if (notices.length) result.notice = notices.join("\n");
  if (session.stopRequestedAt != null) result.stopRequestedAt = session.stopRequestedAt;
  if (session.coverage != null) result.coverage = session.coverage;
  if (base.gaps || session.gaps) {
    const gaps = new Map([...(base.gaps || []), ...(session.gaps || [])].map((gap) => [JSON.stringify(gap), gap]));
    result.gaps = [...gaps.values()];
  }
  return result;
}
