import { gunzipSync, strFromU8 } from "fflate";

const MAX_BYTES = 8000000;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[index]) & 255];
  return (crc ^ 0xffffffff) >>> 0;
}

export function unpackComputedEntries(payload) {
  if (!payload?.entriesEncoding) {
    if (!Array.isArray(payload?.entries)) throw new Error("计算样式批次缺少条目");
    return payload.entries;
  }
  if (payload.entriesEncoding !== "gzip-base64-json-v1" || typeof payload.entriesData !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload.entriesData) ||
      !Number.isSafeInteger(payload.entriesBytes) || payload.entriesBytes < 0 || payload.entriesBytes > MAX_BYTES ||
      !Number.isSafeInteger(payload.entryCount) || payload.entryCount < 0)
    throw new Error("计算样式压缩元信息无效");
  const binary = atob(payload.entriesData);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (bytes.length < 18 || bytes[0] !== 31 || bytes[1] !== 139 ||
      new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 4, 4).getUint32(0, true) !== payload.entriesBytes)
    throw new Error("计算样式压缩长度无效");
  const decoded = gunzipSync(bytes);
  if (decoded.length !== payload.entriesBytes) throw new Error("计算样式解压长度无效");
  const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + bytes.length - 8, 4).getUint32(0, true);
  if (crc32(decoded) !== expectedCrc) throw new Error("计算样式压缩校验失败");
  const entries = JSON.parse(strFromU8(decoded));
  if (!Array.isArray(entries) || entries.length !== payload.entryCount) throw new Error("计算样式条目数量无效");
  return entries;
}
