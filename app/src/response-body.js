import { cleanBody } from "./privacy.js";

function header(headers, name) {
  const value = Object.entries(headers || {}).find(
    ([key]) => key.toLowerCase() === name,
  )?.[1];
  return typeof value === "string" ? value : "";
}

export function cleanDebuggerResponse(result, response = {}, method = "") {
  if (typeof result?.body !== "string")
    return {
      value: null,
      status: "unavailable",
      reason: "浏览器未提供响应内容",
    };
  const headers = response.headers || {},
    contentType = header(headers, "content-type") || response.mimeType || "",
    bodyType = response.mimeType || contentType,
    length = header(headers, "content-length"),
    encoding = header(headers, "content-encoding");
  if (
    result.body === "" &&
    /^\d+$/.test(length) &&
    Number(length) > 0 &&
    (!encoding || encoding.toLowerCase() === "identity") &&
    method.toUpperCase() !== "HEAD" &&
    Number(response.status) >= 200 &&
    ![204, 205, 304].includes(Number(response.status))
  )
    return {
      value: null,
      status: "unavailable",
      reason: "浏览器返回空响应，但声明长度非零",
    };
  if (!result.base64Encoded) return cleanBody(result.body, bodyType);
  if (result.body.length > 5333336)
    return { value: null, status: "omitted_size" };
  try {
    const binary = atob(result.body);
    if (binary.length > 4000000) return { value: null, status: "omitted_size" };
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const match =
      /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(
        contentType,
      );
    const charset = match?.[1] || match?.[2] || match?.[3] || "utf-8";
    return cleanBody(
      new TextDecoder(charset, { fatal: true }).decode(bytes),
      bodyType,
    );
  } catch {
    return { value: null, status: "omitted_encoding" };
  }
}
