export function indexCacheEvidence(events, fragmentComplete) {
  const groups = new Map();
  for (const event of events) {
    if (event.kind !== "cache.entry") continue;
    const id = event.payload?.snapshotId;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(event);
  }
  return (snapshot) => {
    const info = snapshot.payload, items = groups.get(info.snapshotId) || [];
    if (info.status !== "captured" || info.truncated || !Number.isSafeInteger(info.total) ||
        info.total < 0 || items.length !== info.total) return false;
    const indices = new Set();
    for (const event of items) {
      const item = event.payload, body = item.body;
      if (!Number.isSafeInteger(item.index) || item.index < 0 || item.index >= info.total || indices.has(item.index) ||
          event.seq >= snapshot.seq || item.status !== "captured" || !body || body.encoding !== "base64" ||
          !Number.isSafeInteger(body.size) || body.size < 0) return false;
      indices.add(item.index);
      if (body.status === "fragmented") {
        if (body.reference?.length !== 4 * Math.ceil(body.size / 3) || !fragmentComplete(body.reference)) return false;
      } else if (body.status === "captured") {
        try { if (typeof body.data !== "string" || atob(body.data).length !== body.size) return false; }
        catch { return false; }
      } else return false;
    }
    return true;
  };
}
