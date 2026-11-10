import { compareEvents } from "./event-order.js";

function withoutHash(raw) {
  try { const url = new URL(raw); url.hash = ""; return url.href; }
  catch { return null; }
}

export function createResourceScope(events, tabId, upTo, context) {
  if (!context || tabId == null) return { initial: () => true, request: () => true };
  let boundary = null;
  if (context.documentId && context.frameId != null && context.snapshotEvent) {
    for (const event of events) {
      if (event.kind !== "navigation.committed" || event.tabId !== tabId ||
          event.frameId !== context.frameId || event.payload?.documentId !== context.documentId ||
          compareEvents(event, context.snapshotEvent) > 0) continue;
      if (!boundary || compareEvents(boundary, event) < 0) boundary = event;
    }
  }
  const latestSnapshots = new Map(), latestNavigations = new Map();
  for (const event of events) {
    if (!["page.snapshot", "navigation.committed"].includes(event.kind) || event.tabId !== tabId || event.frameId == null ||
        (upTo && compareEvents(event, upTo) > 0)) continue;
    const map = event.kind === "page.snapshot" ? latestSnapshots : latestNavigations;
    const current = map.get(event.frameId);
    if (!current || compareEvents(current, event) < 0) map.set(event.frameId, event);
  }
  const pageUrl = withoutHash(context.url);
  const sameUrlFrames = [...latestSnapshots.values()].filter((event) => {
    const navigation = latestNavigations.get(event.frameId);
    if (navigation && compareEvents(event, navigation) < 0 &&
        (!event.documentId || navigation.payload?.documentId !== event.documentId)) return false;
    return pageUrl && withoutHash(event.payload?.url) === pageUrl;
  }).length;
  return {
    initial(event) {
      const sourceTab = event.tabId ?? event.payload?.tabId;
      const frame = event.frameId ?? event.payload?.frameId;
      const document = event.documentId ?? event.payload?.documentId;
      return !(sourceTab != null && sourceTab !== tabId) && !(boundary && compareEvents(event, boundary) < 0) &&
        !(frame != null && context.frameId != null && frame !== context.frameId) &&
        !(document && context.documentId && document !== context.documentId);
    },
    request(event) {
      if (!event || (boundary && compareEvents(event, boundary) < 0)) return false;
      const request = event.payload || {}, source = request.sourceFrame;
      const sourceTab = event.tabId ?? request.tabId;
      if (sourceTab != null && sourceTab !== tabId) return false;
      if (context.frameId != null && ((source === "main" && context.frameId !== 0) || (source === "embedded" && context.frameId === 0))) return false;
      const sourceUrl = withoutHash(request.documentUrl);
      if (source !== "main" && sourceUrl && pageUrl && sourceUrl !== pageUrl) return false;
      if (source !== "main" && sourceUrl && sameUrlFrames > 1) return false;
      return true;
    },
  };
}
