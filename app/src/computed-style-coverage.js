import { unpackComputedEntries } from "./computed-style-packing.js";

export function indexComputedStyleEvidence(events) {
  const ends = new Map(), batches = new Map();
  for (const event of events) {
    const payload = event.payload || {};
    if (event.kind === "page.computedStyleEnd") {
      if (!ends.has(payload.snapshotId)) ends.set(payload.snapshotId, []);
      ends.get(payload.snapshotId).push(event);
    } else if (event.kind === "page.computedStyle") {
      if (!batches.has(payload.captureId)) batches.set(payload.captureId, []);
      batches.get(payload.captureId).push(event);
    }
  }
  return (snapshotId) => {
    const matches = ends.get(snapshotId) || [];
    if (matches.length !== 1) return false;
    const end = matches[0], info = end.payload;
    if (info.status !== "captured" || info.enumerationStatus !== "captured" ||
        !Number.isSafeInteger(info.total) || info.total < 0 || info.processed !== info.total || info.failures !== 0) return false;
    const expected = Math.ceil(info.total / 5), items = batches.get(info.captureId) || [];
    if (items.length !== expected) return false;
    const seen = new Set();
    let entries = 0;
    for (const event of items) {
      const batch = event.payload;
      let batchEntries;
      try { batchEntries = unpackComputedEntries(batch); } catch { return false; }
      if (batch.snapshotId !== snapshotId || batch.batchCount !== expected ||
          !Number.isSafeInteger(batch.batchIndex) || batch.batchIndex < 0 || batch.batchIndex >= expected ||
          seen.has(batch.batchIndex) || event.seq >= end.seq ||
          batchEntries.some((entry) => entry.status !== "captured")) return false;
      seen.add(batch.batchIndex);
      entries += batchEntries.length;
    }
    return entries === info.total;
  };
}
