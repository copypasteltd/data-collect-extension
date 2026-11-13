/* Standalone isolated-world IIFE. Evidence is inert text, never inserted/executed. */
(() => {
  const KEY = "__logicRecorderFlowV1";
  const holder = globalThis[KEY] || (globalThis[KEY] = {});
  if (holder.boot) return; // Concurrent injections share the same bounded settings/startup work.
  holder.boot = (async () => {
    try {
      const reply = await send({ type: "FLOW_SETTINGS" }, 5000);
      const settings = reply?.ok && reply.value;
      if (settings?.profile !== "business-flow-v1" || !settings.sessionId || !settings.ownerToken) return holder.dispose?.();
      const identity = holder.identity?.();
      if (holder.document === document && holder.active?.() && identity?.sessionId === settings.sessionId && identity.ownerToken === settings.ownerToken) return;
      holder.dispose?.();
      await start({ sessionId: settings.sessionId, ownerToken: settings.ownerToken });
    } catch {} // An unconfirmed probe never destroys a live collector or its queue.
  })().finally(() => { holder.boot = null; });
  function deadline(promise, ms, label) {
    return new Promise((resolve, reject) => {
      const id = setTimeout(() => reject(new Error(label)), ms);
      Promise.resolve(promise).then((v) => { clearTimeout(id); resolve(v); }, (e) => { clearTimeout(id); reject(e); });
    });
  }
  function send(message, ms = 2500) { return deadline(chrome.runtime.sendMessage(message), ms, "message-deadline"); }
  function start(settings) {
  const MiB = 1024 * 1024, MAX = 2 * MiB, META = 30 * 1024;
  const encoder = new TextEncoder(), timers = new Set(), removers = [], observers = [];
  const cssSeen = new Set(), resourceSeen = new Set(), before = new WeakMap(), previousState = new WeakMap(), pendingInput = new Map();
  const watchedRoots = new WeakSet(), seenEvents = new WeakSet();
  const nonce = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  let active = false, closed = false, disposed = false, policyStopped = false;
  let queue = [], queuedBytes = 0, sending = null, batchNo = 0, accepted = 0, failed = 0, reason = "";
  let captureTail = Promise.resolve(), flushPromise, checkpointTimer, scrollTimer, lastCapture = -Infinity;
  let pendingReasons = new Set(), scrollTarget, waiters = [], lastUrl = "";
  const size = (s) => encoder.encode(s).byteLength;
  const short = (s, n = 512) => String(s ?? "").slice(0, n);
  const timer = (fn, ms) => { const id = setTimeout(() => { timers.delete(id); fn(); }, ms); timers.add(id); return id; };
  const cancel = (id) => { clearTimeout(id); timers.delete(id); };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  function detach() {
    active = false;
    for (const remove of removers.splice(0)) remove();
    for (const observer of observers.splice(0)) observer.disconnect();
    for (const id of timers) clearTimeout(id);
    timers.clear(); checkpointTimer = scrollTimer = undefined; pendingReasons.clear();
  }
  function dispose() {
    detach(); closed = disposed = true; pendingInput.clear();
    chrome.runtime.onMessage.removeListener(onMessage);
    queue = []; queuedBytes = 0; settle();
  }
  Object.assign(holder, { dispose, identity: () => ({ ...settings }), active: () => !closed && !disposed, document });
  function policy(code) {
    if (policyStopped) return;
    policyStopped = true; reason = code; closed = true; detach(); pendingInput.clear();
    queue = []; queuedBytes = 0;
    void send({ type: "FLOW_POLICY_STOPPED", ...settings, reason: code }).catch(() => {});
    settle();
  }
  function summary() {
    const pending = queue.length + (sending?.count || 0);
    const confirmed = !pending && !failed && !policyStopped && !reason;
    return { ok: confirmed, value: { sessionId: settings?.sessionId, accepted, failed, policyStopped, reason: reason || undefined, pending, confirmed } };
  }
  function settle() { if (!queue.length && !sending) for (const resolve of waiters.splice(0)) resolve(); }
  function emit(kind, payload = {}, contents = []) {
    if (closed || disposed) return;
    const metadata = JSON.stringify(payload);
    if (metadata.length > META || size(metadata) > META) { policy("content-metadata-limit"); return; }
    const bytes = size(metadata) + contents.reduce((n, item) => n + size(item.bytes), 0);
    if (queue.length + (sending?.count || 0) >= 32 || queuedBytes + (sending?.bytes || 0) + bytes > 6 * MiB) {
      policy("content-queue-limit"); return;
    }
    queue.push({ event: { kind, time: Date.now(), payload, ...(contents.length ? { contents } : {}) }, bytes });
    queuedBytes += bytes; void pump();
  }
  async function pump() {
    if (sending || !queue.length || closed || disposed) return settle();
    const batch = []; let bytes = 0;
    while (queue.length && batch.length < 8 && (!batch.length || bytes + queue[0].bytes < MAX + META)) {
      const item = queue.shift(); batch.push(item.event); bytes += item.bytes; queuedBytes -= item.bytes;
    }
    sending = { count: batch.length, bytes };
    try {
      const reply = await send({ type: "FLOW_EVENTS", sessionId: settings.sessionId, ownerToken: settings.ownerToken,
        batchId: settings.ownerToken + ":" + nonce + ":" + (++batchNo), events: batch });
      const result = reply?.ok === true && reply.value;
      if (!result || !Number.isInteger(result.accepted) || !Number.isInteger(result.failed) ||
          result.accepted < 0 || result.failed < 0 || result.accepted + result.failed > batch.length) throw new Error("invalid-event-ack");
      accepted += result.accepted; failed += result.failed;
      if (result.policyStopped) policy(short(result.reason || "background-policy"));
      else if (result.accepted + result.failed !== batch.length) throw new Error("incomplete-event-ack");
      if (result.failed) { reason ||= "event-write-failed"; detach(); }
    } catch (error) {
      failed += batch.length; reason ||= short(error.message || "event-send-failed"); detach();
    } finally { sending = null; if (queue.length && !closed) void pump(); else settle(); }
  }
  function drain() {
    if (!queue.length && !sending) return Promise.resolve();
    void pump(); return new Promise((resolve) => waiters.push(resolve));
  }
  function contentValue(payload, contents, field, value, budget = MAX) {
    if (typeof value !== "string") { payload[field] = value; return 0; }
    if (value.length > budget) { payload[field] = { status: "policy", reason: "value-size-limit", characters: value.length }; return 0; }
    const bytes = size(value);
    if (bytes > budget) { payload[field] = { status: "policy", reason: "value-size-limit", bytes }; return 0; }
    if (bytes <= 2048) { payload[field] = value; return bytes; }
    contents.push({ field, category: "dom", mime: "text/plain;charset=utf-8", bytes: value });
    return bytes;
  }
  function fieldValue(element) {
    return element?.isContentEditable ? { status: "policy", reason: "contenteditable-use-source-structure" } : typeof element?.value === "string" ? element.value : undefined;
  }
  function directText(element, limit = 512) {
    let text = "", node = element?.firstChild, scanned = 0;
    while (node && scanned++ < 16 && text.length < limit) {
      if (node.nodeType === 3) text += node.data.slice(0, limit - text.length);
      node = node.nextSibling;
    }
    return text;
  }
  function target(element) {
    if (!element || element.nodeType !== 1) return {};
    const id = element.getAttribute("id"), name = element.getAttribute("name");
    return { tag: short(element.localName, 64), selector: id && id.length <= 256 ? "#" + CSS.escape(id) : short(element.localName) + (name ? '[name="' + short(name).replace(/["\\]/g, "\\$&") + '"]' : ""),
      id: short(id), name: short(name), type: short(element.getAttribute("type"), 64), textPreview: directText(element), role: short(element.getAttribute("role"), 64) };
  }
  function eventTarget(event) { return event.composedPath?.()[0] || event.target; }
  function recordValue(kind, element, extra = {}) {
    const payload = { url: short(location.href, 4096), target: target(element), ...extra }, contents = [];
    const value = fieldValue(element);
    if (value !== undefined) contentValue(payload, contents, "value", value);
    if (before.has(element)) contentValue(payload, contents, "beforeValue", before.get(element), MAX - contents.reduce((n, c) => n + size(c.bytes), 0));
    if (previousState.has(element)) Object.assign(payload, previousState.get(element));
    if (typeof element?.checked === "boolean") { payload.checked = element.checked; previousState.set(element, { beforeChecked: element.checked }); }
    if (typeof element?.disabled === "boolean") payload.disabled = element.disabled;
    if (value !== undefined) before.set(element, value);
    emit(kind, payload, contents);
  }
  function commitInput(element) {
    const pending = pendingInput.get(element); if (!pending) return;
    cancel(pending); pendingInput.delete(element); recordValue("ui.input", element); schedule("input");
  }
  function recordScroll() {
    if (!scrollTarget) return;
    const element = scrollTarget; scrollTarget = null;
    emit("ui.scroll", element === document || element === window ? { x: scrollX, y: scrollY, scope: "document" } :
      { target: target(element), x: element.scrollLeft, y: element.scrollTop, scope: "element" });
  }
  function listen(root, name, listener, options = true) {
    const handler = (event) => { if (!active || seenEvents.has(event)) return; seenEvents.add(event); listener(event); };
    root.addEventListener(name, handler, options); removers.push(() => root.removeEventListener(name, handler, options));
  }
  const transientSeen = new WeakMap();
  function businessState(el) {
    if (el?.nodeType !== 1) return false;
    return ["dialog", "menu", "listbox", "alert", "combobox"].includes(el.getAttribute("role")) || el.localName === "dialog" ||
      el.getAttribute("aria-invalid") === "true" || /dialog|modal|dropdown|popover|validation|error-message/i.test(short(el.getAttribute("class"), 256));
  }
  function transientText(root, limit) {
    const parts = []; let bytes = 0, nodes = 0, limited = false;
    function visit(node, depth) {
      if (++nodes > 128 || depth > 8) { limited = true; return; }
      if (node.nodeType === 3) {
        if (node.length > limit - bytes || size(node.data) > limit - bytes) { limited = true; return; }
        parts.push(node.data); bytes += size(node.data); return;
      }
      if (node.nodeType !== 1 || ["script", "style"].includes(node.localName)) return;
      for (let child = node.firstChild; child && !limited; child = child.nextSibling) visit(child, depth + 1);
    }
    visit(root, 0);
    return limited ? { status: "policy", reason: "transient-text-scan-limit" } : parts.join("");
  }
  function transientNotice(el, action, budget) {
    if (!businessState(el) || budget.nodes >= 8 || budget.bytes >= 8192) return;
    budget.nodes++;
    const payload = { reason: "transient_state", role: short(el.getAttribute("role") || el.localName, 64), action, target: target(el),
      state: { open: el.hasAttribute ? el.hasAttribute("open") : el.getAttribute("open") !== null,
        hidden: !!el.hidden, expanded: el.getAttribute("aria-expanded"), invalid: el.getAttribute("aria-invalid") } };
    const contents = [], reserve = size(JSON.stringify(payload)) + 128;
    contentValue(payload, contents, "text", transientText(el, Math.max(0, Math.min(7000, 8192 - budget.bytes - reserve))), 7000);
    const key = JSON.stringify(payload) + (contents[0]?.bytes || "");
    if (transientSeen.get(el) === key) return;
    const bytes = size(key); if (budget.bytes + bytes > 8192) return;
    transientSeen.set(el, key); budget.bytes += bytes; emit("recorder.notice", payload, contents);
  }
  function install(root) {
    if (watchedRoots.has(root)) return; watchedRoots.add(root);
    listen(root, "beforeinput", (e) => { const el = eventTarget(e); if (!pendingInput.has(el)) before.set(el, fieldValue(el)); });
    listen(root, "input", (e) => {
      const el = eventTarget(e); if (pendingInput.has(el)) cancel(pendingInput.get(el));
      if (pendingInput.size >= 32 && !pendingInput.has(el)) return policy("pending-input-limit");
      pendingInput.set(el, timer(() => commitInput(el), 250));
    });
    for (const type of ["click", "change", "submit"]) listen(root, type, (e) => {
      const el = eventTarget(e);
      if (type === "change" && pendingInput.has(el)) { cancel(pendingInput.get(el)); pendingInput.delete(el); }
      if (type === "submit") for (const field of pendingInput.keys()) commitInput(field);
      recordValue("ui." + type, el, { trusted: e.isTrusted === true, button: e.button }); schedule(type);
    });
    listen(root, "keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") {
      commitInput(eventTarget(e)); recordValue("ui.key", eventTarget(e), { key: e.key, trusted: e.isTrusted === true }); schedule("key");
    } });
    listen(root, "invalid", (e) => { recordValue("recorder.notice", eventTarget(e), { reason: "validation" }); schedule("validation"); });
    listen(root, "scroll", (e) => { scrollTarget = e.target; cancel(scrollTimer); scrollTimer = timer(recordScroll, 250); }, { capture: true, passive: true });
    const observer = new MutationObserver((records) => {
      if (!active) return;
      const transientBudget = { nodes: 0, bytes: 0 };
      // Never serialize mutation records. Inspect at most 64 relevant targets per delivery.
      for (let i = 0; i < records.length && i < 64; i++) {
        const record = records[i]; let el = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
        for (let depth = 0; el && depth < 5; depth++, el = el.parentElement) {
          const role = el.getAttribute("role"), cls = short(el.getAttribute("class"), 256);
          if (["dialog", "menu", "listbox", "alert", "combobox"].includes(role) || el.localName === "dialog" ||
              el.getAttribute("aria-invalid") === "true" || /dialog|modal|dropdown|popover|validation|error-message/i.test(cls)) {
            transientNotice(el, "changed", transientBudget);
            schedule(el.getAttribute("aria-invalid") === "true" ? "validation" : "mutation"); break;
          }
        }
        if (record.type === "childList") for (const [list, action] of [[record.addedNodes, "added"], [record.removedNodes, "removed"]]) {
          for (let j = 0; j < (list?.length || 0) && j < 8; j++) {
            const node = list[j];
            if (businessState(node)) { transientNotice(node, action, transientBudget); schedule("mutation"); }
          }
        }
      }
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ["open", "hidden", "class", "aria-expanded", "aria-hidden", "aria-invalid", "aria-selected", "aria-checked", "disabled"] });
    observers.push(observer);
  }
  function collectDOM() {
    const chunks = [], forms = [], contents = [], roots = [], urls = [], policies = new Set();
    let bytes = 0, formBytes = 0, nodes = 0, shadows = 0, shadowNodes = 0, formMeta = 0;
    const note = (code) => { if (policies.size < 24) policies.add(code); };
    const put = (text) => {
      if (text.length > MAX - bytes - formBytes || bytes + formBytes + size(text) > MAX - 1024) { note("dom-size-limit"); return false; }
      chunks.push(text); bytes += size(text); return true;
    };
    const escape = (text, attribute = false) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(attribute ? /"/g : /$^/, "&quot;");
    function resource(url, type) {
      if (!url || url.length > 4096 || urls.length >= 128) return;
      try { const parsed = new URL(url, document.baseURI); if (/^https?:$/.test(parsed.protocol)) urls.push({ url: parsed.href, type }); } catch {}
    }
    function form(el, selector) {
      if (!["input", "textarea", "select", "option", "button"].includes(el.localName) && !el.isContentEditable) return;
      if (forms.length >= 128 || formMeta > 14000) { note("form-count-limit"); return; }
      const row = { selector, tag: el.localName, disabled: !!el.disabled }, extra = {}, items = [];
      const value = fieldValue(el); if (value !== undefined) {
        if (!before.has(el)) before.set(el, value);
        const field = "formValue" + forms.length;
        const cost = contentValue(extra, items, field, value, contents.length >= 15 ? 0 : Math.max(0, MAX - bytes - formBytes - 8192));
        if (items.length) { row.value = { field }; contents.push(...items); formBytes += cost; }
        else row.value = extra[field];
      }
      if (typeof el.checked === "boolean") { row.checked = el.checked; if (!previousState.has(el)) previousState.set(el, { beforeChecked: el.checked }); }
      if (typeof el.selected === "boolean") row.selected = el.selected;
      if (typeof el.selectedIndex === "number") row.selectedIndex = el.selectedIndex;
      if (el.validity) row.validity = { valid: el.validity.valid, valueMissing: el.validity.valueMissing, typeMismatch: el.validity.typeMismatch, customError: el.validity.customError };
      if (el.validationMessage) contentValue(extra, items, "validation" + forms.length, el.validationMessage, 2048);
      if (el.validationMessage) row.validationMessage = extra["validation" + forms.length];
      const cost = size(JSON.stringify(row));
      if (formMeta + cost > 16000) { note("form-metadata-limit"); return; }
      forms.push(row); formMeta += cost;
    }
    function children(parent, depth, inShadow) {
      let node = parent.firstChild;
      while (node) {
        if (nodes >= 12000 || (inShadow && shadowNodes >= 2000) || bytes + formBytes > MAX - 2048) { note("dom-scan-limit"); break; }
        const next = node.nextSibling; visit(node, depth, inShadow); node = next;
      }
    }
    function visit(node, depth, inShadow) {
      nodes++; if (inShadow) shadowNodes++;
      if (depth > 64) { note("dom-depth-limit"); return; }
      if (node.nodeType === 3) {
        if (node.length > MAX - bytes - formBytes) { note("text-size-limit"); put("<!-- text omitted: size policy -->"); return; }
        put(escape(node.data)); return;
      }
      if (node.nodeType !== 1) return;
      const tag = node.localName, selector = '[data-flow-node="' + nodes + '"]';
      if (!put("<" + tag + ' data-flow-node="' + nodes + '"')) return;
      for (let i = 0; i < node.attributes.length && i < 64; i++) {
        const attr = node.attributes[i];
        if (attr.name === "data-flow-node") { note("generated-node-marker-collision"); continue; }
        if (attr.value.length > MAX - bytes - formBytes - 2048) { note("attribute-size-limit"); continue; }
        if (!put(" " + attr.name + '="' + escape(attr.value, true) + '"')) break;
      }
      if (node.attributes.length > 64) note("attribute-count-limit");
      put(">"); form(node, selector);
      if (tag === "img" && node.complete && node.naturalWidth > 0 && !node.hidden) resource(node.currentSrc || node.src, "image");
      if (tag === "link" && /stylesheet/.test(node.rel || "")) resource(node.href, "stylesheet");
      if (tag === "link" && node.as === "font") resource(node.href, "font");
      if (tag === "iframe") note("frame-document-separate-sender-policy");
      if (tag === "script" || tag === "style") { note(tag + "-text-separate-policy"); put("<!-- " + tag + " text not sampled here -->"); }
      else if (tag === "canvas") note("canvas-pixels-not-sampled");
      else children(tag === "template" ? node.content : node, depth + 1, inShadow);
      if (node.shadowRoot) {
        if (shadows >= 16 || shadowNodes >= 2000) note("open-shadow-limit");
        else { shadows++; roots.push(node.shadowRoot); put('<template shadowrootmode="open">'); children(node.shadowRoot, depth + 1, true); put("</template>"); }
      } else if (tag.includes("-")) note("closed-or-no-shadow-not-accessible-not-probed");
      if (!/^(area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/.test(tag)) put("</" + tag + ">");
    }
    put("<!doctype html>"); if (document.documentElement) visit(document.documentElement, 0, false);
    return { source: chunks.join(""), forms, contents, roots, urls, policies: [...policies], nodes, shadowNodes, bytes: bytes + formBytes };
  }
  async function styles(roots, urls) {
    const refs = [], events = [], policies = new Set(); let count = 0, rules = 0, sampleBytes = 0, refBytes = 0;
    for (const root of [document, ...roots]) {
      const lists = [root.styleSheets || [], root.adoptedStyleSheets || []];
      for (const list of lists) for (let i = 0; i < list.length && count < 32; i++, count++) {
        const sheet = list[i], href = short(sheet.href, 4096), ref = { href, access: "readable" };
        if (href && urls.length < 128) urls.push({ url: href, type: "stylesheet" });
        try {
          const cssRules = sheet.cssRules, parts = []; let bytes = 0;
          for (let j = 0; j < cssRules.length && j < 2000 && rules < 8000; j++, rules++) {
            const text = cssRules[j].cssText;
            if (text.length > MAX || bytes + size(text) + 1 > MAX || sampleBytes + bytes + size(text) + 1 > MAX) {
              ref.access = "policy"; ref.reason = "stylesheet-size-limit"; break;
            }
            parts.push(text); bytes += size(text) + 1;
          }
          if (parts.length !== cssRules.length) { ref.access = "policy"; ref.reason ||= "stylesheet-rule-limit"; }
          if (ref.access === "readable") {
            const text = parts.join("\n"), data = encoder.encode(text);
            ref.sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), (b) => b.toString(16).padStart(2, "0")).join("");
            sampleBytes += data.byteLength;
            const rx = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/g; let match, seen = 0;
            while ((match = rx.exec(text)) && seen++ < 128 && urls.length < 128) {
              const raw = (match[1] || match[2] || match[3] || "").trim();
              if (raw.length > 4096) continue;
              try { const url = new URL(raw, href || document.baseURI); if (/^https?:$/.test(url.protocol))
                urls.push({ url: url.href, type: /\.(woff2?|ttf|otf)(?:[?#]|$)/i.test(url.href) ? "font" : "image" }); } catch {}
            }
            if (!cssSeen.has(ref.sha256)) {
              if (cssSeen.size >= 256) { ref.access = "policy"; ref.reason = "stylesheet-hash-limit"; }
              else { cssSeen.add(ref.sha256); events.push({ payload: { href, sha256: ref.sha256, source: "cssom-rules" },
                contents: [{ field: "text", category: "resource", mime: "text/css;charset=utf-8", bytes: text }] }); }
            }
          }
        } catch { ref.access = "unavailable"; ref.reason = "cross-origin-or-unreadable-css-rules"; }
        const refSize = size(JSON.stringify(ref));
        if (refBytes + refSize > 6000) { policies.add("stylesheet-reference-metadata-limit"); return { refs, events, policies: [...policies] }; }
        refBytes += refSize; refs.push(ref);
      }
      if (count >= 32) policies.add("stylesheet-count-limit");
    }
    return { refs, events, policies: [...policies] };
  }
  async function capture(why) {
    if (closed || disposed) return;
    await wait(Math.max(0, 500 - (Date.now() - lastCapture)));
    if (closed || disposed) return;
    lastCapture = Date.now();
    const dom = collectDOM(); if (active) for (const root of dom.roots) install(root);
    const css = await styles(dom.roots, dom.urls);
    if (closed || disposed) return;
    const payload = { reason: why, url: short(location.href, 4096), title: short(document.title, 1024), forms: dom.forms,
      viewport: { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY }, nodes: dom.nodes,
      shadowNodes: dom.shadowNodes, policies: [...dom.policies, ...css.policies], stylesheets: css.refs };
    for (const content of dom.contents) payload[content.field] = undefined;
    emit("page.snapshot", payload, [{ field: "sourceHtml", category: "dom", mime: "text/html;charset=utf-8", bytes: dom.source }, ...dom.contents]);
    for (const item of css.events) emit("page.stylesheet", item.payload, item.contents);
    let resourceBytes = 0;
    const urls = dom.urls.filter((item) => { const key = item.type + ":" + item.url;
      resourceBytes += size(JSON.stringify(item)); if (resourceBytes > 14000) return false;
      if (resourceSeen.has(key) || resourceSeen.size >= 256) return false; resourceSeen.add(key); return true; });
    if (urls.length) emit("page.resources", { urls });
  }
  function checkpoint(why) {
    captureTail = captureTail.then(() => capture(why)).catch(() => { failed++; reason ||= "checkpoint-failed"; detach(); });
    return captureTail;
  }
  function schedule(why) {
    if (!active || closed) return;
    pendingReasons.add(why);
    if (!checkpointTimer) checkpointTimer = timer(() => {
      checkpointTimer = undefined; const reasons = [...pendingReasons]; pendingReasons.clear();
      void checkpoint(reasons.includes("validation") ? "validation" : reasons[0] || "mutation");
    }, Math.max(100, 500 - (Date.now() - lastCapture)));
  }
  function flush() {
    if (!flushPromise) {
      for (const el of pendingInput.keys()) commitInput(el); recordScroll(); detach();
      flushPromise = deadline((async () => { await checkpoint("stop"); await drain(); return summary(); })(), 3000, "flush-deadline")
        .catch(() => { reason ||= "flush-deadline"; failed++; closed = true; queue = []; queuedBytes = 0; return summary(); });
    }
    return flushPromise;
  }
  function onMessage(message, _sender, respond) {
    if (!["FLOW_CHECKPOINT", "FLOW_FLUSH", "STOP_CAPTURE"].includes(message?.type)) return;
    if (!settings || message.sessionId !== settings.sessionId || message.ownerToken !== settings.ownerToken || disposed) {
      respond({ ok: false, error: "stale-owner-token" }); return;
    }
    if (message.type === "STOP_CAPTURE") { detach(); closed = true; pendingInput.clear(); respond({ ok: true }); return; }
    if (message.type === "FLOW_CHECKPOINT") { schedule("checkpoint"); respond({ ok: active && !closed }); return; }
    void flush().then(respond); return true;
  }
  chrome.runtime.onMessage.addListener(onMessage);
  return (async () => {
    try {
      const ready = await send({ type: "FLOW_READY", ...settings });
      if (disposed || closed || ready?.ok !== true) return dispose();
      active = true; install(document); lastUrl = location.href;
      const navigation = (event) => { const url = location.href;
        emit("page.navigation", { url: short(url, 4096), beforeUrl: short(lastUrl, 4096), trigger: event.type }); lastUrl = url; schedule("navigation"); };
      listen(window, "popstate", navigation); listen(window, "hashchange", navigation);
      await checkpoint("initial");
    } catch { dispose(); }
  })();
  }
})();
