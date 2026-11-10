const validOffset = (value) =>
  typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1e7;

export function recordedScrollState(snapshot, events) {
  const viewport = snapshot?.viewport || {};
  const state = {
    x: validOffset(viewport.scrollX) ? viewport.scrollX : 0,
    y: validOffset(viewport.scrollY) ? viewport.scrollY : 0,
    elements: new Map(),
    truncated: !!snapshot?.scroll?.truncated,
  };
  const positions = snapshot?.scroll?.positions;
  if (Array.isArray(positions)) {
    if (positions.length > 200) state.truncated = true;
    for (const item of positions.slice(0, 200)) {
      if (
        typeof item?.nodeId === "string" &&
        /^\d{1,16}$/.test(item.nodeId) &&
        validOffset(item.left) &&
        validOffset(item.top)
      )
        state.elements.set(`id:${item.nodeId}`, item);
    }
  }
  for (const event of events) {
    const payload = event.payload || {};
    if (event.kind !== "interaction.scroll") continue;
    if (payload.targetScope === "element") {
      if (!validOffset(payload.scrollLeft) || !validOffset(payload.scrollTop))
        continue;
      const nodeId = payload.targetNodeId;
      const selector = payload.target?.selector;
      const idValid = typeof nodeId === "string" && /^\d{1,16}$/.test(nodeId);
      const selectorValid =
        typeof selector === "string" && selector.length > 0 && selector.length <= 1024;
      if (!idValid && !selectorValid) continue;
      const key = idValid ? `id:${nodeId}` : `selector:${selector}`;
      if (!state.elements.has(key) && state.elements.size >= 1000) {
        state.truncated = true;
        continue;
      }
      state.elements.set(key, {
        nodeId: idValid ? nodeId : undefined,
        selector: selectorValid ? selector : undefined,
        left: payload.scrollLeft,
        top: payload.scrollTop,
      });
    } else if (payload.targetScope === "document" || !payload.targetScope) {
      if (validOffset(payload.x)) state.x = payload.x;
      if (validOffset(payload.y)) state.y = payload.y;
    }
  }
  return state;
}

export function restoreScrollState(frame, state) {
  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) return false;
  doc.documentElement.style.setProperty("scroll-behavior", "auto", "important");
  const nodes = new Map(), roots = [doc];
  for (let index = 0; index < roots.length; index++) {
    for (const node of roots[index].querySelectorAll("*")) {
      const id = node.getAttribute("data-logic-node");
      if (id && !nodes.has(id)) nodes.set(id, node);
      if (node.shadowRoot) roots.push(node.shadowRoot);
    }
  }
  for (const item of state.elements.values()) {
    try {
      const node = item.nodeId
        ? nodes.get(item.nodeId)
        : doc.querySelector(item.selector);
      if (!node) continue;
      node.style.setProperty("scroll-behavior", "auto", "important");
      node.scrollLeft = item.left;
      node.scrollTop = item.top;
    } catch {
      return false;
    }
  }
  win.scrollTo(state.x, state.y);
  return true;
}
