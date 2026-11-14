import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Sha256, sha256Blob, sha256Bytes, blobChunks, FLOW_STREAM_BLOCK_BYTES } from "../src/flow-hash.js";
const bytes = (text) => new TextEncoder().encode(text);
const oracle = (value) => createHash("sha256").update(value).digest("hex");
it("SHA256 known vectors and independently chunked padding boundaries match Node crypto", async () => {
  for (const [text, expected] of [["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
    ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
    ["abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq", "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"]]) {
    assert.equal(await sha256Bytes(bytes(text)), expected);
    const hash = new Sha256(); for (const byte of bytes(text)) hash.update(Uint8Array.of(byte));
    assert.equal(hash.digestHex(), expected); assert.equal(hash.digestHex(), expected);
    assert.throws(() => hash.update(new Uint8Array()), /finalized/);
  }
  for (const length of [55, 56, 63, 64, 65, 119, 120, 127, 128, 129, 4097]) {
    const value = Uint8Array.from({ length }, (_, n) => (n * 73 + 11) % 256), hash = new Sha256();
    for (let p = 0; p < length; p += 17) hash.update(value.subarray(p, p + 17));
    assert.equal(hash.digestHex(), oracle(value));
  }
  const millionA = new Uint8Array(1000).fill(97), hash = new Sha256();
  for (let n = 0; n < 1000; n++) hash.update(millionA);
  assert.equal(hash.digestHex(), "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0");
  assert.throws(() => new Sha256().update("abc"), /Uint8Array/);
});
it("Blob hashing uses bounded stream blocks and never whole-Blob arrayBuffer", async () => {
  const value = Uint8Array.from({ length: FLOW_STREAM_BLOCK_BYTES * 2 + 37 }, (_, n) => n % 251);
  let cancelled = 0;
  const blob = { arrayBuffer() { throw new Error("whole Blob read forbidden"); },
    stream() { return new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); }, cancel() { cancelled++; } }); } };
  const chunks = []; for await (const chunk of blobChunks(blob)) chunks.push(chunk.byteLength);
  assert.deepEqual(chunks, [FLOW_STREAM_BLOCK_BYTES, FLOW_STREAM_BLOCK_BYTES, 37]);
  assert.equal(await sha256Blob(blob), oracle(value));
  const controller = new AbortController(), reason = new Error("cancelled during content hash");
  const stalled = { stream() { return new ReadableStream({ cancel() { cancelled++; } }); } };
  const operation = sha256Blob(stalled, { signal: controller.signal }); controller.abort(reason);
  await assert.rejects(operation, (error) => error === reason); assert.equal(cancelled, 1);
});
