// Twenty identical short business cycles; the independent 60s acceptance is not this P95 workload.
import assert from "node:assert/strict";
import { runAcceptance } from "./flow-acceptance.e2e.mjs";
const rounds = Number(process.env.PERF_ROUNDS || 20);
assert.equal(rounds, 20, "formal performance report requires PERF_ROUNDS=20");
await runAcceptance({ mode: "performance", rounds, durationMs: Number(process.env.PERF_DURATION_MS || 5000) });
