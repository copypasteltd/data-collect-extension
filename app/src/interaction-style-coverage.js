export function countInteractionStyleGaps(events) {
  const interactions = new Map(), styles = new Map();
  for (const event of events) {
    const id = event.payload?.interactionCaptureId;
    if (!id) continue;
    const group = event.kind?.startsWith("interaction.") ? interactions : event.kind === "page.interactionStyle" ? styles : null;
    if (group) { if (!group.has(id)) group.set(id, []); group.get(id).push(event); }
  }
  let gaps = 0;
  for (const id of new Set([...interactions.keys(), ...styles.keys()])) {
    const actions = interactions.get(id) || [], samples = styles.get(id) || [];
    if (actions.length !== 1 || samples.length !== 1) { gaps++; continue; }
    const action = actions[0], sample = samples[0], payload = sample.payload;
    if (payload.status !== "captured" || payload.nodeId !== action.payload.target?.nodeId ||
        payload.interactionTime !== action.time || action.seq >= sample.seq ||
        ["tabId", "frameId", "documentId"].some((key) => action[key] !== sample[key]) ||
        !Array.isArray(payload.properties) || !Array.isArray(payload.before) || !Array.isArray(payload.after)) gaps++;
  }
  return gaps;
}

export function countInteractionDescendantGaps(events) {
  const interactions = new Map(), samples = new Map(), ends = new Map();
  for (const event of events) {
    const id = event.payload?.interactionCaptureId;
    if (!id) continue;
    const group = event.kind?.startsWith("interaction.") ? interactions :
      event.kind === "page.interactionDescendantStyle" ? samples : event.kind === "page.interactionDescendantStyleEnd" ? ends : null;
    if (group) { if (!group.has(id)) group.set(id, []); group.get(id).push(event); }
  }
  let gaps = 0;
  for (const id of new Set([...interactions.keys(), ...samples.keys(), ...ends.keys()])) {
    const actions = interactions.get(id) || [], summaries = ends.get(id) || [], rows = samples.get(id) || [];
    if (actions.length !== 1 || summaries.length !== 1) { gaps++; continue; }
    const action = actions[0], summary = summaries[0], data = summary.payload;
    const nodes = new Set();
    if (data.status !== "captured" || data.scope !== "light_dom_descendants_only" || data.failed !== 0 ||
        data.processed !== rows.length || data.nodeId !== action.payload.target?.nodeId ||
        data.interactionTime !== action.time || summary.seq <= action.seq ||
        ["tabId", "frameId", "documentId"].some((key) => summary[key] !== action[key])) { gaps++; continue; }
    if (rows.some((row) => {
      const item = row.payload;
      if (!item.nodeId || nodes.has(item.nodeId)) return true;
      nodes.add(item.nodeId);
      return item.rootNodeId !== data.nodeId || item.interactionTime !== action.time || item.status !== "captured" ||
        row.seq <= action.seq || row.seq >= summary.seq || ["tabId", "frameId", "documentId"].some((key) => row[key] !== action[key]) ||
        !Array.isArray(item.properties) || !Array.isArray(item.before) || !Array.isArray(item.after);
    })) gaps++;
  }
  return gaps;
}
