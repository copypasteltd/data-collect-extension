import { it } from "node:test";
import assert from "node:assert/strict";
import { CAPTURE_SCENARIOS, createCapturePlan, summarizeCaptureResults } from "./capture-scenarios.mjs";

// Authored only, NOT RUN. Pure catalog/aggregation assertions do not start Chrome.
it("保留48个固定场景和两个显式可选字体场景", () => {
  const fixed = createCapturePlan(), withFont = createCapturePlan({ fontAvailable: true });
  assert.equal(CAPTURE_SCENARIOS.length, 48);
  assert.equal(fixed.length, 50);
  assert.equal(new Set(fixed.map((s) => s.id)).size, 50);
  assert.equal(fixed.filter((s) => s.state === "pending").length, 48);
  assert.deepEqual(fixed.filter((s) => s.state === "skipped").map((s) => s.id), ["font", "initial-resources"]);
  assert.ok(withFont.every((s) => s.state === "pending"));
  fixed[0].flags.TEST_LARGE_DOM = "changed";
  assert.equal(createCapturePlan()[0].flags.TEST_LARGE_DOM, "1");
});

it("超时/中断/启动错误/清理未确认/未启动都不能汇总成全过", () => {
  const passed = createCapturePlan().map((s) => ({ id: s.id, status: s.state === "skipped" ? "skipped" : "passed" }));
  assert.equal(summarizeCaptureResults(passed).passed, true);
  assert.deepEqual(summarizeCaptureResults(passed).counts, { passed: 48, skipped: 2 });
  for (const status of ["failed", "timed_out", "interrupted", "spawn_error", "cleanup_unconfirmed", "not_run"]) {
    const results = passed.map((row, index) => index ? row : { ...row, status });
    assert.equal(summarizeCaptureResults(results).passed, false);
  }
  assert.equal(summarizeCaptureResults(passed, { interrupted: true }).passed, false);
  assert.equal(summarizeCaptureResults(passed, { preflightFailed: true }).passed, false);
  assert.equal(summarizeCaptureResults(passed, { identityMatches: false }).status, "invalidated");
  assert.equal(summarizeCaptureResults([]).passed, false);
  assert.equal(summarizeCaptureResults([{ id: "font", status: "skipped" }]).passed, false);
});
