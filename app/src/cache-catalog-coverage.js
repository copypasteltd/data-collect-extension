export function indexCacheCatalogEvidence(events, fragmentComplete) {
  const snapshots = new Map(), ends = new Map();
  for (const event of events) {
    const id = event.payload?.catalogId;
    if (!id) continue;
    const groups = event.kind === "cache.snapshot" && Number.isSafeInteger(event.payload.catalogIndex) ? snapshots
      : event.kind === "cache.catalogEnd" ? ends : null;
    if (groups) { if (!groups.has(id)) groups.set(id, []); groups.get(id).push(event); }
  }
  return (catalog) => {
    const info = catalog.payload, results = ends.get(info.catalogId) || [], items = snapshots.get(info.catalogId) || [];
    if (results.length !== 1 || !Number.isSafeInteger(info.count) || info.count < 0) return false;
    const end = results[0];
    if (end.payload.status !== "captured" || end.payload.count !== info.count || end.payload.processed !== info.count ||
        catalog.seq >= end.seq || items.length !== info.count) return false;
    if (info.status === "fragmented") {
      if (!fragmentComplete(info.reference)) return false;
    } else if (info.status !== "captured" || !Array.isArray(info.names) || info.names.length !== info.count ||
        info.names.some((name) => typeof name !== "string")) return false;
    const indices = new Set();
    for (const item of items) {
      const index = item.payload.catalogIndex;
      if (index < 0 || index >= info.count || indices.has(index) || item.seq >= end.seq || item.seq <= catalog.seq) return false;
      indices.add(index);
    }
    return true;
  };
}
