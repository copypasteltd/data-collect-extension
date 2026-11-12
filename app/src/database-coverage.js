export function indexDatabaseEvidence(events, fragmentComplete) {
  const records = new Map(), ends = new Map();
  for (const event of events) {
    const id = event.payload?.graphCaptureId;
    if (!id) continue;
    if (event.kind === "database.record") {
      if (!records.has(id)) records.set(id, []);
      records.get(id).push(event);
    } else if (event.kind === "database.recordsEnd") {
      if (!ends.has(id)) ends.set(id, []);
      ends.get(id).push(event);
    }
  }
  return (id) => {
    const results = ends.get(id) || [];
    if (results.length !== 1) return false;
    const end = results[0], info = end.payload, items = records.get(id) || [];
    if (info.status !== "captured" || !Number.isSafeInteger(info.total) || info.total < 0 ||
        info.saved !== info.total || info.failed || info.omitted || info.storesTruncated || items.length !== info.total) return false;
    const indices = new Set();
    for (const item of items) {
      const payload = item.payload;
      if (!Number.isSafeInteger(payload.index) || payload.index < 0 || payload.index >= info.total || indices.has(payload.index) ||
          item.seq >= end.seq || (payload.status !== "captured" && payload.status !== "fragmented") ||
          (payload.status === "captured" && (!payload.graph || payload.graph.issues?.length)) ||
          (payload.status === "fragmented" && !fragmentComplete(payload.graphReference))) return false;
      indices.add(payload.index);
    }
    return true;
  };
}
