import { it } from "node:test";
import assert from "node:assert/strict";
import { createArchiveTask } from "../src/archive-task.js";

it("stalled archive wait rejects, retains failure and ignores late completion", async () => {
  let timeout, resolve;
  const task = createArchiveTask(() => {}, { setTimer: (callback) => { timeout = callback; return 1; }, clearTimer() {} });
  task.stage("整理操作与页面", { current: 20, total: 100 });
  const promise = task.wait(new Promise((accept) => { resolve = accept; }));
  const rejection = assert.rejects(promise, /整理操作与页面长时间无进展.*本地批次仍保留/);
  timeout(); await rejection; resolve("late");
  assert.throws(() => task.progress(), /长时间无进展/);
  task.dispose();
});
it("actual per-block progress renews idle deadline without faking a completed export", async () => {
  const reports = [], timers = new Set(); let clock = 0;
  const task = createArchiveTask((value) => reports.push(value), { now: () => clock,
    setTimer: (callback) => { timers.add(callback); return callback; }, clearTimer: (callback) => timers.delete(callback) });
  task.stage("压缩并校验记录", { current: 0, total: 3 });
  clock = 101; task.progress({ bytesDone: 65536 });
  assert.equal(timers.size, 1); assert.equal(reports.at(-1).bytesDone, 65536);
  assert.equal(await task.wait(Promise.resolve("read")), "read");
  task.dispose(); assert.equal(timers.size, 0);
});
it("external cancellation prevents lock work from starting and cleans listeners", async () => {
  const controller = new AbortController(); controller.abort(new Error("synthetic abort"));
  let started = false;
  const task = createArchiveTask(() => {}, { signal: controller.signal });
  await assert.rejects(task.wait(() => { started = true; }), /synthetic abort/);
  assert.equal(started, false); task.dispose();
});
