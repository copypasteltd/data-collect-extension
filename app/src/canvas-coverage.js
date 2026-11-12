export function indexCanvasEvidence(events, fragmentComplete) {
  const captures = new Map(), ends = new Map();
  for (const event of events) {
    const id = event.payload?.snapshotId;
    if (!id) continue;
    const groups = event.kind === "canvas.capture" ? captures : event.kind === "canvas.captureEnd" ? ends : null;
    if (groups) { if (!groups.has(id)) groups.set(id, []); groups.get(id).push(event); }
  }
  return (snapshotId) => {
    const results = ends.get(snapshotId) || [], items = captures.get(snapshotId) || [];
    if (results.length !== 1) return false;
    const end = results[0], info = end.payload;
    if (info.status !== "captured" || !Number.isSafeInteger(info.total) || info.total < 0 ||
        info.processed !== info.total || info.failed !== 0 || items.length !== info.total) return false;
    const nodes = new Set();
    for (const event of items) {
      const item = event.payload;
      if (!item.nodeId || nodes.has(item.nodeId) || item.status !== "fragmented" || event.seq >= end.seq ||
          !Number.isSafeInteger(item.size) || item.size <= 0 || item.reference?.length !== 4 * Math.ceil(item.size / 3) ||
          !fragmentComplete(item.reference)) return false;
      nodes.add(item.nodeId);
    }
    return true;
  };
}
