export function responseBlob(result, mime) {
  if (typeof result?.body !== "string") throw new Error("浏览器未提供响应内容");
  const type = mime || "application/octet-stream";
  if (!result.base64Encoded)
    return { blob: new Blob([result.body], { type }), representation: "browser-decoded-text", encoding: "utf-8" };
  const parts = [];
  for (let offset = 0; offset < result.body.length; offset += 262144) {
    const binary = atob(result.body.slice(offset, offset + 262144));
    parts.push(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
  }
  return { blob: new Blob(parts, { type }), representation: "browser-provided-bytes", encoding: "binary" };
}
