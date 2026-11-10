export function normalizeNumericConstraint(name, raw) {
  if (typeof raw !== "string" || raw.length > 64) return null;
  if (name === "step" && raw.toLowerCase() === "any") return "any";
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) ||
      !Number.isFinite(Number(raw)) || (name === "step" && Number(raw) <= 0)) return null;
  return raw;
}

export function readNumericConstraints(input) {
  return Object.fromEntries(["min", "max", "step"].map((name) =>
    [name, normalizeNumericConstraint(name, input.getAttribute(name))]));
}
