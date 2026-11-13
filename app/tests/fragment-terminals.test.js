import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createFragmentTerminals } from "../src/fragment-terminals.js";
import { reconstructFragments } from "../src/fragments.js";
import { observeBrowserData, incompleteBrowserObservation } from "../src/browser-observations.js";
import { createBrowserFieldSummary } from "../src/browser-field-summary.js";

// 验证状态：仅编写和静态复核，未运行（完整 OS 隔离尚未确认）。
const reference = { captureId: "capture", field: "databaseGraph", parts: 1, length: 10 };
const end = (extra = {}) => ({ kind: "capture.fragmentEnd", payload: { ...reference, status: "confirmed", ...extra } });
const failure = (extra = {}) => ({ kind: "capture.fragmentFailure", payload: { ...reference, status: "failed", ...extra } });

function index(events) {
  const terminals = createFragmentTerminals();
  for (const event of events) terminals.add(event);
  return terminals;
}

it("End 之后的实际 Failure 也会预先阻止重组，前后顺序不改变失败事实", () => {
  for (const events of [[end(), failure()], [failure(), end()], [end(), failure(), end()]])
    assert.throws(() => index(events).validate(reference), /失败终态/);
});

it("实际 Failure 仅凭同 captureId+field 否决，不依赖 status/length/parts 合法", () => {
  for (const payload of [
    { captureId: reference.captureId, field: reference.field },
    { captureId: reference.captureId, field: reference.field, status: "unknown", length: -1, parts: "bad" },
  ]) assert.throws(() => index([end(), { kind: "capture.fragmentFailure", payload }]).validate(reference), /失败终态/);
});

it("同组 End 之后任意 part 使首次重组预先失败，不读取或保留正文", () => {
  const late = { kind: "capture.fragment", payload: { captureId: reference.captureId, field: reference.field,
    get data() { throw new Error("不应读取分段正文"); } } };
  assert.throws(() => index([end(), late]).validate(reference), /结束确认后仍有/);
  assert.equal(index([end(), { kind: "capture.fragment", payload: { ...reference, field: "other" } }]).validate(reference), true);
});

it("按 captureId+field 区分终态，不把其他 field/capture 的失败并入", () => {
  const terminals = index([end(), failure({ field: "storage" }), failure({ captureId: "other" })]);
  assert.equal(terminals.validate(reference), true);
  assert.throws(() => terminals.validate({ ...reference, field: "storage" }), /失败终态/);
  assert.throws(() => terminals.validate({ ...reference, captureId: "missing" }), /未收到/);
});

it("缺失、重复及不合法 End 均不能支持成功重组", () => {
  assert.throws(() => index([]).validate(reference), /未收到/);
  assert.throws(() => index([end(), end()]).validate(reference), /重复/);
  for (const extra of [{ status: "unknown" }, { status: "pending" }, { parts: 2 }, { length: 11 },
    { parts: null }, { length: "10" }, { parts: 0 }, { length: Number.MAX_SAFE_INTEGER + 1 }])
    assert.throws(() => index([end(extra)]).validate(reference), /无效/);
});

it("reference 的正 safe integer 与非空标识前置检查不替代正文长度校验", () => {
  const terminals = index([end()]);
  for (const invalid of [null, [], {}, { ...reference, captureId: "" }, { ...reference, field: "" },
    { ...reference, parts: 0 }, { ...reference, parts: 1.2 }, { ...reference, parts: 2 }, { ...reference, length: 0 },
    { ...reference, length: "10" }, { ...reference, parts: Number.MAX_SAFE_INTEGER + 1 }])
    assert.throws(() => terminals.validate(invalid), /引用无效/);
  assert.equal(terminals.validate(reference), true);
  assert.throws(() => reconstructFragments(reference, [end()]), /不完整|未确认/);
});

it("只保留终态标量投影，不持有正文、任意 reason 或原事件引用", () => {
  const terminal = end();
  const terminals = index([{ kind: "capture.fragment", payload: { ...reference, data: "synthetic-body-secret" } }, terminal,
    { kind: "delivery.unknown", payload: { ...reference, status: "unknown" } }]);
  terminal.payload.status = "failed";
  terminal.payload.parts = 99;
  assert.equal(terminals.validate(reference), true);
  // ACK unknown/transport diagnostics do not invent a capture.fragmentFailure fact.
  assert.equal(index([end(), { kind: "capture.deliveryUnconfirmed", payload: reference }]).validate(reference), true);
});

it("无矛盾终态且正文完整时保留原始重组结果和可追溯字段", () => {
  const graph = { root: { type: "ref", id: 0 }, nodes: [
    { id: 0, type: "object", entries: [["name", { type: "string", value: "synthetic-original-value" }]] },
  ] };
  const text = JSON.stringify(graph), ref = { ...reference, length: text.length };
  const fragment = { kind: "capture.fragment", payload: { ...ref, index: 0, data: text } };
  const terminal = { kind: "capture.fragmentEnd", payload: { ...ref, status: "confirmed" } };
  assert.equal(index([fragment, terminal]).validate(ref), true);
  assert.equal(reconstructFragments(ref, [fragment, terminal]), text);
  const event = { id: "record", sessionId: "session", documentId: "document", kind: "database.record",
    payload: { database: "db", store: "items", url: "https://shop.example/page", status: "fragmented", graphReference: ref } };
  const rows = [...observeBrowserData(event, { path: "timeline/events.jsonl", line: 3 }, JSON.parse(text))];
  assert.equal(rows[0].status, "fragmented");
  assert.ok(rows.some((row) => row.path === "/name" && row.source.line === 3));
  assert.doesNotMatch(JSON.stringify(rows), /synthetic-original-value/);
  assert.equal(fragment.payload.data, text);
});

it("有效End的终态门禁之后仍需完整fragment正文，坏正文不得产生字段", () => {
  const terminals = index([end()]);
  assert.equal(terminals.validate(reference), true);
  assert.throws(() => reconstructFragments(reference, [
    { kind: "capture.fragment", payload: { ...reference, index: 0, data: "short" } }, end(),
  ]), /无效|不完整/);
});

it("预扫到 late Failure/duplicate End 时首次 End 只产 incomplete，不污染成功字段统计", () => {
  const graph = { root: { type: "ref", id: 0 }, nodes: [
    { id: 0, type: "object", entries: [["name", { type: "string", value: "synthetic-record-secret" }]] },
  ] };
  const text = JSON.stringify(graph), ref = { ...reference, length: text.length };
  const origin = { sessionId: "session", tabId: 1, frameId: 0, documentId: "document" };
  const event = { ...origin, id: "fragmented", kind: "database.record", payload: { database: "db", store: "items", index: 1,
    url: "https://shop.example/page", graphCaptureId: "graph", status: "fragmented", graphReference: ref } };
  const fragment = { kind: "capture.fragment", payload: { ...ref, index: 0, data: text } };
  const terminal = { kind: "capture.fragmentEnd", payload: { ...ref, status: "confirmed" } };
  for (const late of [{ kind: "capture.fragmentFailure", payload: { ...ref, status: "failed" } }, terminal]) {
    const allEvents = [event, fragment, terminal, late];
    const terminals = index(allEvents), summary = createBrowserFieldSummary();
    const complete = { ...event, id: "complete", payload: { ...event.payload, status: "captured", graph } };
    for (const row of observeBrowserData(complete, { path: "timeline/events.jsonl", line: 1 })) summary.add(row);
    const rows = [];
    try {
      // This is the first End, before the late terminal is visited by the main pass.
      terminals.validate(ref);
      rows.push(...observeBrowserData(event, { path: "timeline/events.jsonl", line: 2 }, JSON.parse(reconstructFragments(ref, [fragment, terminal]))));
    } catch (error) {
      rows.push(incompleteBrowserObservation(event, { path: "timeline/events.jsonl", line: 2 }, String(error)));
    }
    assert.deepEqual(rows.map((row) => row.kind), ["sample"]);
    assert.equal(rows[0].status, "incomplete");
    for (const row of rows) summary.add(row);
    const field = [...summary.results()].find((row) => row.path === "/name");
    assert.equal(field.observedSamples, 1);
    assert.deepEqual(field.sampleCounts, { total: 2, available: 1 });
    assert.doesNotMatch(JSON.stringify([...summary.results()]), /synthetic-record-secret/);
  }
});

it("archive 在主流前预扫且在 decode 前校验终态（静态连线检查）", async () => {
  const code = await readFile(new URL("../src/archive.js", import.meta.url), "utf8");
  assert.ok(code.indexOf("fragmentTerminals.add(event)") < code.indexOf("let after = 0"));
  assert.ok(code.indexOf("fragmentTerminals.validate(pending.reference)") < code.indexOf("JSON.parse(reconstructFragments(pending.reference"));
  assert.match(code, /terminalEventCount !== count/);
  assert.match(code, /eventCount !== terminalEventCount/);
  assert.match(code, /after !== terminalAfter/);
});
