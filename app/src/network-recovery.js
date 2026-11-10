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
