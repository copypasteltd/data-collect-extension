import { unpackComputedEntries } from "./computed-style-packing.js";

export function* observeThemeValues(event, evidence) {
  if (!["page.computedStyle", "page.interactionStyle", "page.interactionDescendantStyle"].includes(event.kind)) return;
  const entries = event.kind === "page.computedStyle" ? unpackComputedEntries(event.payload) : [event.payload];
  const related = new Set(["background", "background-image", "box-shadow", "text-shadow", "fill", "stroke"]);
  for (const entry of entries) {
    if (entry.status !== "captured") continue;
    for (const [pseudo, properties] of [[null, entry.properties], ["::before", entry.before], ["::after", entry.after], ...Object.entries(entry.pseudos || {})]) {
      if (!Array.isArray(properties)) continue;
      for (const [property, value] of properties) {
        if (typeof property !== "string" || typeof value !== "string") continue;
        if (!property.startsWith("--") && !property.includes("color") && !related.has(property)) continue;
        yield { eventId: event.id, evidence, snapshotId: event.payload.snapshotId,
          nodeId: entry.nodeId, observedAt: entry.observedAt, pseudo, property, value,
          ...(entry.interactionCaptureId ? { interactionCaptureId: entry.interactionCaptureId } : {}),
          source: event.kind === "page.computedStyle" ? "computed" : "computed_interaction" };
      }
    }
  }
}
