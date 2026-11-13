// Chrome manifest.version is one to four decimal components (0..65535), not version_name.
// Bound before inspecting; do not trim, stringify or echo arbitrary metadata as a version.
export function normalizeExtensionVersion(value) {
  if (typeof value !== "string" || !value.length || value.length > 23 || /[^0-9.]/.test(value)) return null;
  const parts = value.split(".");
  return parts.length <= 4 && parts.every((part) => /^(0|[1-9][0-9]{0,4})$/.test(part) && Number(part) <= 65535) &&
    parts.some((part) => part !== "0") ? value : null;
}

// The runtime boundary is separate from the pure metadata projection below.
// Missing/broken APIs and invalid versions mean unknown, never a package/source fallback.
export function readArchiveExporterVersion(environment = globalThis) {
  try {
    const runtime = environment?.chrome?.runtime, getManifest = runtime?.getManifest;
    if (typeof getManifest !== "function") return null;
    return normalizeExtensionVersion(getManifest.call(runtime)?.version);
  } catch { return null; }
}

// These label the existing export derivations, not capabilities, validation results or source commits.
const derivations = Object.freeze({
  browserObservations: 3, // schema-v2 rows, source identity and explicit bounded derived paths
  browserFieldSummary: 2, // schema-v2 namespace-scoped aggregation
  fragmentValidation: 1, // validateFragments/reconstructFragments reference, part and End rules
  fragmentTerminals: 1, // whole-stream End/Failure/late-part checks before browser derivation
});

export function createArchiveProvenance(session, exporterVersion = null) {
  return {
    schemaVersion: 1,
    // Only the version persisted at batch creation can identify the producer.
    producerVersion: normalizeExtensionVersion(session?.producerVersion),
    exporterVersion: normalizeExtensionVersion(exporterVersion),
    derivations: { ...derivations },
  };
}
