export function recoverPendingRequests(events, tabs) {
  const requests = new Map();
  const keysById = new Map();
  for (const event of [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    const payload = event.payload || {};
    const id = payload.requestId;
    if (typeof id !== "string") continue;
    if (event.kind === "network.request") {
      const tabId = event.tabId ?? payload.tabId;
      const tab = tabs?.[tabId];
      const prefix = `${tabId}:`;
      const suffix = id.slice(prefix.length);
      const separator = suffix.indexOf(":");
      if (!tab || tab.closed || !tab.debuggerAttached || !id.startsWith(prefix) ||
          separator <= 0 || separator === suffix.length - 1) continue;
      const key = id.replace(/:redirect:[0-9a-f-]{36}$/i, "");
      const previous = requests.get(key);
      if (previous) keysById.delete(previous.requestId);
      requests.set(key, { ...payload, tabId });
      keysById.set(id, key);
    } else {
      const key = keysById.get(id);
      const item = key && requests.get(key);
      if (!item) continue;
      if (event.kind === "network.response") item.response = { ...payload };
      else if (event.kind === "network.requestBody") item.postData = payload.body;
      else if (event.kind === "network.finished" || event.kind === "network.failed") {
        requests.delete(key);
        keysById.delete(id);
      }
    }
  }
  return requests;
}

export function recoverRootSockets(events, tabs, documents) {
  const open = new Map();
  const snapshots = new Map(), latestNavigation = new Map(), latestMismatch = new Map();
  for (const event of events) {
    const documentId = documents.get(event.tabId);
    if (!documentId || event.frameId !== 0 || !Number.isFinite(event.time)) continue;
    if (event.kind === "page.snapshot" && event.documentId === documentId) {
      const times = snapshots.get(event.tabId) || [];
      times.push(event.time);
      snapshots.set(event.tabId, times);
    } else if (event.kind === "navigation.committed") {
      latestNavigation.set(event.tabId, Math.max(latestNavigation.get(event.tabId) ?? -Infinity, event.time));
      if (event.payload?.documentId !== documentId)
        latestMismatch.set(event.tabId, Math.max(latestMismatch.get(event.tabId) ?? -Infinity, event.time));
    }
  }
  for (const times of snapshots.values()) times.sort((a, b) => a - b);
  for (const event of [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    if (event.kind !== "network.websocket" || typeof event.payload?.requestId !== "string") continue;
    const id = event.payload.requestId;
    if (event.payload.type === "webSocketCreated") open.set(id, event);
    else if (event.payload.type === "webSocketClosed") open.delete(id);
  }
  const recovered = new Map();
  for (const [id, created] of open) {
    const tabId = created.tabId;
    const tab = tabs?.[tabId];
    const documentId = documents.get(tabId);
    if (!tab || tab.closed || !tab.inScope || !tab.debuggerAttached || !documentId ||
        !Number.isFinite(created.time) || !id.startsWith(`${tabId}:root:`) || id === `${tabId}:root:`) continue;
    const times = snapshots.get(tabId) || [];
    let low = 0, high = times.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (times[mid] < created.time) low = mid + 1;
      else high = mid;
    }
    const snapshotTime = times[low - 1];
    if (snapshotTime == null || (latestNavigation.get(tabId) ?? -Infinity) >= created.time ||
        (latestMismatch.get(tabId) ?? -Infinity) >= snapshotTime) continue;
    recovered.set(id, { tabId, sessionId: null, url: created.payload.url, createdAt: created.time, allowed: true });
  }
  return recovered;
}

export function recoverChildSockets(events, tabs, targets, documents) {
  const open = new Map();
  for (const event of [...events].sort((a, b) => (a.seq || 0) - (b.seq || 0))) {
    if (event.kind !== "network.websocket" || typeof event.payload?.requestId !== "string") continue;
    const id = event.payload.requestId;
    if (event.payload.type === "webSocketCreated") open.set(id, event);
    else if (event.payload.type === "webSocketClosed") open.delete(id);
  }
  const recovered = new Map();
  for (const [id, created] of open) {
    const tabId = created.tabId, prefix = `${tabId}:`;
    if (!id.startsWith(prefix)) continue;
    const suffix = id.slice(prefix.length), separator = suffix.indexOf(":");
    if (separator <= 0 || separator === suffix.length - 1) continue;
    const sessionId = suffix.slice(0, separator), tab = tabs?.[tabId], document = documents.get(sessionId);
    if (sessionId === "root" || !tab || tab.closed || !tab.inScope || !tab.debuggerAttached ||
        targets.get(sessionId) !== tabId || !document?.loaderId ||
        created.payload.frameLoaderId !== document.loaderId) continue;
    try {
      if (new URL(created.payload.frameUrl).origin !== new URL(document.url).origin) continue;
    } catch { continue; }
    recovered.set(id, { tabId, sessionId, url: created.payload.url, createdAt: created.time, allowed: true });
  }
  return recovered;
}
