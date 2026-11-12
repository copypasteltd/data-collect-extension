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
