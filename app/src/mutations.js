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
  /^(on|src$|srcset$|href$|xlink:href$|action$|formaction$|poster$|background$|manifest$|ping$|srcdoc$|data-logic-node$|data-logic-popover-open$|data-logic-dialog-modal$)/i;

function inputNode(doc, target) {
  const unique = (root, selector) => {
    if (typeof selector !== "string" || !selector || selector.length > 1024) return null;
    const nodes = root.querySelectorAll(selector);
    return nodes.length === 1 ? nodes[0] : null;
  };
  const selector = target?.selector, path = target?.shadowPath;
  let node;
  if (Array.isArray(path) && path.length >= 2 && path.length <= 21 &&
      path.every((part) => typeof part === "string" && part.length <= 1024)) {
    let root = doc;
    for (const part of path.slice(0, -1)) {
      const host = unique(root, part);
      const templates = host && [...host.children].filter((child) => child.matches("template[data-logic-shadow-root]"));
      if (templates?.length !== 1) return null;
      root = templates[0].content;
    }
    node = unique(root, path.at(-1));
  } else node = unique(doc, selector);
  if (!node || (target?.tag && node.localName !== target.tag) ||
      (target?.nodeId && node.getAttribute("data-logic-node") !== target.nodeId) ||
      (target?.type && String(node.getAttribute("type") || "").toLowerCase() !== String(target.type).toLowerCase())) return null;
  return node;
}

export function applyRecordedMutations(doc, events, popover, dialog) {
  const refs = new Map(),
    duplicates = new Set(),
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
      if (refs.has(id)) { duplicates.add(id); issues.push("节点标识重复"); }
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
        if (refs.has(match[2])) duplicates.add(match[2]);
        issues.push("文本节点标识无效");
        continue;
      }
      refs.set(match[2], { node: marker.nextSibling, marker });
    }
  }
  if (popover != null) {
    if (!Array.isArray(popover.open) || popover.open.length > 100)
      issues.push("弹出层状态格式无效或超过上限");
    for (const id of Array.isArray(popover.open) ? popover.open.slice(0, 100) : []) {
      const node = typeof id === "string" && /^\d{1,16}$/.test(id) && !duplicates.has(id) ? refs.get(id)?.node : null;
      if (!node || node.nodeType !== 1 || !node.hasAttribute("popover")) issues.push("弹出层目标无法确认");
      else node.setAttribute("data-logic-popover-open", "1");
    }
  }
  if (dialog != null) {
    if (!Array.isArray(dialog.modal) || dialog.modal.length > 100)
      issues.push("模态对话框状态格式无效或超过上限");
    for (const id of Array.isArray(dialog.modal) ? dialog.modal.slice(0, 100) : []) {
      const node = typeof id === "string" && /^\d{1,16}$/.test(id) && !duplicates.has(id) ? refs.get(id)?.node : null;
      if (!node || node.localName !== "dialog" || !node.hasAttribute("open")) issues.push("模态对话框目标无法确认");
      else node.setAttribute("data-logic-dialog-modal", "1");
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
      if (refs.has(item.id)) duplicates.add(item.id);
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
    if (refs.has(item.id)) duplicates.add(item.id);
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
    if (typeof expected !== "string" || ["redacted", "redacted_truncated"].includes(event.payload?.valueStatus) ||
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
    if (typeof expected !== "string" || ["redacted", "redacted_truncated"].includes(event.payload?.valueStatus) || expected.length > MAX_INPUT_LENGTH ||
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
    if (event.kind === "page.popover") {
      const id = event.payload?.targetNodeId;
      const node = typeof id === "string" && /^\d{1,16}$/.test(id) && !duplicates.has(id) ? refs.get(id)?.node : null;
      if (!present(node) || node.nodeType !== 1 || !node.hasAttribute("popover") || typeof event.payload?.open !== "boolean")
        issues.push("弹出层状态无法确认");
      else if (event.payload.open) node.setAttribute("data-logic-popover-open", "1");
      else node.removeAttribute("data-logic-popover-open");
      continue;
    }
    if (event.kind === "page.dialog") {
      const id = event.payload?.targetNodeId;
      const node = typeof id === "string" && /^\d{1,16}$/.test(id) && !duplicates.has(id) ? refs.get(id)?.node : null;
      const { open, modal } = event.payload || {};
      if (!present(node) || node.localName !== "dialog" || typeof open !== "boolean" ||
          typeof modal !== "boolean" || (modal && !open)) issues.push("对话框状态无法确认");
      else {
        if (open) node.setAttribute("open", ""); else node.removeAttribute("open");
        if (modal) node.setAttribute("data-logic-dialog-modal", "1"); else node.removeAttribute("data-logic-dialog-modal");
      }
      continue;
    }
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
            if (name.toLowerCase() === "popover") ref.node.removeAttribute("data-logic-popover-open");
            if (name.toLowerCase() === "open" && ref.node.localName === "dialog") ref.node.removeAttribute("data-logic-dialog-modal");
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
    if (["redacted", "redacted_truncated"].includes(event.payload?.valueStatus) || target?.sensitive) continue;
    try {
      const node = inputNode(doc, target);
      if (!node) {
        issues.add("输入或选择的目标无法唯一确认");
        continue;
      }
      if (node.matches('input[type="file"]'))
        continue;
      if (node.matches("select") && (state?.truncated || state?.optionsTruncated)) {
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
      } else if (node.matches("select")) {
        let indices;
        if (Array.isArray(state?.selectedIndices)) {
          const options = state.options;
          const signatures = new Map();
          if (Array.isArray(options) && options.length <= 200) for (const item of options) {
            const signature = JSON.stringify([item?.label, item?.value]);
            signatures.set(signature, (signatures.get(signature) || 0) + 1);
          }
          const validOptions = Array.isArray(options) && options.length <= 200 && options.length === node.options.length &&
            (typeof state.multiple !== "boolean" || state.multiple === node.multiple) &&
            options.every((item, index) => {
              const option = node.options[index];
              if (!item || item.uncertain || typeof item.label !== "string" || item.label !== option.label ||
                  typeof item.value !== "string" || item.value !== option.value) return false;
              if (typeof item.id === "string" && item.id)
                return item.id === option.getAttribute("data-logic-node");
              return signatures.get(JSON.stringify([item.label, item.value])) === 1;
            });
          if (!validOptions || state.selectedIndices.length > 200 ||
              (!node.multiple && state.selectedIndices.length !== 1) ||
              new Set(state.selectedIndices).size !== state.selectedIndices.length ||
              !state.selectedIndices.every((index) => Number.isInteger(index) && index >= 0 && index < node.options.length)) {
            issues.add("选项身份或选择状态无法确认，未还原选择");
            continue;
          }
          indices = new Set(state.selectedIndices);
        } else {
          const matches = typeof value === "string" && !node.multiple &&
            !["redacted", "truncated", "redacted_truncated"].includes(event.payload?.valueStatus)
            ? [...node.options].flatMap((option, index) => option.value === value ? [index] : []) : [];
          if (matches.length !== 1) {
            issues.add("选项身份或选择状态无法确认，未还原选择");
            continue;
          }
          indices = new Set(matches);
        }
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
    } catch {
      issues.add("输入或选择的目标无法唯一确认");
    }
  }
  return { issues: [...issues] };
}
