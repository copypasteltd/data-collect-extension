import {
  strToU8,
  strFromU8,
  Zip,
  ZipDeflate,
  ZipPassThrough,
  Unzip,
  UnzipInflate,
} from "fflate";
import { all, get, eventPage, countEvents } from "./db.js";

const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export async function readLocalSession(id) {
  const session = await get("sessions", id);
  if (!session) throw new Error("记录不存在");
  const events = (await all("events", id)).sort((a, b) => a.seq - b.seq);
  const assets = await all("assets", id);
  const files = {
    "resources/index.json": strToU8(
      JSON.stringify(assets.map(({ id, type, mime }) => ({ id, type, mime }))),
    ),
  };
  for (const asset of assets)
    files[
      asset.type === "screenshot"
        ? `screenshots/${asset.id}.jpg`
        : `resources/${asset.id}.bin`
    ] = new Uint8Array(await asset.blob.arrayBuffer());
  return {
    manifest: {
      format: "logic-recorder",
      version: 1,
      session,
      eventCount: events.length,
      assetCount: assets.length,
      partial: session.status === "interrupted",
    },
    events,
    files,
  };
}
export async function createArchive(id, onProgress = () => {}) {
  const session = await get("sessions", id);
  if (!session || !["ready", "interrupted"].includes(session.status))
    throw new Error("记录尚未结束，无法导出");
  const assets = await all("assets", id);
  if (assets.length > 25000) throw new Error("截图和资源数量超过单包上限");
  const count = await countEvents(id),
    chunks = [],
    integrity = [],
    eventChunks = [];
  let resolveZip, rejectZip, zipError;
  const finished = new Promise((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });
  const zip = new Zip((error, data, final) => {
    if (error) {
      zipError = error;
      rejectZip(error);
    } else {
      chunks.push(data);
      if (final) resolveZip(new Blob(chunks, { type: "application/zip" }));
    }
  });
  async function addFile(path, bytes, compress = true) {
    if (zipError) throw zipError;
    const item = compress
      ? new ZipDeflate(path, { level: 6 })
      : new ZipPassThrough(path);
    zip.add(item);
    item.push(bytes, true);
    integrity.push({ path, size: bytes.length, sha256: await digest(bytes) });
  }
  let after = 0,
    eventCount = 0,
    batch = [],
    batchSize = 0;
  async function flushEvents() {
    if (!batch.length) return;
    const bytes = new Uint8Array(batchSize);
    let offset = 0;
    for (const item of batch) {
      bytes.set(item, offset);
      offset += item.length;
    }
    const path = `timeline/events-${String(eventChunks.length + 1).padStart(5, "0")}.jsonl`;
    await addFile(path, bytes);
    eventChunks.push(path);
    batch = [];
    batchSize = 0;
  }
  while (true) {
    const events = await eventPage(id, after);
    if (!events.length) break;
    for (const event of events) {
      const encoded = strToU8(JSON.stringify(event) + "\n");
      if (batchSize && batchSize + encoded.length > 2000000)
        await flushEvents();
      batch.push(encoded);
      batchSize += encoded.length;
      after = event.seq;
      eventCount++;
    }
    onProgress({ phase: "整理操作与页面", current: eventCount, total: count });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await flushEvents();
  if (eventCount !== count) throw new Error("记录数据不完整，无法导出");
  await addFile(
    "resources/index.json",
    strToU8(
      JSON.stringify(assets.map(({ id, type, mime }) => ({ id, type, mime }))),
    ),
  );
  let assetsDone = 0;
  for (const asset of assets) {
    const path =
      asset.type === "screenshot"
        ? `screenshots/${asset.id}.jpg`
        : `resources/${asset.id}.bin`;
    await addFile(path, new Uint8Array(await asset.blob.arrayBuffer()), false);
    assetsDone++;
    if (assetsDone % 10 === 0 || assetsDone === assets.length)
      onProgress({
        phase: "整理截图与资源",
        current: assetsDone,
        total: assets.length,
      });
  }
  const manifest = {
    format: "logic-recorder",
    version: 2,
    session,
    eventCount,
    eventChunks,
    assetCount: assets.length,
    exportedAt: Date.now(),
    partial: session.status === "interrupted",
    limitations: [
      "仅记录已授权范围内的网页",
      "开始前的请求未采集",
      "页面快照不包含站点脚本",
      "数据库仅采集有限的开始和结束快照，缓存仅采集名称",
      "部分请求体和响应体可能不可获取",
      "敏感凭据默认隐藏",
    ],
  };
  await addFile("manifest.json", strToU8(JSON.stringify(manifest, null, 2)));
  const index = new ZipDeflate("integrity.json", { level: 6 });
  zip.add(index);
  index.push(strToU8(JSON.stringify(integrity, null, 2)), true);
  zip.end();
  return finished;
}
async function inspectZip(blob) {
  const tailOffset = Math.max(0, blob.size - 65557);
  const tail = new Uint8Array(await blob.slice(tailOffset).arrayBuffer());
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--)
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === tail.length
    ) {
      end = i;
      break;
    }
  if (end < 0) throw new Error("ZIP 目录损坏");
  const entries = view.getUint16(end + 10, true),
    directorySize = view.getUint32(end + 12, true),
    directory = view.getUint32(end + 16, true);
  if (
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== entries ||
    entries > 30000 ||
    directorySize > 10000000 ||
    directory + directorySize > tailOffset + end
  )
    throw new Error("ZIP 目录超出限制");
  const bytes = new Uint8Array(
    await blob.slice(directory, directory + directorySize).arrayBuffer(),
  );
  const dirView = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  );
  let pos = 0,
    total = 0;
  const names = new Map();
  for (let i = 0; i < entries; i++) {
    if (pos + 46 > bytes.length || dirView.getUint32(pos, true) !== 0x02014b50)
      throw new Error("ZIP 目录无效");
    const compressed = dirView.getUint32(pos + 20, true),
      size = dirView.getUint32(pos + 24, true),
      nameLen = dirView.getUint16(pos + 28, true),
      extraLen = dirView.getUint16(pos + 30, true),
      commentLen = dirView.getUint16(pos + 32, true);
    if (
      nameLen > 1024 ||
      dirView.getUint16(pos + 8, true) & 1 ||
      pos + 46 + nameLen + extraLen + commentLen > bytes.length
    )
      throw new Error("ZIP 目录越界或包含加密文件");
    const name = strFromU8(bytes.subarray(pos + 46, pos + 46 + nameLen));
    if (
      !name ||
      name.startsWith("/") ||
      name.includes("\\") ||
      name.split("/").includes("..") ||
      names.has(name) ||
      /^[a-z]:/i.test(name)
    )
      throw new Error("ZIP 含不安全或重复路径");
    names.set(name, size);
    total += size;
    if (
      size > 50000000 ||
      total > 1000000000 ||
      (size > 1000000 && size / Math.max(compressed, 1) > 500)
    )
      throw new Error("ZIP 展开体积超过限制");
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== bytes.length) throw new Error("ZIP 目录长度不匹配");
  return names;
}
export async function readArchive(input, onProgress = () => {}) {
  const blob = input instanceof Blob ? input : new Blob([input]);
  if (blob.size > 300000000) throw new Error("记录包超过 300 MB 导入限制");
  const directory = await inspectZip(blob),
    seen = new Set(),
    files = Object.create(null);
  let expanded = 0;
  const unzip = new Unzip((file) => {
    if (!directory.has(file.name) || seen.has(file.name))
      throw new Error("ZIP 文件与目录不匹配");
    seen.add(file.name);
    const parts = [];
    let size = 0;
    file.ondata = (error, data, final) => {
      if (error) throw error;
      size += data.length;
      expanded += data.length;
      if (size > directory.get(file.name) || expanded > 1000000000)
        throw new Error("ZIP 实际展开体积超过限制");
      parts.push(data);
      if (final) {
        if (size !== directory.get(file.name))
          throw new Error("ZIP 文件大小不匹配");
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        files[file.name] = bytes;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  const chunkSize = 32768;
  for (let offset = 0; offset < blob.size; offset += chunkSize) {
    const end = Math.min(blob.size, offset + chunkSize);
    unzip.push(
      new Uint8Array(await blob.slice(offset, end).arrayBuffer()),
      end === blob.size,
    );
    if ((offset / chunkSize) % 8 === 0 || end === blob.size) {
      onProgress(end, blob.size);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  if (
    seen.size !== directory.size ||
    Object.keys(files).length !== directory.size
  )
    throw new Error("ZIP 文件不完整");
  if (!files["manifest.json"] || !files["integrity.json"])
    throw new Error("记录包缺少必要文件");
  const manifest = JSON.parse(strFromU8(files["manifest.json"]));
  if (
    manifest.format !== "logic-recorder" ||
    ![1, 2].includes(manifest.version)
  )
    throw new Error("不支持的记录包格式");
  if (
    !manifest.session ||
    typeof manifest.session.id !== "string" ||
    typeof manifest.session.title !== "string" ||
    !Number.isFinite(manifest.session.startedAt)
  )
    throw new Error("记录任务信息无效");
  const integrity = JSON.parse(strFromU8(files["integrity.json"]));
  if (!Array.isArray(integrity) || integrity.length > directory.size)
    throw new Error("校验清单无效");
  const paths = new Set();
  for (const entry of integrity) {
    if (
      !entry ||
      typeof entry.path !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      paths.has(entry.path) ||
      !files[entry.path] ||
      files[entry.path].length !== entry.size ||
      (await digest(files[entry.path])) !== entry.sha256
    )
      throw new Error(`文件校验失败：${entry?.path || "未知文件"}`);
    paths.add(entry.path);
  }
  for (const path of Object.keys(files))
    if (path !== "integrity.json" && !paths.has(path))
      throw new Error(`文件未纳入校验：${path}`);
  const eventPaths =
    manifest.version === 1 ? ["timeline/events.jsonl"] : manifest.eventChunks;
  if (
    !Array.isArray(eventPaths) ||
    (manifest.version === 2 &&
      (new Set(eventPaths).size !== eventPaths.length ||
        eventPaths.some(
          (path) =>
            typeof path !== "string" ||
            !/^timeline\/events-\d{5}\.jsonl$/.test(path) ||
            !files[path],
        ))) ||
    (manifest.version === 1 && !files[eventPaths[0]])
  )
    throw new Error("记录包缺少事件文件");
  const events = [],
    eventIds = new Set();
  for (const path of eventPaths) {
    for (const line of strFromU8(files[path]).split("\n")) {
      if (!line) continue;
      if (line.length > 10000000 || events.length >= 1000000)
        throw new Error("事件数据超过大小限制");
      const event = JSON.parse(line);
      if (
        !event ||
        typeof event.id !== "string" ||
        event.id.length > 128 ||
        eventIds.has(event.id) ||
        typeof event.kind !== "string" ||
        event.kind.length > 128 ||
        !Number.isFinite(event.time) ||
        !Number.isSafeInteger(event.seq) ||
        !event.payload ||
        typeof event.payload !== "object" ||
        Array.isArray(event.payload)
      )
        throw new Error("事件数据格式无效");
      eventIds.add(event.id);
      events.push(event);
    }
    delete files[path];
  }
  if (manifest.version === 2 && events.length !== manifest.eventCount)
    throw new Error("事件数量与清单不一致");
  if (files["resources/index.json"]) {
    const resources = JSON.parse(strFromU8(files["resources/index.json"]));
    if (
      !Array.isArray(resources) ||
      resources.length > 25000 ||
      resources.some(
        (item) =>
          !item ||
          typeof item.id !== "string" ||
          !/^[a-z0-9_-]{1,128}$/i.test(item.id) ||
          typeof item.mime !== "string" ||
          !["resource", "screenshot"].includes(item.type),
      )
    )
      throw new Error("资源索引格式无效");
  }
  return { manifest, events, files };
}
