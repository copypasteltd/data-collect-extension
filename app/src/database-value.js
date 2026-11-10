export function encodeDatabaseValue(input, cleanText) {
  const issues = new Set();
  const ancestors = new WeakSet();
  let nodes = 0;
  const limit = (issue, value) => {
    issues.add(issue);
    return value;
  };
  function encode(value, depth) {
    if (++nodes > 2000) return limit("node_limit", "[内容过多]");
    if (depth > 12) return limit("depth_limit", "[层级过深]");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "string") {
      if (value.length > 10000) issues.add("string_limit");
      return cleanText(value);
    }
    if (typeof value === "number")
      return Number.isFinite(value) ? value : { $type: "number", value: String(value) };
    if (typeof value === "bigint") return { $type: "bigint", value: String(value) };
    if (typeof value === "undefined") return { $type: "undefined" };
    if (typeof value !== "object")
      return limit("unsupported_type", "[类型未采集]");
    if (value instanceof Date) {
      if (!Number.isFinite(value.getTime()))
        return { $type: "date", value: "invalid" };
      return value.toISOString();
    }
    if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      const size = value instanceof Blob ? value.size : value.byteLength;
      const kind = value instanceof Blob ? "Blob" : value.constructor.name;
      return limit("binary_omitted", { $type: "binary", kind, size });
    }
    if (value instanceof RegExp)
      return { $type: "regexp", source: encode(value.source, depth + 1), flags: value.flags };
    if (ancestors.has(value))
      return limit("circular_reference", "[循环引用未采集]");
    ancestors.add(value);
    try {
      if (value instanceof Map) {
        if (value.size > 200) issues.add("entry_limit");
        const entries = [];
        for (const [key, item] of value) {
          if (entries.length >= 200) break;
          entries.push([
            encode(key, depth + 1),
            encode(item, depth + 1),
          ]);
        }
        return { $type: "map", entries };
      }
      if (value instanceof Set) {
        if (value.size > 200) issues.add("entry_limit");
        const values = [];
        for (const item of value) {
          if (values.length >= 200) break;
          values.push(encode(item, depth + 1));
        }
        return { $type: "set", values };
      }
      if (Array.isArray(value)) {
        if (value.length > 200) issues.add("entry_limit");
        return value.slice(0, 200).map((item) => encode(item, depth + 1));
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return limit("unsupported_type", { $type: "unsupported", kind: Object.prototype.toString.call(value) });
      const entries = Object.entries(value);
      if (entries.length > 200) issues.add("entry_limit");
      return Object.fromEntries(entries.slice(0, 200).map(([key, item]) => [
        key,
        encode(item, depth + 1),
      ]));
    } finally {
      ancestors.delete(value);
    }
  }
  return { value: encode(input, 0), issues: [...issues] };
}
