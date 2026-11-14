import * as flowStore from "./flow-store.js";
import { createArchiveTask } from "./archive-task.js";
import { limitsForSession } from "./flow-config.js";
import { createFlowZipSink, FlowZip64Writer, FLOW_MEMORY_ZIP_MAX_BYTES } from "./flow-zip64.js";

const SHA = /^[a-f0-9]{64}$/;
const CATEGORIES = ["body", "dom", "resource", "screenshot", "meta"];
const encoder = new TextEncoder(), EVENT_CHUNK_BYTES = 1024 * 1024;
const assert = (value, message) => { if (!value) throw new Error(message); };
const natural = (value) => Number.isSafeInteger(value) && value >= 0;
const same = (a, b) => {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a); return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
};
function publicSession(session) { const { ownerToken, captureKey, ...safe } = session; return safe; }
function watermark(session) {
  assert(session?.seal && ["ready", "interrupted"].includes(session.status), "当前批次尚未完成封存，不能导出");
  return JSON.stringify(publicSession(session));
}
function checkedLimits(session) {
  const limits = limitsForSession(session), budget = session.budget;
  assert(budget && natural(budget.usedBytes) && budget.usedBytes <= limits.budget.totalBytes && budget.limitBytes === limits.budget.totalBytes,
    "批次容量账本或设置上限无效");
  if (budget.reserveBytes !== undefined) assert(budget.reserveBytes === limits.budget.reserveBytes, "批次预留容量与设置不一致");
  if (session.capturePolicy?.settings !== undefined) {
    assert(same(budget.settings, limits.settings) && same(session.capturePolicy.limits, limits.budget) &&
      same(session.capturePolicy.runtimeLimits, { background: limits.background, content: limits.content }), "批次设置或限额快照不一致");
  } else if (budget.settings !== undefined) assert(same(budget.settings, limits.settings), "旧批次限额不能改为当前设置");
  if (budget.byCategory !== undefined) {
    assert(Object.keys(budget.byCategory).length === CATEGORIES.length && CATEGORIES.every((category) =>
      natural(budget.byCategory[category]) && budget.byCategory[category] <= limits.budget.categoryBytes[category]), "批次分类容量账本无效");
  }
  assert(natural(session.eventCount) && natural(session.contentCount) && natural(session.lastSeq) &&
    session.lastSeq === session.eventCount && session.seal.eventCount === session.eventCount &&
    session.seal.contentCount === session.contentCount && session.seal.lastSeq === session.lastSeq, "批次封存计数不一致");
  return limits;
}
// Older pure callers may supply the original read API. Production always uses
// cursor pages; no complete events/content handles are retained by this module.
async function* contentPages(store, id, task, session) {
  if (typeof store.flowContentPage !== "function") {
    assert(typeof store.readContents === "function", "缺少内容分页接口");
    yield await task.wait(() => store.readContents(id, { signal: task.signal })); return;
  }
  let afterId = "", count = 0;
  for (;;) {
    const page = await task.wait(() => store.flowContentPage(id, afterId, { limit: 50, signal: task.signal }));
    assert(page && Array.isArray(page.contents) && page.contents.length <= 50 && typeof page.done === "boolean", "内容分页结果无效");
    let previous = afterId;
    for (const item of page.contents) { assert(typeof item.id === "string" && item.id > previous, "内容分页游标无效"); previous = item.id; }
    assert(typeof page.nextId === "string" && page.nextId === previous && (page.done || previous > afterId), "内容分页游标无效");
    count += page.contents.length; assert(count <= session.contentCount, "批次封存计数不一致");
    yield page.contents; if (page.done) return; afterId = page.nextId; await task.yield();
  }
}
async function* eventPages(store, id, task, session) {
  if (typeof store.flowEventPage !== "function") {
    assert(typeof store.readEvents === "function", "缺少事件分页接口");
    yield await task.wait(() => store.readEvents(id, { signal: task.signal })); return;
  }
  let afterSeq = 0, count = 0;
  for (;;) {
    const page = await task.wait(() => store.flowEventPage(id, afterSeq, { limit: 500, maxBytes: 8 * 1024 * 1024, signal: task.signal }));
    assert(page && Array.isArray(page.events) && page.events.length <= 500 && typeof page.done === "boolean", "事件分页结果无效");
    const next = page.events.at(-1)?.seq ?? afterSeq;
    assert(natural(page.nextSeq) && page.nextSeq === next && (page.done || next > afterSeq), "事件分页游标无效");
    count += page.events.length; assert(count <= session.eventCount, "批次封存计数不一致");
    yield page.events; if (page.done) return; afterSeq = page.nextSeq; await task.yield();
  }
}
function contentMetadata(item, id, maximum) {
  assert(item && item.sessionId === id && SHA.test(item.sha256) && item.id === id + ":" + item.sha256 &&
    natural(item.size) && item.size <= maximum && item.blob instanceof Blob && item.blob.size === item.size &&
    typeof item.mime === "string" && item.mime.length > 0 && item.mime.length <= 256 && CATEGORIES.includes(item.category), "内容索引无效或重复");
  assert(!Object.hasOwn(item, "ownerToken") && !Object.hasOwn(item, "captureKey"), "内部接纳标识不能进入记录包");
  return { contentId: item.id, path: "contents/" + item.sha256 + ".bin", size: item.size, sha256: item.sha256, mime: item.mime, category: item.category };
}

export function createFlowArchive(store = flowStore) {
  return async function createArchive(id, onProgress = () => {}, options = {}) {
    const task = createArchiveTask(onProgress, options);
    let sink, returned = false;
    try {
      task.stage("读取批次与附件索引");
      const original = await task.wait(() => store.getSession(id, { signal: task.signal }));
      assert(original?.profile === "business-flow-v1", "该批次不是新版业务记录；本版本不迁移旧数据");
      const initialWatermark = watermark(original);
      // Preserve the exact initial snapshot even when a pure source returns the
      // same mutable object on the final read.
      const session = JSON.parse(JSON.stringify(publicSession(original))), limits = checkedLimits(session);
      const storage = Object.hasOwn(options, "storage") ? options.storage : globalThis.navigator?.storage;
      if (typeof storage?.getDirectory !== "function") assert(session.budget.usedBytes <= FLOW_MEMORY_ZIP_MAX_BYTES,
        "此环境不支持OPFS磁盘导出；内存导出上限为128MiB，请使用支持OPFS的Chrome");
      // Creating a disk sink is cancellable; late resolution after abort cleans
      // its own temporary file instead of leaking an unclaimed handle.
      sink = await task.wait(async () => {
        sink = await createFlowZipSink({ signal: task.signal, storage, onWrite: (bytesDone) => task.progress({ bytesDone }) });
        if (task.signal.aborted) { await sink.abort(); task.check(); }
        return sink;
      });
      const zip = new FlowZip64Writer(sink, { task, signal: task.signal });
      const byId = new Map(), byHash = new Set(), declared = [], integrity = [], eventChunks = [];
      let storedBytes = 0, rawBytes = 0, inputBytes = 0, eventCount = 0, stopCount = 0, lastSeq = 0, lastKind;
      const categoryBytes = Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
      const add = async (path, source, size = source.byteLength, expectedSha256) => {
        const record = await zip.add(path, source, { size, expectedSha256 });
        inputBytes += record.size; assert(Number.isSafeInteger(inputBytes), "记录包计数溢出"); integrity.push(record); return record;
      };
      // Only index metadata is retained between pages; Blob handles are revisited
      // once for streaming after all references and the byte ledger pass.
      for await (const contents of contentPages(store, id, task, session)) {
        for (const item of contents) {
          const meta = contentMetadata(item, id, limits.budget.totalBytes);
          assert(!byId.has(meta.contentId) && !byHash.has(meta.sha256), "内容索引无效或重复");
          storedBytes += item.size; assert(Number.isSafeInteger(storedBytes) && storedBytes <= session.budget.usedBytes, "批次内容超过设置容量上限");
          byId.set(meta.contentId, { ...meta, references: 0, categories: new Set() }); byHash.add(meta.sha256); declared.push(meta);
          task.progress({ current: declared.length, total: session.contentCount }); await task.yield();
        }
      }
      assert(declared.length === session.contentCount, "批次封存计数不一致");
      task.stage("整理操作与页面", { total: session.eventCount });
      let pending = [], pendingBytes = 0;
      const flush = async () => {
        if (!pending.length) return;
        const path = "timeline/events-" + String(eventChunks.length + 1).padStart(5, "0") + ".jsonl";
        const bytes = new Uint8Array(pendingBytes); let p = 0;
        for (const block of pending) { bytes.set(block, p); p += block.length; }
        pending = []; pendingBytes = 0; await add(path, bytes); eventChunks.push(path);
      };
      const uniqueIds = new Set();
      for await (const events of eventPages(store, id, task, session)) {
        for (const event of events) {
          task.check();
          assert(event.sessionId === id && typeof event.id === "string" && event.id.length > 0 && event.id.length <= 512 && !uniqueIds.has(event.id) &&
            natural(event.seq) && event.seq === lastSeq + 1 && typeof event.kind === "string" && typeof event.time === "number" && Number.isFinite(event.time), "原始事件顺序或身份无效");
          assert(!Object.hasOwn(event, "captureKey") && !Object.hasOwn(event, "ownerToken"), "内部接纳标识不能进入记录包");
          uniqueIds.add(event.id); lastSeq = event.seq; lastKind = event.kind; eventCount++; if (event.kind === "session.stop") stopCount++;
          let references = 0;
          for (const value of Object.values(event.payload || {})) {
            // Only the recorder reference schema has both markers. Business
            // payloads may independently contain status or contentId fields.
            if (!value || typeof value !== "object" || value.status !== "captured" || !Object.hasOwn(value, "contentId")) continue;
            const item = byId.get(value.contentId);
            assert(value.status === "captured" && item && item.sha256 === value.sha256 && item.size === value.size &&
              typeof value.mime === "string" && value.mime.length > 0 && value.mime.length <= 256 && CATEGORIES.includes(value.category), "事件引用的原始内容缺失或不一致");
            assert(++references <= limits.content.maxContents, "事件内容引用超过设置上限");
            if (value.category === "body") assert(value.size <= limits.budget.singleBodyBytes, "单个正文超过设置上限");
            if (!item.categories.has(value.category)) { item.categories.add(value.category); categoryBytes[value.category] += item.size; }
            item.references++;
          }
          const bytes = encoder.encode(JSON.stringify(event) + "\n");
          assert(bytes.length <= limits.budget.eventBytes, "原始事件超过设置元数据上限");
          rawBytes += bytes.length; categoryBytes.meta += bytes.length;
          assert(Number.isSafeInteger(rawBytes) && rawBytes + storedBytes <= limits.budget.totalBytes, "已保存数据超过设置容量上限");
          if (pendingBytes && pendingBytes + bytes.length > EVENT_CHUNK_BYTES) await flush();
          pending.push(bytes); pendingBytes += bytes.length;
          if (pendingBytes >= EVENT_CHUNK_BYTES) await flush();
          task.progress({ current: eventCount, total: session.eventCount }); await task.yield();
        }
      }
      await flush();
      assert(eventCount === session.eventCount && lastSeq === session.lastSeq && lastKind === "session.stop" && stopCount === 1, "批次停止记录或水位不一致");
      assert([...byId.values()].every((item) => item.references > 0), "内容索引存在未引用的原始内容");
      assert(rawBytes + storedBytes === session.budget.usedBytes, "批次容量账本与原始数据不一致");
      assert(CATEGORIES.every((category) => categoryBytes[category] <= limits.budget.categoryBytes[category]), "分类内容超过设置上限");
      if (session.budget.byCategory !== undefined) assert(same(session.budget.byCategory, categoryBytes), "批次分类容量账本与引用不一致");
      task.stage("整理截图与资源", { total: session.contentCount });
      const written = new Set();
      for await (const contents of contentPages(store, id, task, session)) {
        for (const item of contents) {
          const meta = contentMetadata(item, id, limits.budget.totalBytes), originalMeta = byId.get(meta.contentId);
          assert(originalMeta && !written.has(meta.contentId) && Object.keys(meta).every((key) => meta[key] === originalMeta[key]), "导出期间内容索引已改变");
          await add(meta.path, item.blob, meta.size, meta.sha256); written.add(meta.contentId);
          task.progress({ current: written.size, total: session.contentCount }, true);
        }
      }
      assert(written.size === session.contentCount, "导出期间内容索引已改变");
      task.stage("生成清单与完整性校验");
      const manifest = { format: "logic-recorder", version: 3, profile: "business-flow-v1", session,
        eventCount, contentCount: declared.length, eventChunks, contents: declared,
        capturePolicy: session.capturePolicy, budget: session.budget, derivations: "none", partial: session.status === "interrupted" || !!session.incomplete || !!session.budget.policyStopped,
        byteAccounting: { eventJsonlBytes: rawBytes, uniqueContentBytes: storedBytes, storedLogicalBytes: rawBytes + storedBytes },
        capabilities: { purpose: "observed-business-flow-reconstruction", defaultScope: "root-tab-and-attributed-child",
          computedStyle: "not_collected_by_policy", themeDictionary: "offline_only", fullDatabase: "not_collected_by_policy",
          cacheMirror: "not_collected_by_policy", fullPageScreenshot: "not_collected_by_policy", uploadFileBytes: "not_collected_by_policy",
          sensitiveValues: "captured-original-values-may-exist", encrypted: false } };
      await add("manifest.json", encoder.encode(JSON.stringify(manifest, null, 2)));
      const checksums = encoder.encode(JSON.stringify(integrity, null, 2));
      await zip.add("integrity.json", checksums); inputBytes += checksums.length;
      const allowance = Math.max(1024 * 1024, Math.ceil((rawBytes + storedBytes) * 0.05));
      assert(inputBytes <= rawBytes + storedBytes + allowance, "清单开销超过导出预算");
      const blob = await zip.finish();
      task.stage("核对封存与下载准备");
      assert(watermark(await task.wait(() => store.getSession(id, { signal: task.signal }))) === initialWatermark, "导出期间封存已改变");
      task.check(); returned = true;
      return { blob, cleanup: () => sink.cleanup(), importIssues: [], metrics: { expandedBytes: inputBytes, storedLogicalBytes: rawBytes + storedBytes,
        metadataOverheadBytes: inputBytes - rawBytes - storedBytes, zipBytes: blob.size, eventCount, contentCount: declared.length, outputStorage: sink.storage, storageMode: sink.storage } };
    } finally {
      try { if (sink && !returned) await sink.abort(); } finally { task.dispose(); }
    }
  };
}
export const createArchive = createFlowArchive();
