// Own handles only: no spawning, process-name lookup, filesystem access or OS tree claims.
export const VALIDATION_STOP = "logic-recorder:validation-stop";
export const VALIDATION_CLEANUP = "logic-recorder:validation-cleanup";

const defaultClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer),
};

export async function withDeadline(operation, { timeoutMs, clock = defaultClock }) {
  const started = clock.now();
  let timer;
  const timeout = new Promise((resolve) => {
    timer = clock.setTimer(() => resolve({ status: "timeout" }), timeoutMs);
  });
  // Observe late rejection too: a timed-out callback must not become unhandled.
  const result = Promise.resolve().then(operation).then(
    (value) => ({ status: "completed", value }),
    (error) => ({ status: "rejected", error }),
  );
  try {
    return { ...await Promise.race([result, timeout]), elapsedMs: Math.max(0, clock.now() - started) };
  } finally {
    clock.clearTimer(timer);
  }
}

export function cleanupError(cleanup) {
  const error = new Error("cleanup_unconfirmed: owned resources could not all be confirmed closed");
  error.code = "cleanup_unconfirmed";
  error.cleanup = cleanup;
  return error;
}

export function attachCleanup(error, cleanup) {
  // Keep the original error identity/stack even if it is frozen or not an object.
  try { if (error && (typeof error === "object" || typeof error === "function")) error.cleanup = cleanup; } catch {}
  return error;
}

export function createOwnedChromeCleanup({
  getRoot = () => null, getBrowser = () => null,
  afterChrome = [], profile = null, clock = defaultClock,
  deadlines = {},
} = {}) {
  const limits = { setup: 500, protocol: 500, browser: 500, kill: 500, exit: 5000, resource: 500, profile: 1000, ...deadlines };
  let child, launchError, terminal = "not_created", rootClosed = true, exitCode = null, signal = null;
  let closePromise, throwingPromise;
  const pendingSetup = new Set();
  const waiters = new Set();
  const listeners = [];
  const notify = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  const confirm = (state, code, reason) => {
    rootClosed = true; terminal = state; exitCode = code ?? null; signal = reason ?? null; notify();
  };
  const snapshot = () => ({ rootClosed, terminal, exitCode, signal, launchError });

  function registerChild(handle) {
    if (child || closePromise) throw new Error("Cannot register another child after cleanup starts");
    if (!handle || typeof handle.on !== "function" || typeof handle.kill !== "function") throw new TypeError("Expected an owned child handle");
    child = handle; rootClosed = false; terminal = "running";
    const onError = (error) => {
      launchError = error;
      // A runtime error/failed kill with a PID is NOT evidence that the child exited.
      if (child.pid == null) confirm("spawn_failed", null, null);
    };
    const onExit = (code, reason) => confirm("exited", code, reason);
    const onClose = (code, reason) => {
      if (terminal !== "spawn_failed") confirm("closed", code, reason);
    };
    for (const [event, listener] of [["error", onError], ["exit", onExit], ["close", onClose]]) {
      child.on(event, listener); listeners.push([event, listener]);
    }
    // Also cover a terminal handle supplied before registration (no event wait race).
    if (child.exitCode != null || child.signalCode != null) confirm("exited", child.exitCode, child.signalCode);
    return handle;
  }

  function trackSetup(operation) {
    if (closePromise) return Promise.reject(new Error("Owned cleanup already started"));
    const pending = Promise.resolve().then(() => {
      if (closePromise) throw new Error("Owned cleanup already started");
      return operation();
    });
    pendingSetup.add(pending);
    pending.then(() => pendingSetup.delete(pending), () => pendingSetup.delete(pending));
    return pending;
  }

  async function runCleanup() {
    const steps = [];
    const step = async (name, operation, timeoutMs) => {
      const result = await withDeadline(operation, { timeoutMs, clock });
      const record = { name, status: result.status, elapsedMs: result.elapsedMs };
      if (result.error !== undefined) record.error = result.error;
      steps.push(record);
      return result;
    };
    const skip = (name, reason) => steps.push({ name, status: "skipped", reason, elapsedMs: 0 });
    let setupSettled = false, resourcesClosed = true, profileDeleted = false;
    try {
      const setup = await step("setup.settle", () => Promise.allSettled([...pendingSetup]), limits.setup);
      setupSettled = setup.status === "completed";
      const protocolClose = await step("Browser.close", async () => {
        const target = getRoot();
        if (!target) return false;
        await target.send("Browser.close");
        return true;
      }, limits.protocol);
      const browserClose = await step("browser.close", async () => {
        const target = getBrowser();
        if (!target) return false;
        await target.close();
        return true;
      }, limits.browser);
      const browserClosed = (protocolClose.status === "completed" && protocolClose.value === true) ||
        (browserClose.status === "completed" && browserClose.value === true);
      if (child && !rootClosed) {
        await step("child.kill", () => {
          if (child.exitCode != null || child.signalCode != null) confirm("exited", child.exitCode, child.signalCode);
          else return child.kill(); // Only the registered handle; never taskkill or name matching.
        }, limits.kill);
      } else skip("child.kill", child ? "already_exited" : "not_created");
      let releaseWaiter;
      try {
        await step("child.exit", () => rootClosed ? undefined : new Promise((resolve) => {
          releaseWaiter = resolve; waiters.add(resolve);
        }), limits.exit);
      } finally { if (releaseWaiter) waiters.delete(releaseWaiter); }
      // Each callback is independent, even after Chrome close rejects/times out.
      for (const resource of afterChrome) {
        const result = await step(resource.name, resource.close, resource.timeoutMs ?? limits.resource);
        if (result.status !== "completed") resourcesClosed = false;
      }
      const profileRequired = Boolean(profile && (!profile.isCreated || profile.isCreated()));
      if (profileRequired && setupSettled && rootClosed) {
        const trusted = await step("profile.trust", () => profile.isTrusted(), limits.profile);
        if (trusted.status === "completed" && trusted.value === true) {
          const removed = await step("profile.delete", profile.remove, limits.profile);
          profileDeleted = removed.status === "completed";
        } else skip("profile.delete", "untrusted_profile");
      } else skip("profile.delete", profileRequired ? "exit_or_setup_unconfirmed" : "not_owned_or_created");
      // Killing/exiting the root alone cannot confirm an already-created Chrome group.
      const chromeClosed = !child || terminal === "spawn_failed" || browserClosed;
      const confirmed = setupSettled && rootClosed && chromeClosed && resourcesClosed && (!profileRequired || profileDeleted);
      return {
        status: confirmed ? "confirmed" : "unconfirmed",
        code: confirmed ? null : "cleanup_unconfirmed",
        scope: "owned-observable-only",
        rootClosed, browserClosed, terminal, exitCode, signal, childError: launchError ?? null,
        setupSettled, resourcesClosed, profileDeleted, steps,
      };
    } finally {
      // All wait timers are cleared by withDeadline; event registrations have one owner.
      for (const [event, listener] of listeners) child.removeListener(event, listener);
      listeners.length = 0; waiters.clear();
    }
  }

  function close() {
    if (!closePromise) closePromise = Promise.resolve().then(runCleanup);
    return closePromise;
  }
  function closeOrThrow() {
    if (!throwingPromise) throwingPromise = close().then((result) => {
      if (result.status !== "confirmed") throw cleanupError(result);
      return result;
    });
    return throwingPromise;
  }
  return { registerChild, trackSetup, childState: snapshot, close, closeOrThrow, get closing() { return Boolean(closePromise); } };
}

export function installValidationStop({
  processLike, cleanup, clock = defaultClock, cleanupTimeoutMs = 12000, sendTimeoutMs = 250,
}) {
  let stopping = false, stopPromise, acknowledgement, disposed = false;
  const enabled = typeof processLike.send === "function" && Boolean(processLike.channel);
  const dispose = () => {
    if (!disposed && enabled) processLike.removeListener("message", onMessage);
    disposed = true;
  };
  function acknowledge(result) {
    if (!enabled) return Promise.resolve({ status: "skipped" });
    if (!acknowledgement) {
      const status = result?.status === "confirmed" ? "confirmed" : "unconfirmed";
      // One sticky status for normal finally and stop; no paths/data/errors on IPC.
      acknowledgement = withDeadline(() => new Promise((resolve, reject) => {
        processLike.send({ type: VALIDATION_CLEANUP, status }, (error) => error ? reject(error) : resolve());
      }), { timeoutMs: sendTimeoutMs, clock });
    }
    return acknowledgement;
  }
  async function finish(result) {
    const ack = await acknowledge(result);
    if (stopping) await stopPromise;
    else {
      dispose();
      // The matrix IPC channel must not keep a normally completed scenario alive.
      if (enabled && processLike.channel && typeof processLike.disconnect === "function") {
        try { processLike.disconnect(); } catch { return { status: "unconfirmed", ipcAcknowledged: false, reason: "ipc_disconnect_failed" }; }
      }
    }
    return ack.status === "completed" || ack.status === "skipped" ? ack :
      { status: "unconfirmed", ipcAcknowledged: false, reason: "ipc_ack_failed" };
  }
  async function stop() {
    const result = await withDeadline(cleanup, { timeoutMs: cleanupTimeoutMs, clock });
    try {
      await acknowledge(result.status === "completed" ? result.value : { status: "unconfirmed" });
    } finally {
      dispose();
      // Stop the test body even if a pending Playwright/startup await never settles.
      // This exits only this Node process; it is not an OS Chrome-tree cleanup claim.
      processLike.exit(130);
    }
  }
  function onMessage(message) {
    if (stopping || !message || typeof message !== "object" || Array.isArray(message) ||
        Object.keys(message).length !== 1 || message.type !== VALIDATION_STOP) return;
    stopping = true;
    stopPromise = stop();
  }
  if (enabled) processLike.on("message", onMessage);
  return { dispose, finish, get stopping() { return stopping; }, get done() { return stopPromise; } };
}
