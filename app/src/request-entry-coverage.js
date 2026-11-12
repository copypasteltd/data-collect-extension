export function indexRequestEntryEvidence(events) {
  const results = new Map();
  for (const event of events) {
    if (event.kind !== "network.requestDataEntries") continue;
    const id = event.payload?.requestId;
    if (!results.has(id)) results.set(id, []);
    results.get(id).push(event);
  }
  return (request) => {
    const payload = request.payload, matches = results.get(payload.requestId) || [];
    if (matches.length !== 1 || matches[0].payload.status !== "captured" || matches[0].seq <= request.seq ||
        !Array.isArray(matches[0].payload.entries) || matches[0].payload.entries.length !== payload.postDataEntriesCount) return false;
    return matches[0].payload.entries.every((entry, index) => entry.index === index && entry.status === "captured" &&
      typeof entry.assetId === "string" && Number.isSafeInteger(entry.size) && entry.size >= 0);
  };
}
