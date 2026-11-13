const identityString = (value) => typeof value === "string" && value.length ? value : null;
const contextId = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;
const evidenceLine = (value) => Number.isSafeInteger(value) && value > 0 ? value : null;

function browserOrigin(value) {
  if (!identityString(value)) return null;
  try {
    const url = new URL(value);
    // Opaque/inherited origins cannot be proved by their URL alone.
    return ["http:", "https:"].includes(url.protocol) && url.origin !== "null" ? url.origin : null;
  } catch { return null; }
}

function normalizeIdentity(identity) {
  if (identity?.version !== 1) return null;
  const origin = identity.originBasis === "payload.url" ? browserOrigin(identity.origin) : null;
  const storageKey = identity.storagePartition?.status === "observed" &&
    identity.storagePartition.basis === "event.storageKey" ? identityString(identity.storagePartition.storageKey) : null;
  const instanceId = identity.storageInstance?.status === "observed" &&
    identity.storageInstance.basis === "event.storageInstanceId" ? identityString(identity.storageInstance.id) : null;
  return {
    version: 1, origin, originBasis: origin ? "payload.url" : "unknown",
    sessionId: identityString(identity.sessionId), tabId: contextId(identity.tabId), frameId: contextId(identity.frameId),
    documentId: identityString(identity.documentId), graphCaptureId: identityString(identity.graphCaptureId),
    catalogId: identityString(identity.catalogId), fragmentCaptureId: identityString(identity.fragmentCaptureId),
    storagePartition: storageKey ? { status: "observed", storageKey, basis: "event.storageKey" } : { status: "unknown" },
    storageInstance: instanceId ? { status: "observed", id: instanceId, basis: "event.storageInstanceId" } : { status: "unknown" },
  };
}

// Project metadata, never record values, decoded graphs, Cookie partitionKey or guessed top-level sites.
// Current collectors provide sender context + payload.url; the optional top-level storage metadata is not inferred.
export function browserObservationSource(event, evidence = {}) {
  const payload = event.payload || {};
  return { ...evidence, eventId: event.id, identity: normalizeIdentity({
    version: 1, origin: browserOrigin(payload.url), originBasis: "payload.url", sessionId: event.sessionId,
    tabId: event.tabId, frameId: event.frameId, documentId: event.documentId,
    graphCaptureId: payload.graphCaptureId, catalogId: payload.catalogId,
    fragmentCaptureId: payload.graphReference?.captureId || payload.storageReference?.captureId,
    storagePartition: { status: "observed", storageKey: event.storageKey, basis: "event.storageKey" },
    storageInstance: { status: "observed", id: event.storageInstanceId, basis: "event.storageInstanceId" },
  }) };
}

// Summary evidence has an explicit allow-list, so extra historical/source fields cannot echo original values.
export function browserObservationEvidence(source) {
  const identity = normalizeIdentity(source?.identity);
  return { eventId: identityString(source?.eventId),
    ...(identityString(source?.path) ? { path: source.path } : {}),
    ...(evidenceLine(source?.line) ? { line: source.line } : {}),
    ...(identityString(source?.fragmentCaptureId) ? { fragmentCaptureId: source.fragmentCaptureId } : {}),
    ...(identity ? { identity } : {}),
  };
}

export function browserStorageNamespace(source) {
  const identity = normalizeIdentity(source?.identity);
  const eventScope = { eventId: identityString(source?.eventId), path: identityString(source?.path), line: evidenceLine(source?.line) };
  if (!identity) return { version: 1, scope: "legacy-event", legacy: true, ...eventScope };
  const { origin, sessionId, storagePartition, storageInstance } = identity;
  const base = { version: 1, origin, sessionId, storagePartition, storageInstance };
  if (!origin || !sessionId) return { ...base, scope: "event", ...eventScope };
  if (storagePartition.status === "observed") return { ...base, scope: "storage-key" };
  if (storageInstance.status === "observed") return { ...base, scope: "storage-instance" };
  // A document context is a conservative continuity boundary, NOT a claimed storage partition.
  // It permits start/stop samples in that document, without merging other same-origin documents.
  if (identity.documentId) return { ...base, scope: "document", tabId: identity.tabId, documentId: identity.documentId };
  for (const kind of ["graphCaptureId", "catalogId", "fragmentCaptureId"])
    if (identity[kind]) return { ...base, scope: "capture", tabId: identity.tabId, frameId: identity.frameId,
      capture: { kind, id: identity[kind] } };
  return { ...base, scope: "event", ...eventScope };
}

export function incompleteBrowserObservation(event, evidence, reason) {
  const payload = event.payload || {};
  return { schemaVersion: 2, kind: "sample", domain: event.kind === "storage.snapshot" ? "storage" : "indexeddb",
    database: payload.database, store: payload.store, ...(event.kind === "database.record" ? { index: payload.index } : {}),
    source: browserObservationSource(event, evidence), status: "incomplete", reason };
}

function valueType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function* observeBrowserData(event, evidence, decoded = null) {
  const payload = event.payload || {}, source = browserObservationSource(event, evidence);
  if (["cookie.initial", "cookie.partitionSnapshot", "cookie.change"].includes(event.kind)) {
    const items = event.kind === "cookie.change" ? [payload] : payload.items || [];
    yield { schemaVersion: 2, kind: "sample", domain: "cookie", source, status: payload.status || "captured", count: items.length };
    for (let index = 0; index < items.length; index++) {
      if (!items[index] || typeof items[index] !== "object") continue;
      for (const [key, value] of Object.entries(items[index]))
        yield { schemaVersion: 2, kind: "field", domain: "cookie", source, item: index, key, type: valueType(value) };
    }
  } else if (event.kind === "storage.snapshot") {
    const data = decoded || payload;
    yield { schemaVersion: 2, kind: "sample", domain: "storage", source, status: "observed", coverage: data.coverage };
    for (const [store, entries] of Object.entries(data.stores || {}))
      for (const [key, value] of Object.entries(entries || {}))
        yield { schemaVersion: 2, kind: "field", domain: "storage", source, store, key, type: valueType(value) };
  } else if (event.kind === "database.record") {
    const graph = decoded || payload.graph;
    yield { schemaVersion: 2, kind: "sample", domain: "indexeddb", source, database: payload.database,
      store: payload.store, index: payload.index, status: graph ? payload.status : "unavailable" };
    if (!graph || !Array.isArray(graph.nodes)) return;
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const typeOf = (ref) => ref?.type === "ref" ? nodes.get(ref.id)?.type || "unknown" : ref?.type || "unknown";
    for (const node of graph.nodes) {
      yield { schemaVersion: 2, kind: "graph-node", domain: "indexeddb", source, database: payload.database, store: payload.store,
        recordIndex: payload.index, nodeId: node.id, type: node.type, ...(Number.isSafeInteger(node.size) ? { size: node.size } : {}) };
      if (["object", "array"].includes(node.type)) for (const [key, value] of node.entries || [])
        yield { schemaVersion: 2, kind: "field", domain: "indexeddb", source, database: payload.database, store: payload.store,
          recordIndex: payload.index, nodeId: node.id, key, type: typeOf(value) };
    }
    if (graph.root) {
      const stack = [{ ref: graph.root, path: "", location: [], ancestors: new Set() }];
      let visited = 0;
      while (stack.length && visited < 100000) {
        const { ref, path, location, ancestors } = stack.pop();
        visited++;
        const node = ref?.type === "ref" ? nodes.get(ref.id) : null;
        const cycle = !!node && ancestors.has(node.id);
        yield { schemaVersion: 2, kind: "field-path", domain: "indexeddb", source, database: payload.database,
          store: payload.store, recordIndex: payload.index, path, location, type: typeOf(ref),
          ...(node ? { nodeId: node.id } : {}), ...(cycle ? { cycle: true } : {}) };
        if (!node || cycle || !["object", "array", "map", "set"].includes(node.type)) continue;
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(node.id);
        const entries = node.type === "set" ? node.values || [] : node.entries || [];
        for (let index = entries.length - 1; index >= 0; index--) {
          if (node.type === "map") {
            const [key, value] = entries[index];
            stack.push({ ref: value, path: null, location: [...location, { mapEntry: index, part: "value" }], ancestors: nextAncestors });
            stack.push({ ref: key, path: null, location: [...location, { mapEntry: index, part: "key" }], ancestors: nextAncestors });
          } else if (node.type === "set") {
            stack.push({ ref: entries[index], path: null, location: [...location, { setEntry: index }], ancestors: nextAncestors });
          } else {
            const [key, child] = entries[index];
            const segment = String(key).replace(/~/g, "~0").replace(/\//g, "~1");
            stack.push({ ref: child, path: path === null ? null : `${path}/${segment}`,
              location: [...location, { key: String(key) }], ancestors: nextAncestors });
          }
        }
      }
      if (stack.length) yield { schemaVersion: 2, kind: "field-path-coverage", domain: "indexeddb", source,
        database: payload.database, store: payload.store, recordIndex: payload.index,
        status: "partial", reason: "path_limit", observed: visited, pending: stack.length };
    }
  }
}
