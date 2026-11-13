import { it } from "node:test";
import assert from "node:assert/strict";
import { createSessionTasks } from "../src/session-tasks.js";
import { createSessionLifecycle, isActiveSession } from "../src/session-lifecycle.js";

// Written for an isolated synthetic run; NOT RUN in the 2026-11-13 repair.
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("track 返回同一个 Promise，保留成功值与拒绝原因且观察分支不产生 unhandled", async () => {
  const tasks = createSessionTasks(), owner = {}, success = deferred(), failure = deferred();
  const error = new Error("synthetic failure"), unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    assert.equal(tasks.track(owner, success.promise), success.promise);
    assert.equal(tasks.track(owner, failure.promise), failure.promise);
    const rejected = assert.rejects(failure.promise, (reason) => reason === error);
    success.resolve("original value"); failure.reject(error);
    assert.equal(await success.promise, "original value");
    await rejected;
    // Also observe a rejected fire-and-forget input with no caller catch.
    tasks.track(owner, Promise.reject(error));
    await tasks.drain(owner);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(tasks.snapshot(owner), []);
  } finally { process.off("unhandledRejection", listener); }
});

it("A 未结任务只留在 A 快照，B drain 不等待 A 且 release 不伪装取消", async () => {
  const tasks = createSessionTasks(), a = {}, b = {}, late = deferred();
  tasks.track(a, late.promise);
  assert.deepEqual(tasks.snapshot(a), [late.promise]);
  assert.deepEqual(tasks.snapshot(b), []);
  let aSettled = false;
  late.promise.then(() => { aSettled = true; });
  await tasks.drain(b);
  assert.equal(aSettled, false);
  assert.equal(tasks.release(a), 1);
  tasks.track(a, late.promise);
  assert.deepEqual(tasks.snapshot(a), []);
  late.resolve("late A");
  assert.equal(await late.promise, "late A");
  assert.equal(aSettled, true);
});

it("drain 包含已接受任务在结算期间登记的后续写，不登记 drain 自身", async () => {
  const tasks = createSessionTasks(), owner = {}, first = deferred(), write = deferred();
  const accepted = first.promise.then(() => tasks.track(owner, write.promise));
  tasks.track(owner, accepted);
  const draining = tasks.drain(owner);
  assert.ok(!tasks.snapshot(owner).includes(draining));
  first.resolve();
  await Promise.resolve();
  assert.ok(tasks.snapshot(owner).includes(write.promise));
  write.resolve();
  await draining;
  assert.deepEqual(tasks.snapshot(owner), []);
});

it("A 超时释放后原异步 late 仍受 A owner/finalized 门，不写到 B", async () => {
  const tasks = createSessionTasks(), a = { id: "A", status: "recording" }, b = { id: "B", status: "recording" };
  const gate = deferred(), item = { finalized: false }, published = [];
  let active = a;
  const original = gate.promise.then((value) => {
    if (active === a && isActiveSession(a) && !item.finalized) published.push([a.id, value]);
  });
  assert.equal(tasks.track(a, original), original);
  item.finalized = true; a.status = "ready"; tasks.release(a); active = b;
  await tasks.drain(b);
  gate.resolve("old response"); await original;
  assert.deepEqual(published, []);
  assert.deepEqual(tasks.snapshot(b), []);
});

it("stopping 仅 finishing 窗接收外部事件，closed/sealed 后不可重开", () => {
  const lifecycle = createSessionLifecycle();
  lifecycle.beginStop();
  assert.equal(lifecycle.acceptsExternal(), true);
  lifecycle.closeAdmission();
  assert.equal(lifecycle.acceptsExternal(), false);
  assert.equal(lifecycle.canWrite(), true);
  lifecycle.closeWrites();
  assert.equal(lifecycle.canWrite(), false);
  lifecycle.seal(); lifecycle.beginStop(); lifecycle.closeAdmission(); lifecycle.closeWrites();
  assert.equal(lifecycle.phase, "sealed");
  assert.equal(lifecycle.acceptsExternal(), false);
  assert.equal(lifecycle.canWrite(), false);
});
