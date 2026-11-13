import {
  strToU8,
  strFromU8,
  Zip,
  Unzip,
  UnzipInflate,
} from "fflate";
import { all, get, eventPage, countEvents, countAssets, saveImport } from "./db.js";
import { withSessionLock } from "./session-lock.js";
import { screenshotAssetPath } from "./screenshots.js";
import { indexEvent } from "./archive-index.js";
import { observeNetworkBody, observeNetworkQuery } from "./field-observations.js";
import { observeThemeValues } from "./style-observations.js";
import { createFieldSummary } from "./field-summary.js";
import { directRelationships } from "./relationships.js";
import { observeBrowserData, incompleteBrowserObservation } from "./browser-observations.js";
import { createBrowserFieldSummary } from "./browser-field-summary.js";
import { createPageInstances } from "./page-instances.js";
import { createInterfaceIndex } from "./interface-index.js";
import { reconstructFragments } from "./fragments.js";
import { createFragmentTerminals } from "./fragment-terminals.js";
import { createArchiveProvenance, readArchiveExporterVersion } from "./archive-provenance.js";
import { createArchiveTask } from "./archive-task.js";
import { addArchiveFile } from "./archive-compression.js";

const digest = async (bytes) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export async function readLocalSession(id) {
  return withSessionLock(id, "shared", () => readLocalSessionData(id));
}
async function readLocalSessionData(id) {
  const session = await get("sessions", id);
  if (!session) throw new Error("记录不存在");
  if (session.imported) {
    const stored = await get("imports", id);
    if (!(stored?.blob instanceof Blob)) throw new Error("已导入的记录包不存在");
    return readArchive(stored.blob);
  }
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
        ? screenshotAssetPath(asset.id, asset.mime)
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
export async function createArchive(id, onProgress = () => {}, options = {}) {
  const task = createArchiveTask(onProgress, options);
  try {
    task.stage("等待记录访问");
    return await task.wait(() => withSessionLock(id, "shared", () => createArchiveData(id, task), { signal: task.signal }));
  } finally { task.dispose(); }
}
export function archiveSeal(session) {
  if (session?.seal == null) return null;
  const seal = session.seal;
  if (!Number.isSafeInteger(seal.revision) || seal.revision <= 0 || session.revision !== seal.revision ||
      ![seal.lastSeq, seal.eventCount, seal.assetCount, seal.sealedAt].every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error("记录封存信息无效，无法导出");
  return { revision: seal.revision, lastSeq: seal.lastSeq, eventCount: seal.eventCount,
    assetCount: seal.assetCount, sealedAt: seal.sealedAt };
}

export function sameArchiveSeal(session, expected) {
  // Legacy terminal sessions remain count-checked; do not manufacture an immutable snapshot for them.
  return expected === null || JSON.stringify(archiveSeal(session)) === JSON.stringify(expected);
}

async function createArchiveData(id, task) {
  const readOptions = { signal: task.signal };
  task.stage("读取批次与附件索引");
  const session = await task.wait(() => get("sessions", id, readOptions));
  if (!session || !["ready", "interrupted"].includes(session.status))
    throw new Error("记录尚未结束，无法导出");
  if (session.imported) {
    const stored = await task.wait(() => get("imports", id, readOptions));
    if (!(stored?.blob instanceof Blob)) throw new Error("已导入的记录包不存在");
    return { blob: stored.blob, importIssues: [] };
  }
  const sealed = archiveSeal(session);
  const assets = await task.wait(() => all("assets", id, readOptions));
  if (assets.length > 25000) throw new Error("截图和资源数量超过单包上限");
  const assetsById = new Map(assets.map((asset) => [asset.id, asset]));
  const count = await task.wait(() => countEvents(id, readOptions)),
    chunks = [],
    integrity = [],
    eventChunks = [],
    eventIndexChunks = [],
    relationshipChunks = [],
    pageInstanceChunks = [],
    interfaceChunks = [],
    fieldObservationChunks = [],
    fieldSummaryChunks = [],
    browserObservationChunks = [],
    browserFieldSummaryChunks = [],
    themeObservationChunks = [];
  if (sealed && (sealed.eventCount !== count || sealed.assetCount !== assets.length))
    throw new Error("记录与封存计数不一致，无法导出");
  const fragmentTerminals = createFragmentTerminals();
  let terminalAfter = 0, terminalEventCount = 0;
  task.stage("核对分段终态", { total: count });
  while (true) {
    const events = await task.wait(() => eventPage(id, terminalAfter, 20, readOptions));
    if (!events.length) break;
    for (const event of events) {
      fragmentTerminals.add(event);
      terminalAfter = event.seq;
      terminalEventCount++;
    }
    task.progress({ current: terminalEventCount, total: count }, true);
    await task.yield(true);
  }
  if (terminalEventCount !== count || (sealed && terminalAfter !== sealed.lastSeq))
    throw new Error("分段终态预扫与记录计数或封存序号不一致");
  if (sealed) {
    const afterPrepass = await task.wait(() => get("sessions", id, readOptions));
    if (!afterPrepass || !["ready", "interrupted"].includes(afterPrepass.status) || !sameArchiveSeal(afterPrepass, sealed))
      throw new Error("记录在分段终态预扫期间发生变化，请重新下载");
  }
  let resolveZip, rejectZip, zipError;
  const finished = new Promise((resolve, reject) => {
    resolveZip = resolve;
    rejectZip = reject;
  });
  // Observe a codec error even while another stage is awaiting I/O.
  finished.catch(() => {});
  const zip = new Zip((error, data, final) => {
    if (error) {
      zipError = error;
      rejectZip(error);
    } else {
      chunks.push(data);
      if (final) resolveZip(new Blob(chunks, { type: "application/zip" }));
    }
  });
  const abortZip = () => zip.terminate();
  task.signal.addEventListener("abort", abortZip, { once: true });
  let compressedInputBytes = 0;
  try {
  async function addFile(path, bytes, compress = true) {
    task.check();
    if (zipError) throw zipError;
    const before = compressedInputBytes;
    await task.wait(() => addArchiveFile(zip, path, bytes, { compress, signal: task.signal,
      onBlock: (done) => task.progress({ bytesDone: before + done }) }));
    compressedInputBytes += bytes.length;
    const sha256 = await task.wait(() => digest(bytes));
    integrity.push({ path, size: bytes.length, sha256 });
  }
  function observationWriter(prefix, paths) {
    let batch = [], size = 0;
    return {
      async add(row) {
        const encoded = strToU8(JSON.stringify(row) + "\n");
        if (size && size + encoded.length > 2000000) await this.flush();
        await task.yield();
        batch.push(encoded);
        size += encoded.length;
      },
      async flush() {
        if (!batch.length) return;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const item of batch) { bytes.set(item, offset); offset += item.length; }
        const path = `${prefix}-${String(paths.length + 1).padStart(5, "0")}.jsonl`;
        await addFile(path, bytes);
        paths.push(path);
        batch = [];
        size = 0;
      },
    };
  }
  const fieldWriter = observationWriter("data-dictionary/observations", fieldObservationChunks);
  const summaryWriter = observationWriter("data-dictionary/fields", fieldSummaryChunks);
  const themeWriter = observationWriter("styles/theme-observations", themeObservationChunks);
  const relationshipWriter = observationWriter("indexes/relationships", relationshipChunks);
  const pageWriter = observationWriter("indexes/page-instances", pageInstanceChunks);
  const pageInstances = createPageInstances();
  const interfaceWriter = observationWriter("indexes/interfaces", interfaceChunks);
  const interfaces = createInterfaceIndex();
  const browserWriter = observationWriter("data-dictionary/browser-observations", browserObservationChunks);
  const browserSummaryWriter = observationWriter("data-dictionary/browser-fields", browserFieldSummaryChunks);
  const browserSummary = createBrowserFieldSummary();
  async function writeBrowserObservation(observation) {
    browserSummary.add(observation);
    await browserWriter.add(observation);
  }
  const requestEndpoints = new Map(), fieldSummary = createFieldSummary();
  const pendingBrowserFragments = new Map();
  const browserFragmentKey = (reference) => JSON.stringify([reference?.captureId, reference?.field]);
  let after = 0,
    eventCount = 0,
    batch = [],
    indexBatch = [],
    batchSize = 0,
    oversizedEvent = false;
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
    const indexPath = `indexes/events-${String(eventIndexChunks.length + 1).padStart(5, "0")}.jsonl`;
    await addFile(indexPath, strToU8(indexBatch.map((event, index) =>
      JSON.stringify(indexEvent(event, path, index + 1))).join("\n") + "\n"));
    eventIndexChunks.push(indexPath);
    for (let index = 0; index < indexBatch.length; index++) {
      await task.yield();
      const event = indexBatch[index];
      pageInstances.add(event, path, index + 1);
      interfaces.add(event, path, index + 1);
      if (typeof event.payload?.assetId === "string" && !assetsById.has(event.payload.assetId))
        throw new Error(`记录引用的附件不存在：${event.id}`);
      if (event.kind === "network.requestDataEntries" && Array.isArray(event.payload?.entries)) {
        for (const entry of event.payload.entries)
          if (entry.status === "captured" && !assetsById.has(entry.assetId))
            throw new Error(`记录引用的请求体附件不存在：${event.id}`);
      }
      if (event.kind === "network.request" && typeof event.payload?.requestId === "string") {
        try {
          const url = new URL(event.payload.url);
          const contentType = Object.entries(event.payload.headers || {})
            .find(([name]) => name.toLowerCase() === "content-type")?.[1] || "";
          requestEndpoints.set(event.payload.requestId, { endpoint: { method: event.payload.method, url: url.origin + url.pathname }, contentType });
        } catch {}
      }
      if (event.kind === "network.response" && typeof event.payload?.requestId === "string") {
        const request = requestEndpoints.get(event.payload.requestId);
        if (request) request.responseContentType = Object.entries(event.payload.headers || {})
          .find(([name]) => name.toLowerCase() === "content-type")?.[1] || event.payload.mimeType || "";
      }
      const body = event.kind === "network.request" ? event.payload?.postData
        : ["network.requestBody", "network.finished"].includes(event.kind) ? event.payload?.body : null;
      const assetId = body?.assetId || (body?.status === "captured_asset" ? event.payload?.assetId : null);
      const asset = assetsById.get(assetId);
      if (body?.status === "captured_asset" && !asset)
        throw new Error(`记录引用的正文附件不存在：${event.id}`);
      let sample = null;
      if (body?.status === "captured_asset" && asset && /(?:^|\/)json$|\+json$|(?:^|\/)xml$|\+xml$|^application\/x-www-form-urlencoded$|^text\/plain$/i.test(asset.mime || "")) {
        const assetPath = `resources/${asset.id}.bin`;
        try {
          sample = { path: assetPath, text: new TextDecoder("utf-8", { fatal: true }).decode(await task.wait(() => asset.blob.arrayBuffer())) };
        } catch (error) { sample = { path: assetPath, error: String(error) }; }
      }
      const request = requestEndpoints.get(event.payload?.requestId);
      const direction = event.kind === "network.finished" ? "response" : "request";
      for (const observation of observeNetworkQuery(event, { path, line: index + 1,
        ...(request ? { endpoint: request.endpoint, direction: "query" } : {}) })) {
        fieldSummary.add(observation);
        await fieldWriter.add(observation);
      }
      for (const observation of observeNetworkBody(event, { path, line: index + 1,
        ...(request ? { endpoint: request.endpoint, direction,
          contentType: direction === "request" ? request.contentType : request.responseContentType } : {}) }, sample)) {
        fieldSummary.add(observation);
        await fieldWriter.add(observation);
      }
      for (const observation of observeThemeValues(indexBatch[index], { path, line: index + 1 }))
        await themeWriter.add(observation);
      for (const relationship of directRelationships(event, { path, line: index + 1 }))
        await relationshipWriter.add(relationship);
      const browserReference = event.kind === "storage.snapshot" ? event.payload?.storageReference
        : event.kind === "database.record" ? event.payload?.graphReference : null;
      if (browserReference) {
        if (pendingBrowserFragments.has(browserFragmentKey(browserReference))) throw new Error("浏览器数据分段标识重复");
        pendingBrowserFragments.set(browserFragmentKey(browserReference), { reference: browserReference, event,
          evidence: { path, line: index + 1, fragmentCaptureId: browserReference.captureId }, parts: [] });
      } else {
        for (const observation of observeBrowserData(event, { path, line: index + 1 })) await writeBrowserObservation(observation);
      }
      if (["capture.fragment", "capture.fragmentEnd", "capture.fragmentFailure"].includes(event.kind)) {
        const pending = pendingBrowserFragments.get(browserFragmentKey(event.payload));
        if (pending) {
          pending.parts.push(event);
          if (event.kind === "capture.fragmentEnd" || event.kind === "capture.fragmentFailure") {
            try {
              if (event.kind === "capture.fragmentFailure") throw new Error("分段传输失败");
              fragmentTerminals.validate(pending.reference);
              const decoded = JSON.parse(reconstructFragments(pending.reference, pending.parts));
              for (const observation of observeBrowserData(pending.event, pending.evidence, decoded)) await writeBrowserObservation(observation);
            } catch (error) {
              await writeBrowserObservation(incompleteBrowserObservation(pending.event, pending.evidence, String(error)));
            }
            pendingBrowserFragments.delete(browserFragmentKey(event.payload));
          }
        }
      }
    }
    batch = [];
    indexBatch = [];
    batchSize = 0;
  }
  task.stage("整理操作与页面", { total: count });
  while (true) {
    const events = await task.wait(() => eventPage(id, after, 20, readOptions));
    if (!events.length) break;
    for (const event of events) {
      const json = JSON.stringify(event);
      if (json.length > 10000000) oversizedEvent = true;
      const encoded = strToU8(json + "\n");
      if (batchSize && batchSize + encoded.length > 2000000)
        await flushEvents();
      batch.push(encoded);
      indexBatch.push(event);
      batchSize += encoded.length;
      after = event.seq;
      eventCount++;
    }
    task.progress({ current: eventCount, total: count }, true);
    await task.yield(true);
  }
  await flushEvents();
  task.stage("整理字段与关系索引");
  await fieldWriter.flush();
  for (const pending of pendingBrowserFragments.values())
    await writeBrowserObservation(incompleteBrowserObservation(pending.event, pending.evidence, "未收到分段结束确认"));
  await browserWriter.flush();
  for (const row of browserSummary.results()) await browserSummaryWriter.add(row);
  await browserSummaryWriter.flush();
  for (const row of fieldSummary.results()) await summaryWriter.add(row);
  await summaryWriter.flush();
  await themeWriter.flush();
  await relationshipWriter.flush();
  for (const page of pageInstances.results()) await pageWriter.add(page);
  await pageWriter.flush();
  for (const endpoint of interfaces.results()) await interfaceWriter.add(endpoint);
  await interfaceWriter.flush();
  if (eventCount !== count || eventCount !== terminalEventCount || after !== terminalAfter ||
      (sealed && after !== sealed.lastSeq)) throw new Error("记录与分段终态预扫或封存信息不一致，无法导出");
  await addFile(
    "resources/index.json",
    strToU8(
      JSON.stringify(assets.map(({ id, type, mime }) => ({ id, type, mime }))),
    ),
  );
  let assetsDone = 0;
  task.stage("整理截图与资源", { total: assets.length });
  for (const asset of assets) {
    const path =
      asset.type === "screenshot"
        ? screenshotAssetPath(asset.id, asset.mime)
        : `resources/${asset.id}.bin`;
    await addFile(path, new Uint8Array(await task.wait(() => asset.blob.arrayBuffer())), false);
    assetsDone++;
    if (assetsDone % 10 === 0 || assetsDone === assets.length)
      task.progress({ current: assetsDone, total: assets.length }, true);
  }
  const manifest = {
    format: "logic-recorder",
    version: 2,
    session,
    provenance: createArchiveProvenance(session, readArchiveExporterVersion()),
    eventCount,
    eventChunks,
    eventIndexChunks,
    relationshipChunks,
    pageInstanceChunks,
    pageInstanceUnassociatedCount: pageInstances.unassociatedCount,
    interfaceChunks,
    interfaceUnindexableCount: interfaces.unindexableCount,
    fieldObservationChunks,
    fieldSummaryChunks,
    browserObservationChunks,
    browserFieldSummaryChunks,
    themeObservationChunks,
    assetCount: assets.length,
    exportedAt: Date.now(),
    partial: session.status === "interrupted",
    limitations: [
      "仅记录已授权范围内的网页",
      "开始前的请求未采集",
      "原始 DOM 可能包含站点脚本；隔离快照与原始 DOM 分开保存",
      "数据库和缓存仅采集有限的开始和结束快照，部分缓存响应可能不可读取",
      "部分请求体和响应体可能不可获取",
      "记录包含浏览器提供的原始数据，ZIP 未加密",
    ],
  };
  task.stage("生成清单与完整性校验");
  await addFile("manifest.json", strToU8(JSON.stringify(manifest, null, 2)));
  await addFile("integrity.json", strToU8(JSON.stringify(integrity, null, 2)));
  zip.end();
  const blob = await task.wait(finished);
  task.stage("核对封存与下载准备");
  const [latest, finalEvents, finalAssets] = await task.wait(() => Promise.all([
    get("sessions", id, readOptions), countEvents(id, readOptions), countAssets(id, readOptions),
  ]));
  if (!latest || !["ready", "interrupted"].includes(latest.status) ||
      finalEvents !== eventCount || finalAssets !== assets.length || !sameArchiveSeal(latest, sealed))
    throw new Error("记录在打包期间发生变化，请重新下载");
  const importIssues = [];
  if (blob.size > 300000000) importIssues.push("ZIP 超过 300 MB");
  if (eventCount > 1000000) importIssues.push("事件超过 100 万条");
  if (oversizedEvent) importIssues.push("单条事件超过 1000 万个 UTF-16 代码单元");
  try {
    await task.wait(() => inspectZip(blob));
  } catch (error) {
    importIssues.push(error.message);
  }
  task.check();
  return { blob, importIssues };
  } finally { task.signal.removeEventListener("abort", abortZip); zip.terminate(); }
}
export async function saveImportedArchive(blob, manifest) {
  const original = manifest.session;
  const session = {
    id: crypto.randomUUID(),
    title: original.title,
    origin: typeof original.origin === "string" ? original.origin : "",
    startedAt: original.startedAt,
    status: manifest.partial ? "interrupted" : "ready",
    imported: true,
    importedAt: Date.now(),
  };
  await saveImport(session, blob);
  return session;
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
    const size = dirView.getUint32(pos + 24, true),
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
    if (size > 50000000)
      throw new Error("ZIP 展开体积超过限制：单个文件超过 50 MB");
    if (total > 1000000000)
      throw new Error("ZIP 展开体积超过限制：总计超过 1 GB");
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
