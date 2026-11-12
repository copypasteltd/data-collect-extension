export function rawMutationComplete(event, fragmentComplete) {
  const changes = event.payload?.rawChanges;
  if (!Array.isArray(changes)) return false;
  const available = (item, inlineKey) => {
    if (item?.status === "fragmented") return fragmentComplete(item.reference);
    return item?.status === "captured" && Object.hasOwn(item, inlineKey);
  };
  for (const change of changes) {
    if (change.type === "attribute" || change.type === "text") {
      if (!available(change.before, "value") || !available(change.value, "value")) return false;
    } else if (change.type === "children") {
      if (!Array.isArray(change.added) || !Array.isArray(change.removed) ||
          [...change.added, ...change.removed].some((node) => !available(node, "data"))) return false;
    } else return false;
  }
  return true;
}
