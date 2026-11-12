import { it } from "node:test";
import assert from "node:assert/strict";
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
