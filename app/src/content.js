import { createEventDelivery } from "./delivery.js";
import { singleBackgroundUrl, fontSourceUrls } from "./background-style.js";
import { encodeDatabaseValue } from "./database-value.js";
import { FRAGMENT_LENGTH, fragmentReference } from "./fragment-writer.js";
import { encodeDatabaseGraph } from "./database-graph.js";
import { packComputedEntries } from "./computed-style-encoder.js";

(async () => {
  if (!["http:", "https:"].includes(location.protocol)) return;
  const previous = globalThis.__logicRecorderInstalled;
  if (previous && !(typeof previous.releaseStopped === "function" && previous.releaseStopped())) {
    let timeout;
    const settings = await Promise.race([
      Promise.resolve().then(() => chrome.runtime.sendMessage({ type: "CANVAS_OPTIONS" })).catch(() => null),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 5000); }),
    ]);
    clearTimeout(timeout);
    if (!settings?.ok || !settings.value?.sessionId || typeof previous.sessionId !== "function" ||
        typeof previous.shutdown !== "function") return;
    let previousId;
    try { previousId = await previous.sessionId(); } catch { return; }
    if (globalThis.__logicRecorderInstalled !== previous || previousId === settings.value.sessionId) return;
    let validationTimeout;
    const current = await Promise.race([
      Promise.resolve().then(() => chrome.runtime.sendMessage({ type: "CANVAS_OPTIONS" })).catch(() => null),
      new Promise((resolve) => { validationTimeout = setTimeout(() => resolve(null), 5000); }),
    ]);
    clearTimeout(validationTimeout);
    if (!current?.ok || current.value?.sessionId !== settings.value.sessionId ||
        globalThis.__logicRecorderInstalled !== previous) return;
    try { previous.shutdown(); } catch { return; }
  }
  const collector = {
    releaseStopped() {
      if (!stopped) return false;
      shutdownCollector();
      return true;
    },
    sessionId() { return captureSettings.then((settings) => settings?.sessionId); },
    shutdown() { shutdownCollector(); },
  };
  globalThis.__logicRecorderInstalled = collector;
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
      Promise.resolve().then(() => chrome.runtime.sendMessage({ type: "CANVAS_OPTIONS" })),
      new Promise((resolve) => { timeout = setTimeout(() => resolve(null), 5000); }),
    ]).catch(() => null).then((result) => {
      clearTimeout(timeout);
      const settings = result?.ok && typeof result.value?.sessionId === "string" ? result.value : null;
      if (!settings && !stopped) shutdownCollector();
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
  const fragmentTransfers = new Set();
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
  function sendFragments(text, reference) {
    const transfer = (async () => {
      await send();
      for (let index = 0; index < reference.parts && !stopped; index++) {
        const failedBefore = delivery.failedEvents;
        await delivery.enqueue([{ kind: "capture.fragment", payload: {
          ...reference, index, data: text.slice(index * FRAGMENT_LENGTH, (index + 1) * FRAGMENT_LENGTH),
        }, screenshot: false, time: Date.now() }]);
        if (delivery.failedEvents !== failedBefore) return false;
      }
      if (!stopped) {
        const failedBefore = delivery.failedEvents;
        await delivery.enqueue([{ kind: "capture.fragmentEnd", payload: {
          ...reference, status: "confirmed",
        }, screenshot: false, time: Date.now() }]);
        return delivery.failedEvents === failedBefore;
      }
      return false;
    })();
    fragmentTransfers.add(transfer);
    transfer.finally(() => fragmentTransfers.delete(transfer)).catch(() => {});
    return transfer;
  }
  let fileTransferChain = Promise.resolve();
  function sendFile(file, reference) {
    const transfer = fileTransferChain.then(async () => {
      await send();
      for (let index = 0; index < reference.parts && !stopped; index++) {
        const bytes = new Uint8Array(await file.slice(index * 75000, (index + 1) * 75000).arrayBuffer());
        const data = btoa(String.fromCharCode(...bytes));
        const before = delivery.failedEvents;
        await delivery.enqueue([{ kind: "capture.fragment", payload: { ...reference, index, data },
          screenshot: false, time: Date.now() }]);
        if (before !== delivery.failedEvents) throw new Error("文件分段写入未确认");
      }
      if (stopped) return false;
      const before = delivery.failedEvents;
      await delivery.enqueue([{ kind: "capture.fragmentEnd", payload: { ...reference, status: "confirmed" },
        screenshot: false, time: Date.now() }]);
      if (before !== delivery.failedEvents) throw new Error("文件结束状态未确认");
      return true;
    }).catch((error) => {
      if (!stopped) emit("capture.fragmentFailure", { ...reference, status: "failed", reason: String(error) });
      return false;
    });
    fileTransferChain = transfer.catch(() => false);
    fragmentTransfers.add(transfer);
    transfer.finally(() => fragmentTransfers.delete(transfer)).catch(() => {});
    return transfer;
  }
  function captureFiles(files) {
    return Array.from(files || [], (file) => {
      const info = { name: file.name, size: file.size, type: file.type, lastModified: file.lastModified };
      if (!file.size) return { ...info, contentStatus: "captured", encoding: "base64", data: "" };
      const length = 4 * Math.ceil(file.size / 3);
      const reference = { captureId: newCaptureId(), field: "fileBytesBase64", length,
        parts: Math.ceil(length / FRAGMENT_LENGTH) };
      sendFile(file, reference);
      return { ...info, contentStatus: "fragmented", encoding: "base64", contentReference: reference };
    });
  }
  function newCaptureId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)),
      (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
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
      focused: el.matches(":focus"),
      disabled: el.matches(":disabled"),
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
  function captureInput(raw, field) {
    const { value: captured, truncated } = cleanInput(raw);
    if (!truncated) return { value: captured, status: "captured" };
    const reference = fragmentReference(raw, newCaptureId(), field);
    sendFragments(raw, reference);
    return { value: captured, status: "fragmented", reference };
  }
  const value = (el) => {
    if (el instanceof HTMLInputElement && el.type === "file")
      return { value: el.value, valueStatus: "browser_file_path" };
    const raw = el instanceof HTMLElement && el.isContentEditable
      ? el.innerText : typeof el?.value === "string" ? el.value : null;
    if (raw === null) return { value: null };
    const captured = captureInput(raw, "inputValue");
    return { value: captured.value, valueStatus: captured.status,
      ...(captured.reference ? { valueReference: captured.reference } : {}) };
  };
  const formState = (el, includeOptions = false) => {
    if (
      el instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(el.type)
    )
      return { checked: el.checked, disabled: el.disabled, indeterminate: el.indeterminate };
    if (el instanceof HTMLSelectElement) {
      const selected = [...el.options].flatMap((option, index) =>
        option.selected
          ? [{ index, value: option.value }]
          : [],
      );
      const state = {
        selectedIndices: selected.map((item) => item.index),
        selectedValues: selected.map((item) => item.value),
        truncated: false,
        disabled: el.disabled,
        ...(includeOptions
          ? {
              multiple: el.multiple,
              options: [...el.options].map((option) => ({ id: nodeId(option), label: option.label, value: option.value,
                disabled: option.disabled || !!option.closest("optgroup:disabled") })),
              optionsTruncated: false,
            }
          : {}),
      };
      const json = JSON.stringify(state);
      if (json.length <= 100000) return state;
      const reference = fragmentReference(json, newCaptureId(), "formState");
      sendFragments(json, reference);
      return { status: "fragmented", reference };
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
  function captureDocumentStyles(snapshotId) {
    try {
      const sheets = [
        ...Array.from(document.styleSheets, (sheet) => ({ sheet, source: "document", ancestors: [] })),
        ...Array.from(document.adoptedStyleSheets || [], (sheet) => ({ sheet, source: "adopted", ancestors: [] })),
      ];
      try {
        const { shadows } = collectDom();
        for (const root of shadows) {
          const owner = { shadowRootId: nodeId(root), hostNodeId: nodeId(root.host) };
          const styles = root.styleSheets ? Array.from(root.styleSheets) :
            [...root.querySelectorAll('style, link[rel~="stylesheet"]')].map((element) => element.sheet).filter(Boolean);
          for (const sheet of styles) sheets.push({ sheet, source: "shadow", ancestors: [], ...owner });
          for (const sheet of root.adoptedStyleSheets || []) sheets.push({ sheet, source: "shadow-adopted", ancestors: [], ...owner });
        }
      } catch (error) {
        emit("page.stylesheet", { snapshotId, url: location.href, source: "shadow", status: "unavailable", reason: String(error) });
      }
      const rootTotal = sheets.length;
      for (let index = 0; index < sheets.length; index++) {
        const { sheet, source, ancestors, parentIndex, parentRuleIndex, importHref, shadowRootId, hostNodeId } = sheets[index];
        const info = { snapshotId, url: location.href, source, index, rootTotal,
          ...(parentIndex == null ? {} : { parentIndex, parentRuleIndex }),
          ...(shadowRootId ? { shadowRootId, hostNodeId } : {}),
          href: sheet?.href || importHref || null, media: sheet?.media?.mediaText || "", disabled: !!sheet?.disabled };
        try {
          if (!sheet) throw new Error("导入的样式表尚未加载或不可用");
          if (ancestors.includes(sheet)) throw new Error("样式表导入形成循环");
          const rules = Array.from(sheet.cssRules);
          const cssText = rules.map((rule) => rule.cssText).join("\n");
          const reference = cssText.length > 1500000 ? fragmentReference(cssText, newCaptureId(), "cssText") : null;
          emit("page.stylesheet", { ...info, status: reference ? "fragmented" : "captured",
            cssText: reference ? null : cssText, ...(reference ? { cssReference: reference } : {}) });
          if (reference) sendFragments(cssText, reference);
          for (let ruleIndex = 0; ruleIndex < rules.length; ruleIndex++) {
            const rule = rules[ruleIndex];
            if (rule.type === CSSRule.IMPORT_RULE)
              sheets.push({ sheet: rule.styleSheet, source: "import", ancestors: [...ancestors, sheet],
                parentIndex: index, parentRuleIndex: ruleIndex, importHref: rule.href, shadowRootId, hostNodeId });
          }
        } catch (error) {
          emit("page.stylesheet", { ...info, status: "unavailable", reason: String(error) });
        }
      }
    } catch (error) {
      emit("page.stylesheet", { snapshotId, url: location.href, status: "unavailable", reason: String(error) });
    }
  }
  function captureFonts(snapshotId) {
    try {
      if (!document.fonts) throw new Error("浏览器未提供字体集合");
      const faces = [...document.fonts].map((font) => ({ family: font.family, style: font.style,
        weight: font.weight, stretch: font.stretch, unicodeRange: font.unicodeRange,
        variant: font.variant, featureSettings: font.featureSettings, display: font.display,
        status: font.status, source: "not_exposed_by_fontface" }));
      const json = JSON.stringify(faces);
      const reference = json.length > 100000 ? fragmentReference(json, newCaptureId(), "fontFaces") : null;
      emit("page.fonts", { snapshotId, url: location.href, status: "captured", setStatus: document.fonts.status,
        count: faces.length, faces: reference ? [] : faces, ...(reference ? { facesStatus: "fragmented", reference } : {}),
        systemFontFiles: "not_provided_by_browser" });
      if (reference) sendFragments(json, reference);
    } catch (error) {
      emit("page.fonts", { snapshotId, url: location.href, status: "unavailable", reason: String(error) });
    }
  }
  function queueFinalCapture(previous, restart, onError) {
    const queued = previous.catch(() => {}).then(() => { if (!stopped) restart(); })
      .catch((error) => { if (!stopped) onError(error); });
    fragmentTransfers.add(queued);
    queued.finally(() => fragmentTransfers.delete(queued)).catch(() => {});
  }
  let computedStyleBusy = false, computedStyleTask;
  let shadowSourceBusy = false, shadowSourceTask;
  function captureShadowSources(snapshotId, captureId, final = false) {
    if (shadowSourceBusy) {
      if (final && shadowSourceTask) {
        queueFinalCapture(shadowSourceTask, () => captureShadowSources(snapshotId, captureId, true),
          (error) => emit("page.shadowRootEnd", { snapshotId, captureId, status: "failed", reason: String(error) }));
        return;
      }
      emit("page.shadowRootEnd", { snapshotId, captureId, status: "skipped_busy" });
      return;
    }
    let roots;
    try { roots = collectDom().shadows; }
    catch (error) {
      emit("page.shadowRootEnd", { snapshotId, captureId, status: "unavailable", reason: String(error) });
      return;
    }
    shadowSourceBusy = true;
    const transfer = (async () => {
      await send();
      let processed = 0, failures = 0;
      for (const root of roots) {
        if (stopped) return;
        const observedAt = Date.now(), parent = root.host.getRootNode();
        const info = { snapshotId, captureId, rootNodeId: nodeId(root), hostNodeId: nodeId(root.host),
          parentRootNodeId: parent instanceof ShadowRoot ? nodeId(parent) : null, mode: root.mode, observedAt };
        let html, reference, result;
        try {
          if (!root.host.isConnected) throw new Error("组件在采集前已移除");
          html = root.innerHTML;
          if (html.length > FRAGMENT_LENGTH) reference = fragmentReference(html, newCaptureId(), "shadowSourceHtml");
          result = { ...info, status: reference ? "fragmented" : "captured", length: html.length,
            ...(reference ? { reference } : { html }) };
        } catch (error) {
          failures++;
          result = { ...info, status: "unavailable", reason: String(error) };
        }
        const before = delivery.failedEvents;
        await delivery.enqueue([{ kind: "page.shadowRoot", payload: result, screenshot: false, time: observedAt }]);
        if (delivery.failedEvents !== before) return;
        if (reference && !await sendFragments(html, reference)) return;
        processed++;
      }
      if (!stopped) await delivery.enqueue([{ kind: "page.shadowRootEnd", payload: {
        snapshotId, captureId, total: roots.length, processed, failures, status: failures ? "partial" : "captured",
      }, screenshot: false, time: Date.now() }]);
    })().catch((error) => {
      if (!stopped) emit("page.shadowRootEnd", { snapshotId, captureId, status: "failed", reason: String(error) });
    });
    shadowSourceTask = transfer;
    fragmentTransfers.add(transfer);
    transfer.finally(() => { fragmentTransfers.delete(transfer); shadowSourceBusy = false; if (shadowSourceTask === transfer) shadowSourceTask = null; }).catch(() => {});
  }
  let canvasCaptureBusy = false, canvasCaptureTask;
  function captureCanvasPixels(snapshotId, final = false) {
    if (canvasCaptureBusy) {
      if (final && canvasCaptureTask) {
        queueFinalCapture(canvasCaptureTask, () => captureCanvasPixels(snapshotId, true),
          (error) => emit("canvas.captureEnd", { snapshotId, status: "failed", reason: String(error) }));
        return;
      }
      emit("canvas.captureEnd", { snapshotId, status: "skipped_busy" });
      return;
    }
    canvasCaptureBusy = true;
    const task = (async () => {
      let elements;
      try { elements = collectDom().elements.filter((element) => element instanceof HTMLCanvasElement); }
      catch (error) {
        emit("canvas.captureEnd", { snapshotId, status: "unavailable", reason: String(error) });
        return;
      }
      const settings = await captureSettings;
      if (!settings?.enabled) {
        emit("canvas.captureEnd", { snapshotId, status: settings && !elements.length ? "captured" : settings ? "disabled" : "unavailable",
          total: elements.length, processed: 0, failed: 0 });
        return;
      }
      let processed = 0, failed = 0;
      for (const element of elements) {
        if (stopped) return;
        const info = { snapshotId, nodeId: nodeId(element), pixelWidth: element.width, pixelHeight: element.height,
          captureStartedAt: Date.now(), drawingContext: "unknown", screenEquivalence: "unverified" };
        try {
          let timer;
          const blob = await Promise.race([
            new Promise((resolve, reject) => {
              try { element.toBlob(resolve, "image/png"); } catch (error) { reject(error); }
            }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("画布读取超时")), 2500); }),
          ]).finally(() => clearTimeout(timer));
          if (!blob?.size) throw new Error("浏览器未提供画布图像");
          const length = 4 * Math.ceil(blob.size / 3);
          const reference = { captureId: newCaptureId(), field: "canvasBytesBase64", length,
            parts: Math.ceil(length / FRAGMENT_LENGTH) };
          emit("canvas.capture", { ...info, capturedAt: Date.now(), status: "fragmented",
            mime: "image/png", size: blob.size, reference });
          if (!await sendFile(blob, reference)) failed++;
        } catch (error) {
          failed++;
          emit("canvas.capture", { ...info, status: "unavailable", reason: String(error) });
        }
        processed++;
      }
      if (!stopped) emit("canvas.captureEnd", { snapshotId, total: elements.length, processed, failed,
        status: failed ? "partial" : "captured" });
    })().catch((error) => {
      if (!stopped) emit("canvas.captureEnd", { snapshotId, status: "failed", reason: String(error) });
    });
    canvasCaptureTask = task;
    fragmentTransfers.add(task);
    task.finally(() => { fragmentTransfers.delete(task); canvasCaptureBusy = false; if (canvasCaptureTask === task) canvasCaptureTask = null; }).catch(() => {});
  }
  function captureComputedStyles(snapshotId, final = false) {
    const captureId = newCaptureId();
    if (computedStyleBusy) {
      if (final && computedStyleTask) {
        queueFinalCapture(computedStyleTask, () => captureComputedStyles(snapshotId, true),
          (error) => emit("page.computedStyleEnd", { snapshotId, captureId, status: "failed", reason: String(error) }));
        return;
      }
      emit("page.computedStyleEnd", { snapshotId, captureId, status: "skipped_busy" });
      return;
    }
    let elements, enumerationStatus = "captured";
    try { elements = collectDom().elements; }
    catch {
      elements = [...document.querySelectorAll("*")];
      enumerationStatus = "shadow_unavailable";
    }
    computedStyleBusy = true;
    const transfer = (async () => {
      await send();
      let processed = 0, failures = 0;
      const batchCount = Math.ceil(elements.length / 5);
      for (let batchIndex = 0; batchIndex < batchCount && !stopped; batchIndex++) {
        const entries = [];
        for (const element of elements.slice(batchIndex * 5, batchIndex * 5 + 5)) {
          const id = nodeId(element), observedAt = Date.now();
          try {
            if (!element.isConnected) throw new Error("元素在采集前已移除");
            const rect = element.getBoundingClientRect();
            const properties = readComputedProperties(element, null);
            const display = properties.find(([name]) => name === "display")?.[1];
            const pseudoNames = ["::first-line", "::first-letter", "::selection"];
            if (display === "list-item") pseudoNames.push("::marker");
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) pseudoNames.push("::placeholder");
            if (element instanceof HTMLInputElement && element.type === "file") pseudoNames.push("::file-selector-button");
            if (element instanceof HTMLDialogElement && element.open) pseudoNames.push("::backdrop");
            const pseudos = Object.fromEntries(pseudoNames.map((name) => [name, readComputedProperties(element, name)]));
            entries.push({ nodeId: id, observedAt, status: "captured",
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              properties, before: readComputedProperties(element, "::before"), after: readComputedProperties(element, "::after"), pseudos,
              pseudoScope: "common_pseudos" });
          } catch (error) {
            failures++;
            entries.push({ nodeId: id, observedAt, status: "unavailable", reason: String(error) });
          }
        }
        const packedEntries = await packComputedEntries(entries);
        if (stopped) return;
        const failedBefore = delivery.failedEvents;
        await delivery.enqueue([{ kind: "page.computedStyle", payload: { snapshotId, captureId,
          batchIndex, batchCount, ...packedEntries }, screenshot: false, time: Date.now() }]);
        if (delivery.failedEvents !== failedBefore) return;
        processed += entries.length;
      }
      if (!stopped) await delivery.enqueue([{ kind: "page.computedStyleEnd", payload: {
        snapshotId, captureId, total: elements.length, processed, failures, enumerationStatus,
        status: failures || enumerationStatus !== "captured" ? "partial" : "captured",
      }, screenshot: false, time: Date.now() }]);
    })().catch((error) => {
      if (!stopped) emit("page.computedStyleEnd", { snapshotId, captureId, status: "failed", reason: String(error) });
    });
    computedStyleTask = transfer;
    fragmentTransfers.add(transfer);
    transfer.finally(() => { fragmentTransfers.delete(transfer); computedStyleBusy = false; if (computedStyleTask === transfer) computedStyleTask = null; }).catch(() => {});
  }
  function readComputedProperties(element, pseudo) {
    const style = getComputedStyle(element, pseudo);
    return Array.from({ length: style.length }, (_, index) => {
      const name = style.item(index);
      return [name, style.getPropertyValue(name)];
    });
  }
  function captureInteractionStyle(element, reason, interactionCaptureId, interactionTime) {
    if (!(element instanceof Element)) return;
    const info = { url: location.href, nodeId: nodeId(element), reason, interactionCaptureId, interactionTime, observedAt: Date.now() };
    try {
      if (!element.isConnected) throw new Error("元素在采集前已移除");
      emit("page.interactionStyle", { ...info, status: "captured", properties: readComputedProperties(element, null),
        before: readComputedProperties(element, "::before"), after: readComputedProperties(element, "::after") });
    } catch (error) {
      emit("page.interactionStyle", { ...info, status: "unavailable", reasonDetail: String(error) });
    }
  }
  function snapshot(reason) {
    try {
      const snapshotId = newCaptureId();
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
      let sourceHtml = null, sourceStatus = "captured", sourceLength = 0, sourceReference, sourceText;
      try {
        const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) : "";
        const source = doctype + document.documentElement.outerHTML;
        sourceLength = source.length;
        if (sourceLength > 1500000) {
          sourceStatus = "fragmented";
          sourceText = source;
          sourceReference = fragmentReference(source, newCaptureId(), "sourceHtml");
        } else sourceHtml = source;
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
      let scrollTruncated = false, scrollSources;
      try { scrollSources = collectDom().elements; }
      catch { scrollSources = backgroundSources; scrollTruncated = true; }
      for (const element of scrollSources) {
        if (element === document.documentElement || element === document.body)
          continue;
        if (element.scrollLeft || element.scrollTop) {
          scrollPositions.push({
            nodeId: nodeId(element),
            left: element.scrollLeft,
            top: element.scrollTop,
            scrollWidth: element.scrollWidth, scrollHeight: element.scrollHeight,
            clientWidth: element.clientWidth, clientHeight: element.clientHeight,
          });
        }
      }
      delete shadow.scrollPositions;
      const scrollJson = JSON.stringify({ positions: scrollPositions, truncated: scrollTruncated });
      const scrollReference = scrollJson.length > 100000 ? fragmentReference(scrollJson, newCaptureId(), "scrollState") : null;
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
      const fragmented = html.length > 1500000;
      const htmlText = fragmented ? html : null;
      const htmlReference = fragmented ? fragmentReference(html, newCaptureId(), "html") : undefined;
      if (fragmented) html = "";
      const shadowSourceCaptureId = newCaptureId();
      emit("page.snapshot", {
        snapshotId,
        shadowSourceCaptureId,
        reason,
        url: location.href,
        title: document.title,
        html,
        sourceHtml,
        sourceStatus,
        sourceLength,
        ...(sourceReference ? { sourceReference } : {}),
        ...(htmlReference ? { htmlReference } : {}),
        status: fragmented
          ? "fragmented"
          : truncatedNodes
            ? "truncated"
            : "captured",
        truncatedNodes,
        scroll: { positions: scrollReference ? [] : scrollPositions, truncated: scrollTruncated,
          coverage: "rendered_only", ...(scrollReference ? { status: "fragmented", reference: scrollReference } : {}) },
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
      if (sourceReference) sendFragments(sourceText, sourceReference);
      if (htmlReference) sendFragments(htmlText, htmlReference);
      if (scrollReference) sendFragments(scrollJson, scrollReference);
      captureShadowSources(snapshotId, shadowSourceCaptureId, reason === "stop");
      captureDocumentStyles(snapshotId);
      captureFonts(snapshotId);
      captureComputedStyles(snapshotId, reason === "stop");
      captureCanvasPixels(snapshotId, reason === "stop");
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
            ? captureFiles(target.files)
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
    inputBefore.set(target, { value: raw, time, inputType: event.inputType });
  });
  recordOnRoots(
    "input",
    (event, target, time) => {
      const previous = target instanceof Element ? inputBefore.get(target) : null;
      if (target instanceof Element) inputBefore.delete(target);
      const beforeValue = event.isTrusted && previous && time >= previous.time &&
        time - previous.time <= 2000 && previous.inputType === event.inputType
        ? previous.value : undefined;
      const beforeCapture = beforeValue !== undefined ? captureInput(beforeValue, "beforeValue") : null;
      emit(
        "interaction.input",
        {
          url: location.href,
          target: describe(target),
          viewport: { width: innerWidth, height: innerHeight, scrollX, scrollY },
          ...value(target),
          ...(beforeCapture ? { beforeValue: beforeCapture.value, beforeValueStatus: beforeCapture.status,
            ...(beforeCapture.reference ? { beforeValueReference: beforeCapture.reference } : {}) } : {}),
          formState: formState(target, true),
          ...(target instanceof HTMLInputElement && target.type === "file" ? { files: captureFiles(target.files) } : {}),
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
    "pointerout",
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
            ? captureFiles(event.dataTransfer?.files)
            : undefined;
        const captureStyle = ["pointerover", "pointerout", "focusin", "focusout"].includes(type) && target instanceof Element;
        const interactionCaptureId = captureStyle ? newCaptureId() : null;
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
            ...(interactionCaptureId ? { interactionCaptureId } : {}),
          },
          true, time,
        );
        if (interactionCaptureId) {
          captureInteractionStyle(target, type, interactionCaptureId, time);
          scheduleSnapshot(type);
        }
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
    scheduleSnapshot("scroll");
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
          firstTime: previous?.payload.firstTime ?? time,
          eventCount: (previous?.payload.eventCount || 0) + 1,
          viewport: { width: innerWidth, height: innerHeight },
          coverage: "rendered_only",
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
    const dialogs = new Set(), nextValues = new Map(), following = new Map();
    for (let index = records.length - 1; index >= 0; index--) {
      const record = records[index];
      if (record.type !== "attributes" && record.type !== "characterData") continue;
      let values = following.get(record.target);
      if (!values) following.set(record.target, values = new Map());
      const key = record.type === "attributes" ? JSON.stringify([record.attributeNamespace, record.attributeName]) : "text";
      if (values.has(key)) nextValues.set(index, values.get(key));
      values.set(key, record.oldValue);
    }
    let changes = [], rawChanges = [], budget = { count: 0, truncated: false }, filtered = 0;
    const batchId = newCaptureId();
    const batchCount = Math.ceil(records.length / 200);
    const rawValue = (value, field) => {
      if (value === null) return { status: "captured", value: null };
      const text = String(value);
      if (text.length <= 10000) return { status: "captured", value: text };
      const reference = fragmentReference(text, newCaptureId(), field);
      sendFragments(text, reference);
      return { status: "fragmented", reference };
    };
    const rawNode = (node) => {
      try {
        const topology = [], pending = [[node, []]];
        while (pending.length) {
          const [current, path] = pending.pop();
          topology.push({ id: nodeId(current), path });
          const children = [...current.childNodes];
          for (let index = children.length - 1; index >= 0; index--)
            pending.push([children[index], [...path, index]]);
        }
        const data = { id: nodeId(node), nodeType: node.nodeType, nodeName: node.nodeName,
          content: node.nodeType === Node.ELEMENT_NODE ? node.outerHTML : node.nodeValue, topology };
        const json = JSON.stringify(data);
        if (json.length <= 100000) return { status: "captured", data };
        const reference = fragmentReference(json, newCaptureId(), "mutationNode");
        sendFragments(json, reference);
        return { status: "fragmented", reference };
      } catch (error) { return { status: "unavailable", id: nodeId(node), reason: String(error) }; }
    };
    function flushMutations(index) {
      emit("page.mutation", {
        url: location.href, changes, rawChanges, rawNodeTime: "observer_callback",
        batchId, batchIndex: Math.floor(index / 200), batchCount,
        filteredRecords: filtered,
        status: budget.truncated || filtered ? "truncated" : "captured",
      });
      changes = [];
      rawChanges = [];
      budget = { count: 0, truncated: false };
      filtered = 0;
    }
    for (let index = 0; index < records.length; index++) {
      const record = records[index];
      if (record.type === "attributes") {
        const name = record.attributeName || "";
        const current = nextValues.has(index) ? nextValues.get(index) :
          record.attributeNamespace ? record.target.getAttributeNS(record.attributeNamespace, name) : record.target.getAttribute(name);
        rawChanges.push({ type: "attribute", id: nodeId(record.target), name, namespace: record.attributeNamespace,
          before: rawValue(record.oldValue, "mutationBefore"), value: rawValue(current, "mutationValue") });
      } else if (record.type === "characterData") {
        const current = nextValues.has(index) ? nextValues.get(index) : record.target.nodeValue;
        rawChanges.push({ type: "text", id: nodeId(record.target), before: rawValue(record.oldValue, "mutationBefore"),
          value: rawValue(current, "mutationValue") });
      } else if (record.type === "childList") {
        rawChanges.push({ type: "children", id: nodeId(record.target), next: record.nextSibling ? nodeId(record.nextSibling) : null,
          added: [...record.addedNodes].map(rawNode), removed: [...record.removedNodes].map(rawNode) });
      }
      const targetElement =
        record.target.nodeType === Node.ELEMENT_NODE
          ? record.target
          : record.target.parentElement;
      if (
        targetElement?.closest(
          "script, noscript, iframe, object, embed, base, meta, link",
        )
      ) {
        filtered++;
      } else if (record.type === "attributes") {
        const name = record.attributeName || "";
        if (name === "open" && record.target instanceof HTMLDialogElement) dialogs.add(record.target);
        if (/^on/i.test(name)) { filtered++; }
        else {
        const current = nextValues.has(index) ? nextValues.get(index) :
          record.attributeNamespace ? record.target.getAttributeNS(record.attributeNamespace, name) : record.target.getAttribute(name);
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
        }
      } else if (record.type === "characterData") {
        const current = nextValues.has(index) ? nextValues.get(index) : record.target.nodeValue;
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
      if ((index + 1) % 200 === 0 || index === records.length - 1) flushMutations(index);
    }
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
    const captureStartedAt = Date.now();
    for (const name of ["localStorage", "sessionStorage"]) {
      try {
        const store = window[name], entries = Object.create(null);
        const total = store.length;
        for (let i = 0; i < total; i++) {
          const key = store.key(i);
          if (key === null) continue;
          const raw = store.getItem(key);
          if (raw === null) continue;
          entries[key] = raw;
          if (key === "__proto__")
            specialEntries.push({ storage: name, key, value: entries[key] });
        }
        stores[name] = entries;
        const captured = Object.keys(entries).length;
        const omittedKeys = Math.max(0, total - captured);
        const finalTotal = store.length;
        coverage[name] = {
          status: omittedKeys || finalTotal !== total ? "partial" : "captured",
          total,
          finalTotal,
          captured,
          omittedKeys,
        };
      } catch (error) {
        coverage[name] = { status: "unavailable", reason: String(error) };
      }
    }
    const json = JSON.stringify({ stores, coverage, specialEntries });
    if (json !== lastStorage) {
      lastStorage = json;
      const reference = json.length > 1500000 ? fragmentReference(json, newCaptureId(), "storage") : null;
      emit("storage.snapshot", {
        url: location.href,
        stores: reference ? {} : stores,
        coverage,
        specialEntries: reference ? [] : specialEntries,
        ...(reference ? { storageReference: reference, storageStatus: "fragmented" } : {}),
        method: reason,
        intervalMs: 1000,
        captureStartedAt,
        capturedAt: Date.now(),
      });
      if (reference) sendFragments(json, reference).then((complete) => {
        if (!complete && lastStorage === json) lastStorage = "";
      }).catch(() => { if (lastStorage === json) lastStorage = ""; });
    }
  }
  captureStorage();
  const storageTimer = setInterval(captureStorage, 1000);
  function openDatabaseForGraph(name) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { settled = true; reject(new Error("数据库打开超时")); }, 2500);
      const request = indexedDB.open(name);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onblocked = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error("数据库打开被阻塞")); } };
      request.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(request.error || new Error("数据库打开失败")); } };
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        clearTimeout(timer);
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
  }
  function readDatabaseBatch(db, name, lastKey, hasLast) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(name, "readonly"), rows = [];
      const timer = setTimeout(() => { try { tx.abort(); } catch {} }, 2500);
      const cursor = tx.objectStore(name).openCursor(hasLast ? IDBKeyRange.lowerBound(lastKey, true) : undefined);
      cursor.onsuccess = () => {
        const row = cursor.result;
        if (!row) return;
        rows.push({ store: name, key: row.primaryKey, value: row.value, observedAt: Date.now() });
        if (rows.length < 20) row.continue();
      };
      tx.oncomplete = () => { clearTimeout(timer); resolve(rows); };
      tx.onerror = tx.onabort = () => { clearTimeout(timer); reject(tx.error || new Error("数据库批次读取失败或超时")); };
    });
  }
  async function captureDatabases(reason) {
    const catalogId = newCaptureId();
    if (!indexedDB.databases) {
      emit("database.catalog", { reason, catalogId, url: location.href, observedAt: Date.now(), status: "unavailable", reasonDetail: "浏览器不支持数据库枚举" });
      emit("database.catalogEnd", { reason, catalogId, status: "unavailable" });
      emit("database.snapshot", { reason, catalogId, status: "unavailable" });
      return;
    }
    try {
      let remainingRecords = 500,
        remainingChars = 2000000;
      const databases = await indexedDB.databases();
      const catalog = JSON.stringify(databases);
      const catalogReference = catalog.length > FRAGMENT_LENGTH ? fragmentReference(catalog, newCaptureId(), "databaseCatalog") : null;
      emit("database.catalog", { reason, catalogId, url: location.href, observedAt: Date.now(), count: databases.length,
        status: catalogReference ? "fragmented" : "captured", ...(catalogReference ? { reference: catalogReference } : { databases }) });
      if (catalogReference && !await sendFragments(catalog, catalogReference)) return;
      let processed = 0;
      for (let catalogIndex = 0; catalogIndex < databases.length; catalogIndex++) {
        if (stopped) return;
        const info = databases[catalogIndex];
        if (typeof info.name !== "string") {
          emit("database.snapshot", { reason, catalogId, catalogIndex, status: "unavailable", error: "浏览器未提供数据库名称" });
          processed++;
          continue;
        }
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
            const names = [...db.objectStoreNames],
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
                    indexDefinitions: [...store.indexNames].map((indexName) => {
                      const index = store.index(indexName);
                      return { name: indexName, keyPath: index.keyPath, unique: index.unique, multiEntry: index.multiEntry };
                    }),
                    autoIncrement: store.autoIncrement,
                    records: [],
                    truncated: false,
                  };
                stores.push(entry);
                const count = store.count();
                count.onsuccess = () => { entry.totalAtSnapshot = count.result; };
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
        const graphCaptureId = result.status === "captured" ? newCaptureId() : null;
        emit("database.snapshot", {
          reason, catalogId, catalogIndex,
          database: result,
          url: location.href,
          ...(graphCaptureId ? { graphCaptureId, graphStatus: "pending" } : {}),
        });
        if (graphCaptureId) {
          let batch = [], batchBytes = 0, saved = 0, failed = 0, scanned = 0, scanError = null, graphDb;
          const flushRows = async () => {
            if (!batch.length) return true;
            const before = delivery.failedEvents;
            await delivery.enqueue(batch);
            batch = [];
            batchBytes = 0;
            return before === delivery.failedEvents;
          };
          await send();
          try {
            graphDb = await openDatabaseForGraph(info.name);
            if (graphDb.version !== result.version) throw new Error("数据库版本在采样期间发生变化");
            for (const store of result.stores) {
              let lastKey, hasLast = false;
              const firstIndex = scanned;
              while (!stopped) {
                const rows = await readDatabaseBatch(graphDb, store.name, lastKey, hasLast);
                for (const row of rows) {
                  const index = scanned++;
                  let payload;
                  try {
                    const graph = await encodeDatabaseGraph({ key: row.key, value: row.value });
                    const json = JSON.stringify(graph);
                    if (graph.issues.length) failed++;
                    if (json.length > 100000) {
                      if (!await flushRows()) throw new Error("数据库记录写入未确认");
                      const reference = fragmentReference(json, newCaptureId(), "databaseGraph");
                      payload = { graphCaptureId, database: info.name, store: row.store, index,
                        observedAt: row.observedAt, status: graph.issues.length ? "partial" : "fragmented", graphReference: reference };
                      const before = delivery.failedEvents;
                      await delivery.enqueue([{ kind: "database.record", payload, screenshot: false, time: Date.now() }]);
                      if (before !== delivery.failedEvents || !await sendFragments(json, reference)) throw new Error("数据库记录分段未确认");
                      saved++;
                      continue;
                    }
                    payload = { graphCaptureId, database: info.name, store: row.store, index,
                      observedAt: row.observedAt, status: graph.issues.length ? "partial" : "captured", graph };
                  } catch (error) {
                    failed++;
                    payload = { graphCaptureId, database: info.name, store: row.store, index,
                      observedAt: row.observedAt, status: "unavailable", reason: String(error) };
                  }
                  const size = JSON.stringify(payload).length;
                  if (batch.length && (batch.length >= 20 || batchBytes + size > 1000000)) {
                    if (!await flushRows()) throw new Error("数据库记录写入未确认");
                  }
                  batch.push({ kind: "database.record", payload, screenshot: false, time: Date.now() });
                  batchBytes += size;
                  saved++;
                }
                if (rows.length < 20) break;
                lastKey = rows[rows.length - 1].key;
                hasLast = true;
              }
              const observed = scanned - firstIndex;
              const matches = Number.isSafeInteger(store.totalAtSnapshot) && observed === store.totalAtSnapshot;
              if (!matches) failed++;
              emit("database.storeScan", { reason, graphCaptureId, database: info.name, store: store.name,
                initialCount: store.totalAtSnapshot ?? null, observedCount: observed,
                status: matches ? "count_matched" : "count_changed_or_unavailable",
                consistency: "batched_non_atomic" });
            }
          } catch (error) { failed++; scanError = String(error); }
          finally { graphDb?.close(); }
          if (!await flushRows()) failed++;
          if (!stopped) emit("database.recordsEnd", { reason, graphCaptureId, database: info.name,
            total: scanned, saved, failed, omitted: 0, consistency: "batched_non_atomic",
            ...(scanError ? { error: scanError, totalStatus: "scanned_only" } : {}),
            storesTruncated: !!result.storesTruncated,
            status: failed || result.storesTruncated || saved !== scanned ? "partial" : "captured" });
        }
        processed++;
      }
      if (!stopped) emit("database.catalogEnd", { reason, catalogId, count: databases.length, processed,
        status: processed === databases.length ? "captured" : "partial" });
    } catch (error) {
      emit("database.catalog", { reason, catalogId, url: location.href, observedAt: Date.now(), status: "unavailable", reasonDetail: String(error) });
      emit("database.catalogEnd", { reason, catalogId, status: "unavailable", reasonDetail: String(error) });
      emit("database.snapshot", {
        reason, catalogId,
        status: "failed",
        error: String(error),
      });
    }
  }
  async function captureCache(reason) {
    const catalogId = newCaptureId();
    let deadline = Date.now() + 2500;
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
      const catalog = JSON.stringify(names);
      const catalogReference = catalog.length > FRAGMENT_LENGTH ? fragmentReference(catalog, newCaptureId(), "cacheCatalog") : null;
      emit("cache.catalog", { reason, catalogId, url: location.href, observedAt: Date.now(), count: names.length,
        status: catalogReference ? "fragmented" : "captured", ...(catalogReference ? { reference: catalogReference } : { names }) });
      if (catalogReference && !await sendFragments(catalog, catalogReference)) return;
      let processed = 0;
      for (let nameIndex = 0; nameIndex < names.length; nameIndex++) {
        if (stopped) return;
        deadline = Date.now() + 2500;
        const name = names[nameIndex];
        const safeName = cleanStored(name);
        const nameStatus = name.length > 10000 ? "omitted_size" : "captured";
        try {
          if (Date.now() >= deadline) throw new Error("缓存采集超时");
          if (!await withinDeadline(caches.has(name)))
            throw new Error("缓存已不存在");
          const cache = await withinDeadline(caches.open(name));
          const requests = await withinDeadline(cache.keys());
          let unavailableUrls = 0;
          const selected = requests;
          const entries = selected.slice(0, 50).map((request) => {
            const url = request.url.length <= 10000 ? safeAttribute("src", request.url) : null;
            const urlStatus = request.url.length > 10000 ? "omitted_size"
              : typeof url === "string" && /^https?:\/\//i.test(url) ? "captured" : "unavailable";
            if (urlStatus !== "captured") unavailableUrls++;
            return { url: urlStatus === "captured" ? url : null, urlStatus,
              method: cleanStored(request.method), mode: request.mode };
          });
          const snapshotId = newCaptureId();
          let responseGaps = 0, attempted = 0;
          for (let index = 0; index < selected.length; index++) {
            if (stopped) return;
            attempted++;
            const request = selected[index];
            const info = { snapshotId, catalogId, catalogIndex: nameIndex, reason, cacheName: name, index, url: location.href,
              request: { url: request.url, method: request.method, mode: request.mode, headers: [...request.headers.entries()] } };
            let emitted = false;
            try {
              if (Date.now() >= deadline) throw new Error("缓存采集超时");
              const response = await withinDeadline(cache.match(request));
              if (!response) throw new Error("缓存响应已不存在");
              const metadata = { url: response.url, type: response.type, status: response.status,
                statusText: response.statusText, headers: [...response.headers.entries()] };
              if (response.type === "opaque" || response.type === "opaqueredirect") {
                responseGaps++;
                emit("cache.entry", { ...info, response: metadata, status: "opaque" });
                continue;
              }
              const bytes = new Uint8Array(await withinDeadline(response.arrayBuffer()));
              const parts = [];
              for (let offset = 0; offset < bytes.length; offset += 49152)
                parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 49152))));
              const data = parts.join("");
              const reference = data.length > 100000 ? fragmentReference(data, newCaptureId(), "cacheBodyBase64") : null;
              emit("cache.entry", { ...info, response: metadata, status: "captured", body: {
                encoding: "base64", size: bytes.length, ...(reference ? { reference, status: "fragmented" } : { data, status: "captured" }),
              } });
              emitted = true;
              if (reference && !await withinDeadline(sendFragments(data, reference))) responseGaps++;
            } catch (error) {
              responseGaps++;
              emit(emitted ? "cache.entryFailure" : "cache.entry", { ...info,
                status: Date.now() >= deadline ? "timeout" : "unavailable", reason: String(error) });
              if (Date.now() >= deadline) break;
            }
          }
          emit("cache.snapshot", {
            reason,
            catalogId,
            catalogIndex: nameIndex,
            snapshotId,
            name: safeName,
            nameStatus,
            status: "captured",
            total: requests.length,
            entries,
            metadataOmitted: Math.max(0, requests.length - entries.length),
            omitted: Math.max(0, requests.length - attempted),
            unavailableUrls,
            responseGaps,
            truncated: requests.length > attempted || nameStatus === "omitted_size" || responseGaps > 0,
          });
        } catch (error) {
          const timedOut = Date.now() >= deadline;
          emit("cache.snapshot", {
            reason, catalogId, catalogIndex: nameIndex, name: safeName, status: timedOut ? "timeout" : "unavailable",
            error: cleanStored(String(error).slice(0, 10000)),
          });
        }
        processed++;
      }
      if (!stopped) emit("cache.catalogEnd", { reason, catalogId, count: names.length, processed,
        status: processed === names.length ? "captured" : "partial" });
    } catch (error) {
      emit("cache.catalog", { reason, catalogId, url: location.href, observedAt: Date.now(),
        status: Date.now() >= deadline ? "timeout" : "unavailable", reasonDetail: String(error) });
      emit("cache.snapshot", {
        reason, catalogId,
        status: Date.now() >= deadline ? "timeout" : "unavailable",
        error: cleanStored(String(error).slice(0, 10000)),
      });
      emit("cache.catalogEnd", { reason, catalogId, status: "unavailable", reasonDetail: String(error) });
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
  function shutdownCollector() {
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
    if (globalThis.__logicRecorderInstalled === collector) delete globalThis.__logicRecorderInstalled;
  }
  const handleMessage = (msg, _sender, reply) => {
    if (msg.type === "COLLECTOR_READY") {
      captureSettings.then((settings) => reply({ ok: !collectorClosed && !stopped && settings?.sessionId === msg.sessionId }))
        .catch(() => reply({ ok: false }));
      return true;
    }
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
      const snapshots = Promise.all(captures.map((capture) => capture.promise)).then(async () => {
        while (fragmentTransfers.size) await Promise.all([...fragmentTransfers]);
      });
      let timeout;
      Promise.race([
        snapshots.then(() => false),
        new Promise((resolve) => { timeout = setTimeout(() => resolve(true), 9000); }),
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
      shutdownCollector();
      reply({ ok: true });
    }
  };
  const onMessage = (msg, sender, reply) => {
    // Finalization messages may arrive after a new collector has replaced this one.
    if (msg.sessionId && ["FLUSH", "STOP_CAPTURE"].includes(msg.type)) {
      captureSettings.then((settings) => {
        if (settings?.sessionId !== msg.sessionId) reply({ ok: false });
        else handleMessage(msg, sender, reply);
      }).catch(() => reply({ ok: false }));
      return true;
    }
    return handleMessage(msg, sender, reply);
  };
  chrome.runtime.onMessage.addListener(onMessage);
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", () => snapshot("initial"), {
      once: true,
      signal: abort.signal,
    });
  else snapshot("initial");
})().catch((error) => console.warn("页面采集器启动失败", error));
