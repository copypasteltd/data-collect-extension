export function interfaceKey(method, rawUrl) {
  if (typeof method !== "string" || typeof rawUrl !== "string") return null;
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    return { method, origin: url.origin, path: url.pathname };
  } catch { return null; }
}

export function createInterfaceIndex() {
  const groups = new Map();
  let unindexable = 0;
  return {
    add(event, path, line) {
      if (event.kind !== "network.request") return;
      const payload = event.payload || {}, key = interfaceKey(payload.method, payload.url);
      if (!key) { unindexable++; return; }
      const id = JSON.stringify([key.method, key.origin, key.path]);
      let group = groups.get(id);
      if (!group) {
        group = { ...key, requests: 0, contexts: new Map(), evidence: [] };
        groups.set(id, group);
      }
      group.requests++;
      const context = { tabId: event.tabId ?? null, protocolSessionId: payload.protocolSessionId ?? null,
        protocolFrameId: payload.frameId ?? null, documentUrl: payload.documentUrl ?? null,
        sourceFrame: payload.sourceFrame ?? "unknown" };
      const contextId = JSON.stringify(context);
      if (!group.contexts.has(contextId)) group.contexts.set(contextId, { ...context, requests: 0 });
      group.contexts.get(contextId).requests++;
      if (group.evidence.length < 3) group.evidence.push({ eventId: event.id, requestId: payload.requestId, path, line });
    },
    *results() {
      for (const group of groups.values()) yield { ...group, contexts: [...group.contexts.values()],
        grouping: "method_origin_path", association: "recorded_context_only" };
    },
    get unindexableCount() { return unindexable; },
  };
}
