import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createSessionTasks } from "../src/session-tasks.js";
import { createSessionLifecycle, isActiveSession } from "../src/session-lifecycle.js";
import { storageWriteDiagnostic, mergeStorageDiagnostics } from "../src/storage-diagnostics.js";

// Authored, NOT RUN. Only the selected production function is evaluated in a
// synthetic VM in a future authorized run; no extension worker/Chrome is loaded.
const source = readFileSync(new URL("../src/background.js", import.meta.url), "utf8");
function initialCapture(context) {
  const begin = source.indexOf("async function captureInitialResources(");
  const end = source.indexOf("\nfunction capture(", begin);
  assert.ok(begin >= 0 && end > begin);
  return vm.runInNewContext("(" + source.slice(begin, end) + ")", context);
}
function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

it("A 初始 frames 读取迟到于 A 中断/B 创建，不能派生 B cookies 或 B task", async () => {
  const tasks = createSessionTasks(), gate = deferred(), cookies = [], published = [];
  const a = { id: "A", status: "preparing" }, b = { id: "B", status: "recording" };
  const runtimes = new WeakMap([[a, { lifecycle: createSessionLifecycle() }], [b, { lifecycle: createSessionLifecycle() }]]);
  const context = {
    active: a, Date, isActiveSession, runtime: (owner) => runtimes.get(owner),
    withDeadline: (promise) => promise,
    chrome: { webNavigation: { getAllFrames: () => gate.promise } },
    allowedUrl: () => true,
    snapshotFrameCookies: (tab, frame, owner) => { cookies.push(owner.id); return Promise.resolve(); },
    track: (promise, owner) => tasks.track(owner, promise),
    append: (...args) => { published.push(args); return Promise.resolve(true); },
  };
  const capture = initialCapture(context);
  const pending = capture({ id: 1 }, Date.now() + 10000, a);
  runtimes.get(a).lifecycle.closeAdmission(); runtimes.get(a).lifecycle.closeWrites();
  a.status = "interrupted"; tasks.release(a); context.active = b;
  gate.resolve([{ frameId: 0, url: "https://example.test/old-A", documentId: "doc-A" }]);
  await pending; await tasks.drain(b);
  assert.deepEqual(cookies, []);
  assert.deepEqual(published, []);
  assert.deepEqual(tasks.snapshot(b), []);
});

it("background 源码保持 barrier/STOP 不登记自身，final stop 失败不继续 ready seal", () => {
  const after = source.slice(source.indexOf("const afterReady ="), source.indexOf("async function start("));
  assert.match(after, /const observedOwner = active/);
  assert.match(after, /const owner = observedOwner;/);
  assert.match(after, /active !== owner/);
  assert.ok(!after.includes("track(ensureReady()"));
  const stop = source.slice(source.indexOf("async function stop("), source.indexOf("async function saveInterruption("));
  assert.ok(!stop.includes("track(stop("));
  assert.ok(stop.indexOf("state.lifecycle.closeAdmission()") < stop.indexOf('"网络收尾"'));
  assert.ok(stop.indexOf("closeSessionWrites(session.id") < stop.indexOf('append("session.stop"'));
  assert.ok(stop.includes('if (!await append("session.stop"'));
  assert.ok(stop.includes('throw new Error("停止记录未能保存'));
  assert.ok(stop.includes('withDeadline(get("sessions", session.id), 5000, "封存水位读取")'));
  assert.ok(stop.indexOf('append("session.stop"') < stop.indexOf('all("events", session.id)'));
  assert.ok(stop.indexOf('all("events", session.id)') < stop.indexOf("await sealSession("));
});

// LR003 additions: authored, NOT RUN. Existing assertions above are unchanged.
function writeFailureFixture() {
  const owner = { id: "A", ownerId: "owner-A", status: "stopping", writeState: "closed" };
  const lifecycle = createSessionLifecycle(); lifecycle.closeWrites();
  const state = { lifecycle, sequence: 0, outstandingWrites: 0, writeChain: Promise.resolve() };
  const saved = [], badges = [];
  const context = {
    active: owner, Date, isActiveSession, storageWriteDiagnostic, mergeStorageDiagnostics,
    runtime: (session) => { assert.equal(session, owner); return state; },
    console: { error() {} }, chrome: { action: { setBadgeText: (value) => { badges.push(value); return Promise.resolve(); } } },
    persistSessionState: (session) => { saved.push(structuredClone(session)); return Promise.resolve(); },
    uid: () => "synthetic-stop", track: (promise) => promise, recordDroppedEvents: () => assert.fail("unexpected capacity path"),
    put: () => Promise.reject({ name: "AbortError", code: 20, message: "synthetic private message" }),
  };
  const begin = source.indexOf("function markEventWriteFailure("), end = source.indexOf("\nfunction appendRealtime(", begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInNewContext(source.slice(begin, end), context);
  return { context, owner, lifecycle, saved, badges };
}

it("已准入 final stop 写失败在 closed 记录枚举证据，重复报错仍为单槽", async () => {
  const { context, owner, saved } = writeFailureFixture();
  assert.equal(await context.append("session.stop", {}, {}, owner, true), false);
  assert.equal(owner.storageError, true); assert.equal(saved.length, 1);
  assert.equal(owner.storageDiagnostic.phase, "closed"); assert.equal(owner.storageDiagnostic.finalEvent, true);
  assert.equal(owner.storageDiagnostic.category, "abort_reported"); assert.equal(owner.storageDiagnostic.errorCode, 20);
  assert.ok(Number.isSafeInteger(owner.storageDiagnostic.observedAt));
  context.markEventWriteFailure(owner, { code: "failed", message: "synthetic private message" }, true);
  assert.equal(Object.keys(owner.storageDiagnostic).length, 6);
  assert.ok(!JSON.stringify(saved).includes("private"));
});

it("closed 普通写和伪 final 非 stop 不补诊断，sealed/ready 不被迟到错误污染", async () => {
  const { context, owner, lifecycle, saved, badges } = writeFailureFixture();
  context.markEventWriteFailure(owner, { name: "QuotaExceededError" });
  assert.equal(await context.append("test.event", {}, {}, owner, true), false);
  assert.equal(saved.length, 0);
  lifecycle.seal();
  context.markEventWriteFailure(owner, { name: "QuotaExceededError" }, true);
  assert.equal(owner.storageError, undefined); assert.equal(owner.storageDiagnostic, undefined);
  assert.equal(saved.length, 0); assert.equal(badges.length, 0);
  owner.status = "ready"; owner.seal = { revision: 1 };
  context.markEventWriteFailure(owner, { code: "session_finalized" }, true);
  assert.equal(saved.length, 0); assert.equal(owner.storageDiagnostic, undefined);
});

it("写入 rejection 保留原对象 owner，同 id 替换也不能污染 B 或已封存 A", async () => {
  const { context, owner, lifecycle, saved, badges } = writeFailureFixture();
  let rejectWrite;
  const rejected = new Promise((resolve, reject) => { rejectWrite = reject; });
  context.put = () => rejected;
  const pending = context.append("session.stop", {}, {}, owner, true);
  await Promise.resolve();
  const replacement = { ...owner, ownerId: "owner-B", status: "recording", writeState: "open" };
  context.active = replacement;
  rejectWrite({ name: "QuotaExceededError", code: 22, message: "synthetic private message" });
  assert.equal(await pending, false);
  for (const session of [owner, replacement]) {
    assert.equal(session.storageError, undefined); assert.equal(session.storageDiagnostic, undefined);
  }
  assert.equal(saved.length, 0); assert.equal(badges.length, 0);
  context.active = owner; lifecycle.seal();
  context.markEventWriteFailure(owner, { name: "QuotaExceededError" }, true);
  assert.equal(owner.storageDiagnostic, undefined); assert.equal(saved.length, 0);
});

