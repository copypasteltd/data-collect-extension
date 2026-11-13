// Fixed allow-lists describe reported signals, not a proven storage root cause.
const PHASES = ["accepting", "finishing", "draining", "closed", "sealed"];
const SESSION_CODES = ["session_missing", "session_finalized", "session_owner_mismatch",
  "session_writes_closed", "session_revision_mismatch", "session_not_drained", "session_not_terminal"];
const WRITE_CODES = ["failed", "conflict", "capacity", "closed", "event_sequence_invalid_or_exhausted"];
const ERROR_NAMES = ["QuotaExceededError", "AbortError", "TimeoutError", "UnknownError", "ConstraintError",
  "DataError", "DataCloneError", "InvalidStateError", "NotFoundError", "ReadOnlyError",
  "TransactionInactiveError", "VersionError", "SecurityError", "NotSupportedError", "InvalidAccessError"];
const DOM_CODES = [3, 4, 5, 8, 9, 11, 12, 15, 18, 20, 22, 23, 25];
const MAX_DATE_MS = 8640000000000000;

function property(value, key) {
  // Rejected values need not be Error instances; even name/code getters can throw.
  try { return value?.[key]; } catch { return undefined; }
}
function safeTime(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_DATE_MS ? value : null;
}
function classification(name, code) {
  if (SESSION_CODES.includes(code)) return "session_rejected";
  if (name === "QuotaExceededError" || code === 22) return "quota_reported";
  if (name === "AbortError" || code === 20) return "abort_reported";
  if (name === "TimeoutError" || code === 23) return "timeout_reported";
  if (name !== "unknown" || DOM_CODES.includes(code)) return "idb_reported";
  if (WRITE_CODES.includes(code)) return "write_rejected";
  return "unknown";
}

export function storageWriteDiagnostic(error, { phase, finalEvent = false, observedAt = Date.now() } = {}) {
  const name = property(error, "name"), code = property(error, "code");
  const errorName = ERROR_NAMES.includes(name) ? name : "unknown";
  const errorCode = SESSION_CODES.includes(code) || WRITE_CODES.includes(code) || DOM_CODES.includes(code) ? code : "unknown";
  return {
    phase: PHASES.includes(phase) ? phase : "unknown",
    finalEvent: finalEvent === true,
    category: classification(errorName, errorCode),
    errorName, errorCode, observedAt: safeTime(observedAt),
  };
}

function storedDiagnostic(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  // Re-project the schema on merge: never spread an error or saved diagnostic.
  return storageWriteDiagnostic({ name: property(value, "errorName"), code: property(value, "errorCode") }, {
    phase: property(value, "phase"), finalEvent: property(value, "finalEvent"),
    observedAt: property(value, "observedAt") ?? null,
  });
}
export function mergeStorageDiagnostics(existing, incoming) {
  const before = storedDiagnostic(existing), next = storedDiagnostic(incoming);
  if (!next) return before;
  if (!before) return next;
  // One slot only. Latest safe observation wins; incoming wins a timestamp tie.
  return (next.observedAt ?? -1) >= (before.observedAt ?? -1) ? next : before;
}
