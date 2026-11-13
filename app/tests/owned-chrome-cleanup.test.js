import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  attachCleanup, createOwnedChromeCleanup, installValidationStop, withDeadline,
  VALIDATION_STOP, VALIDATION_CLEANUP,
} from "./owned-chrome-cleanup.mjs";

// not-run / 未运行：本轮只编写与静态自审，未 import/执行测试或 helper。
// Fake clock + fake handles only; no spawn, Chrome, HTTP listener or filesystem.
const never = () => new Promise(() => {});
const flush = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
function fakeClock() {
  let now = 0, nextId = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimer: (callback, ms) => { const id = ++nextId; timers.set(id, { callback, due: now + ms }); return id; },
    clearTimer: (id) => timers.delete(id),
  };
  async function settle(promise) {
    let done = false, value, failure;
    Promise.resolve(promise).then((result) => { value = result; done = true; }, (error) => { failure = error; done = true; });
    for (let turn = 0; turn < 100 && !done; turn++) {
      await flush();
      if (done) break;
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      assert.ok(next, "synthetic promise stalled without a deadline");
      now = next[1].due; timers.delete(next[0]); next[1].callback();
    }
    await flush();
    assert.ok(done, "synthetic promise exceeded timer-step limit");
    if (failure) throw failure;
    return value;
  }
  return { clock, timers, settle };
}
function fakeChild({ pid = 7, exitCode = null, signalCode = null, kill } = {}) {
  const child = Object.assign(new EventEmitter(), { pid, exitCode, signalCode, kills: 0 });
  child.kill = () => { child.kills++; return kill ? kill(child) : true; };
  return child;
}
function ended(child, code = 0, signal = null) {
  child.exitCode = code; child.signalCode = signal;
  child.emit("exit", code, signal); child.emit("close", code, signal);
}
function assertReleased(child, time) {
  for (const event of ["error", "exit", "close"]) assert.equal(child.listenerCount(event), 0, event);
  assert.equal(time.timers.size, 0, "all deadline timers released");
}
const step = (result, name) => result.steps.find((item) => item.name === name);
const trustedProfile = (remove) => ({ isTrusted: () => true, remove });

it("bounds a close that never returns; browser, kill and exit still run", async () => {
  const time = fakeClock(), calls = [];
  const child = fakeChild({ kill: (handle) => { calls.push("kill"); ended(handle); return true; } });
  const cleanup = createOwnedChromeCleanup({
    clock: time.clock,
    getRoot: () => ({ send: (method) => { calls.push(method); return never(); } }),
    getBrowser: () => ({ close: () => { calls.push("browser"); } }),
  });
  cleanup.registerChild(child);
  const result = await time.settle(cleanup.closeOrThrow());
  assert.deepEqual(calls, ["Browser.close", "browser", "kill"]);
  assert.equal(step(result, "Browser.close").status, "timeout");
  assert.equal(result.browserClosed, true);
  assert.equal(result.rootClosed, true);
  assert.equal(result.status, "confirmed");
  assertReleased(child, time);
});

it("Browser.close rejection does not prevent browser close, kill, server or profile cleanup", async () => {
  const time = fakeClock(), calls = [], diagnostic = new Error("synthetic CDP failure");
  const child = fakeChild({ kill: (handle) => { calls.push("kill"); ended(handle, 3); return true; } });
  const cleanup = createOwnedChromeCleanup({
    clock: time.clock,
    getRoot: () => ({ send: () => { calls.push("protocol"); throw diagnostic; } }),
    getBrowser: () => ({ close: () => { calls.push("browser"); } }),
    afterChrome: [
      { name: "websocket.close", close: () => { calls.push("ws"); throw new Error("synthetic WS failure"); } },
      { name: "server.close", close: () => { calls.push("server"); } },
    ],
    profile: trustedProfile(() => { calls.push("profile"); }),
  });
  cleanup.registerChild(child);
  const result = await time.settle(cleanup.close());
  assert.deepEqual(calls, ["protocol", "browser", "kill", "ws", "server", "profile"]);
  assert.equal(step(result, "Browser.close").error, diagnostic);
  assert.equal(result.exitCode, 3);
  assert.equal(result.profileDeleted, true);
  assert.equal(result.status, "unconfirmed", "failed server/WS step cannot pass");
  assertReleased(child, time);
});

it("both close methods failing cannot become confirmed just because root kill exits", async () => {
  const time = fakeClock();
  const child = fakeChild({ kill: (handle) => { ended(handle, null, "SIGTERM"); return true; } });
  const cleanup = createOwnedChromeCleanup({
    clock: time.clock,
    getRoot: () => ({ send: () => Promise.reject(new Error("synthetic disconnect")) }),
    getBrowser: () => ({ close: never }),
  });
  cleanup.registerChild(child);
  const failure = await time.settle(cleanup.closeOrThrow().then(() => null, (error) => error));
  assert.equal(failure.code, "cleanup_unconfirmed");
  assert.equal(failure.cleanup.rootClosed, true);
  assert.equal(failure.cleanup.browserClosed, false);
  assert.equal(failure.cleanup.scope, "owned-observable-only");
  assertReleased(child, time);
});

it("protocol success OR browser success suffices; a disconnect from the other is retained", async () => {
  const time = fakeClock();
  const child = fakeChild({ kill: (handle) => { ended(handle); return true; } });
  const cleanup = createOwnedChromeCleanup({
    clock: time.clock, getRoot: () => ({ send: async () => undefined }),
    getBrowser: () => ({ close: () => Promise.reject(new Error("already disconnected")) }),
  });
  cleanup.registerChild(child);
  const result = await time.settle(cleanup.closeOrThrow());
  assert.equal(result.status, "confirmed");
  assert.equal(step(result, "browser.close").status, "rejected");
  assertReleased(child, time);
});

it("kill errors and false kill results are not exit evidence; never delete a live profile", async () => {
  for (const kill of [() => false, () => { throw new Error("synthetic kill failure"); }]) {
    const time = fakeClock(), calls = [];
    const child = fakeChild({ kill });
    const cleanup = createOwnedChromeCleanup({
      clock: time.clock, getBrowser: () => ({ close: async () => undefined }),
      afterChrome: [{ name: "server.close", close: () => calls.push("server") }],
      profile: { isTrusted: () => { calls.push("trust"); return true; }, remove: () => calls.push("delete") },
    });
    cleanup.registerChild(child);
    child.emit("error", new Error("PID exists; not a spawn failure"));
    const result = await time.settle(cleanup.close());
    assert.equal(result.rootClosed, false);
    assert.equal(result.status, "unconfirmed");
    assert.equal(step(result, "child.exit").status, "timeout");
    assert.deepEqual(calls, ["server"]);
    assertReleased(child, time);
  }
});

it("registers error/exit/close synchronously and retains early nonzero exit", async () => {
  for (const event of ["exit", "close"]) {
    const time = fakeClock(), child = fakeChild();
    const cleanup = createOwnedChromeCleanup({ clock: time.clock, getBrowser: () => ({ close: async () => undefined }) });
    cleanup.registerChild(child);
    for (const name of ["error", "exit", "close"]) assert.equal(child.listenerCount(name), 1);
    child.emit(event, 9, null); // Happens before ANY await or cleanup exit waiter.
    const result = await time.settle(cleanup.close());
    assert.equal(result.exitCode, 9);
    assert.equal(result.rootClosed, true);
    assert.equal(child.kills, 0);
    assertReleased(child, time);
  }
});

it("spawn error without PID is terminal even if a close event follows", async () => {
  const time = fakeClock(), child = fakeChild({ pid: undefined });
  child.pid = undefined; // Default parameters otherwise synthesize a PID.
  const cleanup = createOwnedChromeCleanup({ clock: time.clock });
  cleanup.registerChild(child);
  const original = new Error("synthetic ENOENT");
  child.emit("error", original); child.emit("close", -2, null);
  assert.equal(cleanup.childState().launchError, original);
  const result = await time.settle(cleanup.closeOrThrow());
  assert.equal(result.terminal, "spawn_failed");
  assert.equal(child.kills, 0);
  assertReleased(child, time);
});

it("an early root exit without any browser close evidence stays unconfirmed", async () => {
  const time = fakeClock(), child = fakeChild({ exitCode: 0 });
  const cleanup = createOwnedChromeCleanup({ clock: time.clock });
  cleanup.registerChild(child);
  const result = await time.settle(cleanup.close());
  assert.equal(result.rootClosed, true);
  assert.equal(result.status, "unconfirmed");
  assert.equal(child.kills, 0);
  assertReleased(child, time);
});

it("duplicate and concurrent close calls share one result and one resource pass", async () => {
  const time = fakeClock();
  let serverCalls = 0;
  const child = fakeChild({ kill: (handle) => { ended(handle); return true; } });
  const cleanup = createOwnedChromeCleanup({
    clock: time.clock, getBrowser: () => ({ close: async () => undefined }),
    afterChrome: [{ name: "server.close", close: () => { serverCalls++; } }],
  });
  cleanup.registerChild(child);
  const first = cleanup.close(), second = cleanup.close();
  assert.equal(first, second);
  const result = await time.settle(first);
  assert.equal(await cleanup.close(), result);
  assert.equal(cleanup.closeOrThrow(), cleanup.closeOrThrow());
  await time.settle(cleanup.closeOrThrow());
  assert.equal(child.kills, 1); assert.equal(serverCalls, 1);
  assertReleased(child, time);
});

it("profile trust/delete and server deadlines are independent after confirmed exit", async () => {
  const time = fakeClock(), calls = [];
  const child = fakeChild({ exitCode: 0 });
  const cleanup = createOwnedChromeCleanup({
    clock: time.clock, getBrowser: () => ({ close: async () => undefined }),
    afterChrome: [
      { name: "server.close", close: never },
      { name: "second.server", close: () => calls.push("second") },
    ],
    profile: trustedProfile(() => { calls.push("delete"); return never(); }),
  });
  cleanup.registerChild(child);
  const result = await time.settle(cleanup.close());
  assert.deepEqual(calls, ["second", "delete"]);
  assert.equal(step(result, "server.close").status, "timeout");
  assert.equal(step(result, "profile.delete").status, "timeout");
  assert.equal(result.status, "unconfirmed");
  assertReleased(child, time);
});

it("untrusted profile and unresolved startup are not deleted", async () => {
  for (const stuckSetup of [false, true]) {
    const time = fakeClock(); let removed = 0, trusted = 0;
    const cleanup = createOwnedChromeCleanup({
      clock: time.clock,
      profile: { isTrusted: () => { trusted++; return false; }, remove: () => { removed++; } },
    });
    if (stuckSetup) { cleanup.trackSetup(never); await flush(); }
    const result = await time.settle(cleanup.close());
    assert.equal(result.status, "unconfirmed"); assert.equal(removed, 0);
    assert.equal(trusted, stuckSetup ? 0 : 1);
    assert.equal(time.timers.size, 0);
  }
});

it("never kills an absent child and forbids new resource setup after close", async () => {
  const time = fakeClock(), cleanup = createOwnedChromeCleanup({ clock: time.clock });
  const result = await time.settle(cleanup.closeOrThrow());
  assert.equal(result.terminal, "not_created");
  assert.equal(step(result, "child.kill").status, "skipped");
  assert.throws(() => cleanup.registerChild(fakeChild()), /Cannot register/);
  await assert.rejects(cleanup.trackSetup(() => assert.fail("must not run")), /cleanup already started/);
});

it("attaches cleanup without replacing the startup error, including frozen errors", () => {
  const original = new Error("original startup"), cleanup = { status: "unconfirmed" };
  assert.equal(attachCleanup(original, cleanup), original);
  assert.equal(original.cleanup, cleanup);
  const frozen = Object.freeze(new Error("frozen startup"));
  assert.equal(attachCleanup(frozen, cleanup), frozen);
});

it("deadline observes late rejection and always releases its timer", async () => {
  const time = fakeClock(); let rejectLate;
  const result = await time.settle(withDeadline(() => new Promise((_, reject) => { rejectLate = reject; }), { clock: time.clock, timeoutMs: 4 }));
  assert.equal(result.status, "timeout");
  rejectLate(new Error("synthetic late failure")); await flush();
  assert.equal(time.timers.size, 0);
});

function fakeProcess({ ipc = true, send } = {}) {
  const processLike = Object.assign(new EventEmitter(), { channel: ipc ? {} : null, sent: [], exits: [], disconnects: 0 });
  if (ipc) processLike.send = (message, callback) => {
    processLike.sent.push(message);
    if (send) return send(message, callback);
    callback();
  };
  processLike.exit = (code) => processLike.exits.push(code);
  processLike.disconnect = () => { processLike.disconnects++; processLike.channel = null; };
  return processLike;
}

it("does not install a remote/IPC handler without both send and channel", () => {
  for (const processLike of [fakeProcess({ ipc: false }), Object.assign(fakeProcess(), { channel: null })]) {
    const control = installValidationStop({ processLike, cleanup: () => assert.fail("direct run has no IPC stop") });
    assert.equal(processLike.listenerCount("message"), 0); control.dispose();
  }
});

it("only the exact fixed stop message triggers cleanup, one ack, and exit 130", async () => {
  const time = fakeClock(), processLike = fakeProcess(); let cleanups = 0;
  const control = installValidationStop({
    processLike, clock: time.clock, cleanup: () => { cleanups++; return { status: "confirmed", secret: "never send" }; },
  });
  for (const message of [null, "stop", { type: "remote" }, { type: VALIDATION_STOP, path: "do not act" }, [{ type: VALIDATION_STOP }]])
    processLike.emit("message", message);
  assert.equal(cleanups, 0); assert.equal(control.stopping, false);
  processLike.emit("message", { type: VALIDATION_STOP });
  processLike.emit("message", { type: VALIDATION_STOP });
  await time.settle(control.done);
  assert.equal(cleanups, 1);
  assert.deepEqual(processLike.sent, [{ type: VALIDATION_CLEANUP, status: "confirmed" }]);
  assert.deepEqual(processLike.exits, [130]);
  assert.equal(processLike.listenerCount("message"), 0);
  assert.equal(time.timers.size, 0);
});

it("hung stop cleanup and hung IPC send each have a deadline and still exit 130", async () => {
  const time = fakeClock(), processLike = fakeProcess({ send: () => {} });
  const control = installValidationStop({ processLike, clock: time.clock, cleanup: never, cleanupTimeoutMs: 20, sendTimeoutMs: 5 });
  processLike.emit("message", { type: VALIDATION_STOP });
  await time.settle(control.done);
  assert.deepEqual(processLike.sent, [{ type: VALIDATION_CLEANUP, status: "unconfirmed" }]);
  assert.deepEqual(processLike.exits, [130]);
  assert.equal(time.clock.now(), 25);
  assert.equal(processLike.listenerCount("message"), 0);
  assert.equal(time.timers.size, 0);
});

it("normal or failed finally sends exactly one fixed ack and disconnects IPC", async () => {
  for (const status of ["confirmed", "unconfirmed"]) {
    const time = fakeClock(), processLike = fakeProcess();
    const control = installValidationStop({ processLike, clock: time.clock, cleanup: () => assert.fail("normal finally already cleaned") });
    await time.settle(control.finish({ status, profile: "must not leak", stderr: "synthetic" }));
    assert.deepEqual(processLike.sent, [{ type: VALIDATION_CLEANUP, status }]);
    assert.equal(processLike.disconnects, 1);
    assert.deepEqual(processLike.exits, []);
    assert.equal(processLike.listenerCount("message"), 0);
    assert.equal(time.timers.size, 0);
  }
});

it("IPC send/disconnect failures are bounded results, not replacement startup exceptions", async () => {
  for (const failAt of ["send", "disconnect"]) {
    const time = fakeClock();
    const processLike = fakeProcess({ send: failAt === "send" ? () => { throw new Error("synthetic send error"); } : undefined });
    if (failAt === "disconnect") processLike.disconnect = () => { throw new Error("synthetic disconnect error"); };
    const control = installValidationStop({ processLike, clock: time.clock, cleanup: never });
    const ack = await time.settle(control.finish({ status: "unconfirmed" }));
    assert.equal(ack.status, "unconfirmed");
    assert.equal(ack.ipcAcknowledged, false);
    const original = new Error("original scenario startup");
    assert.equal(attachCleanup(original, ack), original);
    assert.equal(original.cleanup, ack);
    assert.equal(processLike.listenerCount("message"), 0);
    assert.equal(time.timers.size, 0);
  }
});

it("normal finally racing stop reuses the acknowledgement and cleanup result", async () => {
  const time = fakeClock(), processLike = fakeProcess();
  const cleanup = createOwnedChromeCleanup({ clock: time.clock });
  const control = installValidationStop({ processLike, clock: time.clock, cleanup: () => cleanup.close() });
  const result = await time.settle(cleanup.close());
  processLike.emit("message", { type: VALIDATION_STOP });
  await time.settle(Promise.all([control.finish(result), control.done]));
  assert.deepEqual(processLike.sent, [{ type: VALIDATION_CLEANUP, status: "confirmed" }]);
  assert.deepEqual(processLike.exits, [130]);
  assert.equal(processLike.disconnects, 0);
  assert.equal(time.timers.size, 0);
});
