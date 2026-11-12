function valueType(value) {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

export function* observeBrowserData(event, evidence, decoded = null) {
  const payload = event.payload || {}, source = { eventId: event.id, ...evidence };
  if (["cookie.initial", "cookie.partitionSnapshot", "cookie.change"].includes(event.kind)) {
    const items = event.kind === "cookie.change" ? [payload] : payload.items || [];
    yield { kind: "sample", domain: "cookie", source, status: payload.status || "captured", count: items.length };
    for (let index = 0; index < items.length; index++) {
      if (!items[index] || typeof items[index] !== "object") continue;
      for (const [key, value] of Object.entries(items[index]))
        yield { kind: "field", domain: "cookie", source, item: index, key, type: valueType(value) };
    }
  } else if (event.kind === "storage.snapshot") {
    const data = decoded || payload;
    yield { kind: "sample", domain: "storage", source, status: "observed", coverage: data.coverage };
    for (const [store, entries] of Object.entries(data.stores || {}))
      for (const [key, value] of Object.entries(entries || {}))
        yield { kind: "field", domain: "storage", source, store, key, type: valueType(value) };
  } else if (event.kind === "database.record") {
    const graph = decoded || payload.graph;
    yield { kind: "sample", domain: "indexeddb", source, database: payload.database,
      store: payload.store, index: payload.index, status: graph ? payload.status : "unavailable" };
    if (!graph || !Array.isArray(graph.nodes)) return;
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const typeOf = (ref) => ref?.type === "ref" ? nodes.get(ref.id)?.type || "unknown" : ref?.type || "unknown";
    for (const node of graph.nodes) {
      yield { kind: "graph-node", domain: "indexeddb", source, database: payload.database, store: payload.store,
        recordIndex: payload.index, nodeId: node.id, type: node.type, ...(Number.isSafeInteger(node.size) ? { size: node.size } : {}) };
      if (["object", "array"].includes(node.type)) for (const [key, value] of node.entries || [])
        yield { kind: "field", domain: "indexeddb", source, database: payload.database, store: payload.store,
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
        yield { kind: "field-path", domain: "indexeddb", source, database: payload.database,
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
      if (stack.length) yield { kind: "field-path-coverage", domain: "indexeddb", source,
        database: payload.database, store: payload.store, recordIndex: payload.index,
        status: "partial", reason: "path_limit", observed: visited, pending: stack.length };
    }
  }
}
