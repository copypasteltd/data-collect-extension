export function countFullPageGaps(events) {
  const starts = new Map(), ends = new Map(), tiles = new Map();
  let legacyGaps = 0;
  for (const event of events) {
    const payload = event.payload || {};
    if (event.kind === "screenshot.fullPageStarted" && payload.captureRequestId)
      starts.set(payload.captureRequestId, (starts.get(payload.captureRequestId) || 0) + 1);
    if (event.kind === "screenshot.fullPageTile" && payload.captureId) {
      if (!tiles.has(payload.captureId)) tiles.set(payload.captureId, []);
      tiles.get(payload.captureId).push(payload);
    }
    if (event.kind !== "screenshot.fullPage") continue;
    if (!payload.captureRequestId) { if (payload.status !== "captured") legacyGaps++; continue; }
    if (!ends.has(payload.captureRequestId)) ends.set(payload.captureRequestId, []);
    ends.get(payload.captureRequestId).push(payload);
  }
  let gaps = legacyGaps;
  for (const requestId of new Set([...starts.keys(), ...ends.keys()])) {
    const results = ends.get(requestId) || [], result = results[0];
    if (starts.get(requestId) !== 1 || results.length !== 1 || result.status !== "captured") { gaps++; continue; }
    if (result.captureMode !== "tiles") { if (!result.assetId) gaps++; continue; }
    const pieces = tiles.get(result.captureId) || [];
    const numbers = new Set(pieces.map((piece) => piece.index));
    if (!Number.isSafeInteger(result.totalTiles) || result.totalTiles < 1 || result.capturedTiles !== result.totalTiles ||
        pieces.length !== result.totalTiles || numbers.size !== result.totalTiles ||
        pieces.some((piece) => !Number.isSafeInteger(piece.index) || piece.index < 0 || piece.index >= result.totalTiles ||
          piece.status !== "captured" || !piece.assetId)) gaps++;
  }
  return gaps;
}
