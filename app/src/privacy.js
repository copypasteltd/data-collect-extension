// These compatibility names are used by the collectors; new recordings retain raw values.
export const cleanUrl = (raw) => String(raw || "");
export const cleanHeaders = (headers = {}) => ({ ...headers });

export function cleanCookieValue(_name, value) {
  return { value: value || "", status: "captured" };
}

export function cleanBody(body) {
  if (body == null || body === "") return { value: body ?? null, status: "empty" };
  if (body.length > 1000000) return { value: null, status: "omitted_size" };
  return { value: body, status: "captured" };
}

export function cleanRealtimeText(payload) {
  return cleanBody(payload);
}

export function cleanWebSocketFrame(payload, opcode) {
  if (opcode === 1) return cleanRealtimeText(payload);
  if (typeof payload !== "string") return { value: null, status: "unavailable" };
  if (payload.length > 1333336) return { value: null, status: "omitted_size" };
  return { value: payload, encoding: "base64", status: "captured" };
}
