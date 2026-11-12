export function indexShadowEvidence(events, fragmentComplete) {
  const roots = new Map(), ends = new Map();
  for (const event of events) {
    const id = event.payload?.captureId;
    if (!id) continue;
    const groups = event.kind === "page.shadowRoot" ? roots : event.kind === "page.shadowRootEnd" ? ends : null;
    if (groups) { if (!groups.has(id)) groups.set(id, []); groups.get(id).push(event); }
  }
  return (snapshot) => {
    const id = snapshot.payload?.shadowSourceCaptureId;
    if (!id) return false;
    const results = ends.get(id) || [], items = roots.get(id) || [];
    if (results.length !== 1) return false;
    const end = results[0], info = end.payload;
    if (info.snapshotId !== snapshot.payload.snapshotId || info.status !== "captured" ||
        !Number.isSafeInteger(info.total) || info.total < 0 || info.processed !== info.total || info.failures !== 0 ||
        items.length !== info.total) return false;
    const seen = new Set();
    for (const event of items) {
      const item = event.payload;
      if (item.snapshotId !== info.snapshotId || !item.rootNodeId || !item.hostNodeId || seen.has(item.rootNodeId) ||
          event.seq >= end.seq || !Number.isSafeInteger(item.length) || item.length < 0) return false;
      seen.add(item.rootNodeId);
      if (item.status === "fragmented") {
        if (item.reference?.length !== item.length || !fragmentComplete(item.reference)) return false;
      } else if (item.status !== "captured" || typeof item.html !== "string" || item.html.length !== item.length) return false;
    }
    return true;
  };
}
