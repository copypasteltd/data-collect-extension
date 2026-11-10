import { compareEvents } from "./event-order.js";
import { createResourceScope } from "./resource-scope.js";
export { compareEvents } from "./event-order.js";

export function findRequestsWithoutOutcome(events) {
  const open = new Map(), missing = [];
  const ordered = [...events].sort((a, b) =>
    (Number(a.seq) || 0) - (Number(b.seq) || 0) || compareEvents(a, b));
  for (const event of ordered) {
    const id = event.payload?.requestId;
    if (typeof id !== "string" || !id) continue;
    if (event.kind === "network.request") {
      if (open.has(id)) missing.push(open.get(id));
      open.set(id, event);
    } else if (["network.finished", "network.failed", "network.incomplete"].includes(event.kind)) {
      open.delete(id);
    }
  }
  return [...missing, ...open.values()];
}

export function buildResourceMap(events, tabId, upTo, context) {
  const requests = new Map();
  const resources = new Map();
  const scope = createResourceScope(events, tabId, upTo, context);
  for (const event of events) {
    const payload = event.payload || {};
    if (event.kind === "network.request" && payload.requestId)
      requests.set(payload.requestId, event);
  }
  for (const event of events) {
    const payload = event.payload || {};
    if (
      event.kind === "resource.initial" &&
      payload.url &&
      payload.assetId &&
      scope.initial(event) &&
      (!upTo || compareEvents(event, upTo) <= 0) &&
      (tabId == null || event.tabId == null || event.tabId === tabId)
    ) {
      const current = resources.get(payload.url);
      if (
        !current ||
        (current.event.kind === "resource.initial" &&
          compareEvents(current.event, event) < 0)
      )
        resources.set(payload.url, { event, assetId: payload.assetId });
    }
    if (
      event.kind !== "network.finished" ||
      !payload.assetId ||
      (upTo && compareEvents(event, upTo) > 0) ||
      (tabId != null && event.tabId != null && event.tabId !== tabId)
    )
      continue;
    const seen = new Set();
    let id = payload.requestId;
    while (id && !seen.has(id)) {
      seen.add(id);
      const requestEvent = requests.get(id), request = requestEvent?.payload;
      if (!request) break;
      if (!scope.request(requestEvent)) { id = request.redirectFrom; continue; }
      if (request.url) {
        const current = resources.get(request.url);
        if (
          !current ||
          current.event.kind === "resource.initial" ||
          compareEvents(current.event, event) < 0
        )
          resources.set(request.url, { event, assetId: payload.assetId });
      }
      id = request.redirectFrom;
    }
  }
  return new Map([...resources].map(([url, item]) => [url, item.assetId]));
}

export function buildCatalog(events) {
  const pages = new Map(),
    calls = new Map(),
    endpoints = new Map(),
    flows = [],
    lastFlowByTab = new Map(),
    topNavigations = new Map(), frameNavigations = new Map();
  for (const event of [...events].sort(compareEvents)) {
    const p = event.payload || {};
    if (event.kind === "page.snapshot" && p.url) {
      const pageKey = `${event.tabId ?? "unknown"}:${event.frameId ?? "unknown"}:${event.documentId || "unknown"}:${p.url}`;
      const page = pages.get(pageKey) || {
        id: pageKey,
        tabId: event.tabId,
        frameId: event.frameId,
        documentId: event.documentId,
        url: p.url,
        title: p.title || "",
        snapshots: [],
        firstSeen: event.time,
      };
      page.snapshots.push(event.id);
      pages.set(pageKey, page);
    }
    if (
      ["navigation", "navigation.spa", "navigation.committed", "navigation.hash", "navigation.popstate", "navigation.out_of_scope"].includes(event.kind)
    ) {
      const tabId = event.tabId ?? p.tabId;
      const frameId = event.frameId ?? p.frameId;
      if (tabId != null) {
        const top = event.kind === "navigation" || event.kind === "navigation.spa" || frameId === 0;
        if (top || frameId != null) {
          const map = top ? topNavigations : frameNavigations;
          const key = top ? tabId : `${tabId}:${frameId}`;
          const navigations = map.get(key) || [];
          navigations.push(event);
          map.set(key, navigations);
        }
      }
      if (event.kind === "navigation" || event.kind === "navigation.spa" || frameId === 0) {
        for (const key of lastFlowByTab.keys())
          if (key.startsWith(`${tabId}:`)) lastFlowByTab.delete(key);
      } else if (frameId != null) {
        lastFlowByTab.delete(`${tabId}:${frameId}`);
      }
    }
    if (
      /^interaction\.(click|change|submit|input)$/.test(event.kind) &&
      p.url
    ) {
      const context = `${event.tabId ?? "unknown"}:${event.frameId ?? "unknown"}`;
      let flow = lastFlowByTab.get(context);
      if (
        !flow ||
        flow.url !== p.url ||
        (flow.documentId && event.documentId && flow.documentId !== event.documentId)
      ) {
        flow = {
          id: event.id,
          tabId: event.tabId,
          frameId: event.frameId,
          documentId: event.documentId,
          url: p.url,
          steps: [],
        };
        flows.push(flow);
        lastFlowByTab.set(context, flow);
      }
      flow.steps.push({
        eventId: event.id,
        kind: event.kind,
        time: event.time,
        seq: event.seq,
        target: p.target,
        value: p.value,
        candidateRequests: [],
      });
    }
    if (event.kind === "network.request" && p.requestId)
      calls.set(p.requestId, {
        requestId: p.requestId,
        method: p.method,
        url: p.url,
        requestEventId: event.id,
        time: event.time,
        seq: event.seq,
        tabId: event.tabId ?? p.tabId,
        responseEventId: null,
        finishedEventId: null,
        request: p,
      });
    if (event.kind === "network.response" && calls.has(p.requestId))
      Object.assign(calls.get(p.requestId), {
        response: p,
        responseEventId: event.id,
      });
    if (event.kind === "network.requestBody" && calls.has(p.requestId)) {
      const call = calls.get(p.requestId);
      call.request = { ...call.request, postData: p.body };
      call.requestBodyEventId = event.id;
    }
    if (
      ["network.finished", "network.failed", "network.incomplete"].includes(event.kind) &&
      calls.has(p.requestId)
    )
      Object.assign(calls.get(p.requestId), {
        result: p,
        outcomeKind: event.kind,
        finishedEventId: event.id,
      });
  }
  for (const call of calls.values()) {
    if (!/^(XHR|Fetch)$/i.test(call.request.type || "")) continue;
    let path = call.url;
    try {
      const u = new URL(call.url);
      path = u.origin + u.pathname;
    } catch {}
    const key = `${call.method} ${path}`;
    const item = endpoints.get(key) || {
      method: call.method,
      path,
      count: 0,
      samples: [],
    };
    item.count++;
    item.samples.push(call);
    endpoints.set(key, item);
  }
  const stepsByTab = new Map();
  for (const flow of flows) {
    if (flow.tabId == null || flow.frameId == null) continue;
    const list = stepsByTab.get(flow.tabId) || [];
    for (const step of flow.steps) list.push({ step, flow });
    stepsByTab.set(flow.tabId, list);
  }
  for (const list of stepsByTab.values()) list.sort((a, b) => compareEvents(a.step, b.step));
  const pageUrl = (raw) => {
    try { const url = new URL(raw); url.hash = ""; return url.href; }
    catch { return null; }
  };
  const lastBefore = (list, event) => {
    let low = 0, high = list?.length || 0;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (compareEvents(list[mid], event) <= 0) low = mid + 1;
      else high = mid;
    }
    return low ? list[low - 1] : null;
  };
  for (const call of calls.values()) {
    if (call.tabId == null || typeof call.url !== "string" || !/^(XHR|Fetch|EventSource|Ping)$/i.test(call.request.type || "") || call.request.redirectFrom) continue;
    const list = stepsByTab.get(call.tabId) || [];
    let lo = 0, hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (list[mid].step.time < call.time - 1000) lo = mid + 1;
      else hi = mid;
    }
    const documentUrl = pageUrl(call.request.documentUrl);
    const possible = [];
    for (let i = lo; i < list.length && list[i].step.time <= call.time; i++) {
      const item = list[i], scope = call.request.sourceFrame;
      if (compareEvents(item.step, call) >= 0) continue;
      const top = lastBefore(topNavigations.get(call.tabId), call);
      const frame = lastBefore(frameNavigations.get(`${call.tabId}:${item.flow.frameId}`), call);
      const boundary = !top ? frame : !frame || compareEvents(top, frame) >= 0 ? top : frame;
      const navigation = boundary && compareEvents(boundary, item.step) > 0 ? boundary : null;
      const crossedMainPage = navigation && item.flow.frameId === 0 && scope === "main" &&
        documentUrl && pageUrl(navigation.payload?.url) === documentUrl;
      if ((scope === "main" && item.flow.frameId !== 0) ||
          (scope === "embedded" && item.flow.frameId === 0) ||
          (documentUrl && pageUrl(item.flow.url) !== documentUrl && !crossedMainPage)) continue;
      possible.push({ ...item, navigation });
    }
    if (new Set(possible.map(({ flow }) => flow.frameId)).size !== 1) continue;
    const candidates = possible.some((item) => !item.navigation)
      ? possible.filter((item) => !item.navigation) : possible;
    const contexts = new Set(candidates.map(({ flow }) => `${flow.frameId}:${flow.documentId || "unknown"}`));
    if (contexts.size !== 1) continue;
    const selected = candidates[candidates.length - 1];
    selected.step.candidateRequests.push({
      eventId: call.requestEventId,
      method: typeof call.method === "string" ? call.method.slice(0, 32) : "请求",
      url: call.url.slice(0, 4000),
      delay: Math.max(0, call.time - selected.step.time),
      source: call.request.sourceFrame === "main" && selected.flow.frameId === 0 ? "main" : "unconfirmed",
      ...(selected.navigation ? { navigation: { eventId: selected.navigation.id, kind: selected.navigation.kind } } : {}),
    });
  }
  return {
    pages: [...pages.values()],
    endpoints: [...endpoints.values()],
    flows,
  };
}
