import { createEventDelivery } from "./delivery.js";
import { singleBackgroundUrl, fontSourceUrls } from "./background-style.js";
import { encodeDatabaseValue } from "./database-value.js";

(() => {
  if (globalThis.__logicRecorderInstalled) return;
  globalThis.__logicRecorderInstalled = true;
  const abort = new AbortController();
  const MAX_INPUT_LENGTH = 10000;
  let stopped = false;
  let collectorClosed = false;
  let canvasMode = "pending";
  let canvasPendingSnapshot = false;
  let buffer = [];
  const captureSettings = (() => {
    let timeout;
    return Promise.race([
      chrome.runtime.sendMessage({ type: "CANVAS_OPTIONS" }),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 5000); }),
    ]).catch(() => null).then((result) => {
      clearTimeout(timeout);
      const settings = result?.ok && typeof result.value?.sessionId === "string" ? result.value : null;
      canvasMode = typeof settings?.enabled === "boolean"
        ? (settings.enabled ? "enabled" : "disabled") : "unavailable";
      if (canvasPendingSnapshot && !stopped) scheduleSnapshot("canvas-ready");
      return settings;
    });
  })();
  let overflowNoticeSent = false;
  let unresponsiveNoticeSent = false;
  const delivery = createEventDelivery(async (events, batchId) => {
    const settings = await captureSettings;
    if (!settings || collectorClosed) return { ok: false };
    return chrome.runtime.sendMessage({ type: "EVENTS", events, batchId, sessionId: settings.sessionId });
  }, {
    onOverflow: () => {
      if (overflowNoticeSent) return;
      overflowNoticeSent = true;
      captureSettings.then((settings) => {
        if (settings && !collectorClosed)
          return chrome.runtime.sendMessage({ type: "COLLECTOR_OVERFLOW", sessionId: settings.sessionId });
      }).catch(() => {});
    },
    onUnresponsive: () => {
      if (unresponsiveNoticeSent) return;
      unresponsiveNoticeSent = true;
      captureSettings.then((settings) => {
        if (settings && !collectorClosed)
          return chrome.runtime.sendMessage({ type: "COLLECTOR_UNRESPONSIVE", sessionId: settings.sessionId });
      }).catch(() => {});
    },
  });
  let timer;
  let snapshotTimer;
  let snapshotMaxTimer;
  let snapshotReason;
  let lastStorage = "";
  let nextNodeId = 0;
  const nodeIds = new WeakMap();
  const markedCopies = new WeakSet();
  const nodeId = (node) => {
    if (!nodeIds.has(node)) nodeIds.set(node, String(++nextNodeId));
    return nodeIds.get(node);
  };
  const cleanStored = (value, depth = 0, maxStringLength = 10000) => {
    if (depth > 12) return "[层级过深]";
    if (Array.isArray(value))
      return value.map((v) => cleanStored(v, depth + 1));
    if (value instanceof Date) return value.toISOString();
    if (
      value instanceof Blob ||
      value instanceof ArrayBuffer ||
      ArrayBuffer.isView(value)
    )
      return "[二进制内容未采集]";
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .slice(0, 200)
          .map(([k, v]) => [k, cleanStored(v, depth + 1)]),
      );
    if (typeof value === "string") {
      if (value.length > maxStringLength) return "[超过大小限制]";
      return value;
    }
    return value;
  };
  const send = () => {
    clearTimeout(timer);
    timer = null;
    if (!buffer.length) return delivery.flush();
    const events = buffer;
    buffer = [];
    return delivery.enqueue(events);
  };
  const emit = (kind, payload = {}, screenshot = false, time = Date.now()) => {
    if (stopped) return;
    buffer.push({ kind, payload, screenshot, time });
    if (buffer.length >= 25) send();
    else if (!timer) timer = setTimeout(send, 120);
  };
  const selector = (el) => {
    if (!(el instanceof Element)) return null;
    if (el.id) return `#${CSS.escape(el.id)}`;
    const path = [];
    for (let node = el; node && path.length < 6; node = node.parentElement) {
      let part = node.localName;
      const parent = node.parentElement || (node.parentNode instanceof ShadowRoot ? node.parentNode : null);
      if (parent)
        part += `:nth-of-type(${[...parent.children].filter((x) => x.localName === node.localName).indexOf(node) + 1})`;
      path.unshift(part);
    }
    return path.join(" > ");
  };
  // Keep this local so the injectable content script remains a standalone bundle.
  const readNumericConstraints = (el) => Object.fromEntries(["min", "max", "step"].map((name) => {
    const raw = el.getAttribute(name);
    if (typeof raw !== "string" || raw.length > 64) return [name, null];
    if (name === "step" && raw.toLowerCase() === "any") return [name, "any"];
    const valid = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(raw) &&
      Number.isFinite(Number(raw)) && (name !== "step" || Number(raw) > 0);
    return [name, valid ? raw : null];
  }));
  const describe = (el) => {
    if (!(el instanceof Element)) return {};
    const rect = el.getBoundingClientRect();
    const shadowPath = [];
    let current = el;
    while (current?.getRootNode() instanceof ShadowRoot && shadowPath.length < 20) {
      shadowPath.unshift(selector(current));
      current = current.getRootNode().host;
    }
    if (shadowPath.length) shadowPath.unshift(selector(current));
    const label =
      "labels" in el && el.labels
        ? [...el.labels]
            .slice(0, 10)
            .map((item) => (item.innerText || "").trim().slice(0, 160))
            .filter(Boolean)
            .join(" ")
            .slice(0, 160)
        : "";
    return {
      tag: el.localName,
      nodeId: nodeId(el),
      type: el.getAttribute("type"),
      ...(el instanceof HTMLInputElement && ["range", "number"].includes(el.type)
        ? { numericConstraints: readNumericConstraints(el) }
        : {}),
      editable: el instanceof HTMLElement && el.isContentEditable,
      role: el.getAttribute("role"),
      name: (
            el.getAttribute("aria-label") ||
            cleanStored(label) ||
            el.getAttribute("name") ||
            ""
          ).slice(0, 160),
      text: cleanStored((el.innerText || "").slice(0, 160)),
      selector: shadowPath.length ? null : selector(el),
      ...(shadowPath.length ? { shadowPath } : {}),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
  };
  function cleanInput(raw) {
    const limited = raw.slice(0, MAX_INPUT_LENGTH);
    return { value: limited, truncated: raw.length > limited.length };
  }
  const value = (el) => {
    if (el instanceof HTMLInputElement && el.type === "file")
      return { value: "[文件内容未采集]" };
    const raw = el instanceof HTMLElement && el.isContentEditable
      ? el.innerText : typeof el?.value === "string" ? el.value : null;
    if (raw === null) return { value: null };
    const { value: cleaned, truncated } = cleanInput(raw);
    return { value: cleaned, valueStatus: truncated ? "truncated" : "captured" };
  };
  const formState = (el, includeOptions = false) => {
    if (
      el instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(el.type)
    )
      return { checked: el.checked };
    if (el instanceof HTMLSelectElement) {
      const selected = [...el.options].flatMap((option, index) =>
        option.selected
          ? [{ index, value: cleanStored(option.value.slice(0, 4000)) }]
          : [],
      );
      return {
        selectedIndices: selected.slice(0, 200).map((item) => item.index),
        selectedValues: selected.slice(0, 200).map((item) => item.value),
        truncated: selected.length > 200,
        ...(includeOptions
          ? {
              multiple: el.multiple,
              options: [...el.options].slice(0, 200).map((option) => {
                const label = option.label.slice(0, 400), value = option.value.slice(0, 512);
                const cleanLabel = cleanStored(label), cleanValue = cleanStored(value);
                return {
                  id: nodeId(option), label: cleanLabel, value: cleanValue,
                  uncertain: option.label.length > label.length || option.value.length > value.length || cleanLabel !== label || cleanValue !== value,
                  disabled: option.disabled || !!option.closest("optgroup:disabled"),
                };
              }),
              optionsTruncated: el.options.length > 200,
            }
          : {}),
      };
    }
    return undefined;
  };
  function collectDom(limit = Infinity) {
    if (typeof chrome.dom?.openOrClosedShadowRoot !== "function")
      throw new Error("无法检查关闭式页面组件");
    const elements = [], roots = [document], shadows = [];
    let shadowRoots = 0;
    while (roots.length) {
      const root = roots.pop();
      for (const el of root.querySelectorAll("*")) {
        if (elements.length >= limit)
          return { elements, shadowRoots, shadows, truncated: true };
        elements.push(el);
        const shadow =
          el.shadowRoot ||
          (el instanceof HTMLElement
            ? chrome.dom.openOrClosedShadowRoot(el)
            : null);
        if (shadow) {
          shadowRoots++;
          shadows.push(shadow);
          roots.push(shadow);
        }
      }
    }
    return { elements, shadowRoots, shadows, truncated: false };
  }
  function markNodes(original, copy) {
    const pending = [[original, copy]];
    while (pending.length) {
      const [source, target] = pending.pop();
      if (source.nodeType === Node.ELEMENT_NODE) {
        target.setAttribute("data-logic-node", nodeId(source));
        markedCopies.add(target);
      }
      if (source.nodeType === Node.TEXT_NODE && target.parentNode)
        target.parentNode.insertBefore(
          document.createComment(`logic-text:${nodeId(source)}`),
          target,
        );
      if (source.nodeType === Node.COMMENT_NODE && target.parentNode) {
        target.parentNode.insertBefore(
          document.createComment(`logic-comment:${nodeId(source)}`),
          target,
        );
        if (/^logic-(text|comment):\d+$/.test(target.nodeValue || ""))
          target.nodeValue = `escaped:${target.nodeValue}`;
      }
      const originals = [...source.childNodes],
        copies = [...target.childNodes];
      for (let i = Math.min(originals.length, copies.length) - 1; i >= 0; i--)
        pending.push([originals[i], copies[i]]);
    }
  }
  function safeText(node, text) {
    return cleanStored(String(text || "").slice(0, 10000));
  }
  function safeAttribute(name, raw) {
    if (raw == null) return null;
    if (/^(src|href|action|formaction|poster)$/i.test(name)) {
      try {
        const url = new URL(raw, document.baseURI);
        if (!["http:", "https:"].includes(url.protocol)) return "[非网络地址]";
        return url.href;
      } catch {
        return "[不可读取]";
      }
    }
    return cleanStored(raw);
  }
  function safeImageUrl(raw) {
    const value = safeAttribute("src", raw);
    if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
    const url = new URL(value);
    url.hash = "";
    return url.href;
  }
  function describeNode(node, budget) {
    if (budget.count++ >= 200) {
      budget.truncated = true;
      return null;
    }
    if (node.nodeType === Node.TEXT_NODE)
      return {
        id: nodeId(node),
        type: "text",
        text: safeText(node, node.nodeValue),
      };
    if (node.nodeType === Node.COMMENT_NODE) {
      const text = cleanStored(node.nodeValue || "");
      return {
        id: nodeId(node),
        type: "comment",
        text: /^logic-(text|comment):\d+$/.test(text)
          ? `escaped:${text}`
          : text,
      };
    }
    if (
      node.nodeType !== Node.ELEMENT_NODE ||
      [
        "script",
        "noscript",
        "iframe",
        "object",
        "embed",
        "base",
        "meta",
        "link",
      ].includes(node.localName)
    )
      return null;
    const attrs = Object.create(null);
    for (const attr of [...node.attributes]) {
      if (node.localName === "img" && attr.name.toLowerCase() === "src") {
        const url = safeImageUrl(attr.value);
        if (url) attrs["data-logic-src"] = url;
      }
      if (
        /^on/i.test(attr.name) ||
        /^(src|srcset|href|action|formaction|data-logic-node|data-logic-src|data-logic-popover-open|data-logic-dialog-modal)$/i.test(
          attr.name,
        )
      )
        continue;
      if (attr.value.length > 10000) budget.truncated = true;
      attrs[attr.name] = cleanStored(attr.value);
    }
    if (
      node instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(node.type)
    ) {
      if (node.checked) attrs.checked = "";
      else delete attrs.checked;
    }
    if (node instanceof HTMLOptionElement) {
      if (node.selected) attrs.selected = "";
      else delete attrs.selected;
    }
    const children = [...node.childNodes]
      .map((child) => describeNode(child, budget))
      .filter(Boolean);
    return {
      id: nodeId(node),
      type: "element",
      tag: node.localName,
      attrs,
      children,
    };
  }
  function syncFormValue(source, copy) {
    if (!(source instanceof Element) || !(copy instanceof Element)) return;
    let truncated = false;
    if (source instanceof HTMLInputElement) {
      if (source.type !== "file") {
        truncated = source.value.length > MAX_INPUT_LENGTH;
        copy.setAttribute("value", source.value.slice(0, MAX_INPUT_LENGTH));
      }
      if (source.checked) copy.setAttribute("checked", "");
      else copy.removeAttribute("checked");
    } else if (source instanceof HTMLTextAreaElement) {
      truncated = source.value.length > MAX_INPUT_LENGTH;
      copy.textContent = source.value.slice(0, MAX_INPUT_LENGTH);
    }
    else if (source instanceof HTMLSelectElement)
      [...copy.options].forEach((option, index) => {
        if (source.options[index]?.selected) option.setAttribute("selected", "");
        else option.removeAttribute("selected");
      });
    return truncated;
  }
  function captureFontFaces(sheet, target, fontReferences) {
    const faces = [];
    let inspected = 0, truncated = false;
    const walk = (rules) => {
      for (const rule of rules) {
        if (++inspected > 2000 || faces.length >= 100) { truncated = true; return; }
        if (rule.type === CSSRule.FONT_FACE_RULE && rule.style) {
          const descriptors = {};
          for (const key of ["font-family", "font-style", "font-weight", "font-stretch", "font-display", "unicode-range"]) {
            const value = rule.style.getPropertyValue(key);
            if (value && value.length <= 500 && !/[{};<>\\\u0000-\u001f]/.test(value)) descriptors[key] = cleanStored(value);
          }
          const sources = [], src = rule.style.getPropertyValue("src");
          if (src.length > 10000) truncated = true;
          const sourceUrls = fontSourceUrls(src.slice(0, 10000));
          if (sourceUrls.length > 10) truncated = true;
          for (const raw of sourceUrls.slice(0, 10)) {
            try {
              const url = safeImageUrl(new URL(raw, sheet.href || document.baseURI).href);
              if (url) sources.push(url);
            } catch {}
          }
          if (descriptors["font-family"]) faces.push({ descriptors, sources });
        } else if (rule.cssRules) walk(rule.cssRules);
      }
    };
    try { walk(sheet.cssRules); } catch { return true; }
    if (faces.length) {
      const value = JSON.stringify(faces);
      if (value.length <= 10000) {
        target.setAttribute("data-logic-fonts", value);
        fontReferences.add(target);
      } else truncated = true;
    }
    return truncated;
  }
  function captureShadowSnapshots(original, clone, fontReferences, captureCanvas, capturePopover, captureDialog) {
    const result = { roots: 0, captured: 0, omitted: 0, stylesUnavailable: 0, truncated: false, scrollPositions: [] };
    const pending = [[original, clone, false]];
    let visited = 0, shadowNodes = 0;
    while (pending.length) {
      if (++visited > 20000) { result.truncated = true; break; }
      const [source, copy, inShadow] = pending.pop();
      if (!(source instanceof Element) || !(copy instanceof Element)) continue;
      if (source instanceof HTMLCanvasElement) captureCanvas(source);
      if (source.hasAttribute("popover")) capturePopover(source);
      if (source instanceof HTMLDialogElement) captureDialog(source);
      const sourceChildren = [...source.children], copyChildren = [...copy.children];
      for (let i = 0; i < Math.min(sourceChildren.length, copyChildren.length); i++)
        pending.push([sourceChildren[i], copyChildren[i], inShadow]);
      if (inShadow) {
        if (syncFormValue(source, copy)) result.formValuesTruncated = (result.formValuesTruncated || 0) + 1;
        if (source.localName === "style" && source.sheet && captureFontFaces(source.sheet, copy, fontReferences))
          result.stylesTruncated = true;
        if (source.scrollLeft || source.scrollTop)
          result.scrollPositions.push({ nodeId: nodeId(source), left: source.scrollLeft, top: source.scrollTop });
      }
      let root;
      try { root = source.shadowRoot || (source instanceof HTMLElement ? chrome.dom.openOrClosedShadowRoot(source) : null); }
      catch { result.unavailable = true; continue; }
      if (!root) continue;
      result.roots++;
      const count = root.querySelectorAll("*").length;
      if (result.captured >= 100 || shadowNodes + count > 10000) {
        result.omitted++;
        result.truncated = true;
        continue;
      }
      shadowNodes += count;
      const template = copy.ownerDocument.createElement("template");
      template.setAttribute("shadowrootmode", "open");
      template.setAttribute("data-logic-shadow-root", "");
      template.setAttribute("data-logic-node", nodeId(root));
      markedCopies.add(template);
      for (const child of root.childNodes) {
        const childCopy = copy.ownerDocument.importNode(child, true);
        template.content.appendChild(childCopy);
        markNodes(child, childCopy);
        if (child instanceof Element) pending.push([child, childCopy, true]);
      }
      try {
        for (const sheet of root.adoptedStyleSheets) {
          const css = [...sheet.cssRules].map((rule) => rule.cssText).join("\n");
          if (!css) continue;
          if (css.length > 500000) result.stylesTruncated = true;
          const style = copy.ownerDocument.createElement("style");
          style.textContent = css.replace(/url\s*\([^)]*\)/gi, "none").slice(0, 500000).replace(/<\/style/gi, "<\\2f style");
          if (captureFontFaces(sheet, style, fontReferences)) result.stylesTruncated = true;
          template.content.append(style);
        }
      } catch { result.stylesUnavailable++; }
      copy.prepend(template);
      result.captured++;
    }
    return result;
  }
  function snapshotRoots(root) {
    const roots = [root];
    for (let index = 0; index < roots.length; index++)
      for (const template of roots[index].querySelectorAll("template"))
        roots.push(template.content);
    return roots;
  }
  function snapshot(reason) {
    try {
      const canvas = { status: canvasMode === "enabled" ? "captured" : canvasMode, total: 0, captured: 0, omitted: 0, unavailable: 0, reasons: {}, geometryOmitted: 0, geometry: [], items: [] };
      const popover = { total: 0, open: [], omitted: 0, unavailable: 0 };
      const dialog = { total: 0, modal: [], omitted: 0, unavailable: 0 };
      const captureDialog = (source) => {
        dialog.total++;
        try {
          if (source.matches(":modal")) {
            if (dialog.modal.length < 100) dialog.modal.push(nodeId(source));
            else dialog.omitted++;
          }
        } catch { dialog.unavailable++; }
      };
      const capturePopover = (source) => {
        popover.total++;
        try {
          if (source.matches(":popover-open")) {
            if (popover.open.length < 100) popover.open.push(nodeId(source));
            else popover.omitted++;
          }
        } catch { popover.unavailable++; }
      };
      let canvasBytes = 0, canvasAttempts = 0, canvasDeadline;
      const canvasGap = (kind, reason) => {
        canvas[kind]++;
        canvas.reasons[reason] = (canvas.reasons[reason] || 0) + 1;
      };
      const captureCanvas = (source) => {
        canvas.total++;
        canvasDeadline ??= performance.now() + 100;
        if (canvas.geometry.length < 50 && performance.now() <= canvasDeadline) {
          try {
            const style = getComputedStyle(source);
            const dimension = (value) => /^\d{1,5}(?:\.\d{1,6})?px$/.test(value) ? value : null;
            const width = dimension(style.width), height = dimension(style.height);
            if (width === null || height === null) canvas.geometryOmitted++;
            else canvas.geometry.push({ nodeId: nodeId(source), width, height, inline: style.display === "inline" });
          } catch { canvas.geometryOmitted++; }
        } else canvas.geometryOmitted++;
        if (canvasMode !== "enabled") return;
        if (++canvasAttempts > 5) { canvasGap("omitted", "count_limit"); return; }
        if (performance.now() > canvasDeadline) { canvasGap("omitted", "time_limit"); return; }
        if (!source.width || !source.height) { canvasGap("omitted", "zero_size"); return; }
        if (source.width * source.height > 500000) { canvasGap("omitted", "pixel_limit"); return; }
        try {
          const captureStartedAt = Date.now();
          const data = source.toDataURL("image/png");
          const capturedAt = Date.now();
          if (!/^data:image\/png;base64,iVBORw0KGgo[A-Za-z0-9+/]*={0,2}$/.test(data)) { canvasGap("unavailable", "invalid_image"); return; }
          if (data.length > 150000) { canvasGap("omitted", "image_size_limit"); return; }
          if (canvasBytes + data.length > 400000) { canvasGap("omitted", "total_size_limit"); return; }
          canvasBytes += data.length;
          canvas.items.push({ nodeId: nodeId(source), data, pixelWidth: source.width,
            pixelHeight: source.height, captureStartedAt, capturedAt });
          canvas.captured++;
        } catch (error) { canvasGap("unavailable", error?.name === "SecurityError" ? "cross_origin" : "read_error"); }
      };
      let sourceHtml = null, sourceStatus = "captured", sourceLength = 0;
      try {
        const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
        const source = doctype + document.documentElement.outerHTML;
        sourceLength = source.length;
        if (sourceLength > 1500000) sourceStatus = "omitted_size";
        else sourceHtml = source;
      } catch {
        sourceStatus = "unavailable";
      }
      const inert = document.implementation.createHTMLDocument("");
      const clone = inert.importNode(document.documentElement, true);
      markNodes(document.documentElement, clone);
      const fontReferences = new WeakSet();
      const shadow = captureShadowSnapshots(document.documentElement, clone, fontReferences, captureCanvas, capturePopover, captureDialog);
      if (shadow.truncated) canvas.scanTruncated = true;
      if (shadow.truncated) popover.scanTruncated = true;
      if (shadow.truncated) dialog.scanTruncated = true;
      if (canvasMode === "pending" && canvas.total) canvasPendingSnapshot = true;
      clone.removeAttribute("data-logic-background");
      clone
        .querySelectorAll("[data-logic-background]")
        .forEach((element) => element.removeAttribute("data-logic-background"));
      const backgroundSources = [
        document.documentElement,
        ...document.documentElement.querySelectorAll("*"),
      ];
      const backgroundCopies = new Map(
        [clone, ...clone.querySelectorAll("[data-logic-node]")].map((node) => [node.getAttribute("data-logic-node"), node]),
      );
      const scrollPositions = [];
      let scrollTruncated = backgroundSources.length > 10000;
      for (const element of backgroundSources.slice(0, 10000)) {
        if (element === document.documentElement || element === document.body)
          continue;
        if (element.scrollLeft || element.scrollTop) {
          if (scrollPositions.length >= 200) {
            scrollTruncated = true;
            break;
          }
          scrollPositions.push({
            nodeId: nodeId(element),
            left: element.scrollLeft,
            top: element.scrollTop,
          });
        }
      }
      for (const item of shadow.scrollPositions) {
        if (scrollPositions.length >= 200) { scrollTruncated = true; break; }
        scrollPositions.push(item);
      }
      delete shadow.scrollPositions;
      let backgroundUnavailable = 0;
      for (let i = 0; i < Math.min(backgroundSources.length, 2000); i++) {
        try {
          const raw = getComputedStyle(backgroundSources[i]).backgroundImage;
          if (!raw.toLowerCase().startsWith("url(")) continue;
          const parsed = singleBackgroundUrl(raw);
          const url = parsed && safeImageUrl(parsed);
          if (url)
            backgroundCopies.get(nodeId(backgroundSources[i]))?.setAttribute("data-logic-background", url);
        } catch {
          backgroundUnavailable++;
        }
      }
      const originals = document.documentElement.querySelectorAll(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      );
      const copies = clone.querySelectorAll(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
      );
      let formValuesTruncated = shadow.formValuesTruncated || 0;
      delete shadow.formValuesTruncated;
      originals.forEach((el, i) => {
        const copy = copies[i];
        if (!copy) return;
        if (syncFormValue(el, copy)) formValuesTruncated++;
      });
      const stylesheetReferences = new WeakSet();
      const styleSources = document.documentElement.querySelectorAll("style, link[rel]");
      const styleCopies = clone.querySelectorAll("style, link[rel]");
      let stylesCaptured = 0, stylesUnavailable = 0, stylesTruncated = false;
      const inlineCss = (css) => {
        if (css.length > 500000) stylesTruncated = true;
        return css.replace(/url\s*\([^)]*\)/gi, "none").slice(0, 500000).replace(/<\/style/gi, "<\\2f style");
      };
      styleSources.forEach((source, index) => {
        const copy = styleCopies[index];
        if (!copy || (source.localName === "link" && !source.relList.contains("stylesheet"))) return;
        if (source.disabled || source.sheet?.disabled) { copy.remove(); return; }
        const replacement = clone.ownerDocument.createElement("style");
        if (copy.hasAttribute("data-logic-node")) {
          replacement.setAttribute("data-logic-node", copy.getAttribute("data-logic-node"));
          markedCopies.add(replacement);
        }
        if (source.media) replacement.setAttribute("media", source.media);
        try {
          if (!source.sheet) throw new Error("样式表尚未加载");
          replacement.textContent = inlineCss([...source.sheet.cssRules].map((rule) => rule.cssText).join("\n"));
          if (captureFontFaces(source.sheet, replacement, fontReferences)) stylesTruncated = true;
          stylesCaptured++;
        } catch {
          stylesUnavailable++;
          const url = source.localName === "link" ? safeImageUrl(source.href) : null;
          if (url) {
            replacement.setAttribute("data-logic-stylesheet", url);
            stylesheetReferences.add(replacement);
          } else if (source.localName === "style") replacement.textContent = inlineCss(source.textContent || "");
        }
        copy.replaceWith(replacement);
      });
      try {
        for (const sheet of document.adoptedStyleSheets || []) {
          if (sheet.disabled) continue;
          const style = clone.ownerDocument.createElement("style");
          style.textContent = inlineCss([...sheet.cssRules].map((rule) => rule.cssText).join("\n"));
          if (captureFontFaces(sheet, style, fontReferences)) stylesTruncated = true;
          clone.querySelector("head")?.appendChild(style);
          stylesCaptured++;
        }
      } catch { stylesUnavailable++; }
      const roots = snapshotRoots(clone);
      for (const root of roots) root
        .querySelectorAll(
          "script, noscript, iframe, object, embed, base, meta, link",
        )
        .forEach((el) => el.remove());
      let truncatedNodes = formValuesTruncated;
      for (const root of roots) root.querySelectorAll("*").forEach((el) => {
        if (el.matches('input[type="file"]')) el.removeAttribute("value");
        for (const attribute of [...el.attributes]) {
          if (attribute.name === "data-logic-fonts") {
            if (!fontReferences.has(el)) el.removeAttribute(attribute.name);
            continue;
          }
          if (attribute.name === "data-logic-stylesheet") {
            if (!stylesheetReferences.has(el)) el.removeAttribute(attribute.name);
            continue;
          }
          if (attribute.name === "data-logic-node" && !markedCopies.has(el)) {
            el.removeAttribute(attribute.name);
            continue;
          }
          if (["data-logic-popover-open", "data-logic-dialog-modal"].includes(attribute.name.toLowerCase())) {
            el.removeAttribute(attribute.name);
            continue;
          }
          if (
            attribute.name.toLowerCase() === "src" &&
            el.localName === "img"
          ) {
            const url = safeImageUrl(attribute.value);
            if (url) el.setAttribute("data-logic-src", url);
          }
          if (
            /^on/i.test(attribute.name) ||
            /^(src|srcset|href|action|formaction)$/i.test(attribute.name)
          )
            el.removeAttribute(attribute.name);
          else if (attribute.name.toLowerCase() === "poster")
            el.setAttribute(attribute.name, safeAttribute(attribute.name, attribute.value));
          else {
            const cleaned = cleanStored(attribute.value);
            if (attribute.value.length > 10000 || cleaned.length > 10000) truncatedNodes++;
            el.setAttribute(attribute.name, cleaned.slice(0, 10000));
          }
        }
      });
      for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const original = walker.currentNode.nodeValue;
        const isStyle = walker.currentNode.parentElement?.localName === "style";
        const limit = 500000;
        const cleaned = cleanStored(original.slice(0, limit), 0, limit);
        if (original.length > limit || cleaned.length > limit) {
          truncatedNodes++;
          if (isStyle) {
            if (root === clone) stylesTruncated = true;
            else shadow.stylesTruncated = true;
          }
        }
        const limited = cleaned.slice(0, limit);
        walker.currentNode.nodeValue = isStyle
          ? limited.replace(/<\/style/gi, "<\\2f style")
          : limited;
      }
      const comments = document.createTreeWalker(
        root,
        NodeFilter.SHOW_COMMENT,
      );
      while (comments.nextNode())
        comments.currentNode.nodeValue = cleanStored(
          comments.currentNode.nodeValue,
        );
      }
      let html = "<!doctype html>" + clone.outerHTML;
      const truncated = html.length > 1500000;
      if (truncated) html = "";
      emit("page.snapshot", {
        reason,
        url: location.href,
        title: document.title,
        html,
        sourceHtml,
        sourceStatus,
        sourceLength,
        status: truncated
          ? "omitted_size"
          : truncatedNodes
            ? "truncated"
            : "captured",
        truncatedNodes,
        scroll: { positions: scrollPositions, truncated: scrollTruncated },
        shadow,
        canvas,
        popover,
        dialog,
        styles: {
          captured: stylesCaptured,
          unavailable: stylesUnavailable,
          truncated: stylesTruncated,
          backgroundUnavailable,
          backgroundTruncated: backgroundSources.length > 2000,
        },
        viewport: {
          width: innerWidth,
          height: innerHeight,
          scrollX,
          scrollY,
          dpr: devicePixelRatio,
        },
      });
    } catch (error) {
      emit("page.snapshot", { reason, status: "failed", error: String(error) });
    }
  }
  function scheduleSnapshot(reason) {
    snapshotReason = reason;
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(flushScheduledSnapshot, 500);
    if (!snapshotMaxTimer)
      snapshotMaxTimer = setTimeout(flushScheduledSnapshot, 2000);
  }
  function cancelScheduledSnapshot() {
    clearTimeout(snapshotTimer);
    clearTimeout(snapshotMaxTimer);
    snapshotTimer = null;
    snapshotMaxTimer = null;
    snapshotReason = null;
  }
  function flushScheduledSnapshot() {
    const reason = snapshotReason;
    cancelScheduledSnapshot();
    if (reason) snapshot(reason);
  }
  const registeredRoots = new WeakSet();
  const observedRoots = new WeakSet();
  const observerOptions = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeOldValue: true,
    characterData: true,
    characterDataOldValue: true,
  };
  let observer;
  const shadowHandlers = [];
  const handledEvents = new WeakSet();
  const deferredEvents = new Map();
  let shadowTimer;
  function flushDeferredEvents() {
    for (const item of [...deferredEvents.values()]) item.record();
  }
  function cancelDeferredEvents() {
    for (const item of deferredEvents.values()) clearTimeout(item.timer);
    deferredEvents.clear();
  }
  function rootFor(element) {
    if (!(element instanceof Element)) return null;
    try {
      return element.shadowRoot ||
        (element instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot?.(element) : null);
    } catch {
      return null;
    }
  }
  function listenOn(root, type, handler) {
    root.addEventListener(type, (event) => {
      if (handledEvents.has(event)) return;
      const target = event.target;
      const time = Date.now();
      const record = () => {
        const pending = deferredEvents.get(event);
        if (pending) clearTimeout(pending.timer);
        deferredEvents.delete(event);
        if (handledEvents.has(event)) return;
        handledEvents.add(event);
        handler(event, target, time);
      };
      const nested = rootFor(target);
      if (nested && !registeredRoots.has(nested)) refreshShadowListeners();
      if (nested && registeredRoots.has(nested)) {
        const previous = deferredEvents.get(event);
        if (previous) clearTimeout(previous.timer);
        deferredEvents.set(event, { record, timer: setTimeout(record, 0) });
      } else record();
    }, { capture: true, signal: abort.signal });
  }
  function recordOnRoots(type, handler) {
    shadowHandlers.push({ type, handler });
    listenOn(document, type, handler);
  }
  function refreshShadowListeners() {
    if (stopped) return;
    try {
      for (const root of collectDom().shadows) {
        if (observer && !observedRoots.has(root)) {
          observer.observe(root, observerOptions);
          observedRoots.add(root);
        }
        if (registeredRoots.has(root)) continue;
        registeredRoots.add(root);
        for (const type of ["pointerdown", "focusin"]) {
          root.addEventListener(type, (event) => {
            const nested = rootFor(event.target);
            if (nested && !registeredRoots.has(nested)) refreshShadowListeners();
          }, { capture: true, signal: abort.signal });
        }
        for (const { type, handler } of shadowHandlers) listenOn(root, type, handler);
      }
    } catch {
      // Snapshot and screenshot reports record unavailable component access.
    }
  }
  for (const type of ["pointerdown", "focusin", "keydown", "click", "input", "change", "submit"]) {
    document.addEventListener(type, (event) => {
      const root = rootFor(event.target);
      if (root && !registeredRoots.has(root)) refreshShadowListeners();
    }, { capture: true, signal: abort.signal });
  }
  const choiceBefore = new WeakMap();
  function rememberChoice(target, time) {
    if (!(target instanceof Element)) return;
    choiceBefore.delete(target);
    const state = formState(target, true);
    if (state && !state.truncated && !state.optionsTruncated)
      choiceBefore.set(target, { state, time });
  }
  for (const type of ["click", "dblclick", "contextmenu", "change", "submit"]) {
    recordOnRoots(
      type,
      (event, target, time) => {
        if (type === "click" && !event.isTrusted && target instanceof Element)
          choiceBefore.delete(target);
        const previous = type === "change" && target instanceof Element ? choiceBefore.get(target) : null;
        if (type === "change" && target instanceof Element) choiceBefore.delete(target);
        const beforeFormState = event.isTrusted && previous &&
          time >= previous.time && time - previous.time <= 2000 ? previous.state : undefined;
        const files =
          target instanceof HTMLInputElement &&
          target.type === "file"
            ? [...(target.files || [])].slice(0, 20).map((file) => ({
                name: file.name,
                size: file.size,
                type: file.type,
                content: "未采集",
              }))
            : undefined;
        emit(
          `interaction.${type}`,
          {
            url: location.href,
            target: describe(target),
            viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
            ...value(target),
            formState: formState(target, type === "change"),
            ...(beforeFormState ? { beforeFormState } : {}),
            files,
            trusted: event.isTrusted,
            x: event.clientX,
            y: event.clientY,
          },
          true, time,
        );
        scheduleSnapshot(type);
      },
    );
  }
  const inputBefore = new WeakMap();
  recordOnRoots("beforeinput", (event, target, time) => {
    if (!(target instanceof Element)) return;
    inputBefore.delete(target);
    if (!event.isTrusted) return;
    const raw = target instanceof HTMLElement && target.isContentEditable
      ? target.innerText : typeof target.value === "string" ? target.value : null;
    if (typeof raw !== "string") return;
    const { value: previous, truncated } = cleanInput(raw);
    inputBefore.set(target, { value: previous, time, inputType: event.inputType,
      truncated });
  });
  recordOnRoots(
    "input",
    (event, target, time) => {
      const previous = target instanceof Element ? inputBefore.get(target) : null;
      if (target instanceof Element) inputBefore.delete(target);
      const beforeValue = event.isTrusted && previous && time >= previous.time &&
        time - previous.time <= 2000 && previous.inputType === event.inputType
        ? previous.value : undefined;
      emit(
        "interaction.input",
        {
          url: location.href,
          target: describe(target),
          viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
          ...value(target),
          ...(beforeValue !== undefined ? { beforeValue,
            beforeValueStatus: previous.truncated ? "truncated" : "captured" } : {}),
          formState: formState(target, true),
          inputType: event.inputType,
          composing: event.isComposing,
        },
        true, time,
      );
      scheduleSnapshot("input");
    },
  );
  recordOnRoots(
    "keydown",
    (event, element, time) => {
      if (event.isTrusted && typeof event.key === "string" && !event.ctrlKey && !event.metaKey && !event.altKey &&
          ((element instanceof HTMLSelectElement && (event.key.length === 1 || /^(ArrowUp|ArrowDown|Home|End|PageUp|PageDown)$/.test(event.key))) ||
           (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type) && /^( |ArrowUp|ArrowDown|ArrowLeft|ArrowRight)$/.test(event.key))))
        rememberChoice(element, time);
      emit(
        "interaction.keydown",
        {
          url: location.href,
          target: describe(element),
          key: event.key || "",
          alt: event.altKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey,
        },
        true, time,
      );
    },
  );
  let lastMove = 0;
  for (const type of [
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerover",
    "pointercancel",
    "focusin",
    "focusout",
    "dragstart",
    "drop",
    "paste",
    "copy",
    "cut",
    "compositionstart",
    "compositionend",
    "keyup",
  ]) {
    recordOnRoots(
      type,
      (event, target, time) => {
        if (type === "pointerdown" && event.isTrusted && event.button === 0)
          rememberChoice(target, time);
        if (type === "pointermove") {
          if (Date.now() - lastMove < 250) return;
          lastMove = Date.now();
        }
        const files =
          type === "drop"
            ? [...(event.dataTransfer?.files || [])]
                .slice(0, 20)
                .map((file) => ({
                  name: file.name,
                  size: file.size,
                  type: file.type,
                  content: "未采集",
                }))
            : undefined;
        emit(
          `interaction.${type}`,
          {
            url: location.href,
            target: describe(target),
            viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
            x: event.clientX,
            y: event.clientY,
            ...(type === "keyup" && typeof event.key === "string"
              ? { key: event.key,
                  alt: event.altKey, ctrl: event.ctrlKey, meta: event.metaKey, shift: event.shiftKey }
              : {}),
            files,
            trusted: event.isTrusted,
            sampled: type === "pointermove",
          },
          true, time,
        );
      },
    );
  }
  const pendingScrolls = new Map();
  function flushScroll(target) {
    const pending = pendingScrolls.get(target);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingScrolls.delete(target);
    emit("interaction.scroll", pending.payload, true, pending.time);
  }
  function flushScrolls() {
    for (const target of pendingScrolls.keys()) flushScroll(target);
  }
  function cancelScrolls() {
    for (const item of pendingScrolls.values()) clearTimeout(item.timer);
    pendingScrolls.clear();
  }
  recordOnRoots(
    "scroll",
    (_event, target, time) => {
      const element = target instanceof Element ? target : null;
      const previous = pendingScrolls.get(target);
      if (previous) clearTimeout(previous.timer);
      pendingScrolls.set(target, {
        time,
        payload: {
          url: location.href,
          target: describe(target),
          targetScope: element ? "element" : "document",
          targetNodeId: element ? nodeId(element) : undefined,
          x: scrollX,
          y: scrollY,
          scrollLeft: element ? element.scrollLeft : scrollX,
          scrollTop: element ? element.scrollTop : scrollY,
          ...(element
            ? {
                scrollWidth: element.scrollWidth,
                scrollHeight: element.scrollHeight,
                clientWidth: element.clientWidth,
                clientHeight: element.clientHeight,
              }
            : {}),
        },
        timer: setTimeout(() => flushScroll(target), 180),
      });
    },
  );
  recordOnRoots("toggle", (_event, target, time) => {
    if (!(target instanceof HTMLElement) || !target.hasAttribute("popover")) return;
    try {
      emit("page.popover", { url: location.href, targetNodeId: nodeId(target), open: target.matches(":popover-open") }, false, time);
    } catch {
      emit("page.popover", { url: location.href, targetNodeId: nodeId(target), status: "unavailable" }, false, time);
    }
    scheduleSnapshot("popover");
  });
  refreshShadowListeners();
  window.addEventListener(
    "hashchange",
    () => {
      emit("navigation.hash", { url: location.href });
      scheduleSnapshot("hashchange");
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "popstate",
    () => {
      emit("navigation.popstate", { url: location.href });
      scheduleSnapshot("popstate");
    },
    { signal: abort.signal },
  );
  window.addEventListener(
    "pagehide",
    (event) => {
      flushDeferredEvents();
      flushScrolls();
      captureStorage("pagehide");
      const records = observer?.takeRecords() || [];
      if (records.length) processMutations(records);
      if (snapshotTimer || snapshotMaxTimer) {
        cancelScheduledSnapshot();
        snapshot("pagehide");
      }
      emit("page.lifecycle", {
        url: location.href,
        type: "pagehide",
        persisted: event.persisted,
      });
      send();
    },
    { signal: abort.signal },
  );
  function processMutations(records) {
    if (records.some((record) => record.type === "childList" && record.addedNodes.length)) {
      clearTimeout(shadowTimer);
      shadowTimer = setTimeout(refreshShadowListeners, 100);
    }
    const dialogs = new Set(), changes = [],
      budget = { count: 0, truncated: false };
    for (let index = 0; index < Math.min(records.length, 200); index++) {
      const record = records[index];
      const targetElement =
        record.target.nodeType === Node.ELEMENT_NODE
          ? record.target
          : record.target.parentElement;
      if (
        targetElement?.closest(
          "script, noscript, iframe, object, embed, base, meta, link",
        )
      )
        continue;
      if (record.type === "attributes") {
        const name = record.attributeName || "";
        if (name === "open" && record.target instanceof HTMLDialogElement) dialogs.add(record.target);
        if (/^on/i.test(name)) continue;
        const next = records
          .slice(index + 1)
          .find(
            (item) =>
              item.type === "attributes" &&
              item.target === record.target &&
              item.attributeName === name,
          );
        const current = next ? next.oldValue : record.target.getAttribute(name);
        if (
          (record.oldValue?.length || 0) > 10000 ||
          (current?.length || 0) > 10000
        )
          budget.truncated = true;
        changes.push({
          type: "attribute",
          id: nodeId(record.target),
          name,
          before: record.target.localName === "img" && name === "src"
              ? safeImageUrl(record.oldValue)
              : safeAttribute(name, record.oldValue),
          value: record.target.localName === "img" && name === "src"
              ? safeImageUrl(current)
              : safeAttribute(name, current),
        });
      } else if (record.type === "characterData") {
        const next = records
          .slice(index + 1)
          .find(
            (item) =>
              item.type === "characterData" && item.target === record.target,
          );
        const current = next ? next.oldValue : record.target.nodeValue;
        if (
          (record.oldValue?.length || 0) > 10000 ||
          (current?.length || 0) > 10000
        )
          budget.truncated = true;
        changes.push({
          type: "text",
          id: nodeId(record.target),
          before: safeText(record.target, record.oldValue),
          value: safeText(record.target, current),
        });
      } else if (record.type === "childList") {
        const included = (node) =>
          node.nodeType !== Node.ELEMENT_NODE ||
          ![
            "script",
            "noscript",
            "iframe",
            "object",
            "embed",
            "base",
            "meta",
            "link",
          ].includes(node.localName);
        let next = record.nextSibling;
        while (next && !included(next)) next = next.nextSibling;
        changes.push({
          type: "children",
          id: nodeId(record.target),
          removed: [...record.removedNodes].filter(included).map(nodeId),
          added: [...record.addedNodes]
            .map((node) => describeNode(node, budget))
            .filter(Boolean),
          next: next ? nodeId(next) : null,
        });
      }
    }
    if (changes.length)
      emit("page.mutation", {
        url: location.href,
        changes,
        status:
          records.length > 200 || budget.truncated ? "truncated" : "captured",
      });
    for (const target of dialogs) {
      try {
        emit("page.dialog", { url: location.href, targetNodeId: nodeId(target), open: target.open,
          modal: target.matches(":modal") });
      } catch {
        emit("page.dialog", { url: location.href, targetNodeId: nodeId(target), status: "unavailable" });
      }
    }
    scheduleSnapshot("mutation");
  }
  observer = new MutationObserver(processMutations);
  observer.observe(document, observerOptions);
  refreshShadowListeners();
  function captureStorage(reason = "poll") {
    const stores = {}, coverage = {}, specialEntries = [];
    for (const name of ["localStorage", "sessionStorage"]) {
      try {
        const store = window[name], entries = Object.create(null);
        const total = store.length;
        let oversizedValues = 0;
        for (let i = 0; i < total && i < 200; i++) {
          const key = store.key(i);
          if (key === null) continue;
          const raw = store.getItem(key);
          if (raw?.length > 4000) oversizedValues++;
          entries[key] = raw?.length > 4000 ? "[超过大小限制]" : raw;
          if (key === "__proto__")
            specialEntries.push({ storage: name, key, value: entries[key] });
        }
        stores[name] = entries;
        const captured = Object.keys(entries).length;
        const omittedKeys = Math.max(0, total - captured);
        coverage[name] = {
          status: omittedKeys || oversizedValues ? "partial" : "captured",
          total,
          captured,
          omittedKeys,
          oversizedValues,
        };
      } catch {
        coverage[name] = { status: "unavailable" };
      }
    }
    const json = JSON.stringify({ stores, coverage, specialEntries });
    if (json !== lastStorage) {
      lastStorage = json;
      emit("storage.snapshot", {
        url: location.href,
        stores,
        coverage,
        specialEntries,
        method: reason,
        intervalMs: 1000,
      });
    }
  }
  captureStorage();
  const storageTimer = setInterval(captureStorage, 1000);
  async function captureDatabases(reason) {
    if (!indexedDB.databases) {
      emit("database.snapshot", { reason, status: "unavailable" });
      return;
    }
    try {
      let remainingRecords = 500,
        remainingChars = 2000000;
      const databases = await indexedDB.databases();
      for (const info of databases.slice(0, 20)) {
        if (!info.name) continue;
        const result = await new Promise((resolve) => {
          let settled = false;
          const finish = (value) => {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve(value);
            }
          };
          const timeout = setTimeout(
            () => finish({ name: info.name, status: "timeout" }),
            2500,
          );
          const request = indexedDB.open(info.name);
          request.onupgradeneeded = () => request.transaction.abort();
          request.onerror = () =>
            finish({ name: info.name, status: "unavailable" });
          request.onblocked = () =>
            finish({ name: info.name, status: "blocked" });
          request.onsuccess = () => {
            const db = request.result;
            if (settled) {
              db.close();
              return;
            }
            db.onversionchange = () => db.close();
            const names = [...db.objectStoreNames].slice(0, 30),
              stores = [];
            if (!names.length) {
              db.close();
              finish({
                name: info.name,
                version: db.version,
                stores,
                status: "captured",
              });
              return;
            }
            try {
              const tx = db.transaction(names, "readonly");
              for (const name of names) {
                const store = tx.objectStore(name),
                  entry = {
                    name,
                    keyPath: store.keyPath,
                    indexes: [...store.indexNames],
                    records: [],
                    truncated: false,
                  };
                stores.push(entry);
                const cursor = store.openCursor();
                cursor.onsuccess = () => {
                  const row = cursor.result;
                  if (!row) return;
                  if (
                    entry.records.length >= 100 ||
                    remainingRecords <= 0 ||
                    remainingChars <= 0
                  ) {
                    entry.truncated = true;
                    return;
                  }
                  try {
                    const encodedKey = encodeDatabaseValue(row.key, cleanStored);
                    const encoded = encodeDatabaseValue(row.value, cleanStored);
                    const serialized = JSON.stringify(encoded.value);
                    const tooLarge =
                      serialized?.length > 10000 ||
                      serialized?.length > remainingChars;
                    const safe = tooLarge ? "[超过大小限制]" : encoded.value;
                    const issues = [...new Set([
                      ...encodedKey.issues,
                      ...encoded.issues,
                      ...(tooLarge ? ["value_size_limit"] : []),
                    ])];
                    if (issues.length) entry.truncated = true;
                    entry.records.push({
                      key: encodedKey.value,
                      value: safe,
                      ...(issues.length ? { issues } : {}),
                    });
                    remainingRecords--;
                    remainingChars -=
                      !tooLarge ? serialized?.length || 0 : 0;
                  } catch {
                    entry.truncated = true;
                    remainingRecords--;
                    entry.records.push({
                      key: "[不可读取]",
                      value: "[不可读取]",
                      issues: ["unavailable"],
                    });
                  }
                  row.continue();
                };
              }
              tx.oncomplete = () => {
                db.close();
                finish({
                  name: info.name,
                  version: db.version,
                  stores,
                  status: "captured",
                  storesTruncated: db.objectStoreNames.length > names.length,
                });
              };
              tx.onerror = tx.onabort = () => {
                db.close();
                finish({ name: info.name, status: "failed" });
              };
            } catch {
              db.close();
              finish({ name: info.name, status: "failed" });
            }
          };
        });
        emit("database.snapshot", {
          reason,
          database: result,
          url: location.href,
        });
      }
      if (databases.length > 20)
        emit("database.snapshot", {
          reason,
          status: "truncated",
          total: databases.length,
        });
    } catch (error) {
      emit("database.snapshot", {
        reason,
        status: "failed",
        error: String(error),
      });
    }
  }
  async function captureCache(reason) {
    const deadline = Date.now() + 2500;
    const withinDeadline = (promise) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("缓存采集超时")), Math.max(0, deadline - Date.now()));
        }),
      ]).finally(() => clearTimeout(timer));
    };
    try {
      const names = await withinDeadline(caches.keys());
      let remaining = 300;
      for (const name of names.slice(0, 20)) {
        const safeName = cleanStored(name);
        const nameStatus = name.length > 10000 ? "omitted_size" : "captured";
        if (remaining <= 0) {
          emit("cache.snapshot", { reason, name: safeName, status: "omitted_limit" });
          continue;
        }
        try {
          if (Date.now() >= deadline) throw new Error("缓存采集超时");
          if (!await withinDeadline(caches.has(name)))
            throw new Error("缓存已不存在");
          const cache = await withinDeadline(caches.open(name));
          const requests = await withinDeadline(cache.keys());
          let unavailableUrls = 0;
          const entries = requests.slice(0, Math.min(50, remaining)).map((request) => {
            const url = request.url.length <= 10000 ? safeAttribute("src", request.url) : null;
            const urlStatus = request.url.length > 10000 ? "omitted_size"
              : typeof url === "string" && /^https?:\/\//i.test(url) ? "captured" : "unavailable";
            if (urlStatus !== "captured") unavailableUrls++;
            return { url: urlStatus === "captured" ? url : null, urlStatus,
              method: cleanStored(request.method), mode: request.mode };
          });
          remaining -= entries.length;
          emit("cache.snapshot", {
            reason,
            name: safeName,
            nameStatus,
            status: "metadata_only",
            total: requests.length,
            entries,
            omitted: Math.max(0, requests.length - entries.length),
            unavailableUrls,
            truncated: requests.length > entries.length || unavailableUrls > 0 || nameStatus === "omitted_size",
            note: "缓存请求头及响应内容未采集",
          });
        } catch (error) {
          const timedOut = Date.now() >= deadline;
          emit("cache.snapshot", {
            reason, name: safeName, status: timedOut ? "timeout" : "unavailable",
            error: cleanStored(String(error).slice(0, 10000)),
          });
          if (timedOut) break;
        }
      }
      if (names.length > 20)
        emit("cache.snapshot", {
          reason,
          status: "truncated",
          total: names.length,
        });
    } catch (error) {
      emit("cache.snapshot", {
        reason,
        status: Date.now() >= deadline ? "timeout" : "unavailable",
        error: cleanStored(String(error).slice(0, 10000)),
      });
    }
  }
  function beginStateCapture(source, reason, run) {
    const capture = { source, reason, status: "pending" };
    capture.promise = Promise.resolve().then(run).then(
      () => finishStateCapture(capture, "completed"),
      () => finishStateCapture(capture, "failed"),
    );
    return capture;
  }
  function finishStateCapture(capture, status) {
    if (capture.status !== "pending") return;
    capture.status = status;
    emit("state.capture", { source: capture.source, reason: capture.reason, status });
  }
  const initialCaptures = [
    beginStateCapture("database", "initial", () => captureDatabases("initial")),
    beginStateCapture("cache", "initial", () => captureCache("initial")),
  ];
  const onMessage = (msg, _sender, reply) => {
    if (msg.type === "VIEWPORT_INFO") {
      reply({ url: location.href, viewport: { width: innerWidth, height: innerHeight,
        dpr: devicePixelRatio, scrollX, scrollY, scale: visualViewport?.scale || 1,
        offsetX: visualViewport?.offsetLeft || 0, offsetY: visualViewport?.offsetTop || 0 } });
    }
    if (msg.type === "FLUSH") {
      clearTimeout(shadowTimer);
      flushDeferredEvents();
      flushScrolls();
      const records = observer.takeRecords();
      if (records.length) processMutations(records);
      cancelScheduledSnapshot();
      captureStorage("stop");
      snapshot("stop");
      abort.abort();
      observer.disconnect();
      clearInterval(storageTimer);
      const captures = [
        ...initialCaptures,
        beginStateCapture("database", "stop", () => captureDatabases("stop")),
        beginStateCapture("cache", "stop", () => captureCache("stop")),
      ];
      const snapshots = Promise.all(captures.map((capture) => capture.promise));
      let timeout;
      Promise.race([
        snapshots.then(() => false),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(true), 4000); }),
      ])
        .then((timedOut) => {
          clearTimeout(timeout);
          if (timedOut) for (const capture of captures) finishStateCapture(capture, "timeout");
          stopped = true;
          return send();
        })
        .then(() =>
          reply({
            ok: delivery.failedEvents === 0,
            failedEvents: delivery.failedEvents,
          }),
        );
      return true;
    }
    if (msg.type === "SNAPSHOT") {
      snapshot("route");
      send().then(() => reply({ ok: true }));
      return true;
    }
    if (msg.type === "STOP_CAPTURE") {
      clearTimeout(shadowTimer);
      cancelDeferredEvents();
      collectorClosed = true;
      stopped = true;
      abort.abort();
      observer.disconnect();
      clearInterval(storageTimer);
      clearTimeout(timer);
      cancelScheduledSnapshot();
      cancelScrolls();
      chrome.runtime.onMessage.removeListener(onMessage);
      delete globalThis.__logicRecorderInstalled;
      reply({ ok: true });
    }
  };
  chrome.runtime.onMessage.addListener(onMessage);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => snapshot("initial"), {
      once: true,
      signal: abort.signal,
    });
  else snapshot("initial");
})();
