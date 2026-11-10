import { MAX_INPUT_LENGTH } from "./capture-limits.js";
import { normalizeNumericConstraint, readNumericConstraints } from "./numeric-constraints.js";

function unique(root, selector) {
  if (typeof selector !== "string" || !selector || selector.length > 1024) return null;
  const nodes = root.querySelectorAll(selector);
  return nodes.length === 1 ? nodes[0] : null;
}

export function resolveReplayTarget(doc, target) {
  try {
    const path = target?.shadowPath;
    let node;
    if (Array.isArray(path) && path.length >= 2 && path.length <= 21) {
      let root = doc;
      for (const selector of path.slice(0, -1)) {
        const host = unique(root, selector);
        if (!host?.shadowRoot) return null;
        root = host.shadowRoot;
      }
      node = unique(root, path.at(-1));
    } else node = unique(doc, target?.selector);
    if (!node || (target?.tag && node.localName !== target.tag)) return null;
    if (target?.nodeId && node.getAttribute("data-logic-node") !== target.nodeId) return null;
    if (target?.type && String(node.getAttribute("type") || "").toLowerCase() !== String(target.type).toLowerCase()) return null;
    return node;
  } catch { return null; }
}

export function attachPageReplay(frame, step, options) {
  const doc = frame.contentDocument;
  if (!doc) return { ok: false, reason: "页面快照不可访问" };
  const node = resolveReplayTarget(doc, step.payload?.target);
  if (!node) return { ok: false, reason: "当前操作的页面元素无法唯一定位" };
  const { control, canType, inputBefore, choiceInitial, onInput, onChoice, onSelection, onNext } = options;
  const constraints = step.payload?.target?.numericConstraints;
  if (canType && node.localName === "input" && ["range", "number"].includes(node.type) && constraints && typeof constraints === "object") {
    const current = readNumericConstraints(node);
    if (["min", "max", "step"].some((name) => current[name] !== normalizeNumericConstraint(name, constraints[name])))
      return { ok: false, reason: "页面快照中的数值范围与操作记录不一致" };
  }
  let clickable = step.kind === "interaction.click";
  if (step.kind === "interaction.submit" && node.localName === "form") {
    const submitters = node.querySelectorAll('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]');
    for (const submitter of submitters) submitter.removeAttribute("disabled");
    clickable = submitters.length > 0;
  }
  if (!clickable && !control && !canType) return { ok: false, reason: "当前操作无法在页面快照中执行" };
  if (control?.kind === "select") {
    if (node.localName !== "select" || node.options.length !== control.options.length ||
        !control.options.every((option, index) => {
          const item = node.options[index];
          return item.label === option.label && (option.id == null || item.getAttribute("data-logic-node") === option.id) &&
            (option.value == null || item.value === option.value);
        })) return { ok: false, reason: "页面快照中的选项与操作记录不一致" };
    if (!choiceInitial.status) {
      const selected = new Set(choiceInitial.selected);
      [...node.options].forEach((option, index) => { option.selected = selected.has(index); });
    }
  } else if (control && (node.localName !== "input" || node.type !== control.kind))
    return { ok: false, reason: "页面快照中的控件与操作记录不一致" };
  else if (control && !choiceInitial.status) node.checked = choiceInitial.checked;
  if (canType && typeof step.payload.beforeValue === "string" && !["redacted", "redacted_truncated"].includes(step.payload.beforeValueStatus) && step.payload.beforeValue.length <= MAX_INPUT_LENGTH) {
    if (node.isContentEditable) node.textContent = inputBefore.value;
    else if ("value" in node) node.value = inputBefore.value;
  }
  const actionable = node.closest("button,input,select,textarea") || node;
  actionable.removeAttribute("disabled");
  if (actionable.matches(":disabled")) return { ok: false, reason: "页面快照中的控件不可操作" };
  node.style?.setProperty("outline", "2px solid #168267", "important");
  node.style?.setProperty("outline-offset", "2px", "important");
  const contains = (event) => event.composedPath().includes(node);
  doc.addEventListener("submit", (event) => { event.preventDefault(); event.stopPropagation(); }, true);
  doc.addEventListener("click", (event) => {
    if (!contains(event)) { event.preventDefault(); event.stopPropagation(); return; }
    if (clickable) { event.preventDefault(); event.stopPropagation(); onNext(); }
    else if (!control && !canType) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  doc.addEventListener("beforeinput", (event) => {
    if (!canType || !contains(event)) event.preventDefault();
  }, true);
  doc.addEventListener("input", (event) => {
    if (!canType || !contains(event)) return;
    onInput(node.isContentEditable ? node.innerText : node.value);
  }, true);
  doc.addEventListener("change", (event) => {
    if (!control || !contains(event)) return;
    if (control.kind === "select")
      onSelection([...node.options].flatMap((option, index) => option.selected ? [index] : []));
    else onChoice(node.checked);
  }, true);
  return { ok: true };
}
