import { it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unzipSync } from "fflate";
import { Crc32, FlowZip64Writer, createFlowZipSink, zipLocalHeader, zipCentralHeader, zipDataDescriptor, zipEndRecords } from "../src/flow-zip64.js";
const encode = (text) => new TextEncoder().encode(text);
const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const hash = (value) => createHash("sha256").update(value).digest("hex");
function fakeOpfs({ failWrite = false, failClose = false, pendingWrite = false } = {}) {
  const files = new Map(), removed = [], trace = []; let bytes = [], lastName, maxBlock = 0, active = 0, maxActive = 0, rejectWrite;
  return { files, removed, trace, get maxBlock() { return maxBlock; }, get maxActive() { return maxActive; },
    storage: { async getDirectory() { return {
      async getFileHandle(name, options) {
        assert.equal(options.create, true); lastName = name; files.set(name, true);
        return {
          async createWritable() { return {
            async write(block) {
              trace.push("write"); maxBlock = Math.max(maxBlock, block.length); maxActive = Math.max(maxActive, ++active);
              try {
                if (failWrite) throw new Error("synthetic disk full");
                if (pendingWrite) await new Promise((_, reject) => { rejectWrite = reject; });
                bytes.push(block.slice()); await Promise.resolve();
              } finally { active--; }
            },
            async close() { trace.push("close"); if (failClose) throw new Error("synthetic flush failed"); },
            async abort() { trace.push("abort"); rejectWrite?.(new Error("synthetic write aborted")); },
          }; },
          async getFile() { trace.push("getFile"); return new Blob(bytes, { type: "application/zip" }); },
        };
      },
      async removeEntry(name) { assert.equal(name, lastName); assert.match(name, /^logic-recorder-export-.*\.zip$/); trace.push("remove"); removed.push(name); files.delete(name); bytes = []; },
    }; } },
  };
}
it("CRC32 IEEE vector and multipart updates preserve unsigned scalar", () => {
  assert.equal(new Crc32().digest(), 0);
  const crc = new Crc32(); for (const part of ["123", "456", "789"]) crc.update(encode(part));
  assert.equal(crc.digest(), 0xcbf43926); assert.equal(crc.digest(), 0xcbf43926);
});
it("ZIP64 sizes, descriptors, offsets, counts and locator use exact high words without huge allocation", () => {
  for (const amount of [0xfffffffen, 0xffffffffn, 0x100000000n, 0x312345678n]) {
    const local = zipLocalHeader("x", amount), l = view(local), descriptor = zipDataDescriptor(amount, 0xcbf43926), d = view(descriptor);
    assert.equal(l.getUint16(6, true), 0x0808);
    if (amount < 0xffffffffn) { assert.equal(local.length, 31); assert.equal(d.getUint32(8, true), Number(amount)); }
    else { assert.equal(l.getUint16(4, true), 45); assert.equal(l.getUint32(22, true), 0xffffffff); assert.equal(l.getBigUint64(35, true), amount); assert.equal(d.getBigUint64(16, true), amount); }
    const offset = amount + 123n, central = zipCentralHeader({ path: "x", size: amount, offset, crc32: 0xcbf43926 }), c = view(central);
    assert.equal(c.getUint32(42, true), 0xffffffff);
    assert.equal(c.getBigUint64(central.length - 8, true), offset);
    const ends = zipEndRecords({ entryCount: 65535n, centralSize: amount, centralOffset: offset }), e = view(ends);
    assert.equal(e.getUint32(0, true), 0x06064b50); assert.equal(e.getBigUint64(24, true), 65535n);
    assert.equal(e.getBigUint64(40, true), amount); assert.equal(e.getBigUint64(48, true), offset);
    assert.equal(e.getBigUint64(64, true), offset + amount); assert.equal(e.getUint16(84, true), 65535);
  }
  assert.equal(zipEndRecords({ entryCount: 1, centralSize: 60, centralOffset: 100 }).length, 22);
  assert.throws(() => zipCentralHeader({ path: "x", size: 1, offset: Number.MAX_SAFE_INTEGER + 1, crc32: 0 }), /safe integer/);
  assert.throws(() => zipLocalHeader("../escape", 0), /Unsafe/);
});
it("streamed small ZIP roundtrips UTF8, descriptors and bytes in fflate and Python standard zipfile", async () => {
  const sink = await createFlowZipSink({ storage: null }), zip = new FlowZip64Writer(sink), payload = encode("原始内容💆".repeat(300));
  const source = { size: payload.length, arrayBuffer() { throw new Error("whole read forbidden"); },
    stream() { let p = 0; return new ReadableStream({ pull(controller) { if (p === payload.length) { controller.close(); return; } const next = Math.min(p + 37, payload.length); controller.enqueue(payload.subarray(p, next)); p = next; } }); } };
  const entry = await zip.add("页面/原文.bin", source, { expectedSha256: hash(payload) });
  assert.equal(entry.sha256, hash(payload)); await zip.add("empty.bin", new Uint8Array());
  const output = new Uint8Array(await (await zip.finish()).arrayBuffer());
  assert.deepEqual(unzipSync(output)["页面/原文.bin"], payload);
  const python = spawnSync("python", ["-c", "import sys,io,zipfile,hashlib,json; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; print(json.dumps({n:hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist()}))"], { input: output, encoding: "utf8" });
  assert.equal(python.status, 0, python.stderr); assert.equal(JSON.parse(python.stdout)["页面/原文.bin"], hash(payload)); await sink.cleanup();
  // A real tiny ZIP with forced ZIP64 local/central/end structures gives Python
  // an independent decoder oracle; size fields stay small and CRC stays real.
  const name = "zip64.bin", body = encode("ZIP64 actual tiny fixture"), crc = new Crc32().update(body).digest();
  const local = zipLocalHeader(name, 0x100000000n), l = view(local), lp = 30 + encode(name).length;
  l.setBigUint64(lp + 4, BigInt(body.length), true); l.setBigUint64(lp + 12, BigInt(body.length), true);
  const desc = zipDataDescriptor(0x100000000n, crc); view(desc).setBigUint64(8, BigInt(body.length), true); view(desc).setBigUint64(16, BigInt(body.length), true);
  const central = zipCentralHeader({ path: name, size: 0x100000000n, offset: 0n, crc32: crc }), c = view(central), cp = 46 + encode(name).length;
  c.setBigUint64(cp + 4, BigInt(body.length), true); c.setBigUint64(cp + 12, BigInt(body.length), true);
  const offset = local.length + body.length + desc.length, end = zipEndRecords({ entryCount: 65535n, centralSize: central.length, centralOffset: offset }), e = view(end);
  e.setBigUint64(24, 1n, true); e.setBigUint64(32, 1n, true); e.setUint16(84, 1, true); e.setUint16(86, 1, true);
  const actual64 = Buffer.concat([local, body, desc, central, end]);
  const oracle = spawnSync("python", ["-c", "import sys,io,zipfile; z=zipfile.ZipFile(io.BytesIO(sys.stdin.buffer.read())); assert z.testzip() is None; assert z.read('zip64.bin')==b'ZIP64 actual tiny fixture'; print('zip64-ok')"], { input: actual64, encoding: "utf8" });
  assert.equal(oracle.status, 0, oracle.stderr); assert.match(oracle.stdout, /zip64-ok/);
});
it("OPFS output awaits each <=1MiB block and flushes before getFile; cleanup is owned and deferred", async () => {
  const disk = fakeOpfs(), sink = await createFlowZipSink({ storage: disk.storage }), zip = new FlowZip64Writer(sink);
  await zip.add("blocks.bin", new Uint8Array(2 * 1024 * 1024 + 17)); const blob = await zip.finish();
  assert.equal(sink.storage, "opfs"); assert.equal(disk.files.size, 1); assert.equal(disk.removed.length, 0);
  assert.ok(disk.maxBlock <= 1024 * 1024); assert.equal(disk.maxActive, 1);
  assert.ok(disk.trace.indexOf("close") < disk.trace.indexOf("getFile")); assert.equal(blob.size, Number(zip.offset));
  await sink.cleanup(); await sink.cleanup(); assert.equal(disk.files.size, 0); assert.equal(disk.removed.length, 1);
});
it("failed writes, flush, streaming hash or abort clean their temporary output; memory fallback is bounded", async () => {
  for (const options of [{ failWrite: true }, { failClose: true }]) {
    const disk = fakeOpfs(options), sink = await createFlowZipSink({ storage: disk.storage }), zip = new FlowZip64Writer(sink);
    await assert.rejects(async () => { try { await zip.add("x", encode("123")); await zip.finish(); } finally { await sink.abort(); } }, /synthetic/);
    assert.equal(disk.files.size, 0); assert.equal(disk.removed.length, 1); assert.ok(!disk.trace.includes("getFile"));
  }
  const disk = fakeOpfs(), sink = await createFlowZipSink({ storage: disk.storage }), zip = new FlowZip64Writer(sink);
  await assert.rejects(zip.add("x", encode("abc"), { expectedSha256: "0".repeat(64) }), /校验失败/); await sink.abort(); assert.equal(disk.files.size, 0);
  const pending = fakeOpfs({ pendingWrite: true }), pendingSink = await createFlowZipSink({ storage: pending.storage });
  const write = pendingSink.write(encode("waiting")); await pendingSink.abort(); await assert.rejects(write, /aborted/); assert.equal(pending.files.size, 0);
  const memory = await createFlowZipSink({ storage: null, maximumMemoryBytes: 8 });
  await memory.write(encode("12345678")); await assert.rejects(memory.write(encode("9")), /128MiB/); await memory.abort();
});
