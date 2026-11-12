export function indexEvent(event, path, line) {
  const payload = event.payload || {};
  const kind = event.kind || "";
  const category = kind.startsWith("interaction.") ? "interaction"
    : kind === "screenshot" || kind.startsWith("screenshot.") ? "screenshot"
    : kind.startsWith("network.") ? "network"
    : kind.startsWith("resource.") ? "resource"
    : kind.startsWith("page.") || kind.startsWith("navigation") ? "page"
    : /^(cookie|storage|database|cache|state)\./.test(kind) ? "browser-data"
    : "other";
  return {
    eventId: event.id,
    seq: event.seq,
    time: event.time,
    kind,
    category,
    evidence: { path, line },
    tabId: event.tabId ?? null,
    frameId: event.frameId ?? null,
    documentId: event.documentId ?? null,
    url: typeof payload.url === "string" ? payload.url : null,
    requestId: typeof payload.requestId === "string" ? payload.requestId : null,
    method: kind === "network.request" && typeof payload.method === "string" ? payload.method : null,
    assetId: typeof payload.assetId === "string" ? payload.assetId : null,
    relatedEventIds: Array.isArray(payload.eventIds) ? payload.eventIds : [],
    status: typeof payload.status === "string" ? payload.status : null,
    association: "recorded",
  };
}
