import { parse, serialize } from "parse5";

const forbidden = new Set([
  "script",
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
const unsafeAttribute =
  /^(on|src$|srcset$|href$|xlink:href$|action$|formaction$|poster$|background$|manifest$|ping$|srcdoc$|data-logic-popover-open$)/i;
export const sanitizeCss = (css) =>
  String(css || "")
    .replace(/@import[^;]*(;|$)/gi, "")
    .replace(/url\s*\([^)]*\)/gi, "none")
    .replace(/<\/style/gi, "<\\2f style");

export function sanitizeSnapshotHtml(html) {
  const document = parse(String(html || ""));
  const walk = (node) => {
    if (node.attrs)
      node.attrs = node.attrs
        .filter((attr) => !unsafeAttribute.test(attr.name))
        .map((attr) =>
          attr.name.toLowerCase() === "style"
            ? { ...attr, value: sanitizeCss(attr.value) }
            : attr,
        );
    if (node.childNodes) {
      node.childNodes = node.childNodes.filter(
        (child) => !forbidden.has((child.tagName || "").toLowerCase()),
      );
      for (const child of node.childNodes) {
        if (
          (node.tagName || "").toLowerCase() === "style" &&
          child.nodeName === "#text"
        )
          child.value = sanitizeCss(child.value);
        else walk(child);
      }
    }
    if (node.content) walk(node.content);
  };
  walk(document);
  return serialize(document);
}
