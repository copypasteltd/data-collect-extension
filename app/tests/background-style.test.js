import { it } from "node:test";
import assert from "node:assert/strict";
import { singleBackgroundUrl, fontSourceUrls } from "../src/background-style.js";

it("只识别可安全解析的单张背景图片", () => {
  assert.equal(
    singleBackgroundUrl('url("https://example.test/a(b).png")'),
    "https://example.test/a(b).png",
  );
  assert.equal(singleBackgroundUrl("url(/image.png)"), "/image.png");
  assert.equal(singleBackgroundUrl('url("/a.png"), url("/b.png")'), null);
  assert.equal(
    singleBackgroundUrl('image-set("https://example.test/a.png" 1x)'),
    null,
  );
  assert.equal(singleBackgroundUrl('url("/escaped\\20 name.png")'), null);
  assert.equal(singleBackgroundUrl("linear-gradient(red, blue)"), null);
});

it("解析字体源并忽略本地字体及无法安全处理的地址", () => {
  assert.deepEqual(fontSourceUrls('local("Demo"), url("../font.woff2") format("woff2"), url(/fallback.woff)'), ["../font.woff2", "/fallback.woff"]);
  assert.deepEqual(fontSourceUrls('url("/escaped\\20 name.woff2")'), []);
});
