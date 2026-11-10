import { compareEvents } from "./event-order.js";
import { createResourceScope } from "./resource-scope.js";

export function buildStylesheetMap(events, tabId, upTo, assets, files, context) {
  const requests = new Map(), styles = new Map();
  const scope = createResourceScope(events, tabId, upTo, context);
  for (const event of events)
    if (event.kind === "network.request" && event.payload?.requestId)
      requests.set(event.payload.requestId, event);
  function save(url, css, event) {
    if (typeof url !== "string" || typeof css !== "string" || css.length > 1000000) return;
    const previous = styles.get(url);
    if (!previous || compareEvents(previous.event, event) < 0)
      styles.set(url, { css, event });
  }
  for (const event of events) {
    const payload = event.payload || {};
    if ((upTo && compareEvents(event, upTo) > 0) ||
        (tabId != null && event.tabId != null && event.tabId !== tabId)) continue;
    if (event.kind === "resource.initial" && scope.initial(event) && payload.mime === "text/css" &&
        typeof payload.assetId === "string" && /^[a-z0-9_-]{1,128}$/i.test(payload.assetId)) {
      const asset = assets.get(payload.assetId), bytes = files[`resources/${payload.assetId}.bin`];
      if (asset?.type !== "resource" || asset.mime !== "text/css" || !bytes || bytes.length > 1500000) continue;
      try { save(payload.url, new TextDecoder("utf-8", { fatal: true }).decode(bytes), event); } catch {}
    } else if (event.kind === "network.finished" &&
      ["captured_redacted", "captured_redacted_best_effort"].includes(payload.body?.status)) {
      let id = payload.requestId;
      const seen = new Set();
      while (id && !seen.has(id)) {
        seen.add(id);
        const requestEvent = requests.get(id), request = requestEvent?.payload;
        if (!request) break;
        if (request.type === "Stylesheet" && scope.request(requestEvent)) save(request.url, payload.body.value, event);
        id = request.redirectFrom;
      }
    }
  }
  return new Map([...styles].map(([url, item]) => [url, item.css]));
}
