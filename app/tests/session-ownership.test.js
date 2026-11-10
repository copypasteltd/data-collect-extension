import { it } from "node:test";
import assert from "node:assert/strict";
import { canRecoverSession } from "../src/session-ownership.js";

it("仅在其他批次已结束且时间明确早于目标时允许故障恢复", () => {
  const current = { id: "current", startedAt: 20, status: "recording" };
  const earlier = { id: "earlier", startedAt: 10, status: "ready" };
  assert.equal(canRecoverSession(current, [earlier, current]), true);
  assert.equal(canRecoverSession(current, [{ ...earlier, status: "stopping" }, current]), false);
  assert.equal(canRecoverSession(current, [{ ...earlier, startedAt: 20 }, current]), false);
  assert.equal(canRecoverSession(current, [{ ...earlier, startedAt: 30 }, current]), false);
  assert.equal(canRecoverSession(current, [{ ...earlier, startedAt: null }, current]), false);
  assert.equal(canRecoverSession({ ...current, startedAt: null }, [earlier]), false);
});
