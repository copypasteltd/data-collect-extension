import { it } from "node:test";
import assert from "node:assert/strict";
import { runCaptureMatrix } from "./capture-matrix-run.mjs";

// Authored, NOT RUN. Injected adapters never spawn processes or access disk.
const plan = () => [{ id: "a", flags: {}, state: "pending" }, { id: "b", flags: {}, state: "pending" },
  { id: "font", flags: {}, state: "skipped", reason: "font_fixture_unavailable" }];
const identity = async () => ({ status: "complete", sourceDigest: "a".repeat(64), distDigest: "b".repeat(64) });
it("同一输入且每个必选场景确认通过才能完整，skip保持显式", async () => {
  const history = [];
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: identity,
    runScenario: async (s) => ({ id: s.id, status: "passed", cleanupStatus: "confirmed" }),
    onUpdate: async (row) => history.push(row) });
  assert.equal(result.status, "completed"); assert.equal(result.passed, true);
  assert.deepEqual(result.counts, { passed: 2, skipped: 1 });
  assert.equal(history[0].results[0].status, "not_run");
});
it("缺构建身份拒绝执行，不保存任意异常文本", async () => {
  let runs = 0;
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: async () => { throw new Error("private"); },
    runScenario: async () => { runs++; } });
  assert.equal(runs, 0); assert.equal(result.passed, false);
  assert.equal(result.failure, "preflight_identity_failure");
  assert.doesNotMatch(JSON.stringify(result), /private/);
});
it("缺失或伪造形状的identity不能以两个undefined digest相等判通过", async () => {
  for (const value of [null, {}, { status: "incomplete", sourceDigest: "a".repeat(64), distDigest: "b".repeat(64) },
    { status: "complete", sourceDigest: "not-a-digest", distDigest: "not-a-digest" },
    { status: "complete", sourceDigest: "a".repeat(64) + "\n", distDigest: "b".repeat(64) },
    { status: "complete", sourceDigest: "a".repeat(64), distDigest: "b".repeat(64) + "\n" },
    { status: "complete", sourceDigest: { toString: () => "a".repeat(64) }, distDigest: "b".repeat(64) }]) {
    let runs = 0;
    const result = await runCaptureMatrix({ plan: plan(), captureIdentity: async () => value,
      runScenario: async () => { runs++; } });
    assert.equal(runs, 0); assert.equal(result.passed, false);
  }
});
it("构建/源码运行中变化会invalidated，不能转为全过", async () => {
  let reads = 0;
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: async () => ({ status: "complete", sourceDigest: (++reads === 1 ? "a" : "c").repeat(64), distDigest: "b".repeat(64) }),
    runScenario: async (s) => ({ id: s.id, status: "passed", cleanupStatus: "confirmed" }) });
  assert.equal(result.status, "invalidated"); assert.equal(result.passed, false);
});
it("清理未确认停止后续场景，保留not_run且不吞已记录失败", async () => {
  let runs = 0;
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: identity,
    runScenario: async (s) => { runs++; return { id: s.id, status: "cleanup_unconfirmed", cleanupStatus: "unconfirmed" }; } });
  assert.equal(runs, 1); assert.equal(result.passed, false);
  assert.equal(result.results[1].status, "not_run");
});
it("缺少已拥有资源清理确认的0退出不能冒充passed", async () => {
  let runs = 0;
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: identity,
    runScenario: async (s) => { runs++; return { id: s.id, status: "passed", code: 0 }; } });
  assert.equal(runs, 1); assert.equal(result.results[0].status, "cleanup_unconfirmed");
  assert.equal(result.passed, false);
});
it("失败或超时结果缺清理确认也停止后续并保留原失败类别", async () => {
  for (const status of ["failed", "timed_out", "interrupted", "spawn_error"]) {
    let runs = 0;
    const result = await runCaptureMatrix({ plan: plan(), captureIdentity: identity,
      runScenario: async (s) => { runs++; return { id: s.id, status }; } });
    assert.equal(runs, 1); assert.equal(result.results[0].status, status);
    assert.equal(result.results[0].cleanupStatus, "unconfirmed");
    assert.equal(result.results[1].status, "not_run"); assert.equal(result.passed, false);
  }
});
it("最后结果持久化期间abort必须改写为incomplete且返回非通过", async () => {
  const controller = new AbortController(), reports = [];
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: identity, signal: controller.signal,
    runScenario: async (s) => ({ id: s.id, status: "passed", cleanupStatus: "confirmed" }),
    onUpdate: async (row) => { reports.push(row); if (row.status === "completed") controller.abort(); } });
  assert.equal(result.passed, false); assert.equal(result.status, "incomplete");
  assert.equal(reports.at(-1).passed, false); assert.equal(reports.at(-1).status, "incomplete");
});
it("轮次abort不继续开场景，非0/timeout等不能完整", async () => {
  const controller = new AbortController();
  const result = await runCaptureMatrix({ plan: plan(), captureIdentity: identity, signal: controller.signal,
    runScenario: async (s) => { controller.abort(); return { id: s.id, status: "timed_out", cleanupStatus: "confirmed" }; } });
  assert.equal(result.results[1].status, "not_run"); assert.equal(result.passed, false);
});
