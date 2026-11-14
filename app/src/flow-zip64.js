import { Sha256, blobChunks, FLOW_STREAM_BLOCK_BYTES } from "./flow-hash.js";

const U32 = 0xffffffffn, U16 = 0xffffn, U64 = 0xffffffffffffffffn;
const encoder = new TextEncoder();
const integer = (value, label) => {
  if (typeof value !== "bigint" && !Number.isSafeInteger(value)) throw new TypeError(label + " must be a safe integer or BigInt");
  const result = BigInt(value);
  if (result < 0n || result > U64) throw new RangeError(label + " is outside ZIP64 range");
  return result;
};
const field = (size) => { const bytes = new Uint8Array(size); return { bytes, view: new DataView(bytes.buffer) }; };
const filename = (path) => {
  if (typeof path !== "string" || !path || path.startsWith("/") || path.includes("\\") || path.split("/").some((p) => !p || p === "." || p === "..") || /[\x00-\x1f]/.test(path))
    throw new TypeError("Unsafe ZIP pathname");
  const bytes = encoder.encode(path); if (bytes.length > 65535) throw new RangeError("ZIP pathname is too long"); return bytes;
};
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); crcTable[n] = c; }
export class Crc32 {
  constructor() { this.value = 0xffffffff; }
  update(bytes) { for (const byte of bytes) this.value = (this.value >>> 8) ^ crcTable[(this.value ^ byte) & 255]; return this; }
  digest() { return (this.value ^ 0xffffffff) >>> 0; }
}
// Public pure encoders let boundary tests exercise >4GiB without allocating it.
export function zipLocalHeader(path, size) {
  const name = filename(path), amount = integer(size, "size"), large = amount >= U32;
  const { bytes, view } = field(30 + name.length + (large ? 20 : 0));
  view.setUint32(0, 0x04034b50, true); view.setUint16(4, large ? 45 : 20, true);
  view.setUint16(6, 0x0808, true); view.setUint16(12, 0x21, true); // UTF-8 + descriptor; 1980-01-01.
  view.setUint32(18, large ? 0xffffffff : 0, true); view.setUint32(22, large ? 0xffffffff : 0, true);
  view.setUint16(26, name.length, true); view.setUint16(28, large ? 20 : 0, true); bytes.set(name, 30);
  if (large) { const p = 30 + name.length; view.setUint16(p, 1, true); view.setUint16(p + 2, 16, true); view.setBigUint64(p + 4, amount, true); view.setBigUint64(p + 12, amount, true); }
  return bytes;
}
export function zipDataDescriptor(size, crc32) {
  const amount = integer(size, "size"), large = amount >= U32, { bytes, view } = field(large ? 24 : 16);
  view.setUint32(0, 0x08074b50, true); view.setUint32(4, crc32, true);
  if (large) { view.setBigUint64(8, amount, true); view.setBigUint64(16, amount, true); }
  else { view.setUint32(8, Number(amount), true); view.setUint32(12, Number(amount), true); }
  return bytes;
}
export function zipCentralHeader({ path, size, offset, crc32 }) {
  const name = filename(path), amount = integer(size, "size"), start = integer(offset, "offset");
  const bigSize = amount >= U32, bigOffset = start >= U32, extraSize = (bigSize ? 16 : 0) + (bigOffset ? 8 : 0);
  const { bytes, view } = field(46 + name.length + (extraSize ? extraSize + 4 : 0));
  view.setUint32(0, 0x02014b50, true); view.setUint16(4, 45, true); view.setUint16(6, extraSize ? 45 : 20, true);
  view.setUint16(8, 0x0808, true); view.setUint16(14, 0x21, true); view.setUint32(16, crc32, true);
  view.setUint32(20, bigSize ? 0xffffffff : Number(amount), true); view.setUint32(24, bigSize ? 0xffffffff : Number(amount), true);
  view.setUint16(28, name.length, true); view.setUint16(30, extraSize ? extraSize + 4 : 0, true);
  view.setUint32(42, bigOffset ? 0xffffffff : Number(start), true); bytes.set(name, 46);
  if (extraSize) {
    let p = 46 + name.length; view.setUint16(p, 1, true); view.setUint16(p + 2, extraSize, true); p += 4;
    if (bigSize) { view.setBigUint64(p, amount, true); view.setBigUint64(p + 8, amount, true); p += 16; }
    if (bigOffset) view.setBigUint64(p, start, true);
  }
  return bytes;
}
export function zipEndRecords({ entryCount, centralSize, centralOffset }) {
  const count = integer(entryCount, "entryCount"), size = integer(centralSize, "centralSize"), offset = integer(centralOffset, "centralOffset");
  const large = count >= U16 || size >= U32 || offset >= U32, { bytes, view } = field(large ? 98 : 22);
  let p = 0;
  if (large) {
    view.setUint32(0, 0x06064b50, true); view.setBigUint64(4, 44n, true); view.setUint16(12, 45, true); view.setUint16(14, 45, true);
    view.setBigUint64(24, count, true); view.setBigUint64(32, count, true); view.setBigUint64(40, size, true); view.setBigUint64(48, offset, true);
    view.setUint32(56, 0x07064b50, true); view.setBigUint64(64, integer(offset + size, "ZIP64 end offset"), true); view.setUint32(72, 1, true); p = 76;
  }
  view.setUint32(p, 0x06054b50, true); view.setUint16(p + 8, Number(count < U16 ? count : U16), true); view.setUint16(p + 10, Number(count < U16 ? count : U16), true);
  view.setUint32(p + 12, Number(size < U32 ? size : U32), true); view.setUint32(p + 16, Number(offset < U32 ? offset : U32), true);
  return bytes;
}

export const FLOW_MEMORY_ZIP_MAX_BYTES = 128 * 1024 * 1024;
const check = (signal) => { if (signal?.aborted) throw signal.reason || new Error("ZIP export aborted"); };
// Only our uniquely named temporary file is removed. Recording data is separate.
export async function createFlowZipSink({ signal, storage = globalThis.navigator?.storage, onWrite = () => {}, maximumMemoryBytes = FLOW_MEMORY_ZIP_MAX_BYTES } = {}) {
  check(signal);
  if (!Number.isSafeInteger(maximumMemoryBytes) || maximumMemoryBytes < 0 || maximumMemoryBytes > FLOW_MEMORY_ZIP_MAX_BYTES) throw new RangeError("Invalid memory ZIP limit");
  if (typeof storage?.getDirectory !== "function") {
    let chunks = [], total = 0, closed = false;
    return {
      storage: "memory",
      async write(bytes) {
        check(signal); if (closed) throw new Error("ZIP output is closed");
        if (bytes.length > maximumMemoryBytes - total) throw new Error("此环境不支持OPFS磁盘导出；内存导出上限为128MiB，请使用支持OPFS的Chrome");
        chunks.push(bytes.slice()); total += bytes.length; onWrite(total); check(signal);
      },
      async finish() { check(signal); closed = true; const blob = new Blob(chunks, { type: "application/zip" }); chunks = []; return blob; },
      async abort() { closed = true; chunks = []; }, async cleanup() { chunks = []; },
    };
  }
  const root = await storage.getDirectory(); check(signal);
  const suffix = globalThis.crypto?.randomUUID?.() || Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (v) => v.toString(16).padStart(2, "0")).join("");
  const name = "logic-recorder-export-" + suffix + ".zip";
  let writable, pending, abortPromise, closed = false, removed = false, total = 0;
  const cleanup = async () => {
    if (removed) return;
    try { await root.removeEntry(name); removed = true; }
    catch (error) { if (error?.name !== "NotFoundError") throw error; removed = true; }
  };
  const abort = async () => {
    if (!abortPromise) abortPromise = (async () => {
      if (writable && !closed) { try { await writable.abort(signal?.reason); } catch {} }
      if (pending) { try { await pending; } catch {} }
      closed = true; await cleanup();
    })();
    return abortPromise;
  };
  try {
    const handle = await root.getFileHandle(name, { create: true }); check(signal);
    writable = await handle.createWritable(); check(signal);
    return {
      storage: "opfs",
      async write(bytes) {
        check(signal); if (closed) throw new Error("ZIP output is closed");
        pending = writable.write(bytes);
        try { await pending; } finally { pending = undefined; }
        total += bytes.length; onWrite(total); check(signal);
      },
      async finish() {
        check(signal); pending = writable.close();
        try { await pending; closed = true; } finally { pending = undefined; }
        check(signal); const blob = await handle.getFile(); check(signal); return blob;
      },
      abort, cleanup,
    };
  } catch (error) { await abort(); throw error; }
}

// STORE avoids whole-file compressors and keeps source bytes under backpressure.
// ZIP state retains central-directory metadata only, never previous file chunks.
export class FlowZip64Writer {
  constructor(sink, { signal, task } = {}) { this.sink = sink; this.signal = signal; this.task = task; this.offset = 0n; this.entries = []; this.paths = new Set(); this.closed = false; this.busy = false; }
  async write(bytes) {
    for (let p = 0; p < bytes.length; p += FLOW_STREAM_BLOCK_BYTES) {
      check(this.signal); this.task?.check(); const block = bytes.subarray(p, p + FLOW_STREAM_BLOCK_BYTES);
      const operation = () => this.sink.write(block);
      if (this.task) await this.task.wait(operation); else await operation();
      this.offset = integer(this.offset + BigInt(block.length), "output size");
      this.task?.progress({ bytesDone: Number(this.offset) }); await this.task?.yield();
    }
  }
  async add(path, source, { size = source?.size ?? source?.byteLength, expectedSha256 } = {}) {
    if (this.closed || this.busy) throw new Error("ZIP writer is closed or busy");
    if (this.paths.has(path)) throw new Error("Duplicate ZIP pathname");
    const amount = integer(size, "size"), start = this.offset; filename(path);
    this.paths.add(path); this.busy = true;
    const hash = new Sha256(), crc = new Crc32(); let count = 0n;
    try {
      await this.write(zipLocalHeader(path, amount));
      const iterable = source instanceof Uint8Array ? [source] : typeof source?.stream === "function" ? blobChunks(source, { signal: this.signal }) : source;
      if (!iterable?.[Symbol.asyncIterator] && !iterable?.[Symbol.iterator]) throw new TypeError("ZIP source must be bytes, Blob or a chunk iterable");
      for await (const bytes of iterable) {
        if (!(bytes instanceof Uint8Array)) throw new TypeError("ZIP chunks must be Uint8Array");
        for (let p = 0; p < bytes.length; p += FLOW_STREAM_BLOCK_BYTES) {
          check(this.signal); const block = bytes.subarray(p, p + FLOW_STREAM_BLOCK_BYTES);
          count += BigInt(block.length); if (count > amount) throw new Error("ZIP source size mismatch");
          hash.update(block); crc.update(block); await this.write(block);
        }
      }
      if (count !== amount) throw new Error("ZIP source size mismatch");
      const sha256 = hash.digestHex(); if (expectedSha256 !== undefined && sha256 !== expectedSha256) throw new Error("已保存原始内容校验失败");
      const crc32 = crc.digest(); await this.write(zipDataDescriptor(amount, crc32));
      this.entries.push({ path, size: amount, offset: start, crc32 });
      return { path, size: Number(amount), sha256 };
    } finally { this.busy = false; }
  }
  async finish() {
    if (this.closed || this.busy) throw new Error("ZIP writer is closed or busy"); this.closed = true;
    const centralOffset = this.offset;
    for (const entry of this.entries) await this.write(zipCentralHeader(entry));
    const centralSize = this.offset - centralOffset;
    await this.write(zipEndRecords({ entryCount: BigInt(this.entries.length), centralSize, centralOffset }));
    const finish = () => this.sink.finish(); const blob = this.task ? await this.task.wait(finish) : await finish();
    if (BigInt(blob.size) !== this.offset) throw new Error("记录包输出不完整");
    return blob;
  }
}
