import { sanitizeCss } from "./snapshot.js";
import { MAX_INPUT_LENGTH } from "./capture-limits.js";
const forbiddenTags = new Set([
  "script",
  "noscript",
  "iframe",
  "frame",
  "object",
  "embed",
  "base",
  "meta",
  "link",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "use",
  "foreignobject",
]);
const forbiddenAttr =
  /^(on|src$|srcset$|href$|xlink:href$|action$|formaction$|poster$|background$|manifest$|ping$|srcdoc$|data-logic-node$)/i;

function inputNode(doc, target) {
  const selector = target?.selector, path = target?.shadowPath;
  if (Array.isArray(path) && path.length >= 2 && path.length <= 21 &&
      path.every((part) => typeof part === "string" && part.length <= 1024)) {
    let root = doc;
    for (const part of path.slice(0, -1)) {
      const host = root.querySelector(part);
      const template = host && [...host.children].find((child) => child.matches("template[data-logic-shadow-root]"));
      if (!template) return null;
      root = template.content;
    }
    return root.querySelector(path.at(-1));
  }
  return typeof selector === "string" && selector.length <= 1024
    ? doc.querySelector(selector)
    : null;
}

export function applyRecordedMutations(doc, events) {
  const refs = new Map(),
    issues = [],
    rootHosts = new Map(),
    roots = [doc];
  for (let index = 0; index < roots.length; index++) {
    for (const template of roots[index].querySelectorAll("template")) {
      roots.push(template.content);
      rootHosts.set(template.content, template);
    }
  }
  for (const root of roots) {
    for (const element of root.querySelectorAll("[data-logic-node]")) {
      const id = element.getAttribute("data-logic-node");
      if (refs.has(id)) issues.push("节点标识重复");
      else refs.set(id, {
        node: element,
        container: element.matches("template[data-logic-shadow-root]") ? element.content : element,
      });
    }
    const walker = doc.createTreeWalker(root, 128);
    while (walker.nextNode()) {
      const marker = walker.currentNode,
        match = /^logic-(text|comment):(\d+)$/.exec(marker.nodeValue || "");
      if (!match || !marker.nextSibling) continue;
      const expected = match[1] === "text" ? 3 : 8;
      if (marker.nextSibling.nodeType !== expected || refs.has(match[2])) {
        issues.push("文本节点标识无效");
        continue;
      }
      refs.set(match[2], { node: marker.nextSibling, marker });
    }
  }
  function present(node) {
    const seen = new Set();
    while (node && !node.isConnected) {
      const root = node.getRootNode();
      if (seen.has(root)) return false;
      seen.add(root);
      node = rootHosts.get(root);
    }
    return !!node;
  }
  function build(item, budget) {
    if (
      !item ||
      typeof item.id !== "string" ||
      !/^\d+$/.test(item.id) ||
      budget.count++ >= 500
    )
      throw new Error("新增节点无效");
    if (item.type === "text" || item.type === "comment") {
      const marker = doc.createComment(`logic-${item.type}:${item.id}`);
      const node =
        item.type === "text"
          ? doc.createTextNode(String(item.text ?? "").slice(0, 10000))
          : doc.createComment(String(item.text ?? "").slice(0, 10000));
      const fragment = doc.createDocumentFragment();
      fragment.append(marker, node);
      refs.set(item.id, { node, marker });
      return fragment;
    }
    if (
      item.type !== "element" ||
      typeof item.tag !== "string" ||
      !/^[a-z][a-z0-9-]*$/i.test(item.tag) ||
      forbiddenTags.has(item.tag.toLowerCase())
    )
      throw new Error("新增元素不受支持");
    const node = doc.createElement(item.tag);
    node.setAttribute("data-logic-node", item.id);
    refs.set(item.id, { node });
    for (const [name, value] of Object.entries(item.attrs || {}).slice(
      0,
      200,
    )) {
      if (
        !forbiddenAttr.test(name) &&
        /^[a-z_:][a-z0-9_:.-]*$/i.test(name) &&
        typeof value === "string"
      )
        node.setAttribute(
          name,
          name.toLowerCase() === "style"
            ? sanitizeCss(value).slice(0, 10000)
            : value.slice(0, 10000),
        );
    }
    if (!Array.isArray(item.children)) throw new Error("新增元素子节点无效");
    for (const child of item.children)
      node.append(
        build(
          item.tag.toLowerCase() === "style" && child.type === "text"
            ? { ...child, text: sanitizeCss(child.text) }
            : child,
          budget,
        ),
      );
    return node;
  }
  function textMutationMatches(event, index) {
    const expected = event.payload?.value;
    if (typeof expected !== "string" || expected === "[已隐藏]" ||
        ["input", "textarea", "select"].includes(String(event.payload?.target?.tag || "").toLowerCase())) return false;
    let node;
    try { node = inputNode(doc, event.payload?.target); } catch { return false; }
    if (!node?.matches('[contenteditable]:not([contenteditable="false"])')) return false;
    const walker = doc.createTreeWalker(node, 4), texts = [];
    let size = 0;
    while (walker.nextNode()) {
      if (texts.length >= 500) return false;
      size += walker.currentNode.nodeValue?.length || 0;
      if (size > 10000) return false;
      texts.push(walker.currentNode);
    }
    if (texts.length < 2) return false;
    const values = new Map(texts.map((text) => [text, text.nodeValue]));
    for (let i = index + 1; i < Math.min(events.length, index + 201); i++) {
      const later = events[i];
      if (later.time - event.time > 500) break;
      if (later.kind !== "page.mutation") continue;
      if (later.payload?.status !== "captured" || !Array.isArray(later.payload.changes)) return false;
      let changed = false;
      for (const change of later.payload.changes) {
        const target = refs.get(String(change.id))?.node;
        if (!target || (target !== node && !node.contains(target))) continue;
        if (change.type !== "text" || !values.has(target) || typeof change.value !== "string" || change.value.length > 10000) return false;
        size += change.value.length - (values.get(target)?.length || 0);
        if (size > 10000) return false;
        values.set(target, change.value);
        changed = true;
      }
      if (changed && texts.map((text) => values.get(text)).join("") === expected) return true;
    }
    return false;
  }
  function structuralMutationMatches(event, index) {
    const expected = event.payload?.value;
    if (typeof expected !== "string" || expected === "[已隐藏]" || expected.length > MAX_INPUT_LENGTH ||
        ["input", "textarea", "select"].includes(String(event.payload?.target?.tag || "").toLowerCase())) return false;
    let node;
    try { node = inputNode(doc, event.payload?.target); } catch { return false; }
    if (!node?.matches('[contenteditable]:not([contenteditable="false"])') ||
        node.querySelectorAll("*").length > 300 || (node.textContent?.length || 0) > 10000) return false;
    const preview = doc.implementation.createHTMLDocument("");
    const copy = preview.importNode(node, true);
    preview.body.appendChild(copy);
    let count = 0;
    for (let i = index + 1; i < Math.min(events.length, index + 101); i++) {
      const later = events[i];
      if (later.time - event.time > 500) break;
      if (later.kind !== "page.mutation") continue;
      if (later.payload?.status !== "captured" || !Array.isArray(later.payload.changes)) return false;
      const ids = new Set();
      if (copy.hasAttribute("data-logic-node")) ids.add(copy.getAttribute("data-logic-node"));
      for (const element of copy.querySelectorAll("[data-logic-node]")) ids.add(element.getAttribute("data-logic-node"));
      const walker = preview.createTreeWalker(copy, 128);
      while (walker.nextNode()) {
        const match = /^logic-(?:text|comment):(\d+)$/.exec(walker.currentNode.nodeValue || "");
        if (match) ids.add(match[1]);
      }
      const changes = later.payload.changes.filter((change) => change && ids.has(String(change.id)));
      if (!changes.length) continue;
      count += changes.length;
      if (count > 200) return false;
      const result = applyRecordedMutations(preview, [{ kind: "page.mutation", payload: { status: "captured", changes } }]);
      if (result.issues.length || copy.querySelectorAll("*").length > 300 || (copy.textContent?.length || 0) > 10000) return false;
      if (copy.textContent === expected) return true;
    }
    return false;
  }
  let applied = 0;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (["interaction.input", "interaction.change"].includes(event.kind)) {
      if (["truncated", "redacted_truncated"].includes(event.payload?.valueStatus))
        issues.push("输入值超过采集上限，仅还原已记录内容");
      if (!textMutationMatches(event, index) && !structuralMutationMatches(event, index))
        issues.push(...applyRecordedInputs(doc, [event]).issues);
      continue;
    }
    if (event.kind !== "page.mutation") continue;
    if (event.payload?.status !== "captured") issues.push("页面变化记录不完整");
    if (!Array.isArray(event.payload?.changes)) {
      issues.push("页面变化格式无效");
      continue;
    }
    for (const change of event.payload.changes) {
      try {
        const ref = refs.get(String(change.id));
        if (!present(ref?.node)) throw new Error("页面节点缺失");
        if (change.type === "text" && ref.node.nodeType === 3)
          ref.node.nodeValue = (
            ref.node.parentElement?.tagName === "STYLE"
              ? sanitizeCss(change.value)
              : String(change.value ?? "")
          ).slice(0, 10000);
        else if (change.type === "attribute" && ref.node.nodeType === 1) {
          const name = String(change.name || "");
          if (name === "src" && ref.node.tagName === "IMG") {
            if (
              typeof change.value === "string" &&
              /^https?:\/\//i.test(change.value)
            )
              ref.node.setAttribute("data-logic-src", change.value);
            else ref.node.removeAttribute("data-logic-src");
          } else if (
            !forbiddenAttr.test(name) &&
            /^[a-z_:][a-z0-9_:.-]*$/i.test(name)
          ) {
            if (change.value === null) ref.node.removeAttribute(name);
            else
              ref.node.setAttribute(
                name,
                (name.toLowerCase() === "style"
                  ? sanitizeCss(change.value)
                  : String(change.value)
                ).slice(0, 10000),
              );
          }
        } else if (
          change.type === "children" &&
          ref.node.nodeType === 1 &&
          Array.isArray(change.removed) &&
          Array.isArray(change.added)
        ) {
          for (const id of change.removed) {
            const removed = refs.get(String(id));
            if (present(removed?.node)) {
              removed.marker?.remove();
              removed.node.remove();
              refs.delete(String(id));
            } else issues.push("部分已删除节点无法定位");
          }
          const next =
            change.next == null ? null : refs.get(String(change.next));
          if (change.next != null && !present(next?.node))
            throw new Error("插入位置缺失");
          for (const item of change.added)
            (ref.container || ref.node).insertBefore(
              build(item, { count: 0 }),
              next?.marker || next?.node || null,
            );
        } else throw new Error("页面变化不受支持");
        applied++;
      } catch {
        issues.push("部分页面变化无法还原");
      }
    }
  }
  return { applied, issues: [...new Set(issues)] };
}

export function applyRecordedInputs(doc, events) {
  const issues = new Set();
  for (const event of events) {
    const target = event.payload?.target,
      value = event.payload?.value,
      state = event.payload?.formState;
    if (value === "[已隐藏]") continue;
    try {
      const node = inputNode(doc, target);
      if (!node || node.matches('input[type="password"], input[type="file"]'))
        continue;
      if (node.matches("select") && state?.truncated) {
        issues.add("部分选项状态超过采集上限");
        continue;
      }
      if (
        node.matches('input[type="checkbox"], input[type="radio"]') &&
        typeof state?.checked === "boolean"
      ) {
        if (node.type === "radio" && state.checked && node.name) {
          for (const other of node.getRootNode().querySelectorAll('input[type="radio"]'))
            if (
              other !== node &&
              other.name === node.name &&
              other.form === node.form
            ) {
              other.checked = false;
              other.removeAttribute("checked");
            }
        }
        node.checked = state.checked;
        if (state.checked) node.setAttribute("checked", "");
        else node.removeAttribute("checked");
      } else if (
        node.matches("select") &&
        Array.isArray(state?.selectedIndices) &&
        !state.truncated &&
        state.selectedIndices.length <= 200 &&
        state.selectedIndices.every(
          (index) => Number.isInteger(index) && index >= 0,
        )
      ) {
        const indices = new Set(state.selectedIndices);
        [...node.options].forEach((option, index) => {
          option.selected = indices.has(index);
          if (indices.has(index)) option.setAttribute("selected", "");
          else option.removeAttribute("selected");
        });
      } else if (typeof value !== "string") continue;
      else if (node.matches("input"))
        node.setAttribute("value", value.slice(0, MAX_INPUT_LENGTH));
      else if (
        node.matches(
          'textarea, [contenteditable]:not([contenteditable="false"])',
        )
      ) {
        const walker = doc.createTreeWalker(node, 4);
        const first = walker.nextNode();
        if (first && !walker.nextNode()) first.nodeValue = value.slice(0, MAX_INPUT_LENGTH);
        else {
          if (first || node.children.length) issues.add("复杂富文本仅按文本还原");
          node.textContent = value.slice(0, MAX_INPUT_LENGTH);
        }
      }
      else if (node.matches("select"))
        for (const option of node.querySelectorAll("option")) {
          if (option.value === value) option.setAttribute("selected", "");
          else option.removeAttribute("selected");
        }
    } catch {
      /* A selector from the original page may no longer match. */
    }
  }
  return { issues: [...issues] };
}
