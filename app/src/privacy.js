const sensitive =
  /pass(word|wd)?|pwd|token|secret|authorization|cookie|session|credential|api.?key|csrf|xsrf|jwt|验证码|密码|令牌|身份证|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b/i;
export const isSensitive = (key) => sensitive.test(String(key || ""));
export function scrub(value, depth = 0) {
  if (depth > 15) return "[层级过深]";
  if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        isSensitive(k) ? "[已隐藏]" : scrub(v, depth + 1),
      ]),
    );
  return value;
}
export function scrubEventPayload(kind, payload) {
  const result = scrub(payload);
  if (kind === "storage.snapshot") {
    for (const field of ["stores", "coverage"]) {
      const source = payload?.[field]?.sessionStorage;
      if (source && typeof source === "object" && !Array.isArray(source) && result?.[field])
        result[field].sessionStorage = scrub(source);
    }
  }
  return result;
}
export function cleanUrl(raw) {
  try {
    const url = new URL(raw);
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    for (const key of [...url.searchParams.keys()])
      if (isSensitive(key)) url.searchParams.set(key, "[已隐藏]");
    if (/token|secret|password|credential/i.test(url.hash))
      url.hash = "#[已隐藏]";
    return url.href;
  } catch {
    return String(raw || "");
  }
}
export function cleanHeaders(headers = {}, baseUrl) {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => {
      if (isSensitive(k) || /set-cookie/i.test(k)) return [k, "[已隐藏]"];
      if (
        /^(location|content-location|referer|referrer)$/i.test(k) &&
        typeof v === "string"
      ) {
        try {
          return [k, cleanUrl(new URL(v, baseUrl).href)];
        } catch {
          return [k, redactText(v)];
        }
      }
      return [k, v];
    }),
  );
}
export function cleanCookieValue(name, value, enabled) {
  if (!enabled) return { value: "[已隐藏]", status: "omitted_by_policy" };
  if (
    isSensitive(name) ||
    /sessid|csrf|xsrf|jwt|sso|api.?key|(^|[_.-])sid($|[_.-])/i.test(name) ||
    /\bBearer\s|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./i.test(value || "")
  )
    return { value: "[已隐藏]", status: "redacted" };
  if ((value || "").length > 4000)
    return { value: "[超过大小限制]", status: "omitted_size" };
  return { value: redactText(value || ""), status: "captured_best_effort" };
}
export function redactText(value) {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, "Bearer [已隐藏]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[已隐藏]",
    )
    .replace(
      /((?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*)"(?:[^"\\]|\\.)*"/gi,
      '$1"[已隐藏]"',
    )
    .replace(
      /((?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*)'(?:[^'\\]|\\.)*'/gi,
      "$1'[已隐藏]'",
    )
    .replace(
      /((?:password|passwd|pwd|token|secret|authorization|credential|session(?:[_-]?(?:id|token))?|cookie|api[_.-]?key|csrf(?:[_-]?token)?|xsrf(?:[_-]?token)?|jwt|bank.?card|credit.?card|card.?number|cc-number|cc-csc|\bcvv\b|\bcvc\b|verification.?code|one.?time.?code|\botp\b|验证码|密码|令牌)\s*["']?\s*[:=]\s*["']?)([^\s"'&,;<}]+)/gi,
      "$1[已隐藏]",
    );
}
function cleanHtml(body) {
  const document = parse(body);
  const walk = (node) => {
    const attrs = node.attrs || [];
    const lookup = Object.fromEntries(
      attrs.map((attr) => [attr.name.toLowerCase(), attr.value]),
    );
    const sensitiveElement =
      isSensitive(
        [
          lookup.name,
          lookup.id,
          lookup.placeholder,
          lookup["aria-label"],
          lookup.autocomplete,
        ].join(" "),
      ) ||
      lookup.type?.toLowerCase() === "password" ||
      lookup.autocomplete?.toLowerCase() === "one-time-code";
    for (const attr of attrs) {
      if (
        isSensitive(attr.name) ||
        (sensitiveElement &&
          ["value", "content", "placeholder"].includes(attr.name.toLowerCase()))
      )
        attr.value = "[已隐藏]";
      else attr.value = redactText(attr.value);
    }
    if (
      sensitiveElement &&
      (node.tagName === "textarea" ||
        (Object.hasOwn(lookup, "contenteditable") &&
          lookup.contenteditable.toLowerCase() !== "false"))
    )
      node.childNodes = [
        { nodeName: "#text", value: "[已隐藏]", parentNode: node },
      ];
    else
      for (const child of node.childNodes || []) {
        if (child.nodeName === "#text") child.value = redactText(child.value);
        else walk(child);
      }
    if (node.content) walk(node.content);
  };
  walk(document);
  return serialize(document);
}
export function cleanBody(body, contentType = "") {
  if (!body) return { value: null, status: "empty" };
  if (body.length > 1000000) return { value: null, status: "omitted_size" };
  if (/json/i.test(contentType)) {
    try {
      return {
        value: JSON.stringify(scrub(JSON.parse(body))),
        status: "captured_redacted",
      };
    } catch {
      return { value: null, status: "omitted_unparseable" };
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType)) {
    const params = new URLSearchParams(body);
    for (const key of [...params.keys()])
      if (isSensitive(key)) params.set(key, "[已隐藏]");
    return { value: params.toString(), status: "captured_redacted" };
  }
  if (/html/i.test(contentType)) {
    try {
      return {
        value: cleanHtml(body),
        status: "captured_redacted_best_effort",
      };
    } catch {
      return { value: null, status: "omitted_unparseable" };
    }
  }
  if (/^text\/|javascript|xml|graphql/i.test(contentType))
    return { value: redactText(body), status: "captured_redacted_best_effort" };
  return { value: null, status: "omitted_type" };
}
export function cleanRealtimeText(payload) {
  const json = cleanBody(payload, "application/json");
  if (json.status !== "omitted_unparseable")
    return json.value == null
      ? json
      : { ...json, value: redactText(json.value) };
  return cleanBody(payload, "text/plain");
}
export function cleanWebSocketFrame(payload, opcode) {
  return opcode === 1
    ? cleanRealtimeText(payload)
    : { value: null, status: "omitted_binary" };
}
import { parse, serialize } from "parse5";
