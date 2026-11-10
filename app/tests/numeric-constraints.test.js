import { it } from "node:test";
import assert from "node:assert/strict";
import { normalizeNumericConstraint, readNumericConstraints } from "../src/numeric-constraints.js";

it("保留有效数值约束并忽略无效、过长和非有限值", () => {
  assert.equal(normalizeNumericConstraint("min", "-2.5"), "-2.5");
  assert.equal(normalizeNumericConstraint("max", "1e3"), "1e3");
  assert.equal(normalizeNumericConstraint("step", "ANY"), "any");
  for (const value of ["0", "-1", "1e999", "secret=12", "1".repeat(65), null, {}])
    assert.equal(normalizeNumericConstraint("step", value), null);
  const input = { getAttribute: (name) => ({ min: "-10", max: "bad", step: "0.25" })[name] ?? null };
  assert.deepEqual(readNumericConstraints(input), { min: "-10", max: null, step: "0.25" });
});
