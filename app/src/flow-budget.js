// Pure byte policy. Physical bytes and category charges intentionally differ when
// the same session-local hash is referenced from more than one category.
import { MiB, LEGACY_FLOW_SETTINGS, validateFlowSettings, deriveFlowLimits } from "./flow-config.js";
export { MiB };
// Historical pure callers keep the1x contract; new sessions choose their settings.
export const FLOW_LIMITS = deriveFlowLimits(LEGACY_FLOW_SETTINGS).budget;
export const FLOW_CATEGORIES = Object.freeze(Object.keys(FLOW_LIMITS.categoryBytes));
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

export function byteCount(value, label = "bytes") {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(label + " must be a non-negative safe integer");
  return value;
}

// TextEncoder semantics, including lone-surrogate replacement, without allocating
// a second copy of a possibly rejected string.
export function utf8ByteLength(text) {
  if (typeof text !== "string") throw new TypeError("Expected a string");
  let size = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) size++;
    else if (code < 0x800) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
    else size += 3;
  }
  return size;
}

export function knownByteLength(bytes) {
  if (typeof bytes === "string") return utf8ByteLength(bytes);
  if (bytes instanceof Uint8Array || bytes instanceof ArrayBuffer) return byteCount(bytes.byteLength);
  if (typeof Blob !== "undefined" && bytes instanceof Blob) return byteCount(bytes.size);
  throw new TypeError("Content bytes must be string, Uint8Array, ArrayBuffer or Blob");
}

function budgetSettings(budget) {
  return budget.settings === undefined ? LEGACY_FLOW_SETTINGS : validateFlowSettings(budget.settings);
}
export function getBudgetLimits(budget) {
  if (!budget || typeof budget !== "object" || Array.isArray(budget)) throw new TypeError("Missing budget");
  return deriveFlowLimits(budgetSettings(budget)).budget;
}
export function createBudget(input = LEGACY_FLOW_SETTINGS) {
  const settings = validateFlowSettings(input), limits = deriveFlowLimits(settings).budget;
  return {
    settings,
    usedBytes: 0,
    byCategory: Object.fromEntries(FLOW_CATEGORIES.map((category) => [category, 0])),
    warning: false,
    limitBytes: limits.totalBytes,
    reserveBytes: limits.reserveBytes,
    policyStopped: false,
    rejectedCount: 0,
  };
}

export function validateBudget(budget) {
  const limits = getBudgetLimits(budget);
  byteCount(budget.usedBytes, "usedBytes");
  if (budget.limitBytes !== limits.totalBytes || budget.reserveBytes !== limits.reserveBytes) throw new RangeError("Corrupt budget limits");
  if (budget.usedBytes > limits.totalBytes) throw new RangeError("Corrupt total budget");
  if (typeof budget.warning !== "boolean" || typeof budget.policyStopped !== "boolean") throw new TypeError("Budget flags must be boolean");
  byteCount(budget.rejectedCount ?? 0, "rejectedCount");
  if (!budget.byCategory || typeof budget.byCategory !== "object" || Array.isArray(budget.byCategory) ||
      Object.keys(budget.byCategory).length !== FLOW_CATEGORIES.length) throw new TypeError("Invalid category budget");
  for (const category of FLOW_CATEGORIES) {
    byteCount(budget.byCategory[category], category + " bytes");
    if (budget.byCategory[category] > limits.categoryBytes[category]) throw new RangeError("Corrupt category budget");
  }
  return budget;
}

function categoryLimit(limits, category) {
  if (!has(limits.categoryBytes, category)) throw new TypeError("Unknown content category");
  return limits.categoryBytes[category];
}
function booleanFlag(value, label) {
  if (typeof value !== "boolean") throw new TypeError(label + " must be boolean");
  return value;
}

// Known sizes are ALWAYS validated, even when they describe a deduplicated
// reference. Call this before CDP body reads / Blob.arrayBuffer when known.
export function preflightContent(budget, { category, knownBytes }, { final = false } = {}) {
  validateBudget(budget);
  booleanFlag(final, "final");
  const limits = getBudgetLimits(budget), maximum = categoryLimit(limits, category);
  const size = byteCount(knownBytes, "knownBytes");
  if (category === "body" && size > limits.singleBodyBytes) return { accepted: false, reason: "body-single-limit" };
  if (size > maximum) return { accepted: false, reason: "category-" + category + "-limit" };
  if (budget.policyStopped && !final) return { accepted: false, reason: budget.reason || "policy-stopped" };
  // Remaining space cannot be decided without the hash: a same-category
  // duplicate may cost zero content bytes. evaluateBudget is authoritative.
  return { accepted: true, size };
}

// contents: [{category,size,isNew=true,chargeCategory=true}]. isNew charges
// physical storage; chargeCategory charges the first reference in THAT category.
// Store constructs these flags from rows read inside its readwrite transaction;
// callers cannot use this pure helper as authority for a subsequent write.
export function evaluateBudget(budget, { eventBytes = 0, contents = [], final = false } = {}) {
  validateBudget(budget);
  byteCount(eventBytes, "eventBytes");
  booleanFlag(final, "final");
  const limits = getBudgetLimits(budget);
  if (!Array.isArray(contents)) throw new TypeError("contents must be an array");
  const checked = contents.map((content) => {
    if (!content || typeof content !== "object") throw new TypeError("Invalid content charge");
    if (content.isNew !== undefined) booleanFlag(content.isNew, "isNew");
    if (content.chargeCategory !== undefined) booleanFlag(content.chargeCategory, "chargeCategory");
    const result = preflightContent(budget, { category: content.category, knownBytes: content.size }, { final: true });
    return { content, result };
  });
  if (eventBytes > limits.eventBytes) return { accepted: false, reason: "event-metadata-limit" };
  for (const { result } of checked) if (!result.accepted) return result;
  if (budget.policyStopped && !final) return { accepted: false, reason: budget.reason || "policy-stopped" };
  let physical = eventBytes;
  const categoryCharges = Object.fromEntries(FLOW_CATEGORIES.map((category) => [category, 0]));
  categoryCharges.meta = eventBytes;
  for (const { content } of checked) {
    if (content.isNew !== false) physical += content.size;
    if (content.chargeCategory !== false) categoryCharges[content.category] += content.size;
    if (!Number.isSafeInteger(physical) || !Number.isSafeInteger(categoryCharges[content.category])) throw new RangeError("Budget addition overflow");
  }
  if (!Number.isSafeInteger(budget.usedBytes + physical)) throw new RangeError("Budget addition overflow");
  if (budget.usedBytes + physical > (final ? limits.totalBytes : limits.normalBytes)) return { accepted: false, reason: "total-limit" };
  for (const category of FLOW_CATEGORIES) {
    const maximum = category === "meta" && !final ? limits.normalMetaBytes : categoryLimit(limits, category);
    if (!Number.isSafeInteger(budget.byCategory[category] + categoryCharges[category])) throw new RangeError("Budget addition overflow");
    if (budget.byCategory[category] + categoryCharges[category] > maximum) return { accepted: false, reason: "category-" + category + "-limit" };
  }
  const next = {
    ...budget, settings: budgetSettings(budget),
    usedBytes: budget.usedBytes + physical,
    byCategory: Object.fromEntries(FLOW_CATEGORIES.map((category) => [category, budget.byCategory[category] + categoryCharges[category]])),
  };
  next.warning = Boolean(budget.warning || next.usedBytes >= limits.warningBytes);
  if (!final && next.usedBytes === limits.normalBytes) {
    next.policyStopped = true; next.reason = next.reason || "total-limit";
  }
  return { accepted: true, budget: next, physicalBytes: physical, categoryCharges };
}

const REASONS = new Set([
  "body-single-limit", "category-body-limit", "category-dom-limit", "category-resource-limit", "category-screenshot-limit", "category-meta-limit",
  "event-metadata-limit", "total-limit", "sequence-limit", "capture-content-limit", "policy-stopped",
]);
export function stopBudget(budget, reason) {
  validateBudget(budget);
  if (!REASONS.has(reason)) throw new TypeError("Unbounded policy reason");
  return {
    ...budget, settings: budgetSettings(budget), byCategory: { ...budget.byCategory }, policyStopped: true,
    reason: budget.reason || reason,
    rejectedCount: Math.min(1000000000, byteCount(budget.rejectedCount ?? 0) + 1),
  };
}
