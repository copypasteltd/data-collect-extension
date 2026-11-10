import { createEventDelivery } from "./delivery.js";
import { singleBackgroundUrl, fontSourceUrls } from "./background-style.js";

(() => {
  if (globalThis.__logicRecorderInstalled) return;
  globalThis.__logicRecorderInstalled = true;
  const abort = new AbortController();
  const MAX_INPUT_LENGTH = 10000;
  let stopped = false;
  const secret =
    /pass(word|wd)?|pwd|token|secret|auth|cookie|session|credential|api.?key|csrf|xsrf|jwt|验证码|密码|令牌|身份证|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b/i;
  const isSensitive = (element) =>
    element instanceof Element &&
    (element.matches(
      'input[type="password"], input[autocomplete="one-time-code"], input[autocomplete="current-password"], input[autocomplete="new-password"]',
    ) ||
      secret.test(
        [
          element.getAttribute("name"),
          element.id,
          element.getAttribute("placeholder"),
          element.getAttribute("autocomplete"),
          element.getAttribute("aria-label"),
        ].join(" "),
      ));
  let buffer = [];
  const delivery = createEventDelivery((events) =>
    chrome.runtime.sendMessage({ type: "EVENTS", events }),
  );
  let timer;
  let snapshotTimer;
  let lastStorage = "";
  let nextNodeId = 0;
  const nodeIds = new WeakMap();
  const markedCopies = new WeakSet();
  const nodeId = (node) => {
    if (!nodeIds.has(node)) nodeIds.set(node, String(++nextNodeId));
    return nodeIds.get(node);
  };
  const cleanStored = (value, depth = 0) => {
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
          .map(([k, v]) => [
            k,
            secret.test(k) ? "[已隐藏]" : cleanStored(v, depth + 1),
          ]),
      );
    if (typeof value === "string") {
      if (value.length > 10000) return "[超过大小限制]";
      if (/bearer\s|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./i.test(value))
        return "[已隐藏]";
      return value
        .replace(
          /((?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*)"(?:[^"\\]|\\.)*"/gi,
          '$1"[已隐藏]"',
        )
        .replace(
          /((?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*)'(?:[^'\\]|\\.)*'/gi,
          "$1'[已隐藏]'",
        )
        .replace(
          /((?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;<}]+)/gi,
          "$1[已隐藏]",
        );
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
    if (el.id && !secret.test(el.id)) return `#${CSS.escape(el.id)}`;
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
  const describe = (el) => {
    if (!(el instanceof Element)) return {};
    const rect = el.getBoundingClientRect();
    const sensitive = isSensitive(el);
    const shadowPath = [];
    let current = el;
    while (current?.getRootNode() instanceof ShadowRoot && shadowPath.length < 20) {
      shadowPath.unshift(selector(current));
      current = current.getRootNode().host;
    }
    if (shadowPath.length) shadowPath.unshift(selector(current));
    const label =
      !sensitive && "labels" in el && el.labels
        ? [...el.labels]
            .slice(0, 10)
            .map((item) => (item.innerText || "").trim().slice(0, 160))
            .filter(Boolean)
            .join(" ")
            .slice(0, 160)
        : "";
    return {
      tag: el.localName,
      type: el.getAttribute("type"),
      editable: el instanceof HTMLElement && el.isContentEditable,
      role: el.getAttribute("role"),
      name: sensitive
        ? "[已隐藏]"
        : (
            el.getAttribute("aria-label") ||
            cleanStored(label) ||
            el.getAttribute("name") ||
            ""
          ).slice(0, 160),
      text: sensitive ? "[已隐藏]" : cleanStored((el.innerText || "").slice(0, 160)),
      selector: shadowPath.length ? null : selector(el),
      ...(shadowPath.length ? { shadowPath } : {}),
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      sensitive,
    };
  };
  function cleanInput(raw) {
    const limited = raw.slice(0, MAX_INPUT_LENGTH);
    const redactedValue = cleanStored(limited);
    return {
      value: redactedValue.slice(0, MAX_INPUT_LENGTH),
      redacted: redactedValue !== limited,
      truncated: raw.length > limited.length || redactedValue.length > MAX_INPUT_LENGTH,
    };
  }
  const value = (el) => {
    if (isSensitive(el)) return { value: "[已隐藏]" };
    if (el instanceof HTMLInputElement && el.type === "file")
      return { value: "[文件内容未采集]" };
    const raw = el instanceof HTMLElement && el.isContentEditable
      ? el.innerText : typeof el?.value === "string" ? el.value : null;
    if (raw === null) return { value: null };
    const { value: cleaned, redacted, truncated } = cleanInput(raw);
    return { value: cleaned, valueStatus: redacted && truncated ? "redacted_truncated"
      : redacted ? "redacted" : truncated ? "truncated" : "captured" };
  };
  const formState = (el, includeOptions = false) => {
    if (isSensitive(el)) return undefined;
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
    const parent =
      node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const sensitiveParent = parent?.closest?.(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
    );
    return sensitiveParent && isSensitive(sensitiveParent)
      ? "[已隐藏]"
      : cleanStored(String(text || "").slice(0, 10000));
  }
  function safeAttribute(name, raw) {
    if (raw == null) return null;
    if (/^(src|href|action|formaction|poster)$/i.test(name)) {
      try {
        const url = new URL(raw, document.baseURI);
        if (!["http:", "https:"].includes(url.protocol)) return "[非网络地址]";
        if (url.username) url.username = "redacted";
        if (url.password) url.password = "redacted";
        for (const key of [...url.searchParams.keys()])
          if (secret.test(key)) url.searchParams.set(key, "[已隐藏]");
        if (secret.test(url.hash)) url.hash = "#[已隐藏]";
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
    const hiddenOption =
      node instanceof HTMLOptionElement && isSensitive(node.closest("select"));
    for (const attr of [...node.attributes]) {
      if (node.localName === "img" && attr.name.toLowerCase() === "src") {
        const url = safeImageUrl(attr.value);
        if (url) attrs["data-logic-src"] = url;
      }
      if (
        /^on/i.test(attr.name) ||
        /^(src|srcset|href|action|formaction|data-logic-node|data-logic-src)$/i.test(
          attr.name,
        )
      )
        continue;
      if (attr.value.length > 10000) budget.truncated = true;
      attrs[attr.name] =
        secret.test(attr.name) ||
        ((isSensitive(node) || hiddenOption) &&
          /^(value|placeholder)$/i.test(attr.name))
          ? "[已隐藏]"
          : cleanStored(attr.value);
    }
    if (
      node instanceof HTMLInputElement &&
      ["checkbox", "radio"].includes(node.type)
    ) {
      if (!isSensitive(node) && node.checked) attrs.checked = "";
      else delete attrs.checked;
    }
    if (node instanceof HTMLOptionElement) {
      if (!hiddenOption && node.selected) attrs.selected = "";
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
    if (isSensitive(source)) {
      copy.removeAttribute("value");
      copy.removeAttribute("checked");
      copy.textContent = "[已隐藏]";
    } else if (source instanceof HTMLInputElement) {
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
  function captureShadowSnapshots(original, clone, fontReferences) {
    const result = { roots: 0, captured: 0, omitted: 0, stylesUnavailable: 0, truncated: false, scrollPositions: [] };
    const pending = [[original, clone, false]];
    let visited = 0, shadowNodes = 0;
    while (pending.length) {
      if (++visited > 20000) { result.truncated = true; break; }
      const [source, copy, inShadow] = pending.pop();
      if (!(source instanceof Element) || !(copy instanceof Element)) continue;
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
      const inert = document.implementation.createHTMLDocument("");
      const clone = inert.importNode(document.documentElement, true);
      markNodes(document.documentElement, clone);
      const fontReferences = new WeakSet();
      const shadow = captureShadowSnapshots(document.documentElement, clone, fontReferences);
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
        if (
          el.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])') &&
          isSensitive(el)
        ) {
          el.removeAttribute("value");
          el.removeAttribute("checked");
          el.textContent = "[已隐藏]";
        } else if (el.matches('input[type="file"]')) el.removeAttribute("value");
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
          else if (secret.test(attribute.name))
            el.setAttribute(attribute.name, "[已隐藏]");
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
        const cleaned = cleanStored(walker.currentNode.nodeValue);
        if (walker.currentNode.nodeValue.length > 10000 || cleaned.length > 10000) truncatedNodes++;
        const limited = cleaned.slice(0, 10000);
        walker.currentNode.nodeValue = walker.currentNode.parentElement?.localName === "style"
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
        status: truncated
          ? "omitted_size"
          : truncatedNodes
            ? "truncated"
            : "captured",
        truncatedNodes,
        scroll: { positions: scrollPositions, truncated: scrollTruncated },
        shadow,
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
    clearTimeout(snapshotTimer);
    snapshotTimer = setTimeout(() => snapshot(reason), 500);
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
    if (!(target instanceof Element) || isSensitive(target)) return;
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
        const beforeFormState = event.isTrusted && !isSensitive(target) && previous &&
          time >= previous.time && time - previous.time <= 2000 ? previous.state : undefined;
        const files =
          target instanceof HTMLInputElement &&
          target.type === "file"
            ? [...(target.files || [])].slice(0, 20).map((file) => ({
                name: isSensitive(target) ? "[已隐藏]" : file.name,
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
    if (!event.isTrusted || isSensitive(target)) return;
    const raw = target instanceof HTMLElement && target.isContentEditable
      ? target.innerText : typeof target.value === "string" ? target.value : null;
    if (typeof raw !== "string") return;
    const { value: previous, redacted, truncated } = cleanInput(raw);
    if (previous !== "[已隐藏]")
      inputBefore.set(target, { value: previous, time, inputType: event.inputType,
        redacted, truncated });
  });
  recordOnRoots(
    "input",
    (event, target, time) => {
      const previous = target instanceof Element ? inputBefore.get(target) : null;
      if (target instanceof Element) inputBefore.delete(target);
      const beforeValue = event.isTrusted && !isSensitive(target) && previous && time >= previous.time &&
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
            beforeValueStatus: previous.redacted && previous.truncated ? "redacted_truncated"
              : previous.redacted ? "redacted" : previous.truncated ? "truncated" : "captured" } : {}),
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
          key:
            isSensitive(element) || (typeof event.key === "string" && event.key.length === 1)
              ? "[输入]"
              : event.key || "",
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
                  name: isSensitive(target) ? "[已隐藏]" : file.name,
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
              ? { key: isSensitive(target) || event.key.length === 1 ? "[输入]" : event.key,
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
      const records = observer?.takeRecords() || [];
      if (records.length) processMutations(records);
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
    const changes = [],
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
        if (/^on/i.test(name)) continue;
        const masked =
          secret.test(name) ||
          (isSensitive(record.target) && /^(value|placeholder)$/i.test(name));
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
          before: masked
            ? "[已隐藏]"
            : record.target.localName === "img" && name === "src"
              ? safeImageUrl(record.oldValue)
              : safeAttribute(name, record.oldValue),
          value: masked
            ? "[已隐藏]"
            : record.target.localName === "img" && name === "src"
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
    scheduleSnapshot("mutation");
  }
  observer = new MutationObserver(processMutations);
  observer.observe(document, observerOptions);
  refreshShadowListeners();
  function captureStorage() {
    try {
      const stores = {};
      for (const [name, store] of [
        ["localStorage", localStorage],
        ["sessionStorage", sessionStorage],
      ]) {
        stores[name] = {};
        for (let i = 0; i < store.length && i < 200; i++) {
          const key = store.key(i),
            raw = store.getItem(key);
          let safe = raw;
          if (raw && !secret.test(key) && raw.length <= 4000) {
            try {
              safe = JSON.stringify(cleanStored(JSON.parse(raw)));
            } catch {
              safe = cleanStored(raw);
            }
          }
          stores[name][key] = secret.test(key)
            ? "[已隐藏]"
            : raw?.length > 4000
              ? "[超过大小限制]"
              : safe;
        }
      }
      const json = JSON.stringify(stores);
      if (json !== lastStorage) {
        lastStorage = json;
        emit("storage.snapshot", {
          url: location.href,
          stores,
          method: "poll",
          intervalMs: 1000,
        });
      }
    } catch (error) {
      if (!lastStorage) {
        lastStorage = "unavailable";
        emit("storage.unavailable", { error: String(error) });
      }
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
                    const cleaned =
                      secret.test(name) || secret.test(String(row.key))
                        ? "[已隐藏]"
                        : cleanStored(row.value);
                    const serialized = JSON.stringify(cleaned);
                    const tooLarge =
                      serialized?.length > 10000 ||
                      serialized?.length > remainingChars;
                    const safe = tooLarge ? "[超过大小限制]" : cleaned;
                    if (tooLarge) entry.truncated = true;
                    entry.records.push({
                      key: cleanStored(row.key),
                      value: safe,
                    });
                    remainingRecords--;
                    remainingChars -=
                      safe === cleaned ? serialized?.length || 0 : 0;
                  } catch {
                    entry.records.push({
                      key: "[不可读取]",
                      value: "[不可读取]",
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
    try {
      const names = await caches.keys();
      for (const name of names.slice(0, 20)) {
        emit("cache.snapshot", {
          reason,
          name: secret.test(name) ? "[已隐藏]" : name,
          status: "name_only",
          note: "缓存条目内容未采集",
        });
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
        status: "unavailable",
        error: String(error),
      });
    }
  }
  const initialState = Promise.allSettled([
    captureDatabases("initial"),
    captureCache("initial"),
  ]);
  const onMessage = (msg, _sender, reply) => {
    if (msg.type === "SENSITIVE_CHECK") {
      let elements;
      try {
        elements = collectDom().elements;
      } catch (error) {
        reply({ error: String(error) });
        return;
      }
      const secretText =
        /(?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*\S+|\bBearer\s+[A-Za-z0-9._~+\/-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./i;
      const rects = elements
        .filter(
          (el) =>
            (el.matches(
              'input, textarea, select, [contenteditable]:not([contenteditable="false"])',
            ) &&
              isSensitive(el)) ||
            (!el.children.length && secretText.test(el.textContent || "")),
        )
        .map((el) => el.getBoundingClientRect())
        .filter((rect) => rect.width > 0 && rect.height > 0)
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
      const frames = elements
        .filter((el) => el.localName === "iframe")
        .flatMap((el) => {
          const rect = el.getBoundingClientRect(),
            style = getComputedStyle(el);
          if (
            !rect.width ||
            !rect.height ||
            style.visibility === "hidden" ||
            style.display === "none" ||
            rect.right <= 0 ||
            rect.bottom <= 0 ||
            rect.left >= innerWidth ||
            rect.top >= innerHeight
          )
            return [];
          let node = el,
            safe = true;
          while (node instanceof Element) {
            const css = getComputedStyle(node);
            if (
              css.transform !== "none" ||
              (css.zoom !== "1" && css.zoom !== "normal")
            )
              safe = false;
            node = node.parentElement || node.getRootNode()?.host;
          }
          return [
            {
              url: el.src,
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height,
              borderX: el.clientLeft,
              borderY: el.clientTop,
              clientWidth: el.clientWidth,
              clientHeight: el.clientHeight,
              safe,
            },
          ];
        });
      reply({
        url: location.href,
        rects,
        frames,
        viewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
          scrollX,
          scrollY,
          scale: visualViewport?.scale || 1,
          offsetX: visualViewport?.offsetLeft || 0,
          offsetY: visualViewport?.offsetTop || 0,
        },
      });
    }
    if (msg.type === "FLUSH") {
      clearTimeout(shadowTimer);
      flushDeferredEvents();
      flushScrolls();
      const records = observer.takeRecords();
      if (records.length) processMutations(records);
      clearTimeout(snapshotTimer);
      snapshot("stop");
      abort.abort();
      observer.disconnect();
      clearInterval(storageTimer);
      const snapshots = Promise.allSettled([
        initialState,
        captureDatabases("stop"),
        captureCache("stop"),
      ]);
      Promise.race([
        snapshots.then(() => false),
        new Promise((resolve) => setTimeout(() => resolve(true), 4000)),
      ])
        .then((timedOut) => {
          if (timedOut)
            emit("database.snapshot", {
              reason: "stop",
              status: "timeout",
              note: "站点状态采集超时",
            });
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
      stopped = true;
      abort.abort();
      observer.disconnect();
      clearInterval(storageTimer);
      clearTimeout(timer);
      clearTimeout(snapshotTimer);
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
