export function fontMime(bytes) {
  if (!bytes || bytes.length < 4 || bytes.length > 1500000) return null;
  const signature = String.fromCharCode(...bytes.subarray(0, 4));
  return signature === "wOFF" ? "font/woff" : signature === "wOF2" ? "font/woff2" : null;
}
