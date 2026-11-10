export function restorePopoverState(frame) {
  const doc = frame.contentDocument;
  if (!doc) return false;
  const roots = [doc], targets = [];
  for (let i = 0; i < roots.length; i++) {
    for (const node of roots[i].querySelectorAll("*")) {
      if (node.shadowRoot) roots.push(node.shadowRoot);
      if (node.hasAttribute("data-logic-popover-open")) targets.push(node);
    }
  }
  if (targets.length > 100) return false;
  let valid = true;
  for (const node of targets) {
    try {
      if (!node.hasAttribute("popover") || typeof node.showPopover !== "function") valid = false;
      else if (!node.matches(":popover-open")) node.showPopover();
    } catch { valid = false; }
  }
  for (const node of targets) {
    try { if (!node.matches(":popover-open")) valid = false; }
    catch { valid = false; }
  }
  return valid;
}
