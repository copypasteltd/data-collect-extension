import * as csstree from "css-tree";
import { cleanUrl } from "./privacy.js";

// Rebuild only font descriptors and recorded sources; never trust imported CSS as markup.
export function recordedFontFaces(css, stylesheetUrl, resolveFont) {
  let root;
  try { root = csstree.parse(css); } catch { return { css: "", missing: 0 }; }
  const output = [];
  let missing = 0, count = 0;
  csstree.walk(root, { visit: "Atrule", enter(rule) {
    if (rule.name.toLowerCase() !== "font-face" || !rule.block) return;
    if (++count > 100) { missing++; return; }
    const face = [];
    const sources = [];
    for (const decl of rule.block.children) {
      if (decl.type !== "Declaration") continue;
      const name = decl.property.toLowerCase();
      if (name === "src") {
        let found = false;
        csstree.walk(decl.value, { visit: "Url", enter(node) {
          found = true;
          const raw = node.value;
          if (!raw || /[\\\s<>]/.test(raw) || sources.length >= 10) { missing++; return; }
          try {
            const url = new URL(raw, stylesheetUrl);
            url.hash = "";
            if (!/^https?:$/.test(url.protocol)) { missing++; return; }
            const data = resolveFont(cleanUrl(url.href));
            if (typeof data === "string" && /^data:font\/woff2?;base64,[a-z0-9+/]+=*$/i.test(data)) sources.push(`url("${data}")`);
            else missing++;
          } catch { missing++; }
        }});
        if (!found) missing++;
      } else if (["font-family", "font-style", "font-weight", "font-stretch", "font-display", "unicode-range"].includes(name)) {
        const value = csstree.generate(decl.value);
        if (value.length <= 500 && !/[{};<>\\\u0000-\u001f]/.test(value)) face.push({ name, value });
      }
    }
    if (sources.length && face.some((item) => item.name === "font-family")) {
      output.push(`@font-face{${face.map(({ name, value }) => `${name}:${value};`).join("")}src:${sources.join(",")};}`);
    }
  }});
  return { css: output.join("\n"), missing };
}

export function recordedFontMetadata(value, resolveFont) {
  let faces;
  try {
    if (typeof value !== "string" || value.length > 10000) throw new Error();
    faces = JSON.parse(value);
    if (!Array.isArray(faces) || faces.length > 100) throw new Error();
  } catch { return { css: "", missing: 1 }; }
  const output = [];
  let missing = 0;
  for (const face of faces) {
    if (!face || !face.descriptors || typeof face.descriptors !== "object" || Array.isArray(face.descriptors) || !Array.isArray(face.sources) || face.sources.length > 10) {
      missing++;
      continue;
    }
    const descriptors = [];
    for (const key of ["font-family", "font-style", "font-weight", "font-stretch", "font-display", "unicode-range"]) {
      const item = face.descriptors[key];
      if (typeof item === "string" && item.length <= 500 && !/[{};<>\\\u0000-\u001f]/.test(item)) descriptors.push(`${key}:${item};`);
    }
    if (!descriptors.some((item) => item.startsWith("font-family:"))) { missing++; continue; }
    const sources = [];
    if (!face.sources.length) missing++;
    for (const source of face.sources) {
      try {
        if (typeof source !== "string" || /[\\\s<>]/.test(source)) throw new Error();
        const url = new URL(source);
        if (!/^https?:$/.test(url.protocol)) throw new Error();
        url.hash = "";
        const data = resolveFont(cleanUrl(url.href));
        if (typeof data !== "string" || !/^data:font\/woff2?;base64,[a-z0-9+/]+=*$/i.test(data)) throw new Error();
        sources.push(`url("${data}")`);
      } catch { missing++; }
    }
    if (sources.length) output.push(`@font-face{${descriptors.join("")}src:${sources.join(",")};}`);
  }
  return { css: output.join("\n"), missing };
}
