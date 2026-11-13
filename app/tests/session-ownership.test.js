import { it } from "node:test";
import assert from "node:assert/strict";
import { canRecoverSession, recoverySessionDiagnostic } from "../src/session-ownership.js";

it("仅在其他批次已结束且时间明确早于目标时允许故障恢复", () => {
  const current = { id: "current", startedAt: 20, status: "recording" };
  const earlier = { id: "earlier", startedAt: 10, status: "ready" };
  assert.equal(canRecoverSession(current, [earlier, current]), true);
  assert.equal(canRecoverSession(current, [{ ...earlier, status: "stopping" }, current]), false);
  assert.equal(canRecoverSession(current, [{ ...earlier, startedAt: 20 }, current]), false);
  assert.equal(canRecoverSession(current, [{ ...earlier, startedAt: 30 }, current]), false);
  assert.equal(canRecoverSession(current, [{ ...earlier, startedAt: null }, current]), false);
  assert.equal(canRecoverSession({ ...current, startedAt: null }, [earlier]), false);
  // Missing hint plus a newer/same-clock completed row is not proof of owner.
  assert.match(recoverySessionDiagnostic(current, [{ ...earlier, startedAt: 20 }, current]), /同刻或更新/);
  assert.match(recoverySessionDiagnostic(current, [{ ...earlier, startedAt: null }, current]), /开始时间未知/);
  assert.match(recoverySessionDiagnostic(current, [{ ...earlier, status: "recording" }, current]), /其他活动/);
  assert.match(recoverySessionDiagnostic({ ...current, startedAt: null }, [earlier]), /目标开始时间未知/);
  assert.equal(recoverySessionDiagnostic(current, [earlier, current]), null);
});
