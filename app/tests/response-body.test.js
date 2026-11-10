import { it } from "node:test";
import assert from "node:assert/strict";
import { cleanDebuggerResponse } from "../src/response-body.js";

it("解码 Base64 文本并继续脱敏", () => {
  const body = Buffer.from("customer=C001&token=private").toString("base64");
  const result = cleanDebuggerResponse(
    { body, base64Encoded: true },
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
    },
  );
  assert.equal(result.status, "captured_redacted");
  const parsed = new URLSearchParams(result.value);
  assert.equal(parsed.get("customer"), "C001");
  assert.equal(parsed.get("token"), "[已隐藏]");
  const sniffed = cleanDebuggerResponse(
    { body: "b2s=", base64Encoded: true },
    {
      mimeType: "text/plain",
      headers: { "Content-Type": "application/octet-stream" },
    },
  );
  assert.equal(sniffed.value, "ok");
  const json = Buffer.from(
    JSON.stringify({
      customer: "客户",
      token: "private",
      nested: { password: "secret" },
    }),
  ).toString("base64");
  const decoded = cleanDebuggerResponse(
    { body: json, base64Encoded: true },
    { mimeType: "application/json" },
  );
  assert.deepEqual(JSON.parse(decoded.value), {
    customer: "客户",
    token: "[已隐藏]",
    nested: { password: "[已隐藏]" },
  });
});

it("按声明的字符集解码，并拒绝无效或不支持的编码", () => {
  const response = { headers: { "content-type": 'text/plain; charset="gbk"' } };
  assert.equal(
    cleanDebuggerResponse({ body: "1tDOxA==", base64Encoded: true }, response)
      .value,
    "中文",
  );
  assert.equal(
    cleanDebuggerResponse(
      { body: "//7/", base64Encoded: true },
      { mimeType: "text/plain" },
    ).status,
    "omitted_encoding",
  );
  assert.equal(
    cleanDebuggerResponse(
      { body: "eA==", base64Encoded: true },
      { headers: { "Content-Type": "text/plain; charset=unknown-charset" } },
    ).status,
    "omitted_encoding",
  );
  assert.equal(
    cleanDebuggerResponse({ body: "!", base64Encoded: true }, response).status,
    "omitted_encoding",
  );
});

it("限制解码体积，并辨别可疑空响应与合法空响应", () => {
  assert.equal(
    cleanDebuggerResponse(
      { body: "A".repeat(5333337), base64Encoded: true },
      { mimeType: "text/plain" },
    ).status,
    "omitted_size",
  );
  const nonempty = {
    status: 200,
    mimeType: "text/plain",
    headers: { "Content-Length": "3" },
  };
  assert.equal(
    cleanDebuggerResponse({ body: "", base64Encoded: false }, nonempty, "GET")
      .status,
    "unavailable",
  );
  assert.equal(
    cleanDebuggerResponse({ body: "", base64Encoded: false }, nonempty, "HEAD")
      .status,
    "empty",
  );
  assert.equal(
    cleanDebuggerResponse(
      { body: "", base64Encoded: false },
      { ...nonempty, status: 304 },
      "GET",
    ).status,
    "empty",
  );
  assert.equal(
    cleanDebuggerResponse(
      { body: "", base64Encoded: false },
      {
        ...nonempty,
        headers: { "content-length": "20", "content-encoding": "gzip" },
      },
      "GET",
    ).status,
    "empty",
  );
});
