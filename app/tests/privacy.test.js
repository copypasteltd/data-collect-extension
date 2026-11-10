import { it } from "node:test";
import assert from "node:assert/strict";
import { cleanBody, cleanCookieValue, cleanHeaders, cleanUrl, cleanWebSocketFrame } from "../src/privacy.js";

it("保留浏览器提供的原始请求、响应、Cookie 和事件内容", () => {
  const url = "https://user:pass@example.test/path?token=one&token=two#password=three";
  const body = ' { "password": "one", "token": "two" } ';
  const headers = { Authorization: "Bearer example", Cookie: "session=example" };
  assert.equal(cleanUrl(url), url);
  assert.deepEqual(cleanHeaders(headers), headers);
  assert.deepEqual(cleanBody(body, "application/json"), { value: body, status: "captured" });
  assert.equal(cleanBody("token=one&token=two", "application/x-www-form-urlencoded").value, "token=one&token=two");
  assert.equal(cleanBody("{invalid", "application/json").value, "{invalid");
  assert.equal(cleanCookieValue("session_id", "example", false).value, "example");
  assert.deepEqual(cleanWebSocketFrame("AQID", 2), { value: "AQID", encoding: "base64", status: "captured" });
  assert.equal(cleanWebSocketFrame('{"token":"example"}', 1).value, '{"token":"example"}');
});
