import { it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { FRAGMENT_LENGTH, fragmentReference } from "../src/fragment-writer.js";
import { reconstructFragments, indexFragmentEvidence } from "../src/fragments.js";

it("按原始 UTF-16 内容重组页面，缺段、重复和中断均不视为完整", () => {
  const text = "x".repeat(FRAGMENT_LENGTH - 1) + "😀" + "y".repeat(FRAGMENT_LENGTH + 4);
  const reference = fragmentReference(text, "capture-1", "sourceHtml");
  const parts = Array.from({ length: reference.parts }, (_, index) => ({
    kind: "capture.fragment", seq: index + 1, payload: { ...reference, index,
      data: text.slice(index * FRAGMENT_LENGTH, (index + 1) * FRAGMENT_LENGTH) },
  }));
  const end = { kind: "capture.fragmentEnd", seq: reference.parts + 1, payload: { ...reference, status: "confirmed" } };
  assert.equal(reconstructFragments(reference, [...parts, end]), text);
  assert.throws(() => reconstructFragments(reference, parts), /不完整/);
  assert.throws(() => reconstructFragments(reference, [parts[0], ...parts, end]), /重复/);
  assert.throws(() => reconstructFragments(reference, [end, ...parts]), /未确认/);
  assert.throws(() => reconstructFragments(reference, [...parts.slice(1), end]), /未确认/);
  assert.throws(() => reconstructFragments(reference, [...parts, { ...end, payload: { ...end.payload, status: "failed" } }]), /未确认/);
  assert.equal(indexFragmentEvidence([...parts, end])(reference), true);
  assert.equal(indexFragmentEvidence([end, ...parts.slice().reverse()])(reference), true);
  assert.equal(indexFragmentEvidence(parts)(reference), false);
  assert.equal(indexFragmentEvidence([...parts, end])(undefined), false);
});

// Authored for ARCH06; not executed while OS isolation is unconfirmed.
it("显式 Failure 在任意位置否定 End 确认，错误 metadata 不能把 Failure 预筛掉", () => {
  const reference = fragmentReference("x", "capture-failure", "sourceHtml");
  const part = { kind: "capture.fragment", seq: 1, payload: { ...reference, index: 0, data: "x" } };
  const end = { kind: "capture.fragmentEnd", seq: 2, payload: { ...reference, status: "confirmed" } };
  for (const metadata of [{}, { parts: 0, length: "invalid", status: "confirmed" }]) {
    const failure = { kind: "capture.fragmentFailure", seq: 3, payload: {
      captureId: reference.captureId, field: reference.field, ...metadata,
    } };
    for (const position of [0, 1, 2]) {
      const events = [part, end];
      events.splice(position, 0, failure);
      assert.throws(() => reconstructFragments(reference, events), /失败/);
      assert.equal(indexFragmentEvidence(events)(reference), false);
      assert.equal(indexFragmentEvidence(events.slice().reverse())(reference), false);
    }
  }
});

it("Failure 只否定同 captureId 和 field；unknown ACK 不是显式 Failure", () => {
  const reference = fragmentReference("x", "capture-identity", "sourceHtml");
  const part = { kind: "capture.fragment", seq: 1, payload: { ...reference, index: 0, data: "x" } };
  const end = { kind: "capture.fragmentEnd", seq: 2, payload: { ...reference, status: "confirmed" } };
  const unrelated = [
    { kind: "capture.fragmentFailure", seq: 3, payload: { ...reference, captureId: "other" } },
    { kind: "capture.fragmentFailure", seq: 4, payload: { ...reference, field: "html" } },
    { kind: "warning", seq: 5, payload: { ...reference, status: "unknown", reason: "ACK unknown" } },
  ];
  assert.equal(reconstructFragments(reference, [part, end, ...unrelated]), "x");
  assert.equal(indexFragmentEvidence([part, end, ...unrelated])(reference), true);
  assert.equal(indexFragmentEvidence([part, ...unrelated])(reference), false);
});

it("零长度分片引用不能冒充空文件的直传空值", () => {
  const reference = fragmentReference("", "empty-file", "fileBytesBase64");
  const end = { kind: "capture.fragmentEnd", seq: 1, payload: { ...reference, status: "confirmed" } };
  assert.throws(() => reconstructFragments(reference, [end]), /引用无效/);
  assert.equal(indexFragmentEvidence([end])(reference), false);
});

function expandFixtureText(value) {
  return Array.isArray(value)
    ? value.map((part) => typeof part === "string" ? part : part.text.repeat(part.repeat)).join("")
    : value;
}

function fixtureEvents(entry) {
  const kinds = { part: "capture.fragment", end: "capture.fragmentEnd", failure: "capture.fragmentFailure" };
  return entry.events.map((recipe, offset) => {
    const payload = { ...entry.reference };
    if (recipe.type === "part") Object.assign(payload, { index: recipe.index, data: expandFixtureText(recipe.data) });
    if (recipe.type === "end") payload.status = "confirmed";
    if (recipe.type === "failure") payload.status = "failed";
    Object.assign(payload, recipe.payload);
    for (const key of recipe.omit || []) delete payload[key];
    return { kind: kinds[recipe.type] || recipe.kind, seq: offset + 1, payload };
  });
}

it("JS 消费共享 golden fixture：终态、严格 metadata 与 UTF-16（未运行）", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/fragment-conformance.json", import.meta.url), "utf8"));
  const errors = { reference: /分段引用无效/, failure: /分段传输失败/, incomplete: /分段数据不完整/ };
  assert.equal(fixture.format, "fragment-conformance-v1");
  for (const entry of fixture.cases) {
    const events = fixtureEvents(entry);
    if (entry.complete) assert.equal(reconstructFragments(entry.reference, events), expandFixtureText(entry.expected), entry.name);
    else assert.throws(() => reconstructFragments(entry.reference, events), errors[entry.error], entry.name);
    assert.equal(indexFragmentEvidence(events)(entry.reference), entry.complete, entry.name);
    assert.equal(indexFragmentEvidence(events.slice().reverse())(entry.reference), entry.complete, `${entry.name}: input order`);
  }
});

it("共享 numeric oracle 覆盖引用、分片及 End 各字段（未运行）", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/fragment-conformance.json", import.meta.url), "utf8"));
  const targets = [["reference", "length"], ["reference", "parts"], [0, "length"], [0, "parts"],
    [1, "length"], [1, "parts"], [0, "index"]];
  for (const numeric of fixture.safeIntegerCases) {
    const value = JSON.parse(numeric.valueJson);
    assert.equal(Number.isSafeInteger(value), numeric.safe, numeric.name);
    for (const [target, key] of targets) {
      const reference = { captureId: "numeric", field: "sourceHtml", length: 1, parts: 1 };
      const events = [
        { kind: "capture.fragment", seq: 1, payload: { ...reference, index: 0, data: "x" } },
        { kind: "capture.fragmentEnd", seq: 2, payload: { ...reference, status: "confirmed" } },
      ];
      if (target === "reference") reference[key] = value;
      else events[target].payload[key] = value;
      const expected = numeric.safe && value === (key === "index" ? 0 : 1);
      const label = `${numeric.name}: ${target}.${key}`;
      if (expected) assert.equal(reconstructFragments(reference, events), "x", label);
      else assert.throws(() => reconstructFragments(reference, events), label);
      assert.equal(indexFragmentEvidence(events)(reference), expected, label);
    }
  }
});
