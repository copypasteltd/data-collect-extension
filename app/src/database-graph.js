function base64(bytes) {
  const parts = [];
  for (let offset = 0; offset < bytes.length; offset += 49152)
    parts.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 49152))));
  return parts.join("");
}

export async function encodeDatabaseGraph(input) {
  const seen = new WeakMap(), nodes = [], pending = [], issues = [];
  function reference(value) {
    if (value === null) return { type: "null" };
    if (typeof value === "string" || typeof value === "boolean") return { type: typeof value, value };
    if (typeof value === "number") return { type: "number", value: Object.is(value, -0) ? "-0" : String(value) };
    if (typeof value === "bigint") return { type: "bigint", value: String(value) };
    if (typeof value === "undefined") return { type: "undefined" };
    if (typeof value !== "object") {
      issues.push(`unsupported:${typeof value}`);
      return { type: "unsupported", value: typeof value };
    }
    if (seen.has(value)) return { type: "ref", id: seen.get(value) };
    const id = nodes.length;
    seen.set(value, id);
    const node = { id, type: "pending" };
    nodes.push(node);
    pending.push({ value, node });
    return { type: "ref", id };
  }
  const root = reference(input);
  for (let index = 0; index < pending.length; index++) {
    const { value, node } = pending[index];
    if (value instanceof Date) {
      Object.assign(node, { type: "date", value: Number.isFinite(value.getTime()) ? value.toISOString() : null });
    } else if (value instanceof RegExp) {
      Object.assign(node, { type: "regexp", source: value.source, flags: value.flags, lastIndex: value.lastIndex });
    } else if (value instanceof ArrayBuffer) {
      Object.assign(node, { type: "array-buffer", size: value.byteLength, encoding: "base64", data: base64(new Uint8Array(value)) });
    } else if (ArrayBuffer.isView(value)) {
      Object.assign(node, { type: "view", kind: value.constructor.name, buffer: reference(value.buffer),
        byteOffset: value.byteOffset, byteLength: value.byteLength,
        ...(typeof value.length === "number" ? { length: value.length } : {}) });
    } else if (value instanceof Blob) {
      const isFile = typeof File !== "undefined" && value instanceof File;
      const bytes = new Uint8Array(await value.arrayBuffer());
      Object.assign(node, { type: isFile ? "file" : "blob", mime: value.type, size: value.size, encoding: "base64", data: base64(bytes),
        ...(isFile ? { name: value.name, lastModified: value.lastModified } : {}) });
    } else if (value instanceof Map) {
      Object.assign(node, { type: "map", entries: [...value].map(([key, item]) => [reference(key), reference(item)]) });
    } else if (value instanceof Set) {
      Object.assign(node, { type: "set", values: [...value].map(reference) });
    } else if (Array.isArray(value)) {
      Object.assign(node, { type: "array", length: value.length, entries: Object.keys(value).map((key) => [key, reference(value[key])]) });
    } else if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) {
      Object.assign(node, { type: "object", nullPrototype: Object.getPrototypeOf(value) === null,
        entries: Object.keys(value).map((key) => [key, reference(value[key])]) });
    } else {
      const kind = Object.prototype.toString.call(value);
      issues.push(`unsupported:${kind}`);
      Object.assign(node, { type: "unsupported", kind });
    }
  }
  return { version: 1, root, nodes, issues };
}
