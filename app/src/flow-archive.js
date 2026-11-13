import { Zip, strToU8 } from "fflate";
import * as flowStore from "./flow-store.js";
import { addArchiveFile } from "./archive-compression.js";
import { createArchiveTask } from "./archive-task.js";
const MAX_BYTES = 64 * 1024 * 1024;
const SHA = /^[a-f0-9]{64}$/;
const digest = async (bytes) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const assert = (value, message) => { if (!value) throw new Error(message); };
function publicSession(session) {
  const { ownerToken, captureKey, ...safe } = session;
  return safe;
}
function watermark(session) {
  assert(session?.seal && ["ready", "interrupted"].includes(session.status), "当前批次尚未完成封存，不能导出");
  return JSON.stringify({ id: session.id, seal: session.seal, eventCount: session.eventCount,
    contentCount: session.contentCount, lastSeq: session.lastSeq, revision: session.revision });
}
export function createFlowArchive(store = flowStore) {
  return async function createArchive(id, onProgress = () => {}, options = {}) {
    const task = createArchiveTask(onProgress, options);
    let zip, abortZip;
    try {
      task.stage("读取批次与附件索引");
      const session = await task.wait(() => store.getSession(id, { signal: task.signal }));
      assert(session?.profile === "business-flow-v1", "该批次不是新版业务记录；本版本不迁移旧数据");
      const initialWatermark = watermark(session);
      const [events, contents] = await task.wait(() => Promise.all([
        store.readEvents(id, { signal: task.signal }), store.readContents(id, { signal: task.signal }),
      ]));
      assert(events.length === session.eventCount && contents.length === session.contentCount &&
        session.seal.eventCount === events.length && session.seal.contentCount === contents.length &&
        session.seal.lastSeq === session.lastSeq, "批次封存计数不一致");
      const byId = new Map(), byHash = new Set(), declared = [];
      let storedBytes = 0;
      for (const item of contents) {
        assert(item.sessionId === id && SHA.test(item.sha256) && !byId.has(item.id) && !byHash.has(item.sha256) &&
          Number.isSafeInteger(item.size) && item.size >= 0 && item.blob instanceof Blob && item.blob.size === item.size,
          "内容索引无效或重复");
        storedBytes += item.size; assert(storedBytes <= MAX_BYTES, "批次内容超过新版容量上限");
        byId.set(item.id, item); byHash.add(item.sha256);
        declared.push({ contentId: item.id, path: "contents/" + item.sha256 + ".bin", size: item.size,
          sha256: item.sha256, mime: item.mime, category: item.category });
      }
      let rawBytes = 0, lastSeq = 0;
      const uniqueIds = new Set();
      for (const event of events) {
        assert(event.sessionId === id && typeof event.id === "string" && !uniqueIds.has(event.id) &&
          Number.isSafeInteger(event.seq) && event.seq === lastSeq + 1 && typeof event.kind === "string" &&
          typeof event.time === "number" && Number.isFinite(event.time), "原始事件顺序或身份无效");
        uniqueIds.add(event.id); lastSeq = event.seq;
        assert(!Object.hasOwn(event, "captureKey") && !Object.hasOwn(event, "ownerToken"), "内部接纳标识不能进入记录包");
        for (const value of Object.values(event.payload || {})) {
          if (!value || typeof value !== "object" || value.status !== "captured" || !value.contentId) continue;
          const item = byId.get(value.contentId);
          assert(item && item.sha256 === value.sha256 && item.size === value.size && typeof value.mime === "string" &&
            ["body", "dom", "resource", "screenshot", "meta"].includes(value.category),
            "事件引用的原始内容缺失或不一致");
        }
        rawBytes += strToU8(JSON.stringify(event) + "\n").length;
        assert(rawBytes + storedBytes <= MAX_BYTES, "已保存数据超过新版容量上限");
      }
      assert(lastSeq === session.lastSeq && events.at(-1)?.kind === "session.stop" &&
        events.filter((event) => event.kind === "session.stop").length === 1, "批次停止记录或水位不一致");
      assert(Number.isSafeInteger(session.budget?.usedBytes) && rawBytes + storedBytes === session.budget.usedBytes,
        "批次容量账本与原始数据不一致");
      const chunks = [], integrity = [], eventChunks = [];
      let finish, fail, zipError, outputBytes = 0, inputBytes = 0;
      const finished = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
      finished.catch(() => {});
      zip = new Zip((error, bytes, final) => {
        if (error) { zipError = error; fail(error); return; }
        chunks.push(bytes); outputBytes += bytes.length;
        if (final) finish(new Blob(chunks, { type: "application/zip" }));
      });
      abortZip = () => zip.terminate(); task.signal.addEventListener("abort", abortZip, { once: true });
      const add = async (pathname, bytes, compress = true) => {
        task.check(); if (zipError) throw zipError;
        await task.wait(() => addArchiveFile(zip, pathname, bytes, { compress, signal: task.signal,
          onBlock: (done) => task.progress({ bytesDone: inputBytes + done }) }));
        inputBytes += bytes.length;
        integrity.push({ path: pathname, size: bytes.length, sha256: await task.wait(() => digest(bytes)) });
      };
      task.stage("整理操作与页面", { total: events.length });
      let pending = [], pendingBytes = 0, processed = 0;
      const flush = async () => {
        if (!pending.length) return;
        const pathname = "timeline/events-" + String(eventChunks.length + 1).padStart(5, "0") + ".jsonl";
        await add(pathname, strToU8(pending.join(""))); eventChunks.push(pathname); pending = []; pendingBytes = 0;
      };
      for (const event of events) {
        const line = JSON.stringify(event) + "\n", length = strToU8(line).length;
        if (pendingBytes && pendingBytes + length > 1024 * 1024) await flush();
        pending.push(line); pendingBytes += length; processed++;
        task.progress({ current: processed, total: events.length }); await task.yield();
      }
      await flush();
      task.stage("整理截图与资源", { total: contents.length });
      for (let index = 0; index < contents.length; index++) {
        const item = contents[index], bytes = new Uint8Array(await task.wait(() => item.blob.arrayBuffer()));
        assert(await task.wait(() => digest(bytes)) === item.sha256, "已保存原始内容校验失败");
        await add("contents/" + item.sha256 + ".bin", bytes, !/^(?:image|font)\//.test(item.mime));
        task.progress({ current: index + 1, total: contents.length }, true);
      }
      task.stage("生成清单与完整性校验");
      const manifest = { format: "logic-recorder", version: 3, profile: "business-flow-v1", session: publicSession(session),
        eventCount: events.length, contentCount: contents.length, eventChunks, contents: declared,
        capturePolicy: session.capturePolicy, budget: session.budget, derivations: "none", partial: session.status === "interrupted" || !!session.incomplete || !!session.budget.policyStopped,
        byteAccounting: { eventJsonlBytes: rawBytes, uniqueContentBytes: storedBytes, storedLogicalBytes: rawBytes + storedBytes },
        capabilities: { purpose: "observed-business-flow-reconstruction", defaultScope: "root-tab-and-attributed-child",
          computedStyle: "not_collected_by_policy", themeDictionary: "offline_only", fullDatabase: "not_collected_by_policy",
          cacheMirror: "not_collected_by_policy", fullPageScreenshot: "not_collected_by_policy", uploadFileBytes: "not_collected_by_policy",
          sensitiveValues: "captured-original-values-may-exist", encrypted: false } };
      await add("manifest.json", strToU8(JSON.stringify(manifest, null, 2)));
      const checksums = strToU8(JSON.stringify(integrity, null, 2));
      await task.wait(() => addArchiveFile(zip, "integrity.json", checksums, { signal: task.signal }));
      inputBytes += checksums.length;
      const allowance = Math.max(1024 * 1024, Math.ceil((rawBytes + storedBytes) * 0.05));
      assert(inputBytes <= rawBytes + storedBytes + allowance, "清单开销超过新版导出预算");
      zip.end(); const blob = await task.wait(finished);
      task.stage("核对封存与下载准备");
      assert(watermark(await task.wait(() => store.getSession(id, { signal: task.signal }))) === initialWatermark, "导出期间封存已改变");
      assert(blob.size === outputBytes, "记录包输出不完整");
      return { blob, importIssues: [], metrics: { expandedBytes: inputBytes, storedLogicalBytes: rawBytes + storedBytes,
        metadataOverheadBytes: inputBytes - rawBytes - storedBytes, zipBytes: blob.size, eventCount: events.length, contentCount: contents.length } };
    } finally {
      if (abortZip) task.signal.removeEventListener("abort", abortZip);
      zip?.terminate(); task.dispose();
    }
  };
}
export const createArchive = createFlowArchive();
