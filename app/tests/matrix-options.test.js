import { it } from "node:test";
import assert from "node:assert/strict";
import { validationBudgets, validationEnvironment, validationStep } from "./matrix-options.mjs";

// Pure adapter regressions: no processes, filesystem access or environment mutation.
it("native host retains only explicit Known Folder variables without copying secrets", () => {
  const input = { USERPROFILE: "native-user", LOCALAPPDATA: "native-local", APPDATA: "native-roaming", HOMEDRIVE: "C:",
    HOMEPATH: "/Users/synthetic", SECRET: "private", NODE_OPTIONS: "--require private.js" };
  const directories = { home: "scratch/home", temp: "scratch/temp", appdata: "scratch/app", localappdata: "scratch/local" };
  const env = validationEnvironment(input, directories, { executable: "synthetic-chrome", nativeHost: true });
  for (const key of ["USERPROFILE", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH"]) assert.equal(env[key], input[key]);
  assert.equal(env.TEMP, directories.temp); assert.equal(env.SECRET, undefined); assert.equal(env.NODE_OPTIONS, undefined);
});
it("验证等待遵守abort/有限deadline，迟到拒绝被观察而不重新启动", async () => {
  const controller = new AbortController(); controller.abort();
  let called = 0;
  await assert.rejects(validationStep(() => { called++; }, { timeoutMs: 1, signal: controller.signal }), /validation_interrupted/);
  assert.equal(called, 0);
  let timeout, rejectLate;
  const cleared = [], timers = { setTimeout(fn) { timeout = fn; return 7; }, clearTimeout(handle) { cleared.push(handle); } };
  const pending = validationStep(() => { called++; return new Promise((resolve, reject) => { rejectLate = reject; }); },
    { timeoutMs: 1, timers });
  const rejected = assert.rejects(pending, /validation_step_timeout/);
  await Promise.resolve();
  assert.equal(called, 1); timeout(); await rejected;
  rejectLate(new Error("late-synthetic-error"));
  await Promise.resolve();
  assert.ok(cleared.includes(7));
  assert.equal(await validationStep(() => 42, { timeoutMs: 1, timers }), 42);
});
it("看门预算是明确有限正整数，不接受零/负/Infinity/隐式类型或超范围", () => {
  assert.deepEqual(validationBudgets(), { scenarioMs: 300000, matrixMs: 3600000, cleanupMs: 15000 });
  for (const value of ["0", "-1", "1.5", "Infinity", " 10", "01", "1e3", "10\n", 1, null, "86400001"])
    assert.throws(() => validationBudgets({ VALIDATION_SCENARIO_MS: value }), /invalid_validation_budget/);
  assert.deepEqual(validationBudgets({ VALIDATION_SCENARIO_MS: "1", VALIDATION_MATRIX_MS: "2", VALIDATION_CLEANUP_MS: "3" }),
    { scenarioMs: 1, matrixMs: 2, cleanupMs: 3 });
});

it("子进程环境只取安全白名单与当前场景flags，不带父secret/NODE_OPTIONS/TEST残留", () => {
  const input = { PATH: "synthetic-path", SystemRoot: "synthetic-windows", SECRET: "private",
    NODE_OPTIONS: "--require private.js", TEST_UNRELATED: "1", HOME: "user-home", PYTHONPATH: "private" };
  const dirs = { home: "scratch/home", temp: "scratch/temp", appdata: "scratch/appdata", localappdata: "scratch/local" };
  const before = JSON.stringify(input);
  const env = validationEnvironment(input, dirs, { executable: "synthetic-chrome", flags: { TEST_FRAME_TREE: "1" } });
  assert.equal(Object.getPrototypeOf(env), null);
  assert.equal(env.PATH, input.PATH);
  assert.equal(env.HOME, dirs.home);
  assert.equal(env.TEST_FRAME_TREE, "1");
  for (const key of ["SECRET", "NODE_OPTIONS", "TEST_UNRELATED", "PYTHONPATH"]) assert.equal(Object.hasOwn(env, key), false);
  assert.equal(JSON.stringify(input), before);
  assert.throws(() => validationEnvironment(input, dirs, { flags: { NODE_OPTIONS: "no" } }), /invalid_scenario_flags/);
});
