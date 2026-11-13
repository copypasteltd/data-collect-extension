import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FLOW_LIMITS as L, FLOW_CATEGORIES, MiB, byteCount, utf8ByteLength,
  knownByteLength, createBudget, preflightContent, evaluateBudget, stopBudget,
} from "../src/flow-budget.js";

// No dependency is added. A reproducible seeded generator exercises mathematical
// policy invariants against a separately expressed BigInt accounting oracle.
function rng(seed) {
  let state = seed >>> 0;
  return (maximum) => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state % maximum; };
}
const json = (value) => JSON.stringify(value);

test("approved limits are explicit bytes, not decimal MB or a hidden default", () => {
  assert.equal(L.totalBytes, 67108864);
  assert.equal(L.normalBytes, 66060288);
  assert.equal(L.warningBytes, 50331648);
  assert.equal(L.reserveBytes, 1048576);
  assert.equal(L.maxBodyBytes, 2097152);
  assert.deepEqual(L.categoryBytes, { body: 25165824, dom: 16777216, resource: 8388608, screenshot: 12582912, meta: 4194304 });
});

test("UTF-8 length matches TextEncoder including lone surrogates across 512 seeds", () => {
  const encoder = new TextEncoder();
  for (let seed = 1; seed <= 512; seed++) {
    const random = rng(seed); let text = "中文🙂\ud800\udfff\0";
    for (let i = 0; i < 64; i++) text += String.fromCharCode(random(65536));
    assert.equal(utf8ByteLength(text), encoder.encode(text).byteLength, "seed=" + seed);
  }
});

test("byte types are measured as raw UTF-8 or actual binary view lengths", () => {
  assert.equal(knownByteLength("YWJj中文"), 10); // never base64 decode
  const view = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
  assert.equal(knownByteLength(view), 2);
  assert.equal(knownByteLength(view.buffer), 4);
  assert.equal(knownByteLength(new Blob(["中"])), 3);
  for (const value of [null, undefined, {}, [], new DataView(new ArrayBuffer(1))]) assert.throws(() => knownByteLength(value), TypeError);
});

test("known sizes are validated even for stopped/deduplicated paths", () => {
  const budget = stopBudget(createBudget(), "total-limit");
  for (const invalid of [-1, 0.5, NaN, Infinity, "8", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => byteCount(invalid), TypeError);
    assert.throws(() => preflightContent(budget, { category: "body", knownBytes: invalid }), TypeError);
    assert.throws(() => evaluateBudget(budget, { contents: [{ category: "body", size: invalid, isNew: false, chargeCategory: false }] }), TypeError);
  }
  assert.throws(() => preflightContent(budget, { category: "__proto__", knownBytes: 0 }), TypeError);
  assert.equal(preflightContent(budget, { category: "body", knownBytes: 2 * MiB + 1 }).reason, "body-single-limit");
});

test("normal/final total and metadata boundaries reserve a full MiB", () => {
  const total = createBudget(); total.usedBytes = L.normalBytes - 1;
  let result = evaluateBudget(total, { eventBytes: 1 });
  assert.equal(result.accepted, true); assert.equal(result.budget.usedBytes, L.normalBytes);
  assert.equal(result.budget.policyStopped, true); assert.equal(result.budget.reason, "total-limit");
  assert.equal(evaluateBudget(result.budget, { eventBytes: 1 }).reason, "total-limit");
  const final = stopBudget(result.budget, "total-limit");
  assert.equal(evaluateBudget(final, { eventBytes: 1024, final: true }).accepted, true);
  const full = { ...final, usedBytes: L.totalBytes };
  assert.equal(evaluateBudget(full, { eventBytes: 1, final: true }).accepted, false);
  const meta = createBudget(); meta.byCategory.meta = 3 * MiB - 1;
  result = evaluateBudget(meta, { eventBytes: 1 });
  assert.equal(result.accepted, true);
  assert.equal(evaluateBudget(result.budget, { eventBytes: 1 }).reason, "category-meta-limit");
  assert.equal(evaluateBudget(result.budget, { eventBytes: L.eventBytes, final: true }).accepted, true);
  assert.equal(evaluateBudget(createBudget(), { eventBytes: L.eventBytes + 1 }).reason, "event-metadata-limit");
});

test("single body hard bound, warning transition, category charging on physical dedup", () => {
  const initial = createBudget();
  assert.equal(evaluateBudget(initial, { contents: [{ category: "body", size: L.maxBodyBytes }] }).accepted, true);
  assert.equal(evaluateBudget(initial, { contents: [{ category: "body", size: L.maxBodyBytes + 1, isNew: false, chargeCategory: false }] }).reason, "body-single-limit");
  const near = createBudget(); near.usedBytes = 48 * MiB - 1;
  assert.equal(evaluateBudget(near, { eventBytes: 1 }).budget.warning, true);
  const body = evaluateBudget(initial, { eventBytes: 100, contents: [{ category: "body", size: 1024 }] }).budget;
  const cross = evaluateBudget(body, { eventBytes: 100, contents: [{ category: "dom", size: 1024, isNew: false }] }).budget;
  assert.equal(cross.usedBytes, 1224);
  assert.equal(cross.byCategory.body, 1024); assert.equal(cross.byCategory.dom, 1024);
  cross.byCategory.dom = L.categoryBytes.dom;
  assert.equal(evaluateBudget(cross, { contents: [{ category: "dom", size: 1, isNew: false }] }).reason, "category-dom-limit");
});

test("512 seeds x 160 state transitions preserve caps, immutability and BigInt oracle", () => {
  const caps = { body: 24n * 1048576n, dom: 16n * 1048576n, resource: 8n * 1048576n, screenshot: 12n * 1048576n, meta: 4n * 1048576n };
  let accepted = 0, rejected = 0, finalAccepted = 0;
  for (let seed = 1; seed <= 512; seed++) {
    const random = rng(seed); let budget = createBudget();
    for (let step = 0; step < 160; step++) {
      const final = step >= 145;
      const eventBytes = [0, 1, 32768, 32769, random(32769)][random(5)];
      const contents = Array.from({ length: random(4) }, () => {
        const category = FLOW_CATEGORIES[random(5)];
        const bound = Number(caps[category]);
        const size = [0, 1, 2097152, 2097153, bound, bound + 1, random(bound + 1)][random(7)];
        return { category, size, isNew: random(3) !== 0, chargeCategory: random(3) !== 0 };
      });
      const before = json(budget), operation = { eventBytes, contents, final }, operationBefore = json(operation);
      const delta = contents.reduce((sum, item) => sum + (item.isNew ? BigInt(item.size) : 0n), BigInt(eventBytes));
      const charges = Object.fromEntries(FLOW_CATEGORIES.map((category) => [category, contents.filter((item) => item.category === category && item.chargeCategory).reduce((sum, item) => sum + BigInt(item.size), category === "meta" ? BigInt(eventBytes) : 0n)]));
      const oracle = eventBytes <= 32768 && (!budget.policyStopped || final)
        && contents.every((item) => BigInt(item.size) <= caps[item.category] && (item.category !== "body" || item.size <= 2097152))
        && BigInt(budget.usedBytes) + delta <= (final ? 67108864n : 66060288n)
        && FLOW_CATEGORIES.every((category) => BigInt(budget.byCategory[category]) + charges[category] <= (category === "meta" && !final ? 3145728n : caps[category]));
      const result = evaluateBudget(budget, operation);
      assert.equal(result.accepted, oracle, "seed=" + seed + " step=" + step);
      assert.equal(json(budget), before, "no input mutation"); assert.equal(json(operation), operationBefore);
      if (result.accepted) {
        accepted++; if (final) finalAccepted++;
        assert.equal(BigInt(result.budget.usedBytes), BigInt(budget.usedBytes) + delta);
        assert.ok(result.budget.usedBytes >= budget.usedBytes && result.budget.usedBytes <= 67108864);
        for (const category of FLOW_CATEGORIES) {
          assert.equal(BigInt(result.budget.byCategory[category]), BigInt(budget.byCategory[category]) + charges[category]);
          assert.ok(result.budget.byCategory[category] <= Number(caps[category]));
        }
        assert.ok(!budget.warning || result.budget.warning);
        assert.ok(result.budget.usedBytes < 50331648 || result.budget.warning);
        budget = result.budget;
      } else {
        rejected++;
        // Exercise both sticky policy-stop and continued pure planning states.
        if (random(8) === 0) budget = stopBudget(budget, result.reason);
      }
    }
  }
  assert.ok(accepted > 1000 && rejected > 1000 && finalAccepted > 100, "generators must not be vacuous");
});

test("policy diagnostics are bounded and never accumulate attacker reason strings", () => {
  const initial = createBudget(), first = stopBudget(initial, "total-limit");
  assert.equal(initial.policyStopped, false); assert.equal(first.rejectedCount, 1);
  let result = first;
  for (let i = 0; i < 500; i++) result = stopBudget(result, "category-dom-limit");
  assert.equal(result.reason, "total-limit"); assert.equal(result.rejectedCount, 501);
  assert.ok(JSON.stringify(result).length < 512);
  assert.throws(() => stopBudget(initial, "attacker-".repeat(1000)), TypeError);
});
