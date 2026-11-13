import { it } from "node:test";
import assert from "node:assert/strict";
import { storageWriteDiagnostic, mergeStorageDiagnostics } from "../src/storage-diagnostics.js";
import { mergeInterruptionDiagnostics, sessionWriteError } from "../src/session-lifecycle.js";

// Authored, NOT RUN. Synthetic errors/session records only; no browser or IDB.
const context = { phase: "closed", finalEvent: true, observedAt: 1700000000000 };

it("storage diagnostic 只投影枚举，敏感 message/stack/URL/原值不读取或持久化", () => {
  const error = { name: "QuotaExceededError", code: 22 };
  for (const key of ["message", "stack", "url", "value"])
    Object.defineProperty(error, key, { get() { assert.fail("must not read " + key); } });
  assert.deepEqual(storageWriteDiagnostic(error, context), {
    phase: "closed", finalEvent: true, category: "quota_reported",
    errorName: "QuotaExceededError", errorCode: 22, observedAt: context.observedAt,
  });
  const privateError = { name: "https://example.test/private", code: "secret-value",
    message: "synthetic private message", stack: "synthetic private stack", url: "https://example.test/private", value: "raw" };
  const unknown = storageWriteDiagnostic(privateError, context);
  assert.equal(unknown.errorName, "unknown"); assert.equal(unknown.errorCode, "unknown");
  assert.ok(!JSON.stringify(unknown).includes("private")); assert.ok(!JSON.stringify(unknown).includes("raw"));
});

it("unknown 稳定，抛异常的 name/code getter 不影响错误处理", () => {
  const hostile = {};
  for (const key of ["name", "code"])
    Object.defineProperty(hostile, key, { get() { throw new Error("synthetic getter failure"); } });
  const expected = { phase: "closed", finalEvent: true, category: "unknown",
    errorName: "unknown", errorCode: "unknown", observedAt: context.observedAt };
  for (const error of [null, "synthetic private string", new Error("本地存储写入超时"), hostile])
    assert.deepEqual(storageWriteDiagnostic(error, context), expected);
});

it("已知 code/name 区分报告的 quota/abort/timeout、IDB 和会话拒绝，不推断真实原因", () => {
  for (const [error, category, errorName, errorCode] of [
    [{ name: "QuotaExceededError" }, "quota_reported", "QuotaExceededError", "unknown"],
    [{ code: 22 }, "quota_reported", "unknown", 22],
    [{ name: "AbortError", code: 20 }, "abort_reported", "AbortError", 20],
    [{ name: "TimeoutError", code: 23 }, "timeout_reported", "TimeoutError", 23],
    [{ name: "ConstraintError" }, "idb_reported", "ConstraintError", "unknown"],
    [{ name: "Error", code: "session_writes_closed" }, "session_rejected", "unknown", "session_writes_closed"],
    [{ code: "session_owner_mismatch" }, "session_rejected", "unknown", "session_owner_mismatch"],
    [{ code: "failed" }, "write_rejected", "unknown", "failed"],
  ]) {
    const diagnostic = storageWriteDiagnostic(error, context);
    assert.equal(diagnostic.category, category); assert.equal(diagnostic.errorName, errorName); assert.equal(diagnostic.errorCode, errorCode);
  }
});

it("phase/finalEvent 与 observedAt 安全化，不把任意上下文值复制进诊断", () => {
  for (const observedAt of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER, "1700000000000"])
    assert.equal(storageWriteDiagnostic({}, { ...context, observedAt }).observedAt, null);
  assert.equal(storageWriteDiagnostic({}, { ...context, observedAt: 0 }).observedAt, 0);
  assert.equal(storageWriteDiagnostic({}, { ...context, observedAt: 8640000000000000 }).observedAt, 8640000000000000);
  assert.equal(storageWriteDiagnostic({}, { ...context, phase: "synthetic private phase", finalEvent: "yes" }).phase, "unknown");
  assert.equal(storageWriteDiagnostic({}, { ...context, finalEvent: "yes" }).finalEvent, false);
});

it("最近一次诊断固定单槽，重复错误或带多余原值的 merge 不增长", () => {
  const original = storageWriteDiagnostic({ name: "AbortError" }, context);
  const newer = storageWriteDiagnostic({ code: "failed" }, { ...context, observedAt: context.observedAt + 1 });
  assert.deepEqual(mergeStorageDiagnostics(newer, original), newer);
  assert.deepEqual(mergeStorageDiagnostics(newer, { ...original, observedAt: null }), newer);
  let merged = original;
  for (let count = 0; count < 20; count++) merged = mergeStorageDiagnostics(merged, {
    ...newer, message: "synthetic private message", stack: "synthetic private stack", url: "https://example.test/private", history: [original],
  });
  assert.deepEqual(merged, newer); assert.equal(Object.keys(merged).length, 6);
  assert.deepEqual(mergeStorageDiagnostics(merged, merged), merged);
});

it("interrupt merge 持久保留诊断且不覆盖已有 owner/revision/seq/producer/final-stop 权威字段", () => {
  const existing = { id: "A", ownerId: "owner-A", status: "stopping", writeState: "closed", revision: 7,
    lastSeq: 4, producerVersion: "synthetic-v1", finalStopEventId: "original-stop", raw: { evidence: "original" },
    storageDiagnostic: storageWriteDiagnostic({ name: "AbortError" }, context) };
  const storageDiagnostic = storageWriteDiagnostic({ code: "failed" }, { ...context, observedAt: context.observedAt + 1 });
  const incoming = { ...existing, ownerId: "stale", status: "interrupted", writeState: "open", revision: 0,
    lastSeq: 0, producerVersion: "wrong", finalStopEventId: "wrong", storageError: true, storageDiagnostic };
  const merged = mergeInterruptionDiagnostics(existing, incoming, "synthetic interruption");
  for (const key of ["id", "ownerId", "status", "writeState", "revision", "lastSeq", "producerVersion", "finalStopEventId", "raw"])
    assert.deepEqual(merged[key], existing[key]);
  assert.equal(merged.storageError, true); assert.deepEqual(merged.storageDiagnostic, storageDiagnostic);
  assert.deepEqual(existing.storageDiagnostic.errorName, "AbortError");
  assert.deepEqual(mergeInterruptionDiagnostics(merged, incoming, "synthetic interruption").storageDiagnostic, storageDiagnostic);
  // Diagnostics do not change the existing evidence write gate or final exception.
  assert.equal(sessionWriteError({ ...existing, finalStopEventId: undefined }, "owner-A", true), null);
  assert.equal(sessionWriteError(existing, "owner-A", false), "session_writes_closed");
  assert.equal(sessionWriteError({ ...existing, status: "ready", seal: { revision: 7 } }, "owner-A", true), "session_finalized");
});
