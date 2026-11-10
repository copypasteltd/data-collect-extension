import { compareEvents } from "./event-order.js";

function withoutHash(raw) {
  try {
    const url = new URL(raw);
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function isNavigation(event, tabId, frameId) {
  if (event.tabId !== tabId) return false;
  if (event.kind === "navigation.committed") return event.frameId === frameId;
  return frameId === 0 &&
    ["navigation", "navigation.spa", "navigation.hash", "navigation.popstate"].includes(event.kind) &&
    (event.frameId == null || event.frameId === 0);
}

export function requestSnapshotCursor(events, request, selected) {
  if (!request || !selected || request.tabId !== selected.tabId) return request;
  const navigated = events.some((event) =>
    isNavigation(event, request.tabId, 0) &&
    compareEvents(event, request) > 0 && compareEvents(event, selected) <= 0,
  );
  return navigated ? request : selected;
}

export function matchesRequestSnapshot(events, snapshot, request) {
  if (!snapshot || !request || snapshot.tabId !== request.tabId) return false;
  const documentUrl = withoutHash(request.payload?.documentUrl);
  const snapshotUrl = withoutHash(snapshot.payload?.url);
  if (documentUrl && snapshotUrl && documentUrl !== snapshotUrl) return false;
  const navigations = events.filter((event) => {
    return compareEvents(event, request) <= 0 && isNavigation(event, snapshot.tabId, snapshot.frameId);
  });
  const committed = navigations.filter((event) => event.kind === "navigation.committed")
    .sort((a, b) => compareEvents(b, a))[0];
  if (committed?.payload?.documentId && snapshot.documentId &&
      committed.payload.documentId !== snapshot.documentId) return false;
  for (const event of navigations) {
    if (compareEvents(event, snapshot) <= 0) continue;
    if (event.kind !== "navigation.committed" || !snapshot.documentId ||
        event.payload?.documentId !== snapshot.documentId) return false;
  }
  return true;
}
