import { parseTree } from "jsonc-parser";

export function* observeNetworkQuery(event, evidence) {
  if (event.kind !== "network.request" || typeof event.payload?.url !== "string") return;
  const source = { ...evidence, eventId: event.id, requestId: event.payload.requestId ?? null, bodyPath: "payload.url" };
  let url;
  try { url = new URL(event.payload.url); }
  catch (error) { yield { kind: "sample", source, status: "invalid_query_url", reason: String(error) }; return; }
  if (!url.search) return;
  try { decodeURIComponent(url.search.slice(1).replace(/\+/g, " ")); }
  catch (error) { yield { kind: "sample", source, status: "invalid_query_encoding", reason: String(error) }; return; }
  yield { kind: "sample", source, status: "parsed_query" };
  const occurrences = new Map();
  let index = 0;
  for (const [key] of url.searchParams) {
    const occurrence = occurrences.get(key) || 0;
    occurrences.set(key, occurrence + 1);
    yield { kind: "field", source, location: [{ key, occurrence }], type: "string", queryIndex: index++, encoding: "url-query" };
  }
}

export function* observeNetworkBody(event, evidence, assetSample = null) {
  let body, bodyPath;
  if (event.kind === "network.request") { body = event.payload?.postData; bodyPath = "payload.postData"; }
  else if (event.kind === "network.requestBody" || event.kind === "network.finished") {
    body = event.payload?.body;
    bodyPath = "payload.body";
  } else return;
  const source = { ...evidence, eventId: event.id, requestId: event.payload?.requestId ?? null, bodyPath,
    ...(assetSample ? { assetPath: assetSample.path, decodedAs: "utf-8", representation: body?.representation || null } : {}) };
  if (assetSample?.error) {
    yield { kind: "sample", source, status: "asset_decode_unavailable", reason: assetSample.error };
    return;
  }
  if (assetSample) body = { ...body, value: assetSample.text, encoding: null };
  if (typeof body?.value !== "string" || body.encoding === "base64") {
    yield { kind: "sample", source, status: body?.status || "unavailable", encoding: body?.encoding || null };
    return;
  }
  const contentType = evidence.contentType || Object.entries(event.payload?.headers || {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
  if (/^text\/plain(?:\s*;|\s*$)/i.test(contentType)) {
    const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
    if (charset && !/^utf-?8$/i.test(charset[1] ?? charset[2])) {
      yield { kind: "sample", source, status: "unsupported_text_charset", charset: charset[1] ?? charset[2] };
      return;
    }
    yield { kind: "sample", source, status: "parsed_text", bodyStatus: body.status || null };
    yield { kind: "field", source, location: [], type: "string", offset: 0, length: body.value.length,
      encoding: "text/plain" };
    return;
  }
  if (/^application\/x-www-form-urlencoded(?:\s*;|\s*$)/i.test(contentType)) {
    const charset = /(?:^|;)\s*charset\s*=\s*(?:"([^"]*)"|([^;\s]*))/i.exec(contentType);
    if (charset && !/^utf-?8$/i.test(charset[1] ?? charset[2])) {
      yield { kind: "sample", source, status: "unsupported_form_charset", charset: charset[1] ?? charset[2] };
      return;
    }
    try {
      decodeURIComponent(body.value.replace(/\+/g, " "));
      if (typeof body.value.isWellFormed === "function" && !body.value.isWellFormed()) throw new URIError("invalid string");
    } catch (error) {
      yield { kind: "sample", source, status: "invalid_form_encoding", reason: String(error) };
      return;
    }
    yield { kind: "sample", source, status: "parsed_form_urlencoded", bodyStatus: body.status || null };
    const occurrences = new Map();
    let index = 0;
    for (const [key] of new URLSearchParams(body.value)) {
      const occurrence = occurrences.get(key) || 0;
      occurrences.set(key, occurrence + 1);
      yield { kind: "field", source, location: [{ key, occurrence }], type: "string", formIndex: index++,
        encoding: "application/x-www-form-urlencoded" };
    }
    return;
  }
  let root;
  const errors = [];
  try { root = parseTree(body.value, errors, { disallowComments: true, allowTrailingComma: false }); }
  catch (error) {
    yield { kind: "sample", source, status: "parse_error", reason: String(error) };
    return;
  }
  if (!root || errors.length) {
    yield { kind: "sample", source, status: "not_parsed_as_json", errors };
    return;
  }
  yield { kind: "sample", source, status: "parsed_json", bodyStatus: body.status || null };
  const pending = [{ node: root, location: [] }];
  while (pending.length) {
    const { node, location } = pending.pop();
    yield { kind: "field", source, location, type: node.type, offset: node.offset, length: node.length };
    if (node.type === "array") {
      const children = node.children || [];
      for (let index = children.length - 1; index >= 0; index--)
        pending.push({ node: children[index], location: [...location, { index }] });
    } else if (node.type === "object") {
      const occurrences = new Map(), children = [];
      for (const property of node.children || []) {
        const [name, value] = property.children || [];
        if (!name || !value) continue;
        const occurrence = occurrences.get(name.value) || 0;
        occurrences.set(name.value, occurrence + 1);
        children.push({ node: value, location: [...location, { key: name.value, occurrence }] });
      }
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
}
