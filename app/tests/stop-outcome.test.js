import { it } from "node:test";
import assert from "node:assert/strict";
import { collectorFlushOutcome, normalStopOutcome } from "../src/stop-outcome.js";

it("the real large-page FLUSH producer deadline is not unknown transport or interrupted lifecycle", () => {
  const reply = { ok: false, failedEvents: 0, unknownEvents: 0, captureIncomplete: true, needsVerification: true };
  const outcome = collectorFlushOutcome(reply);
  assert.equal(outcome.transportUnknown, false); assert.equal(outcome.failedDelivery, false); assert.equal(outcome.producerOnly, true);
  assert.equal(normalStopOutcome({ incomplete: true, captureIncomplete: true, needsVerification: true }).result, "completed_with_gaps");
});
it("known producer gaps never erase actual storage delivery transport or cleanup failures", () => {
  const producer = { incomplete: true, captureIncomplete: true, needsVerification: true };
  for (const extra of [{ storageError: true }, { unknownEvents: 1 }, { communicationUnknown: true },
    { collectorUnresponsive: true }, { collectorFailedEvents: 1 }, { droppedEvents: 1 }, { coverage: { status: "unavailable" } }])
    assert.equal(normalStopOutcome({ ...producer, ...extra }).result, "interrupted");
  assert.equal(normalStopOutcome(producer, { finalizationFailed: true }).result, "interrupted");
  const beforeStop = { incomplete: true };
  const finalizationFailed = !!beforeStop.incomplete && !beforeStop.captureIncomplete && !beforeStop.needsVerification;
  assert.equal(normalStopOutcome({ ...beforeStop, ...producer }, { finalizationFailed }).result, "interrupted");
  assert.equal(normalStopOutcome(producer, { stoppedDuringPreparation: true }).result, "interrupted");
});
it("malformed or unexplained negative FLUSH is unknown; explicit failed delivery stays failed", () => {
  for (const result of [null, {}, { ok: false }, { ok: true, failedEvents: -1, unknownEvents: 0 },
    { ok: false, failedEvents: 0, unknownEvents: 0 }]) assert.equal(collectorFlushOutcome(result).transportUnknown, true);
  const failed = collectorFlushOutcome({ ok: false, failedEvents: 1, unknownEvents: 0 });
  assert.equal(failed.failedDelivery, true); assert.equal(failed.transportUnknown, false);
  assert.equal(collectorFlushOutcome({ ok: false, failedEvents: 0, unknownEvents: 1 }).transportUnknown, true);
});
it("clean user stop and unexplained preexisting incomplete retain conservative status", () => {
  assert.equal(normalStopOutcome({}).result, "completed");
  assert.equal(normalStopOutcome({ incomplete: true }).result, "interrupted");
  assert.equal(normalStopOutcome({ needsVerification: true }).result, "completed_with_gaps");
  for (const coverage of [{ databaseGaps: 1 }, { fullPageScreenshotGaps: 1 }, { styleGaps: 1 }])
    assert.equal(normalStopOutcome({ coverage }).result, "completed_with_gaps");
  assert.equal(normalStopOutcome({ coverage: { eventCount: 100, lastSeq: 120 } }).result, "completed");
});
