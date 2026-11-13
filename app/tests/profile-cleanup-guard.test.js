import { it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { attachCleanup } from "./owned-chrome-cleanup.mjs";
import { createProfileCleanupGuard } from "./profile-cleanup-guard.mjs";

// not-run / 未运行：只编写 fake 用例；无真实目录、Chrome、spawn 或文件删除。
const profile = path.resolve("synthetic-profile");
const confirmed = Object.freeze({ status: "confirmed", rootClosed: true, setupSettled: true });

it("allows the original callback once when no launch was attempted", async () => {
  const guard = createProfileCleanupGuard();
  let calls = 0;
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "removed" });
  assert.equal(calls, 1);
});

it("preserves pending and every unconfirmed or incomplete cleanup result", async () => {
  const results = [
    undefined, null, {},
    { status: "unconfirmed", rootClosed: true, setupSettled: true },
    { status: "confirmed", rootClosed: false, setupSettled: true },
    { status: "confirmed", rootClosed: true, setupSettled: false },
    { status: "confirmed", rootClosed: 1, setupSettled: true },
    { status: "confirmed", rootClosed: true },
  ];
  for (const result of results) {
    const guard = createProfileCleanupGuard();
    const token = guard.begin(profile);
    let calls = 0;
    const remove = () => { calls++; };
    assert.deepEqual(await guard.remove(profile, remove), { status: "preserved" });
    assert.equal(guard.report(profile, token, result), true);
    assert.deepEqual(await guard.remove(profile, remove), { status: "preserved" });
    assert.equal(calls, 0);
  }
});

it("allows removal only after all three confirmation fields are true", async () => {
  const guard = createProfileCleanupGuard();
  const token = guard.begin(profile);
  let calls = 0;
  assert.equal(guard.report(profile, token, confirmed), true);
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "removed" });
  assert.equal(calls, 1);
});

it("keeps registry evidence when startup errors are frozen or primitive", async () => {
  const errors = [Object.freeze(new Error("synthetic startup failure")), "synthetic startup failure", null, undefined];
  for (const original of errors) {
    const guard = createProfileCleanupGuard();
    const token = guard.begin(profile);
    let caught, removed = 0, reported = false;
    try {
      try { throw original; }
      catch (error) {
        const result = { status: "unconfirmed", rootClosed: false, setupSettled: true };
        reported = guard.report(profile, token, result);
        assert.equal(attachCleanup(error, result), original);
        throw error;
      }
      finally {
        assert.deepEqual(await guard.remove(profile, () => { removed++; }), { status: "preserved" });
      }
    } catch (error) { caught = error; }
    assert.equal(caught, original);
    assert.equal(reported, true);
    assert.equal(removed, 0);
    assert.deepEqual(await guard.remove(profile, () => { removed++; }), { status: "preserved" });
    assert.equal(removed, 0);
  }
});

it("cannot wash an older unresolved attempt with a newer confirmed attempt", async () => {
  const guard = createProfileCleanupGuard();
  const older = guard.begin(profile);
  guard.report(profile, older, { status: "unconfirmed" });
  const newer = guard.begin(profile);
  guard.report(profile, newer, confirmed);
  let calls = 0;
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "preserved" });
  assert.equal(calls, 0);
  guard.report(profile, older, confirmed);
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "removed" });
  assert.equal(calls, 1);
});

it("an older completion cannot release a newer pending attempt", async () => {
  const guard = createProfileCleanupGuard();
  const older = guard.begin(profile);
  const newer = guard.begin(profile);
  guard.report(profile, older, confirmed);
  let calls = 0;
  assert.equal(guard.report(profile, Symbol("unknown"), confirmed), false);
  assert.equal(guard.report(path.resolve("other-synthetic-profile"), newer, confirmed), false);
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "preserved" });
  assert.equal(calls, 0);
  guard.report(profile, newer, confirmed);
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "removed" });
  assert.equal(calls, 1);
  const current = guard.begin(profile);
  assert.equal(guard.report(profile, older, confirmed), false);
  assert.equal(guard.report(profile, newer, confirmed), false);
  assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "preserved" });
  assert.equal(calls, 1);
  guard.report(profile, current, confirmed);
  await guard.remove(profile, () => { calls++; });
  assert.equal(calls, 2);
});

it("keys equivalent paths by path.resolve and keeps distinct profiles independent", async () => {
  const guard = createProfileCleanupGuard();
  const token = guard.begin("synthetic-profile");
  let calls = 0;
  const remove = () => { calls++; };
  assert.deepEqual(await guard.remove(profile, remove), { status: "preserved" });
  assert.deepEqual(await guard.remove(path.resolve("other-synthetic-profile"), remove), { status: "removed" });
  assert.equal(calls, 1);
  assert.equal(guard.report(profile, token, confirmed), true);
  assert.deepEqual(await guard.remove(profile, remove), { status: "removed" });
  assert.equal(calls, 2);
});

it("retains evidence on synchronous or rejected callback failure and permits retry", async () => {
  for (const rejected of [false, true]) {
    const guard = createProfileCleanupGuard();
    const token = guard.begin(profile);
    guard.report(profile, token, confirmed);
    const failure = new Error("synthetic removal failure");
    let calls = 0;
    await assert.rejects(guard.remove(profile, () => {
      calls++;
      if (rejected) return Promise.reject(failure);
      throw failure;
    }), (error) => error === failure);
    assert.equal(calls, 1);
    assert.equal(guard.report(profile, token, confirmed), true, "failed deletion must not clear the token");
    assert.deepEqual(await guard.remove(profile, () => { calls++; }), { status: "removed" });
    assert.equal(calls, 2);
    assert.equal(guard.report(profile, token, confirmed), false, "successful deletion clears the token");
  }
});

it("locks begin before and during removal and coalesces callbacks exactly once", async () => {
  for (const attempted of [false, true]) {
    const guard = createProfileCleanupGuard();
    const token = attempted ? guard.begin(profile) : null;
    if (attempted) guard.report(profile, token, confirmed);
    let release, calls = 0, secondCalls = 0;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = guard.remove(profile, () => {
      calls++;
      assert.throws(() => guard.begin(profile), /profile_removal_in_progress/);
      return gate;
    });
    assert.throws(() => guard.begin(profile), /profile_removal_in_progress/);
    const second = guard.remove(profile, () => { secondCalls++; });
    assert.equal(first, second);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(secondCalls, 0);
    assert.throws(() => guard.begin(profile), /profile_removal_in_progress/);
    if (attempted) assert.equal(guard.report(profile, token, confirmed), false);
    release();
    assert.deepEqual(await first, { status: "removed" });
    assert.deepEqual(await second, { status: "removed" });
    assert.equal(calls, 1);
    assert.equal(secondCalls, 0);
    const current = guard.begin(profile);
    assert.notEqual(current, token);
    guard.report(profile, current, confirmed);
    await guard.remove(profile, () => {});
  }
});
