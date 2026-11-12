import { it } from "node:test";
import assert from "node:assert/strict";
import { packComputedEntries } from "../src/computed-style-encoder.js";
import { unpackComputedEntries } from "../src/computed-style-packing.js";

it("无损重组样式批次，并拒绝损坏或不匹配的元信息", async () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({ nodeId: String(index), status: "captured",
    properties: [["color", "rgb(1, 2, 3)"], ["--text", `unpaired-\ud800-${"x".repeat(2000)}`]] }));
  const packed = await packComputedEntries(entries);
  assert.equal(packed.entriesEncoding, "gzip-base64-json-v1");
  assert.deepEqual(unpackComputedEntries(packed), entries);
  assert.throws(() => unpackComputedEntries({ ...packed, entriesBytes: packed.entriesBytes + 1 }));
  assert.throws(() => unpackComputedEntries({ ...packed, entryCount: 6 }));
  assert.throws(() => unpackComputedEntries({ ...packed, entriesData: "invalid!" }));
  const corrupted = Uint8Array.from(atob(packed.entriesData), (character) => character.charCodeAt(0));
  corrupted[corrupted.length - 8] ^= 1;
  assert.throws(() => unpackComputedEntries({ ...packed, entriesData: btoa(String.fromCharCode(...corrupted)) }), /校验失败/);
  assert.deepEqual(unpackComputedEntries({ entries }), entries);
});

it("浏览器不支持压缩时保留完整原始样式", async () => {
  const original = globalThis.CompressionStream;
  const entries = [{ status: "captured", properties: [["color", "red"]] }];
  try {
    globalThis.CompressionStream = undefined;
    const packed = await packComputedEntries(entries);
    assert.equal(packed.packingStatus, "unavailable");
    assert.deepEqual(unpackComputedEntries(packed), entries);
  } finally {
    globalThis.CompressionStream = original;
  }
});
