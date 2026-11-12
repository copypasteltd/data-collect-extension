import { it } from "node:test";
import assert from "node:assert/strict";
import { responseBlob } from "../src/large-response.js";

it("保留浏览器返回的字节，并标明浏览器解码文本的表示方式", async () => {
  const bytes = Uint8Array.from({ length: 300000 }, (_, index) => index % 256);
  const result = responseBlob({ body: Buffer.from(bytes).toString("base64"), base64Encoded: true }, "application/octet-stream");
  assert.equal(result.representation, "browser-provided-bytes");
  assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), bytes);
  const text = responseBlob({ body: "中文😀", base64Encoded: false }, "text/plain");
  assert.equal(text.representation, "browser-decoded-text");
  assert.equal(await text.blob.text(), "中文😀");
});
