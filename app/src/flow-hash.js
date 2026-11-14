// Incremental SHA-256; content handles never need a whole-Blob ArrayBuffer.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));
export const FLOW_STREAM_BLOCK_BYTES = 1024 * 1024;
export class Sha256 {
  constructor() {
    this.state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    this.words = new Uint32Array(64); this.tail = new Uint8Array(64); this.tailLength = 0; this.bytes = 0n; this.hex = undefined;
  }
  block(bytes, offset) {
    const w = this.words;
    for (let i = 0; i < 16; i++) {
      const p = offset + i * 4;
      w[i] = (bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3];
    }
    for (let i = 16; i < 64; i++) {
      const x = w[i - 15], y = w[i - 2];
      w[i] = (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 16] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)) + w[i - 7];
    }
    let [a, b, c, d, e, f, g, h] = this.state;
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    const s = this.state;
    s[0] += a; s[1] += b; s[2] += c; s[3] += d; s[4] += e; s[5] += f; s[6] += g; s[7] += h;
  }
  update(bytes) {
    if (!(bytes instanceof Uint8Array)) throw new TypeError("SHA-256 input must be Uint8Array");
    if (this.hex !== undefined) throw new Error("SHA-256 is already finalized");
    this.bytes += BigInt(bytes.length);
    if (this.bytes >= (1n << 61n)) throw new RangeError("SHA-256 input is too long");
    let offset = 0;
    if (this.tailLength) {
      const take = Math.min(64 - this.tailLength, bytes.length);
      this.tail.set(bytes.subarray(0, take), this.tailLength); this.tailLength += take; offset = take;
      if (this.tailLength === 64) { this.block(this.tail, 0); this.tailLength = 0; }
    }
    while (offset + 64 <= bytes.length) { this.block(bytes, offset); offset += 64; }
    if (offset < bytes.length) { this.tail.set(bytes.subarray(offset), 0); this.tailLength = bytes.length - offset; }
    return this;
  }
  digestHex() {
    if (this.hex !== undefined) return this.hex;
    const padded = new Uint8Array(this.tailLength < 56 ? 64 : 128);
    padded.set(this.tail.subarray(0, this.tailLength)); padded[this.tailLength] = 0x80;
    new DataView(padded.buffer).setBigUint64(padded.length - 8, this.bytes * 8n, false);
    this.block(padded, 0); if (padded.length === 128) this.block(padded, 64);
    this.hex = Array.from(this.state, (value) => value.toString(16).padStart(8, "0")).join("");
    return this.hex;
  }
}
const checkAbort = (signal) => { if (signal?.aborted) throw signal.reason || new Error("Content read aborted"); };
// Blob streams are normally 64KiB in Chromium. Split oversized producer chunks
// too, so every hash/write/compression operation has a bounded working block.
export async function* blobChunks(blob, { signal } = {}) {
  checkAbort(signal);
  const reader = blob.stream().getReader();
  const abort = () => { reader.cancel(signal.reason).catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      checkAbort(signal);
      const { done, value } = await reader.read(); checkAbort(signal);
      if (done) return;
      if (!(value instanceof Uint8Array)) throw new TypeError("Blob stream must produce Uint8Array");
      for (let offset = 0; offset < value.length; offset += FLOW_STREAM_BLOCK_BYTES) {
        checkAbort(signal); yield value.subarray(offset, offset + FLOW_STREAM_BLOCK_BYTES);
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    try { await reader.cancel(); } finally { reader.releaseLock(); }
  }
}
export async function sha256Blob(blob, { signal } = {}) {
  const hash = new Sha256(); let lastYield = Date.now();
  for await (const bytes of blobChunks(blob, { signal })) {
    hash.update(bytes);
    if (Date.now() - lastYield >= 8) { await new Promise((resolve) => setTimeout(resolve, 0)); lastYield = Date.now(); checkAbort(signal); }
  }
  checkAbort(signal); return hash.digestHex();
}
export async function sha256Bytes(bytes) { return new Sha256().update(bytes).digestHex(); }
