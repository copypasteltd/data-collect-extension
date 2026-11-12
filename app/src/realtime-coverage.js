export function countRealtimeGaps(events) {
  const starts = new Map(), results = new Map();
  let gaps = 0;
  for (const event of events) {
    const data = event.payload?.data;
    if (["network.websocketFrame", "network.eventSourceMessage"].includes(event.kind)) {
      if (data?.status === "pending_asset" && data.captureId) {
        if (!starts.has(data.captureId)) starts.set(data.captureId, []);
        starts.get(data.captureId).push(event);
      } else if (data && !["captured", "empty"].includes(data.status)) gaps++;
    } else if (event.kind === "network.realtimePayload" && event.payload?.captureId) {
      if (!results.has(event.payload.captureId)) results.set(event.payload.captureId, []);
      results.get(event.payload.captureId).push(event);
    }
  }
  for (const id of new Set([...starts.keys(), ...results.keys()])) {
    const begin = starts.get(id) || [], end = results.get(id) || [];
    if (begin.length !== 1 || end.length !== 1 || end[0].payload.status !== "captured_asset" || !end[0].payload.assetId ||
        (Number.isSafeInteger(begin[0].seq) && Number.isSafeInteger(end[0].seq) && begin[0].seq >= end[0].seq)) gaps++;
  }
  return gaps;
}
