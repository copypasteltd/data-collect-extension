import { it } from "node:test";
import assert from "node:assert/strict";
import { Zip, unzipSync } from "fflate";
import { addArchiveFile } from "../src/archive-compression.js";

async function encode(bytes, options = {}) {
  const chunks = [];
  let complete, fail;
  const result = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
  const zip = new Zip((error, bytes, final) => {
    if (error) { fail(error); return; }
    chunks.push(bytes);
    if (final) complete(Buffer.concat(chunks));
  });
  await addArchiveFile(zip, "synthetic.bin", bytes, options);
  zip.end();
  return result;
}
for (const nativeCompression of [globalThis.CompressionStream, null]) {
  it("chunked archive compression round trips exact bytes and yields between blocks: native=" + !!nativeCompression, async () => {
    let schedules = 0, blocks = 0;
    const bytes = new Uint8Array(450123);
    for (let index = 0; index < bytes.length; index++) bytes[index] = (index * 31 + Math.floor(index / 29)) % 256;
    const archive = await encode(bytes, { nativeCompression, schedule: async () => { schedules++; }, onBlock: () => { blocks++; } });
    assert.deepEqual(unzipSync(archive)["synthetic.bin"], bytes);
    assert.equal(schedules, Math.ceil(bytes.length / 65536));
    assert.equal(blocks, schedules);
  });
  it("empty and already-compressed passthrough payloads remain valid ZIP entries: native=" + !!nativeCompression, async () => {
    for (const compress of [true, false]) for (const bytes of [new Uint8Array(), new Uint8Array([0, 255, 1, 2])])
      assert.deepEqual(unzipSync(await encode(bytes, { nativeCompression, compress }))["synthetic.bin"], bytes);
  });
}
it("aborted compression does not finish a successful archive or keep processing blocks", async () => {
  const controller = new AbortController();
  let blocks = 0;
  await assert.rejects(encode(new Uint8Array(300000), { signal: controller.signal, nativeCompression: null,
    onBlock() { blocks++; controller.abort(new Error("synthetic cancellation")); }, schedule: async () => {} }), /synthetic cancellation/);
  assert.equal(blocks, 1);
});
it("unsupported native raw-deflate gracefully uses bounded fallback without dropping bytes", async () => {
  class Unsupported { constructor() { throw new Error("unsupported"); } }
  const bytes = new TextEncoder().encode("same raw payload 中文💆".repeat(10000));
  assert.deepEqual(unzipSync(await encode(bytes, { nativeCompression: Unsupported }))["synthetic.bin"], bytes);
});
