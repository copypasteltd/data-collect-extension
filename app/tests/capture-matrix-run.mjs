import { summarizeCaptureResults } from "./capture-scenarios.mjs";

// Orchestration only. No process, filesystem, clock, signal handler or timer is
// acquired at import. The caller provides real adapters in a qualified run.
const validDigest = (value) => typeof value === "string" && value.length === 64 && !/[^0-9a-f]/.test(value);
const validIdentity = (value) => value?.status === "complete" &&
  validDigest(value.sourceDigest) && validDigest(value.distDigest);

export async function runCaptureMatrix({ plan, runScenario, captureIdentity, onUpdate = async () => {}, signal }) {
  const results = plan.map((item) => ({ id: item.id, status: item.state === "skipped" ? "skipped" : "not_run",
    ...(item.reason ? { reason: item.reason } : {}) }));
  let before = null, after = null, failure = null, cleanupUnconfirmed = false;
  const snapshot = (summary) => ({ schemaVersion: 1, beforeIdentity: before, afterIdentity: after,
    failure, results: results.map((item) => ({ ...item })), ...summary });
  try {
    await onUpdate(snapshot({ status: "preflight", passed: false }));
    if (signal?.aborted) throw new Error("preflight_interrupted");
    before = await captureIdentity();
    if (!validIdentity(before)) { before = null; throw new Error("invalid_validation_identity"); }
    await onUpdate(snapshot({ status: "running", passed: false }));
    for (let index = 0; index < plan.length; index++) {
      if (plan[index].state === "skipped") continue;
      if (signal?.aborted || cleanupUnconfirmed) break;
      const result = await runScenario(plan[index]);
      if (!result || result.id !== plan[index].id || !["passed", "failed", "timed_out", "interrupted", "spawn_error", "cleanup_unconfirmed"].includes(result.status))
        throw new Error("invalid_scenario_result");
      const cleanupConfirmed = result.cleanupStatus === "confirmed";
      results[index] = cleanupConfirmed ? result : { ...result,
        status: result.status === "passed" ? "cleanup_unconfirmed" : result.status, cleanupStatus: "unconfirmed" };
      // A bad/incomplete adapter result must not open another Chrome, even when
      // its primary reason was failed/timed_out rather than passed.
      if (!cleanupConfirmed || result.status === "cleanup_unconfirmed") cleanupUnconfirmed = true;
      await onUpdate(snapshot({ status: "running", passed: false }));
    }
    after = await captureIdentity();
    if (!validIdentity(after)) { after = null; throw new Error("invalid_validation_identity"); }
  } catch {
    // Do not persist arbitrary thrown messages, stdout or ambient environment.
    failure = before ? "execution_or_identity_failure" : "preflight_identity_failure";
  }
  const identityMatches = !!before && !!after && before.sourceDigest === after.sourceDigest && before.distDigest === after.distDigest;
  const summary = summarizeCaptureResults(results, { interrupted: !!signal?.aborted || cleanupUnconfirmed,
    identityMatches: before && after ? identityMatches : true, preflightFailed: !!failure || !before || !after });
  let final = snapshot({ ...summary, identityMatches });
  await onUpdate(final);
  // A signal/deadline can arrive while the final result is being persisted.
  // Rewrite conservatively before returning; a pre-write summary is not final.
  if (signal?.aborted && final.passed) {
    final = snapshot({ ...summarizeCaptureResults(results, { interrupted: true,
      identityMatches, preflightFailed: !!failure }), identityMatches });
    await onUpdate(final);
  }
  return final;
}
