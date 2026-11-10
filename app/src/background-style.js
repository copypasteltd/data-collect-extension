import valueParser from "postcss-value-parser";

export function singleBackgroundUrl(value) {
  const nodes = valueParser(String(value || "")).nodes.filter(
    (node) => node.type !== "space" && node.type !== "comment",
  );
  if (
    nodes.length !== 1 ||
    nodes[0].type !== "function" ||
    nodes[0].value.toLowerCase() !== "url"
  )
    return null;
  const parts = nodes[0].nodes.filter(
    (node) => node.type !== "space" && node.type !== "comment",
  );
  if (
    parts.length !== 1 ||
    !["string", "word"].includes(parts[0].type) ||
    !parts[0].value ||
    parts[0].value.includes("\\")
  )
    return null;
  return parts[0].value;
}

export function fontSourceUrls(value) {
  const urls = [];
  valueParser(String(value || "")).walk((node) => {
    if (node.type !== "function" || node.value.toLowerCase() !== "url") return;
    const parts = node.nodes.filter((part) => part.type !== "space" && part.type !== "comment");
    if (parts.length === 1 && ["string", "word"].includes(parts[0].type) &&
        parts[0].value && !/[\\\s<>]/.test(parts[0].value)) urls.push(parts[0].value);
    return false;
  });
  return urls;
}
