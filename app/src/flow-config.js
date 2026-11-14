// One policy source for settings, immutable session capture and downstream tools.
// Timeouts, identifiers, permission scope and recursive depth are not size knobs.
export const MiB = 1024 * 1024;
export const MAX_MULTIPLIER = 20;
export const LEGACY_FLOW_SETTINGS = Object.freeze({ schemaVersion: 1, budgetMultiplier: 1, queueMultiplier: 1, samplingMultiplier: 1 });
export const DEFAULT_FLOW_SETTINGS = Object.freeze({ schemaVersion: 1, budgetMultiplier: 20, queueMultiplier: 20, samplingMultiplier: 20 });
const keys = Object.keys(DEFAULT_FLOW_SETTINGS);
export function validateFlowSettings(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).length !== keys.length ||
      keys.some((key) => !Object.hasOwn(input, key)) || input.schemaVersion !== 1)
    throw new TypeError("录制设置格式无效");
  const next = { schemaVersion: 1 };
  for (const key of keys.slice(1)) {
    const value = input[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MULTIPLIER)
      throw new RangeError("倍率必须是1–20之间的整数");
    next[key] = value;
  }
  return Object.freeze(next);
}
export function deriveFlowLimits(input = DEFAULT_FLOW_SETTINGS) {
  const settings = validateFlowSettings(input), b = settings.budgetMultiplier, q = settings.queueMultiplier, s = settings.samplingMultiplier;
  return Object.freeze({
    settings,
    budget: Object.freeze({ totalBytes: 64 * MiB * b, warningBytes: 48 * MiB * b, reserveBytes: MiB * b,
      normalBytes: 63 * MiB * b, eventBytes: 32 * 1024 * b, singleBodyBytes: 2 * MiB * b,
      maxBodyBytes: 2 * MiB * b, normalMetaBytes: 3 * MiB * b,
      categoryBytes: Object.freeze({ body: 24 * MiB * b, dom: 16 * MiB * b, resource: 8 * MiB * b, screenshot: 12 * MiB * b, meta: 4 * MiB * b }) }),
    background: Object.freeze({ body: 2 * MiB * b, resource: 8 * MiB * b, screenshot: 4 * MiB * b,
      metadata: 32 * 1024 * b, batchBytes: 4 * MiB * q, queuedBytes: 8 * MiB * q,
      queue: 64 * q, requests: 128 * q, frames: 32 * s, batch: 64 * q,
      streams: 32 * s, resourceObservations: 128 * s, notices: 24 * s, batchHistory: 256 * q,
      screenshotInterval: 1000, flushMs: 3000, stopMs: 300, detachMs: 2000, commandMs: 2000 }),
    content: Object.freeze({ maxBytes: 2 * MiB * b, metadataBytes: 30 * 1024 * b,
      queueEvents: 32 * q, queueBytes: 6 * MiB * q, batchEvents: 8 * q, pendingInputs: 32 * q,
      domNodes: 12000 * s, shadowHosts: 16 * s, shadowNodes: 2000 * s, formCount: 128 * s,
      formMetadataBytes: 16000 * b, formMetadataSoftBytes: 14000 * b,
      maxContents: 16 * s, stylesheetCount: 32 * s, stylesheetRulesPerSheet: 2000 * s,
      stylesheetRules: 8000 * s, stylesheetHashes: 256 * s, resourceUrls: 128 * s,
      resourceHashes: 256 * s, resourceMetadataBytes: 14000 * b, stylesheetMetadataBytes: 6000 * b,
      transientNodes: 8 * s, transientBytes: 8192 * b, transientTextBytes: 7000 * b,
      transientTextNodes: 128 * s, mutationRecords: 64 * s, mutationChildren: 8 * s,
      domDepth: 64, transientDepth: 8, ancestorDepth: 5, attributeCount: 64 })
  });
}
export function settingsForSession(session) {
  // Old sealed sessions preserve their original64MiB contract. Never substitute
  // current user defaults for a session created before configurable policies.
  const value = session?.capturePolicy?.settings;
  return value === undefined ? LEGACY_FLOW_SETTINGS : validateFlowSettings(value);
}
export function limitsForSession(session) { return deriveFlowLimits(settingsForSession(session)); }
export function formatFlowBytes(value) {
  if (!Number.isFinite(value) || value < 0) return "未知";
  if (value >= 1024 * MiB) return (value / (1024 * MiB)).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " GiB";
  if (value >= MiB) return (value / MiB).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " MiB";
  if (value >= 1024) return (value / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 2 }) + " KiB";
  return value + " B";
}
export const FLOW_SETTINGS_KEY = "businessFlowLimitSettingsV1";
export async function loadFlowSettings(storage = globalThis.chrome?.storage?.local) {
  if (!storage?.get) throw new Error("无法读取录制设置");
  const saved = await storage.get(FLOW_SETTINGS_KEY);
  return saved?.[FLOW_SETTINGS_KEY] === undefined ? DEFAULT_FLOW_SETTINGS : validateFlowSettings(saved[FLOW_SETTINGS_KEY]);
}
export async function saveFlowSettings(input, storage = globalThis.chrome?.storage?.local) {
  const settings = validateFlowSettings(input);
  if (!storage?.set) throw new Error("无法保存录制设置");
  await storage.set({ [FLOW_SETTINGS_KEY]: settings });
  return settings;
}
