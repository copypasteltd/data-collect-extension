// Pure byte policy. Physical bytes and category charges intentionally differ when
// the same session-local hash is referenced from more than one category.
export const MiB = 1024 * 1024;
export const FLOW_LIMITS = Object.freeze({
  totalBytes: 64 * MiB,
  warningBytes: 48 * MiB,
  reserveBytes: MiB,
  normalBytes: 63 * MiB,
  eventBytes: 32 * 1024,
  singleBodyBytes: 2 * MiB,
  maxBodyBytes: 2 * MiB,
  normalMetaBytes: 3 * MiB,
  categoryBytes: Object.freeze({ body: 24 * MiB, dom: 16 * MiB, resource: 8 * MiB, screenshot: 12 * MiB, meta: 4 * MiB }),
});
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

export function createBudget() {
  return {
    usedBytes: 0,
    byCategory: Object.fromEntries(FLOW_CATEGORIES.map((category) => [category, 0])),
    warning: false,
    limitBytes: FLOW_LIMITS.totalBytes,
    reserveBytes: FLOW_LIMITS.reserveBytes,
    policyStopped: false,
    rejectedCount: 0,
  };
}

export function validateBudget(budget) {
  if (!budget || typeof budget !== "object") throw new TypeError("Missing budget");
  byteCount(budget.usedBytes, "usedBytes");
  if (budget.usedBytes > FLOW_LIMITS.totalBytes) throw new RangeError("Corrupt total budget");
  for (const category of FLOW_CATEGORIES) {
    byteCount(budget.byCategory?.[category], category + " bytes");
    if (budget.byCategory[category] > FLOW_LIMITS.categoryBytes[category]) throw new RangeError("Corrupt category budget");
  }
  return budget;
}

function categoryLimit(category) {
  if (!has(FLOW_LIMITS.categoryBytes, category)) throw new TypeError("Unknown content category");
  return FLOW_LIMITS.categoryBytes[category];
}

// Known sizes are ALWAYS validated, even when they describe a deduplicated
// reference. Call this before CDP body reads / Blob.arrayBuffer when known.
export function preflightContent(budget, { category, knownBytes }, { final = false } = {}) {
  validateBudget(budget);
  const maximum = categoryLimit(category);
  const size = byteCount(knownBytes, "knownBytes");
  if (category === "body" && size > FLOW_LIMITS.singleBodyBytes) return { accepted: false, reason: "body-single-limit" };
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
  if (!Array.isArray(contents)) throw new TypeError("contents must be an array");
  const checked = contents.map((content) => {
    const result = preflightContent(budget, { category: content.category, knownBytes: content.size }, { final: true });
    return { content, result };
  });
  if (eventBytes > FLOW_LIMITS.eventBytes) return { accepted: false, reason: "event-metadata-limit" };
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
  if (budget.usedBytes + physical > (final ? FLOW_LIMITS.totalBytes : FLOW_LIMITS.normalBytes)) return { accepted: false, reason: "total-limit" };
  for (const category of FLOW_CATEGORIES) {
    const maximum = category === "meta" && !final ? FLOW_LIMITS.normalMetaBytes : categoryLimit(category);
    if (budget.byCategory[category] + categoryCharges[category] > maximum) return { accepted: false, reason: "category-" + category + "-limit" };
  }
  const next = {
    ...budget,
    usedBytes: budget.usedBytes + physical,
    byCategory: Object.fromEntries(FLOW_CATEGORIES.map((category) => [category, budget.byCategory[category] + categoryCharges[category]])),
  };
  next.warning = Boolean(budget.warning || next.usedBytes >= FLOW_LIMITS.warningBytes);
  if (!final && next.usedBytes === FLOW_LIMITS.normalBytes) {
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
    ...budget, byCategory: { ...budget.byCategory }, policyStopped: true,
    reason: budget.reason || reason,
    rejectedCount: Math.min(1000000000, byteCount(budget.rejectedCount ?? 0) + 1),
  };
}
