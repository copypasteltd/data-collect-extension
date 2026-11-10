import { it } from "node:test";
import assert from "node:assert/strict";
import { cleanDebuggerResponse } from "../src/response-body.js";

it("解码 Base64 文本并保留原始字段值", () => {
  const body = Buffer.from("customer=C001&token=private").toString("base64");
  const result = cleanDebuggerResponse(
    { body, base64Encoded: true },
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
    },
  );
  assert.equal(result.status, "captured");
  const parsed = new URLSearchParams(result.value);
  assert.equal(parsed.get("customer"), "C001");
  assert.equal(parsed.get("token"), "private");
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
    token: "private",
    nested: { password: "secret" },
  });
  assert.deepEqual(cleanDebuggerResponse({ body: "AQID", base64Encoded: true }, { mimeType: "application/octet-stream" }),
    { value: "AQID", encoding: "base64", status: "captured" });
});

it("按声明的字符集解码，无法解码时保留原始字节", () => {
  const response = { headers: { "content-type": 'text/plain; charset="gbk"' } };
  assert.equal(
    cleanDebuggerResponse({ body: "1tDOxA==", base64Encoded: true }, response)
      .value,
    "中文",
  );
  assert.deepEqual(
    cleanDebuggerResponse(
      { body: "//7/", base64Encoded: true },
      { mimeType: "text/plain" },
    ),
    { value: "//7/", encoding: "base64", status: "captured", textStatus: "unavailable_encoding" },
  );
  assert.deepEqual(
    cleanDebuggerResponse(
      { body: "eA==", base64Encoded: true },
      { headers: { "Content-Type": "text/plain; charset=unknown-charset" } },
    ),
    { value: "eA==", encoding: "base64", status: "captured", textStatus: "unavailable_encoding" },
  );
  assert.equal(
    cleanDebuggerResponse({ body: "!", base64Encoded: true }, response).status,
    "omitted_encoding",
  );
  const large = Buffer.from("x".repeat(1000001)).toString("base64");
  assert.deepEqual(cleanDebuggerResponse({ body: large, base64Encoded: true }, { mimeType: "text/plain" }),
    { value: large, encoding: "base64", status: "captured", textStatus: "omitted_size" });
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
