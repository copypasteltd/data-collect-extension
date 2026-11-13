import { ZipDeflate, ZipPassThrough } from "fflate";

const BLOCK_BYTES = 65536;
const yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0));
function cooperativeScheduler() {
  let lastYield = performance.now();
  return async () => {
    if (performance.now() - lastYield < 8) return;
    await yieldTask(); lastYield = performance.now();
  };
}

// Native compression is asynchronous and needs no blob/eval worker or CSP change.
// Fall back to small, cooperatively scheduled DEFLATE blocks on older Chrome.
export async function addArchiveFile(zip, filename, bytes, {
  compress = true, level = 1, signal, onBlock = () => {},
  nativeCompression = globalThis.CompressionStream, schedule = cooperativeScheduler(),
} = {}) {
  const check = () => { if (signal?.aborted) throw signal.reason || new Error("导出已停止，本地批次仍保留"); };
  check();
  let item, writer, reader, stream, native = false;
  if (compress && typeof nativeCompression === "function") {
    try { stream = new nativeCompression("deflate-raw"); native = true; } catch {}
  }
  if (native) {
    item = new ZipPassThrough(filename);
    item.compression = 8;
    item.flag = 0;
    writer = stream.writable.getWriter();
    reader = stream.readable.getReader();
  } else item = compress ? new ZipDeflate(filename, { level }) : new ZipPassThrough(filename);
  let pumping, pendingWrite;
  const cancel = () => {
    if (writer) void writer.abort(signal?.reason).catch(() => {});
    if (reader) void reader.cancel(signal?.reason).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    zip.add(item);
    if (native) {
      item.process = (chunk, final) => {
        pendingWrite = writer.write(chunk).then(() => final ? writer.close() : undefined);
        pendingWrite.catch(() => {});
      };
      pumping = (async () => {
        while (true) {
          const { done, value } = await reader.read();
          check();
          if (done) { item.ondata(null, new Uint8Array(), true); return; }
          item.ondata(null, value, false);
        }
      })();
      pumping.catch(() => {});
    }
    if (!bytes.length) { item.push(bytes, true); if (pendingWrite) await pendingWrite; }
    for (let offset = 0; offset < bytes.length; offset += BLOCK_BYTES) {
      check();
      const end = Math.min(bytes.length, offset + BLOCK_BYTES);
      item.push(bytes.subarray(offset, end), end === bytes.length);
      if (pendingWrite) await pendingWrite;
      check();
      onBlock(end, bytes.length);
      await schedule();
    }
    if (pumping) await pumping;
    check();
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
    try { writer?.releaseLock(); } catch {}
    try { reader?.releaseLock(); } catch {}
  }
}
