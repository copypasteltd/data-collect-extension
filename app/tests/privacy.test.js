import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cleanBody,
  cleanCookieValue,
  cleanHeaders,
  cleanUrl,
  cleanWebSocketFrame,
  scrub,
} from "../src/privacy.js";

describe("敏感数据处理", () => {
  it("隐藏 JSON 嵌套字段和认证头", () => {
    const body = cleanBody(
      '{"user":"A","token":"secret","profile":{"password":"x"}}',
      "application/json",
    );
    assert.ok(!body.value.includes("secret"));
    assert.equal(JSON.parse(body.value).profile.password, "[已隐藏]");
    assert.equal(
      cleanHeaders({
        Authorization: "Bearer token",
        "Content-Type": "application/json",
      }).Authorization,
      "[已隐藏]",
    );
  });
  it("处理文本内容并跳过无法识别的主体", () => {
    assert.ok(!cleanBody("password=one", "text/plain").value.includes("one"));
    const quoted = cleanBody('password="two word secret"', "text/plain").value;
    assert.ok(!quoted.includes("two") && !quoted.includes("secret"));
    const payment = cleanBody(
      'card_number="card value" otp=123456 cc-csc=789 name=客户',
      "text/plain",
    ).value;
    assert.ok(!payment.includes("card value") && !payment.includes("123456"));
    assert.ok(!payment.includes("789") && payment.includes("name=客户"));
    assert.equal(cleanBody("opaque", "application/octet-stream").value, null);
    assert.equal(
      cleanBody("{broken", "application/json").status,
      "omitted_unparseable",
    );
  });
  it("按内容处理实时文本消息并标注二进制内容", () => {
    assert.equal(cleanWebSocketFrame("业务消息", 1).value, "业务消息");
    const json = cleanWebSocketFrame('{"order":"A","token":"hidden"}', 1);
    assert.equal(JSON.parse(json.value).token, "[已隐藏]");
    assert.ok(
      !cleanWebSocketFrame("42[token=hidden]", 1).value.includes("hidden"),
    );
    const text = cleanWebSocketFrame(
      "session_id=private api_key=private cookie='private value' order=ok",
      1,
    ).value;
    assert.ok(!text.includes("private") && text.includes("order=ok"));
    assert.equal(
      JSON.parse(cleanWebSocketFrame('{"api_key":"private"}', 1).value).api_key,
      "[已隐藏]",
    );
    assert.equal(cleanWebSocketFrame("AQID", 2).status, "omitted_binary");
    assert.equal(
      cleanWebSocketFrame("a".repeat(1000001), 1).status,
      "omitted_size",
    );
  });
  it("隐藏 URL 认证信息和敏感参数", () => {
    const url = cleanUrl(
      "https://user:pass@example.com/path?token=abc&name=ok#access_token=abc",
    );
    assert.ok(!url.includes("abc"));
    assert.ok(!url.includes("user:pass"));
    assert.ok(url.includes("name=ok"));
    const headers = cleanHeaders(
      {
        Location: "/next?token=abc&name=ok",
        Referer: "https://example.test/?password=abc",
      },
      "https://example.test/path",
    );
    assert.ok(
      !headers.Location.includes("abc") && !headers.Referer.includes("abc"),
    );
    assert.ok(headers.Location.includes("name=ok"));
  });
  it("按元素语义隐藏 HTML 中的密码和可编辑内容", () => {
    const body = cleanBody(
      '<input type="password" value="one two"><div contenteditable aria-label="密码">three four</div><div contenteditable="plaintext-only" aria-label="验证码">five six</div><input autocomplete="cc-number" value="card value"><p>普通内容</p>',
      "text/html",
    ).value;
    assert.ok(!body.includes("one two") && !body.includes("three four"));
    assert.ok(!body.includes("five six") && !body.includes("card value"));
    assert.ok(body.includes("普通内容"));
  });
  it("仅在明确选择时保存可识别的非认证 Cookie", () => {
    assert.equal(cleanCookieValue("theme", "dark", false).value, "[已隐藏]");
    assert.equal(cleanCookieValue("theme", "dark", true).value, "dark");
    assert.equal(
      cleanCookieValue("session_id", "secret-value", true).value,
      "[已隐藏]",
    );
    assert.equal(
      cleanCookieValue("PHPSESSID", "secret-value", true).value,
      "[已隐藏]",
    );
  });
  it("保留普通字段", () =>
    assert.deepEqual(scrub({ name: "客户", password: "p" }), {
      name: "客户",
      password: "[已隐藏]",
    }));
});
