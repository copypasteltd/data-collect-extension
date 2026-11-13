import { spawn as nodeSpawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export const SCENARIO_SHUTDOWN_MESSAGE = Object.freeze({
  type: "logic-recorder:validation-stop",
});
const MAX_TIMER_MS = 2_147_483_647;
const nativeTimers = { setTimeout, clearTimeout };
const terminateOwnedRoot = (child) => ({ requested: child.kill("SIGKILL") === true });

function positiveTimer(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMER_MS) {
    throw new TypeError(name + " must be a positive safe integer <= " + MAX_TIMER_MS);
  }
}
function text(value) { return typeof value === "string" && value.length > 0 && !value.includes("\0"); }
function exitCode(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }
function exitSignal(value) { return typeof value === "string" && /^SIG[A-Z0-9]{1,16}(?![\s\S])/.test(value) ? value : null; }

/**
 * Run one owned child without capturing command/env/output in its result.
 * Adapters are trusted: spawn has Node's child-handle/event contract; timers
 * schedule asynchronously; clock returns monotonic milliseconds. A promise
 * returned by spawn is observed too, but its producer owns errors until it
 * hands over a child. A late handle only receives best-effort termination.
 * terminate(child, { id, reason, phase: "force" }) may return a promise of
 * { requested?: boolean, treeConfirmed?: boolean }; tree claims are attributed
 * to that adapter, not independent OS verification or an execution sandbox.
 */
export async function runScenario({
  id, command, args = [], cwd, env, timeoutMs, cleanupMs, signal,
  stdio = ["inherit", "inherit", "inherit", "ipc"], requireCleanupAck = false, adapters = {},
}) {
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}(?![\s\S])/.test(id)) throw new TypeError("Invalid scenario id");
  if (!text(command) || !Array.isArray(args) || args.some((arg) => typeof arg !== "string" || arg.includes("\0"))) {
    throw new TypeError("command/args must be NUL-free strings");
  }
  if (cwd !== undefined && !text(cwd)) throw new TypeError("Invalid cwd");
  if (env !== undefined && (!env || typeof env !== "object" || Array.isArray(env)
    || Object.entries(env).some(([key, value]) => !text(key) || key.includes("=") || (value !== undefined && typeof value !== "string") || value?.includes("\0")))) {
    throw new TypeError("Invalid env");
  }
  positiveTimer(timeoutMs, "timeoutMs"); positiveTimer(cleanupMs, "cleanupMs");
  if (typeof requireCleanupAck !== "boolean") throw new TypeError("requireCleanupAck must be boolean");
  const arrayStdio = Array.isArray(stdio) && (stdio.length === 3 || stdio.length === 4)
    && stdio.slice(0, 3).every((entry) => entry === "inherit" || entry === "ignore")
    && (stdio.length === 3 || stdio[3] === "ipc");
  if (stdio !== "inherit" && stdio !== "ignore" && !arrayStdio) throw new TypeError("stdio must inherit/ignore output, optionally with IPC");
  if (signal !== undefined && (!signal || typeof signal.aborted !== "boolean"
    || typeof signal.addEventListener !== "function" || typeof signal.removeEventListener !== "function")) throw new TypeError("Invalid AbortSignal");
  const { spawn = nodeSpawn, timers = nativeTimers, clock = () => performance.now(), terminate = terminateOwnedRoot } = adapters;
  if (typeof spawn !== "function" || typeof clock !== "function" || typeof terminate !== "function"
    || typeof timers?.setTimeout !== "function" || typeof timers?.clearTimeout !== "function") throw new TypeError("Invalid adapters");
  const started = clock();
  if (!Number.isFinite(started) || started < 0) throw new TypeError("clock must return finite nonnegative milliseconds");
  const hasIpc = Array.isArray(stdio) && stdio.includes("ipc");

  return new Promise((resolve) => {
    let settled = false, child, spawnPending = false, lastClock = started;
    let trigger = null, cleanupAt = null, code = null, signalName = null, signalObserved = false;
    let exitAt = null, closeAt = null, observedExitCode = null, observedExitSignal = false;
    let spawnAttempted = false, spawnConfirmed = false, spawnRejected = false;
    let closeConfirmed = false, cooperative = "not_attempted", forceAttempted = false, forcePending = false;
    let forceAccepted = null, forceFailed = false, adapterTreeConfirmed = false;
    let cooperativeCleanupStatus = null, browserVersion = null;
    const errors = { spawn: false, child: false, clock: false };
    const handles = new Map();
    const listeners = [];
    let abortAttached = false;
    function elapsed() {
      try {
        const now = clock();
        if (Number.isFinite(now) && now >= lastClock) lastClock = now;
        else errors.clock = true;
      } catch { errors.clock = true; }
      return lastClock - started;
    }
    function clear(name) {
      if (!handles.has(name)) return;
      const handle = handles.get(name); handles.delete(name); timers.clearTimeout(handle);
    }
    function arm(name, ms, callback) {
      clear(name);
      handles.set(name, timers.setTimeout(() => {
        handles.delete(name);
        if (!settled) callback();
      }, ms));
    }
    function finish(status) {
      if (settled) return;
      settled = true;
      for (const name of [...handles.keys()]) clear(name);
      for (const [event, listener] of listeners) child.removeListener(event, listener);
      if (abortAttached) signal.removeEventListener("abort", onAbort);
      const totalMs = elapsed();
      if (status === "passed" && errors.clock) status = "failed";
      resolve({
        id, status, code, signal: signalName, browserVersion, cooperativeCleanupStatus,
        cleanupStatus: status !== "cleanup_unconfirmed" && (!spawnAttempted || spawnRejected || closeConfirmed) ? "confirmed" : "unconfirmed",
        durations: {
          runMs: cleanupAt ?? totalMs, cleanupMs: cleanupAt === null ? 0 : totalMs - cleanupAt,
          totalMs, exitMs: exitAt, closeMs: closeAt,
        },
        termination: {
          reason: trigger, spawnAttempted, spawnConfirmed, spawnRejected, spawnPending,
          exitObserved: exitAt !== null, closeConfirmed, signalObserved,
          cooperative, forceAttempted, forcePending, forceAccepted, forceFailed,
          treeConfirmedByAdapter: closeConfirmed && adapterTreeConfirmed,
          cleanupScope: closeConfirmed && adapterTreeConfirmed ? "adapter-reported-tree"
            : forceAttempted && cooperativeCleanupStatus !== "confirmed" ? "tree-unverified"
            : terminate === terminateOwnedRoot ? "owned-root-only" : "tree-unverified",
        },
        errors: { ...errors },
      });
    }
    function maybeFinish() {
      if (settled || !closeConfirmed || forcePending) return;
      if (!spawnRejected && (cooperativeCleanupStatus === "unconfirmed"
        || (requireCleanupAck && cooperativeCleanupStatus !== "confirmed")
        || (forceAttempted && cooperativeCleanupStatus !== "confirmed" && !adapterTreeConfirmed))) {
        finish("cleanup_unconfirmed"); return;
      }
      const normal = code === 0 && !signalObserved && !errors.spawn && !errors.child
        && (exitAt === null || (observedExitCode === 0 && !observedExitSignal));
      finish(trigger === "timeout" ? "timed_out" : trigger === "abort" ? "interrupted"
        : trigger === "spawn_error" ? "spawn_error" : normal && !trigger ? "passed" : "failed");
    }
    // Always consume the rejection branch, including callbacks/adapters that throw.
    function observe(value, yes, no) {
      void Promise.resolve(value).then(yes, no).catch((error) => {
        try { no(error); } catch { /* Terminal observer must not reject again. */ }
      });
    }
    function force() {
      if (settled || !child || closeConfirmed || forceAttempted) return;
      clear("force"); forceAttempted = true; forcePending = true;
      const failed = () => {
        if (settled) return;
        forcePending = false; forceFailed = true; maybeFinish();
      };
      try {
        const result = terminate(child, { id, reason: trigger, phase: "force" });
        observe(result, (report) => {
          if (settled) return;
          forcePending = false;
          forceAccepted = report === true || report?.requested === true;
          adapterTreeConfirmed = terminate !== terminateOwnedRoot && report?.treeConfirmed === true;
          maybeFinish();
        }, failed);
      } catch { failed(); }
    }
    function requestShutdown() {
      if (settled || !child || closeConfirmed || spawnRejected || cooperative !== "not_attempted") return;
      if (!hasIpc || child.connected !== true || typeof child.send !== "function") {
        cooperative = "unavailable"; force(); return;
      }
      cooperative = "pending";
      // The cleanup deadline includes this grace period; it is not extended.
      const reserveMs = Math.min(2000, Math.ceil(cleanupMs / 2));
      const graceMs = Math.max(0, cleanupMs - reserveMs - (elapsed() - cleanupAt));
      if (graceMs > 0) arm("force", graceMs, force);
      try {
        child.send(SCENARIO_SHUTDOWN_MESSAGE, (error) => {
          if (settled) return;
          cooperative = error ? "send_failed" : "delivered";
          if (error) force();
        });
      } catch {
        cooperative = "threw"; force();
      }
      if (graceMs === 0) force();
    }
    function cleanup(reason) {
      if (settled || trigger) return;
      trigger = reason; cleanupAt = elapsed(); clear("runtime");
      arm("cleanup", cleanupMs, () => finish("cleanup_unconfirmed"));
      requestShutdown();
    }
    function onAbort() { cleanup("abort"); }
    function onSpawn() { if (!settled) spawnConfirmed = true; }
    function onError() {
      if (settled) return;
      if (spawnConfirmed) { errors.child = true; cleanup("child_error"); }
      else { errors.spawn = true; spawnRejected = true; cleanup("spawn_error"); }
    }
    function onExit(value, termSignal) {
      if (settled || exitAt !== null) return;
      exitAt = elapsed(); observedExitCode = exitCode(value); observedExitSignal = termSignal != null;
      code = observedExitCode; signalName = exitSignal(termSignal); signalObserved ||= termSignal != null;
      // exit alone never proves stdio/IPC closure and never settles success.
    }
    function onClose(value, termSignal) {
      if (settled || closeConfirmed) return;
      closeAt = elapsed(); closeConfirmed = true; code = exitCode(value);
      signalName = exitSignal(termSignal) ?? signalName; signalObserved ||= termSignal != null;
      if (!trigger && signal?.aborted) { trigger = "abort"; cleanupAt = closeAt; }
      if (!trigger && closeAt >= timeoutMs) { trigger = "timeout"; cleanupAt = closeAt; }
      maybeFinish();
    }
    function onMessage(message) {
      if (settled || !hasIpc || !message || typeof message !== "object" || Array.isArray(message)) return;
      if (message.type === "logic-recorder:validation-cleanup"
        && (message.status === "confirmed" || message.status === "unconfirmed")) {
        // Any negative owner report is sticky; an IPC acknowledgement is not OS proof.
        if (cooperativeCleanupStatus !== "unconfirmed") cooperativeCleanupStatus = message.status;
      }
      if (message.type === "logic-recorder:validation-browser" && typeof message.version === "string"
        && message.version.length <= 128 && /^[0-9]{1,10}(?:[.][0-9]{1,10}){1,3}(?![\s\S])/.test(message.version)) {
        browserVersion ??= message.version;
      }
    }
    function acceptChild(value) {
      spawnPending = false;
      if (settled) {
        // A timed-out asynchronous spawn adapter can hand over a late handle.
        // Do not change its unconfirmed result or create more timers/listeners.
        try { observe(terminate(value, { id, reason: "late_spawn", phase: "force" }), () => {}, () => {}); }
        catch { /* Best effort only; never a tree-clean assertion. */ }
        return;
      }
      if (!value || typeof value.on !== "function" || typeof value.removeListener !== "function") {
        errors.spawn = true; spawnRejected = true; trigger ??= "spawn_error"; finish("spawn_error"); return;
      }
      child = value;
      spawnConfirmed = Number.isSafeInteger(child.pid) && child.pid > 0;
      for (const [event, listener] of [["error", onError], ["spawn", onSpawn], ["exit", onExit], ["close", onClose], ["message", onMessage]]) {
        listeners.push([event, listener]); child.on(event, listener);
      }
      if (trigger) requestShutdown();
      else if (signal?.aborted) onAbort();
    }
    function rejectSpawn() {
      if (settled) return;
      spawnPending = false; spawnRejected = true; errors.spawn = true;
      trigger ??= "spawn_error";
      // A throwing/rejecting spawn adapter guarantees it did not hand off a process.
      finish(trigger === "abort" ? "interrupted" : trigger === "timeout" ? "timed_out" : "spawn_error");
    }

    if (signal?.aborted) { trigger = "abort"; finish("interrupted"); return; }
    if (signal) { signal.addEventListener("abort", onAbort); abortAttached = true; }
    if (signal?.aborted) { trigger = "abort"; finish("interrupted"); return; }
    arm("runtime", timeoutMs, () => cleanup("timeout"));
    spawnAttempted = true; spawnPending = true;
    try {
      const value = spawn(command, [...args], {
        cwd, env: env === undefined ? undefined : { ...env },
        stdio: Array.isArray(stdio) ? [...stdio] : stdio, windowsHide: true, shell: false,
      });
      if (value && typeof value.then === "function") observe(value, acceptChild, rejectSpawn);
      else acceptChild(value);
    } catch { rejectSpawn(); }
  });
}
