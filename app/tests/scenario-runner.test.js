import { it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runScenario, SCENARIO_SHUTDOWN_MESSAGE } from "./scenario-runner.mjs";

// NOT RUN (2026-11-13): all children, timers, aborts and clocks below are fake.
// No target code, browser, process, profile, filesystem fixture or native timer.
class FakeChild extends EventEmitter {
  constructor() { super(); this.pid = 42; this.connected = true; this.sent = []; this.kills = []; }
  send(message, callback) {
    this.sent.push(message);
    if (this.onSend) return this.onSend(message, callback);
    callback(null); return true;
  }
  kill(signal) { this.kills.push(signal); return this.onKill ? this.onKill(signal) : true; }
  close(code = 0, signal = null) { this.connected = false; this.emit("close", code, signal); }
  ack(status = "confirmed") { this.emit("message", { type: "logic-recorder:validation-cleanup", status }); }
}
function fakeTime() {
  let now = 0, sequence = 0;
  const jobs = new Map(), callbacks = [];
  const timers = {
    setTimeout(callback, ms) {
      assert.ok(Number.isFinite(ms) && ms >= 0);
      const key = ++sequence; jobs.set(key, { at: now + ms, callback }); callbacks.push(callback); return key;
    },
    clearTimeout(key) { jobs.delete(key); },
  };
  return {
    timers, jobs, callbacks, clock: () => now, jump: (value) => { now = value; },
    advance(ms) {
      const target = now + ms;
      while (true) {
        const first = [...jobs].filter(([, job]) => job.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!first) break;
        const [key, job] = first; now = job.at; jobs.delete(key); job.callback();
      }
      now = target;
    },
  };
}
function fakeAbort() {
  const listeners = new Set();
  return {
    aborted: false, listeners,
    addEventListener(type, fn) { assert.equal(type, "abort"); listeners.add(fn); },
    removeEventListener(type, fn) { assert.equal(type, "abort"); listeners.delete(fn); },
    abort() { this.aborted = true; for (const fn of [...listeners]) fn(); },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 6; i += 1) await Promise.resolve(); }
function fixture({ spawn, terminate, clock, child = new FakeChild() } = {}) {
  const time = fakeTime(), signal = fakeAbort(), spawned = [];
  const adapters = {
    timers: time.timers, clock: clock ?? time.clock,
    spawn(...args) { spawned.push(args); return spawn ? spawn(...args) : child; },
    ...(terminate ? { terminate } : {}),
  };
  return { child, time, signal, spawned, adapters,
    run(extra = {}) {
      return runScenario({ id: "synthetic", command: "synthetic-command", args: [], timeoutMs: 100,
        cleanupMs: 20, signal, ...extra, adapters });
    },
  };
}
function disposed(f) {
  assert.equal(f.time.jobs.size, 0, "all owned timers are cleared");
  assert.equal(f.signal.listeners.size, 0, "abort listener is removed");
  assert.deepEqual(f.child.eventNames(), [], "all owned child listeners are removed");
}

it("normal zero exit waits for close; only safe metadata and monotonic durations survive", async () => {
  const f = fixture(), pending = f.run({ cwd: "synthetic-dir", args: ["synthetic-argument"], env: { TOKEN: "synthetic-secret" } });
  let settled = false; void pending.then(() => { settled = true; });
  f.time.advance(7); f.child.emit("exit", 0, null); await flush();
  assert.equal(settled, false); assert.equal(f.time.jobs.size, 1);
  f.time.advance(3); f.child.close(); const result = await pending;
  assert.equal(result.status, "passed"); assert.equal(result.code, 0); assert.equal(result.signal, null);
  assert.deepEqual(result.durations, { runMs: 10, cleanupMs: 0, totalMs: 10, exitMs: 7, closeMs: 10 });
  assert.equal(result.termination.closeConfirmed, true); assert.equal(result.termination.cleanupScope, "owned-root-only");
  assert.equal(result.termination.treeConfirmedByAdapter, false);
  const metadata = JSON.stringify(result);
  for (const value of ["synthetic-command", "synthetic-argument", "synthetic-dir", "synthetic-secret", "TOKEN"]) assert.ok(!metadata.includes(value));
  assert.equal(f.spawned[0][2].shell, false); assert.deepEqual(f.spawned[0][2].stdio, ["inherit", "inherit", "inherit", "ipc"]);
  disposed(f);
});

it("nonzero, null and signalled exits are failures, never successful null-code coercions", async () => {
  for (const [code, signal] of [[2, null], [null, null], [null, "SIGTERM"], [0, "SIGTERM"], [0, "SIGTERM\n"], [0, "arbitrary payload"]]) {
    const f = fixture(), pending = f.run(); f.child.emit("exit", code, signal); f.child.close(code, signal);
    const result = await pending; assert.equal(result.status, "failed");
    assert.equal(result.signal, signal === "SIGTERM" ? signal : null); disposed(f);
  }
  const f = fixture(), pending = f.run(); f.child.emit("exit", 3, null); f.child.close(0);
  assert.equal((await pending).status, "failed"); disposed(f);
});

it("throwing or rejecting spawn is observed without retaining its error text", async () => {
  for (const spawn of [() => { throw new Error("synthetic private text"); }, () => Promise.reject(new Error("synthetic private text"))]) {
    const f = fixture({ spawn }), result = await f.run();
    assert.equal(result.status, "spawn_error"); assert.equal(result.errors.spawn, true);
    assert.equal(result.termination.spawnRejected, true); assert.equal(result.termination.reason, "spawn_error");
    assert.equal(result.termination.closeConfirmed, false); assert.ok(!JSON.stringify(result).includes("synthetic private text")); disposed(f);
  }
});

it("native-style error then exit/close cannot pass; no close has a bounded cleanup", async () => {
  const child = new FakeChild(); child.pid = undefined;
  const f = fixture({ child }), pending = f.run({ requireCleanupAck: true });
  child.emit("error", new Error("synthetic spawn failure")); child.emit("exit", 0, null); child.close(0);
  assert.equal((await pending).status, "spawn_error"); assert.deepEqual(child.kills, []); disposed(f);
  const missing = new FakeChild(); missing.pid = undefined;
  const g = fixture({ child: missing }), stuck = g.run(); missing.emit("error", new Error("synthetic"));
  g.time.advance(20); const result = await stuck;
  assert.equal(result.status, "cleanup_unconfirmed"); assert.equal(result.cleanupStatus, "unconfirmed"); disposed(g);
});

it("exit without close reaches timeout then cleanup deadline, not pass", async () => {
  const f = fixture(), pending = f.run(); f.child.emit("exit", 0, null);
  f.time.advance(100); assert.deepEqual(f.child.sent, [SCENARIO_SHUTDOWN_MESSAGE]);
  f.time.advance(20); const result = await pending;
  assert.equal(result.status, "cleanup_unconfirmed"); assert.equal(result.termination.reason, "timeout");
  assert.equal(result.code, 0); assert.equal(result.termination.exitObserved, true); assert.equal(result.termination.closeConfirmed, false);
  assert.equal(result.termination.cleanupScope, "tree-unverified"); assert.deepEqual(f.child.kills, ["SIGKILL"]); disposed(f);
});

it("timeout with cooperative confirmed cleanup remains timed_out and sends fixed IPC before force", async () => {
  const f = fixture(), pending = f.run({ requireCleanupAck: true });
  f.time.advance(100); assert.deepEqual(f.child.sent, [{ type: "logic-recorder:validation-stop" }]); assert.deepEqual(f.child.kills, []);
  f.time.advance(4); f.child.ack(); f.child.emit("exit", 0, null); f.child.close();
  const result = await pending;
  assert.equal(result.status, "timed_out"); assert.equal(result.cooperativeCleanupStatus, "confirmed");
  assert.equal(result.cleanupStatus, "confirmed"); assert.equal(result.termination.forceAttempted, false);
  assert.deepEqual(result.durations, { runMs: 100, cleanupMs: 4, totalMs: 104, exitMs: 104, closeMs: 104 }); disposed(f);
  const g = fixture(), longCleanup = g.run({ cleanupMs: 15_000 });
  g.time.advance(13_099); assert.deepEqual(g.child.kills, []);
  g.time.advance(1); assert.deepEqual(g.child.kills, ["SIGKILL"]);
  g.child.ack(); g.child.close(0); assert.equal((await longCleanup).status, "timed_out"); disposed(g);
});

it("root force and close alone remain cleanup_unconfirmed/tree-unverified", async () => {
  const f = fixture(), pending = f.run(); f.time.advance(110); await flush(); f.child.close(null, "SIGKILL");
  const result = await pending;
  assert.equal(result.status, "cleanup_unconfirmed"); assert.equal(result.cleanupStatus, "unconfirmed");
  assert.equal(result.termination.forceAccepted, true); assert.equal(result.termination.closeConfirmed, true);
  assert.equal(result.termination.treeConfirmedByAdapter, false); assert.equal(result.termination.cleanupScope, "tree-unverified"); disposed(f);
});

it("injected tree terminator evidence is attributed, requires close, and does not turn timeout into pass", async () => {
  const calls = [], f = fixture({ terminate: (child, context) => { calls.push([child, context]); return { requested: true, treeConfirmed: true }; } });
  const pending = f.run(); f.time.advance(110); await flush(); f.child.close(null, "SIGKILL");
  const result = await pending;
  assert.equal(result.status, "timed_out"); assert.equal(result.termination.treeConfirmedByAdapter, true);
  assert.equal(result.termination.cleanupScope, "adapter-reported-tree"); assert.equal(calls[0][0], f.child);
  assert.deepEqual(calls[0][1], { id: "synthetic", reason: "timeout", phase: "force" }); disposed(f);
  const g = fixture({ terminate: () => ({ treeConfirmed: true }) }), stuck = g.run(); g.time.advance(120);
  const unclosed = await stuck; assert.equal(unclosed.status, "cleanup_unconfirmed"); assert.equal(unclosed.termination.treeConfirmedByAdapter, false); disposed(g);
});

it("manual abort is sticky across timeout/error/exit races, and pre-abort never spawns", async () => {
  const f = fixture(), pending = f.run(); f.time.advance(9); f.signal.abort(); f.signal.abort();
  f.child.emit("error", new Error("synthetic late child error")); f.child.ack(); f.child.close(0);
  const result = await pending; assert.equal(result.status, "interrupted"); assert.equal(result.termination.reason, "abort");
  assert.equal(result.termination.cooperative, "delivered"); assert.equal(f.child.sent.length, 1); disposed(f);
  const g = fixture(); g.signal.abort(); const stopped = await g.run();
  assert.equal(stopped.status, "interrupted"); assert.equal(stopped.termination.spawnAttempted, false); assert.equal(g.spawned.length, 0); disposed(g);
});

it("child.send throw or callback error cannot reject the runner and force only its handle", async () => {
  for (const behavior of [() => { throw new Error("synthetic send failure"); }, (_message, done) => done(new Error("synthetic send error"))]) {
    const f = fixture(); f.child.onSend = behavior; const pending = f.run(); f.signal.abort(); await flush();
    assert.deepEqual(f.child.kills, ["SIGKILL"]); f.child.ack(); f.child.close(null, "SIGKILL");
    const result = await pending; assert.equal(result.status, "interrupted");
    assert.ok(["threw", "send_failed"].includes(result.termination.cooperative)); disposed(f);
  }
});

it("send callback never returns, disconnect and absent IPC still have bounded cleanup", async () => {
  for (const mode of ["silent-send", "disconnected", "no-ipc"]) {
    const f = fixture(); if (mode === "silent-send") f.child.onSend = () => false;
    if (mode === "disconnected") f.child.connected = false;
    const pending = f.run(mode === "no-ipc" ? { stdio: "ignore" } : {}); f.signal.abort(); f.time.advance(20);
    const result = await pending; assert.equal(result.status, "cleanup_unconfirmed");
    assert.deepEqual(f.child.kills, ["SIGKILL"]); disposed(f);
  }
});

it("termination throw/reject/hang is observed and cannot extend the cleanup deadline", async () => {
  for (const terminate of [() => { throw new Error("synthetic kill"); }, () => Promise.reject(new Error("synthetic kill")), () => new Promise(() => {})]) {
    const f = fixture({ terminate }), pending = f.run(); f.signal.abort(); f.time.advance(10); await flush();
    f.child.close(null, "SIGKILL"); f.time.advance(10); const result = await pending;
    assert.equal(result.status, "cleanup_unconfirmed"); assert.equal(result.cleanupStatus, "unconfirmed"); disposed(f);
  }
});

it("pending async spawn is bounded; late handle is best-effort terminated and does not rewrite evidence", async () => {
  const spawn = deferred(), calls = [], f = fixture({ spawn: () => spawn.promise, terminate: (child, context) => { calls.push([child, context]); return Promise.reject(new Error("synthetic late failure")); } });
  const pending = f.run(); f.signal.abort(); f.time.advance(20); const result = await pending;
  assert.equal(result.status, "cleanup_unconfirmed"); assert.equal(result.termination.spawnPending, true);
  const before = JSON.stringify(result); spawn.resolve(f.child); await flush();
  assert.equal(calls.length, 1); assert.equal(calls[0][0], f.child); assert.equal(calls[0][1].reason, "late_spawn");
  assert.equal(JSON.stringify(result), before); disposed(f);
});

it("late captured events/timers/send callbacks cannot settle twice or add resources", async () => {
  const f = fixture(); let sendDone; f.child.onSend = (_message, done) => { sendDone = done; };
  const pending = f.run(); let deliveries = 0; void pending.then(() => { deliveries += 1; });
  const events = new Map(f.child.eventNames().map((name) => [name, [...f.child.listeners(name)]]));
  f.signal.abort(); f.child.ack(); f.child.close(0); const result = await pending, before = JSON.stringify(result);
  disposed(f);
  for (const callback of f.time.callbacks) callback();
  for (const [event, listeners] of events) for (const listener of listeners) {
    if (event === "error") listener(new Error("synthetic late"));
    else if (event === "message") listener({ type: "logic-recorder:validation-cleanup", status: "unconfirmed" });
    else listener(7, "SIGTERM");
  }
  sendDone(new Error("synthetic late send")); f.signal.abort(); await flush();
  assert.equal(deliveries, 1); assert.equal(JSON.stringify(result), before); assert.equal(f.child.kills.length, 0); disposed(f);
});

it("unrelated child listeners survive disposal; runner does not remove host error policy", async () => {
  const f = fixture(), external = () => {}; f.child.on("error", external);
  const pending = f.run(); f.child.close(0); await pending;
  assert.deepEqual(f.child.listeners("error"), [external]); f.child.removeListener("error", external); disposed(f);
});

it("cleanup ACK is required only when opted in; negative ACK is sticky and missing IPC cannot pass the Chrome gate", async () => {
  for (const mode of ["confirmed", "missing", "unconfirmed", "retracted", "no-ipc"]) {
    const f = fixture(), pending = f.run({ requireCleanupAck: true, ...(mode === "no-ipc" ? { stdio: "ignore" } : {}) });
    if (["unconfirmed", "retracted"].includes(mode)) f.child.ack("unconfirmed");
    if (["confirmed", "retracted", "no-ipc"].includes(mode)) f.child.ack("confirmed");
    f.child.close(0); const result = await pending;
    assert.equal(result.status, mode === "confirmed" ? "passed" : "cleanup_unconfirmed");
    assert.equal(result.cooperativeCleanupStatus, mode === "confirmed" ? "confirmed" : ["unconfirmed", "retracted"].includes(mode) ? "unconfirmed" : null); disposed(f);
  }
});

it("IPC retains only strict finite browser labels, never arbitrary messages or output", async () => {
  const f = fixture(), pending = f.run();
  for (const version of ["Chrome/123.0.1.2", "arbitrary synthetic secret", "1".repeat(129), "123.0\n", 123]) f.child.emit("message", { type: "logic-recorder:validation-browser", version });
  f.child.emit("message", { type: "other", payload: "synthetic secret" }); f.child.emit("message", null);
  f.child.emit("message", { type: "logic-recorder:validation-browser", version: "123.0.1.2", arbitrary: "synthetic secret" });
  f.child.close(0); const result = await pending;
  assert.equal(result.browserVersion, "123.0.1.2"); assert.ok(!JSON.stringify(result).includes("synthetic secret")); disposed(f);
});

it("elapsed deadline wins a close-before-watchdog-dispatch race; invalid clock cannot pass", async () => {
  const f = fixture(), pending = f.run(); f.time.jump(101); f.child.close(0);
  assert.equal((await pending).status, "timed_out"); disposed(f);
  let calls = 0; const g = fixture({ clock: () => ++calls === 1 ? 0 : NaN }), bad = g.run(); g.child.close(0);
  const result = await bad; assert.equal(result.status, "failed"); assert.equal(result.errors.clock, true); disposed(g);
});

it("rejects invalid IDs, command fields and non-finite/non-safe/out-of-native-range budgets before spawn", async () => {
  const changes = [];
  for (const field of ["timeoutMs", "cleanupMs"]) for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, 2_147_483_648, "100"]) changes.push({ [field]: value });
  for (const id of ["", "../escape", "two words", "UPPER", "x".repeat(65), "x\n", 1]) changes.push({ id });
  changes.push({ command: "" }, { command: "bad\0command" }, { args: [1] }, { args: ["bad\0arg"] }, { cwd: "bad\0cwd" },
    { env: { "BAD=KEY": "x" } }, { env: { TOKEN: 1 } }, { env: { TOKEN: "bad\0value" } }, { requireCleanupAck: "yes" }, { stdio: "pipe" });
  for (const change of changes) { const f = fixture(); await assert.rejects(f.run(change), TypeError); assert.equal(f.spawned.length, 0); disposed(f); }
});
