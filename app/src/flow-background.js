import * as flowStore from "./flow-store.js";
import { DEFAULT_FLOW_SETTINGS, LEGACY_FLOW_SETTINGS, MAX_MULTIPLIER, deriveFlowLimits, limitsForSession, loadFlowSettings, saveFlowSettings, validateFlowSettings } from "./flow-config.js";

// Deliberately independent of the legacy browser-wide recorder/import graph.
export const FLOW_LIMITS = deriveFlowLimits(LEGACY_FLOW_SETTINGS).background;
// Chrome serializes runtime messages as JSON. Framing is a protocol guard, not a capture setting.
const CONTENT_PART_BYTES = 1024 * 1024, CONTENT_PART_CHARS = 131072;
const PAGE_KINDS = new Set(["page.snapshot", "page.stylesheet", "page.resources", "page.navigation", "page.dialog", "ui.click", "ui.change", "ui.input", "ui.submit", "ui.key", "ui.scroll", "recorder.notice"]);
const BODY_TYPES = new Set(["Fetch", "XHR", "Document"]);
const RESOURCE_TYPES = new Set(["Image", "Stylesheet", "Font"]);
const textEncoder = new TextEncoder();
const http = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } };
const bytesOf = (value) => typeof value === "string" ? textEncoder.encode(value).byteLength : value?.byteLength ?? value?.size ?? Infinity;
const errorText = (error) => error?.message || "capture_failed";
function boundedMetadata(value, limit, sampling = 1) {
  let size = 0, nodes = 0;
  function walk(item, depth) {
    if (++nodes > 2048 * sampling || depth > 10) return false;
    if (typeof item === "string") { if (item.length > limit) return false; size += bytesOf(item); }
    else if (item == null || typeof item === "boolean" || typeof item === "number" && Number.isFinite(item)) size += 16;
    else if (typeof item === "object") {
      let count = 0;
      for (const key in item) { if (++count > 512 * sampling || key.length > 256) return false; if (item[key] === undefined) continue; size += key.length * 3; if (!walk(item[key], depth + 1)) return false; }
    } else return false;
    return size <= limit;
  }
  return walk(value, 0) ? size : Infinity;
}
function decodeBody(value, max) {
  if (typeof value?.body !== "string") throw new Error("body_unavailable");
  if (!value.base64Encoded) { if (value.body.length > max || bytesOf(value.body) > max) throw new Error("decoded_body_limit"); return value.body; }
  if (value.body.length > Math.ceil(max / 3) * 4 + 4) throw new Error("decoded_body_limit");
  const raw = atob(value.body);
  if (raw.length > max) throw new Error("decoded_body_limit");
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
function contentLength(headers) {
  for (const [key, value] of Object.entries(headers || {})) if (key.toLowerCase() === "content-length" && /^\d+$/.test(String(value))) return Number(value);
  return 0;
}
const textual = (mime) => /^(text\/(?!event-stream)|application\/(?:[\w.+-]*json|[\w.+-]*xml|x-www-form-urlencoded))/i.test(mime || "");

export function createFlowBackground({ chrome = globalThis.chrome, store = flowStore, now = Date.now,
  uuid = () => crypto.randomUUID(), setTimeout: delay = globalThis.setTimeout,
  clearTimeout: cancel = globalThis.clearTimeout, limits = {}, settingsStorage = chrome?.storage?.local } = {}) {
  let active = null, starting = false, recovery = null;
  // Internal factory overrides keep small deterministic tests; production derives solely from the batch.
  const L = { ...FLOW_LIMITS, ...limits }; // Protocol time bounds never scale. Capacity bounds live on r.
  const metadataSize = (r, value) => boundedMetadata(value, r.backgroundLimits.metadata, r.captureLimits.settings.samplingMultiplier);
  const readSettings = async () => settingsStorage === undefined && !chrome?.storage ? DEFAULT_FLOW_SETTINGS : loadFlowSettings(settingsStorage);
  const settingsReply = (settings) => ({ settings, defaults: DEFAULT_FLOW_SETTINGS, maximumMultiplier: MAX_MULTIPLIER, limits: deriveFlowLimits(settings) });
  const subscriptions = [];
  function deadline(promise, milliseconds, reason) {
    let timer;
    return Promise.race([Promise.resolve(promise), new Promise((_, reject) => { timer = delay(() => reject(new Error(reason)), milliseconds); })]).finally(() => cancel(timer));
  }
  function summary(session) {
    if (!session) return null;
    const { ownerToken, ...safe } = session;
    return { ...safe, hasNotice: !!(safe.hasNotice || safe.diagnostics?.notice || safe.budget?.policyStopped || safe.coverage?.policyGaps), storageError: !!safe.error };
  }
  function live(r) { return active === r && r.admission && ["preparing", "recording"].includes(r.session.status); }
  async function permitted(url) {
    const u = http(url);
    return !!u && await deadline(chrome.permissions.contains({ origins: [u.origin + "/*"] }), L.commandMs, "permissions_timeout");
  }
  function track(r, work) {
    const p = Promise.resolve(work); r.tasks.add(p);
    p.finally(() => r.tasks.delete(p)).catch(() => {});
    return p;
  }
  function controlledStop(r, reason, interrupted = false) {
    if (active !== r) return;
    r.admission = false;
    if (interrupted) r.error = reason; else r.policyReason ||= reason;
    r.session.hasNotice = true;
    Promise.resolve().then(() => stop(r.session.id)).catch(() => {});
  }
  async function append(r, event, contents = [], { final = false, flushing = false } = {}) {
    if (!final && (!live(r) && !(flushing && r.flushing && !r.policyReason && !r.error))) return { accepted: 0, failed: 0, policyStopped: !!r.policyReason, reason: r.policyReason || "admission_closed" };
    if (metadataSize(r, event) === Infinity) { if (!final) controlledStop(r, "event_metadata_limit"); throw new Error("event_metadata_limit"); }
    event = JSON.parse(JSON.stringify(event)); // only the already-bounded JSON tree, never content bytes
    const size = metadataSize(r, event) + contents.reduce((sum, content) => sum + bytesOf(content.bytes), 0);
    if (!final && (size > r.backgroundLimits.queuedBytes || r.queueCount >= r.backgroundLimits.queue || r.queueBytes + r.transferBytes + size > r.backgroundLimits.queuedBytes)) {
      controlledStop(r, "producer_queue_limit");
      return { accepted: 0, failed: 0, policyStopped: true, reason: "producer_queue_limit" };
    }
    r.queueCount++; r.queueBytes += size;
    const task = r.tail.then(async () => {
      // Already-admitted writes drain; only the owner can enter this queue.
      const result = await store.appendCapture(r.session.id, r.session.ownerToken, event, contents, { final });
      if (result.failed) throw new Error("capture_write_failed");
      if (result.policyStopped) controlledStop(r, result.reason || "storage_budget_limit");
      if (!result.accepted && !result.policyStopped) throw new Error(result.reason || "capture_not_saved");
      if (result.event?.seq > (r.session.lastSeq || 0)) { r.session.lastSeq = result.event.seq; r.session.eventCount = result.event.seq; }
      return result;
    });
    r.tail = task.catch((error) => { if (!final) controlledStop(r, "storage_error", true); }).finally(() => { r.queueCount--; r.queueBytes -= size; });
    return task;
  }
  async function gap(r, reason, details = {}) {
    r.gaps.set(reason, (r.gaps.get(reason) || 0) + 1); r.session.hasNotice = true;
    if (r.notices.has(reason) || r.notices.size >= r.backgroundLimits.notices || !live(r)) return;
    r.notices.add(reason);
    await append(r, { kind: "session.notice", payload: { reason, ...details } });
  }
  const cdp = (tabId, method, params = {}) => deadline(chrome.debugger.sendCommand({ tabId }, method, params), L.commandMs, "cdp_timeout");
  async function reserveRead(r, category, maximum, known = 0) {
    if (!live(r) || r.readers >= 2) return null;
    r.readers++; let reserved = false;
    try {
      const session = await store.getSession(r.session.id), budget = session?.budget;
      if (!live(r) || !budget || budget.policyStopped) return null;
      const policy = r.captureLimits.budget, categoryMax = policy.categoryBytes[category];
      const remaining = Math.min(policy.normalBytes - budget.usedBytes - r.readBytes - 4096, categoryMax - (budget.byCategory[category] || 0) - (r.readCategories[category] || 0));
      const max = Math.min(maximum, remaining);
      if (max <= 0) { controlledStop(r, "capture_read_budget_limit"); return null; }
      if (known > max) return null;
      r.readBytes += max; r.readCategories[category] = (r.readCategories[category] || 0) + max; reserved = true;
      return { max, release() { r.readBytes -= max; r.readCategories[category] -= max; r.readers--; } };
    } finally { if (!reserved) r.readers--; }
  }
  async function detach(t) {
    t.closed = true;
    try { await deadline(chrome.debugger.detach({ tabId: t.id }), L.detachMs, "detach_timeout"); t.attached = false; return true; }
    catch { return !t.attached && !t.attaching; }
  }
  async function attach(r, t) {
    if (t.attached || t.attaching || !live(r)) return;
    t.closed = false; t.attaching = true;
    const attaching = chrome.debugger.attach({ tabId: t.id }, "1.3");
    // An attach completing after a timeout/Stop must not leave a debugger behind.
    attaching.then(() => { if (t.closed || !live(r)) chrome.debugger.detach({ tabId: t.id }).catch(() => {}); }).catch(() => {});
    try {
      await deadline(attaching, L.detachMs, "attach_timeout"); t.attached = true;
      if (!live(r) || t.closed) { await detach(t); return; }
      await cdp(t.id, "Network.enable", { maxTotalBufferSize: r.captureLimits.budget.categoryBytes.resource * 2, maxResourceBufferSize: r.backgroundLimits.resource, maxPostDataSize: r.backgroundLimits.body });
      if (live(r)) await cdp(t.id, "Page.enable");
    } catch { if (live(r)) controlledStop(r, "debugger_attach_failed", true); }
    finally { t.attaching = false; }
  }
  async function inject(r, t) {
    if (!live(r)) return;
    if (t.injecting) { t.injectAgain = true; return; }
    t.injecting = true;
    try {
      if (!await permitted(t.url) || !live(r)) { await gap(r, "origin_permission_missing", { tabId: t.id }); return; }
      const frames = await deadline(chrome.webNavigation.getAllFrames({ tabId: t.id }), L.commandMs, "frames_timeout") || [];
      const present = new Set();
      for (const f of frames.slice(0, r.backgroundLimits.frames)) {
        if (!live(r)) return;
        present.add(f.frameId);
        const allowed = !!http(f.url) && await permitted(f.url);
        if (!live(r)) return;
        const previous = t.frames.get(f.frameId);
        const documentId = f.documentId || (previous?.url === f.url ? previous.documentId : undefined);
        const sameDocument = previous?.url === f.url && previous?.documentId === documentId && previous?.allowed === allowed;
        const frame = sameDocument ? previous : { ...f, documentId, allowed };
        if (previous && !sameDocument) clearTransfers(r, t.id, f.frameId, "content_transfer_navigation");
        t.frames.set(f.frameId, frame);
        if (!allowed) { await gap(r, "frame_not_readable"); continue; }
        const identity = frame.documentId ? "doc:" + frame.documentId : "frame:" + frame.frameId + ":" + frame.url;
        if (t.injected.get(f.frameId) === identity) continue;
        const target = frame.documentId ? { tabId: t.id, documentIds: [frame.documentId] } : { tabId: t.id, frameIds: [f.frameId] };
        try {
          await deadline(chrome.scripting.executeScript({ target, files: ["content.js"] }), L.commandMs, "injection_timeout");
          t.injected.set(f.frameId, identity);
        } catch { if (live(r)) await gap(r, "content_injection_unavailable", { tabId: t.id, frameId: f.frameId }); }
      }
      for (const frameId of t.frames.keys()) if (!present.has(frameId)) { clearTransfers(r, t.id, frameId, "content_transfer_navigation"); t.frames.delete(frameId); t.injected.delete(frameId); }
      if (frames.length > r.backgroundLimits.frames) await gap(r, "frame_limit");
      if (live(r) && t.attached) {
        const tree = await cdp(t.id, "Page.getFrameTree");
        const queue = [tree.frameTree]; let seen = 0;
        while (queue.length && seen++ < r.backgroundLimits.frames) {
          const node = queue.shift(); if (!node?.frame) continue;
          const matches = [...t.frames.values()].filter((f) => f.allowed && f.url === node.frame.url);
          if (!node.frame.parentId) t.cdpFrames.set(node.frame.id, 0);
          else if (matches.length === 1) t.cdpFrames.set(node.frame.id, matches[0].frameId);
          queue.push(...(node.childFrames || []).slice(0, r.backgroundLimits.frames - seen));
        }
      }
    } catch { if (live(r)) await gap(r, "content_injection_unavailable", { tabId: t.id }); }
    finally {
      t.injecting = false;
      if (t.injectAgain && live(r)) { t.injectAgain = false; track(r, inject(r, t)).catch(() => {}); }
    }
  }
  function addTab(r, tab) {
    const t = { id: tab.id, url: tab.url || tab.pendingUrl, frames: new Map(), injected: new Map(), requests: new Map(), streams: new Map(), resources: new Set(), cdpFrames: new Map(), attached: false };
    t.frames.set(0, { frameId: 0, url: t.url, allowed: true }); r.tabs.set(t.id, t);
    return t;
  }
  async function prepare(r, t) {
    await attach(r, t);
    if (live(r)) await inject(r, t);
    if (live(r) && r.session.status === "preparing") {
      r.session.status = "recording";
      await store.updateSession(r.session.id, r.session.ownerToken, { status: "recording" });
    }
  }
  async function start(message) {
    await ready();
    if (active || starting) throw new Error("已有批次正在准备或录制");
    starting = true;
    let r;
    try {
      if (!Number.isInteger(message.tab?.id)) throw new Error("请选择根业务标签页");
      const tab = await chrome.tabs.get(message.tab.id);
      if (!http(tab.url)) throw new Error("仅支持 HTTP(S) 业务标签页");
      if (!await permitted(tab.url)) throw new Error("根标签页来源未授权，请先授予当前来源访问权限");
      const savedSettings = validateFlowSettings(await readSettings()), captureLimits = deriveFlowLimits(savedSettings);
      let session = { id: uuid(), ownerToken: uuid(), profile: "business-flow-v1", producerVersion: chrome.runtime.getManifest?.().version ?? null, startedAt: now(), rootTabId: tab.id,
        status: "preparing", scope: { rootTabId: tab.id, tabIds: [tab.id] }, hasNotice: false };
      const persisted = await store.createSession({ ...session, settings: savedSettings });
      session = { ...session, ...persisted, capturePolicy: { ...persisted?.capturePolicy, settings: persisted?.capturePolicy?.settings ?? savedSettings } };
      const batchLimits = persisted?.capturePolicy?.settings ? limitsForSession(persisted) : captureLimits;
      r = { session, captureLimits: batchLimits, backgroundLimits: { ...batchLimits.background, ...limits }, transfers: new Map(), transferBytes: 0, tabs: new Map(), admission: true, flushing: false, tail: Promise.resolve(), queueCount: 0, queueBytes: 0,
        readBytes: 0, readCategories: {}, readers: 0, tasks: new Set(), gaps: new Map(), notices: new Set(), gestures: new Map(), batches: new Map(), screenshots: new Map(), lastScreenshot: -Infinity };
      active = r;
      const t = addTab(r, tab);
      await append(r, { kind: "session.start", time: session.startedAt, tabId: tab.id, payload: { profile: session.profile, rootTabId: tab.id, sensitiveNote: "原 URL、查询参数、请求头及业务正文可能包含敏感数据；仅本地保存。" } });
      const prep = track(r, prepare(r, t));
      prep.catch(() => controlledStop(r, "preparation_failed", true));
      if (!message.acknowledgeEarly) { await prep; if (r.stopPromise) return await r.stopPromise; }
      return summary(r.session);
    } catch (error) { if (r && active === r) controlledStop(r, "preparation_failed", true); throw error; }
    finally { starting = false; }
  }
  async function authorized(r, sender, tokenRequired, message) {
    if (!r || !r.tabs.has(sender.tab?.id) || !Number.isInteger(sender.frameId) || !http(sender.url)) return null;
    if (sender.id && sender.id !== chrome.runtime.id) return null;
    if (tokenRequired && (message.sessionId !== r.session.id || message.ownerToken !== r.session.ownerToken)) return null;
    const t = r.tabs.get(sender.tab.id), f = t.frames.get(sender.frameId);
    if (!f || !f.allowed || http(f.url)?.origin !== http(sender.url)?.origin || sender.origin && sender.origin !== http(sender.url).origin) return null;
    if (f.documentId && sender.documentId !== f.documentId) return null;
    if (!await permitted(sender.url) || active !== r || t.frames.get(sender.frameId) !== f) return null;
    if (sender.documentId) f.documentId = sender.documentId;
    return { t, f };
  }
  function settings(r) { return { sessionId: r.session.id, ownerToken: r.session.ownerToken, profile: "business-flow-v1", maxBodyBytes: r.backgroundLimits.body, maxMetadataBytes: r.backgroundLimits.metadata, maxBatchEvents: r.backgroundLimits.batch, captureLimits: r.captureLimits }; }
  const validContent = (c) => c && /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(c.field) && ["body", "dom", "resource", "meta"].includes(c.category) && typeof c.mime === "string" && c.mime.length <= 128;
  const transferKey = (sender, id) => [sender.tab.id, sender.frameId, sender.documentId || "", id].join(":");
  function releaseTransfer(r, key) {
    const transfer = r.transfers.get(key); if (!transfer) return;
    r.transferBytes -= transfer.byteLength; r.transfers.delete(key);
  }
  function clearTransfers(r, tabId, frameId, reason = "content_transfer_incomplete") {
    let count = 0;
    for (const [key, transfer] of r.transfers) {
      if ((tabId === undefined || transfer.tabId === tabId) && (frameId === undefined || transfer.frameId === frameId)) { releaseTransfer(r, key); count++; }
    }
    if (count) { r.gaps.set(reason, (r.gaps.get(reason) || 0) + count); r.session.hasNotice = true; }
  }
  async function contentPart(r, message, sender, auth) {
    if (!(live(r) || r.flushing && !r.policyReason && !r.error)) throw new Error("采集接纳已关闭");
    const { text, ...header } = message;
    if (!validContent(message) || boundedMetadata(header, 4096) === Infinity ||
        typeof message.transferId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(message.transferId) ||
        typeof text !== "string" || !text.length || text.length > CONTENT_PART_CHARS ||
        !Number.isSafeInteger(message.index) || !Number.isSafeInteger(message.parts) || message.index < 0 || message.parts < 1 || message.index >= message.parts ||
        !Number.isSafeInteger(message.byteLength) || message.byteLength < 1 || message.parts > message.byteLength || message.parts > Math.ceil(message.byteLength / (CONTENT_PART_CHARS - 1)) + 1 ||
        message.byteLength > (message.category === "resource" ? r.backgroundLimits.resource : r.backgroundLimits.body)) throw new Error("无效内容传输分片");
    const bytes = bytesOf(text);
    if (bytesOf(JSON.stringify(message)) > CONTENT_PART_BYTES || bytes > CONTENT_PART_BYTES || message.index + 1 < message.parts && /[\uD800-\uDBFF]$/.test(text)) throw new Error("内容传输分片超限或截断字符");
    const key = transferKey(sender, message.transferId);
    let transfer = r.transfers.get(key);
    if (!transfer) {
      if (message.index !== 0) throw new Error("内容传输分片顺序无效");
      if (r.transfers.size >= Math.max(r.backgroundLimits.batch, r.captureLimits.content.maxContents) || r.transferBytes + r.queueBytes + message.byteLength > r.backgroundLimits.queuedBytes) {
        controlledStop(r, "content_transfer_queue_limit"); return { policyStopped: true, reason: "content_transfer_queue_limit" };
      }
      transfer = { tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId, frame: auth.f,
        field: message.field, mime: message.mime, category: message.category, byteLength: message.byteLength, parts: message.parts, chunks: [], received: 0 };
      r.transfers.set(key, transfer); r.transferBytes += transfer.byteLength;
    }
    if (transfer.frame !== auth.f || ["field", "mime", "category", "byteLength", "parts"].some((name) => transfer[name] !== message[name])) throw new Error("内容传输身份不一致");
    if (message.index < transfer.chunks.length) {
      if (await transfer.chunks[message.index].text() !== text) throw new Error("重复内容分片不一致");
    } else {
      if (message.index !== transfer.chunks.length || transfer.received + bytes > transfer.byteLength ||
          message.index + 1 === transfer.parts && transfer.received + bytes !== transfer.byteLength) throw new Error("内容传输长度或顺序无效");
      transfer.chunks.push(new Blob([text])); transfer.received += bytes;
    }
    if (r.transfers.get(key) !== transfer || active !== r || auth.t.frames.get(sender.frameId) !== auth.f) throw new Error("内容传输来源已过期");
    return { transferId: message.transferId, index: message.index, receivedBytes: transfer.received, complete: transfer.chunks.length === transfer.parts };
  }
  async function pageBatch(r, message, sender, auth) {
    if (!(live(r) || r.flushing && !r.policyReason && !r.error)) throw new Error("采集接纳已关闭");
    if (typeof message.batchId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(message.batchId) || !Array.isArray(message.events) || message.events.length > r.backgroundLimits.batch) throw new Error("无效采集批次");
    const key = [sender.tab.id, sender.frameId, sender.documentId || "", message.batchId].join(":");
    if (r.batches.has(key)) return r.batches.get(key);
    const inputs = [], consumed = new Set();
    let total = 0;
    for (const event of message.events) {
      const contents = [], transferKeys = [];
      if (!PAGE_KINDS.has(event?.kind) || !Number.isFinite(event.time) || metadataSize(r, event.payload || {}) === Infinity) throw new Error("无效采集事件");
      if (event.contents && (!Array.isArray(event.contents) || event.contents.length > r.captureLimits.content.maxContents)) throw new Error("无效采集内容");
      for (const c of event.contents || []) {
        if (!validContent(c)) throw new Error("无效内容引用");
        let bytes = c.bytes;
        if (Object.hasOwn(c, "transferId")) {
          const transferId = c.transferId;
          if (typeof transferId !== "string" || !/^[a-zA-Z0-9:_-]{1,160}$/.test(transferId) || Object.hasOwn(c, "bytes")) throw new Error("无效内容传输引用");
          const transferIdKey = transferKey(sender, transferId), transfer = r.transfers.get(transferIdKey);
          if (!transfer || consumed.has(transferIdKey) || transfer.frame !== auth.f || transfer.received !== transfer.byteLength || transfer.chunks.length !== transfer.parts ||
              ["field", "mime", "category"].some((name) => transfer[name] !== c[name])) throw new Error("内容传输未完成或来源无效");
          bytes = new Blob(transfer.chunks, { type: c.mime }); consumed.add(transferIdKey); transferKeys.push(transferIdKey);
        } else if (typeof bytes !== "string") throw new Error("无效直接采集内容");
        const size = bytesOf(bytes); if (size > (c.category === "resource" ? r.backgroundLimits.resource : r.backgroundLimits.body)) throw new Error("采集内容超过单项限制"); total += size;
        contents.push({ field: c.field, mime: c.mime, category: c.category, bytes });
      }
      total += metadataSize(r, event.payload || {});
      if (total > r.backgroundLimits.batchBytes) { controlledStop(r, "page_batch_limit"); return { accepted: 0, failed: 0, policyStopped: true, reason: "page_batch_limit" }; }
      inputs.push({ ...event, contents, transferKeys });
    }
    const task = (async () => {
      let accepted = 0;
      for (let index = 0; index < inputs.length; index++) {
        const input = inputs[index];
        const event = { kind: input.kind, time: input.time, payload: input.payload || {}, tabId: sender.tab.id,
          frameId: sender.frameId, documentId: sender.documentId, captureKey: key + ":" + index };
        // No await between reservation release and append admission: remaining events stay reserved.
        for (const transfer of input.transferKeys) releaseTransfer(r, transfer);
        const result = await append(r, event, input.contents || [], { flushing: true });
        accepted += result.accepted;
        if (result.policyStopped) return { accepted, failed: 0, policyStopped: true, reason: result.reason };
        if (!result.accepted) throw new Error("采集接纳已关闭，未保存事件");
        if (result.accepted && !result.duplicate && live(r)) {
          const p = input.payload || {};
          if (["ui.click", "ui.submit"].includes(input.kind) && p.trusted === true && now() - input.time >= 0 && now() - input.time <= 2000) {
            r.gestures.set(sender.tab.id, { time: input.time, eventId: result.event?.id });
            if (r.childCandidate?.opener === sender.tab.id) r.childCandidate.resolve();
          }
          if (input.kind === "page.snapshot" && ["initial", "click", "change", "submit", "navigation", "validation"].includes(p.reason)) {
            requestScreenshot(r, auth.t, { eventId: result.event?.id, time: input.time, frameId: sender.frameId, documentId: sender.documentId, reason: p.reason });
          }
          if (input.kind === "page.resources" && Array.isArray(p.urls)) {
            for (const resource of p.urls.slice(0, r.captureLimits.content.resourceUrls)) { if (!live(r)) break; track(r, pageResource(r, auth.t, resource, sender, result.event)).catch(() => {}); }
          }
        }
      }
      return { accepted, failed: 0, policyStopped: false };
    })();
    r.batches.set(key, task);
    if (r.batches.size > r.backgroundLimits.batchHistory) r.batches.delete(r.batches.keys().next().value);
    try { return await task; } catch (error) { r.batches.delete(key); throw error; }
  }
  function requestScreenshot(r, t, association) {
    if (!live(r) || !t.attached) return;
    const entry = r.screenshots.get(t.id) || {};
    entry.association = association; r.screenshots.set(t.id, entry);
    if (entry.timer || entry.running) return;
    const wait = Math.max(0, r.backgroundLimits.screenshotInterval - (now() - r.lastScreenshot));
    if (wait) { entry.timer = delay(() => { entry.timer = null; requestScreenshot(r, t, entry.association); }, wait); return; }
    entry.running = true; r.lastScreenshot = now(); const captured = entry.association; entry.association = null;
    track(r, (async () => {
      try {
        const reservation = await reserveRead(r, "screenshot", r.backgroundLimits.screenshot);
        if (!reservation) { await gap(r, "screenshot_budget_preflight"); return; }
        try {
          const result = await cdp(t.id, "Page.captureScreenshot", { format: "png", fromSurface: true, captureBeyondViewport: false });
          if (!live(r)) return;
          const bytes = decodeBody({ body: result.data, base64Encoded: true }, reservation.max);
          await append(r, { kind: "screenshot", time: now(), tabId: t.id, frameId: captured.frameId, documentId: captured.documentId,
            payload: { viewportOnly: true, reason: captured.reason, associatedEventId: captured.eventId, sourceTime: captured.time } }, [{ field: "image", category: "screenshot", mime: "image/png", bytes }]);
        } finally { reservation.release(); }
      } catch { if (live(r)) await gap(r, "viewport_screenshot_unavailable", { tabId: t.id }); }
      finally { entry.running = false; if (entry.association && live(r)) requestScreenshot(r, t, entry.association); }
    })());
  }
  async function pageResource(r, t, input, sender, event) {
    const p = input, url = http(p.url);
    if (!url || !["Image", "Stylesheet", "Font", "image", "stylesheet", "font"].includes(p.type) || t.resources.has(p.url)) return;
    if (t.resources.size >= r.backgroundLimits.resourceObservations) { await gap(r, "resource_observation_limit"); return; }
    t.resources.add(p.url);
    // Metadata from the collector identifies displayed CSS URLs. This is a cache
    // read through CDP, never an HTTP fallback and never an initial resource scan.
    const cdpFrameId = [...t.cdpFrames].find(([, f]) => f === sender.frameId)?.[0];
    if (!cdpFrameId || !live(r) || !t.attached) { await gap(r, "page_resource_unavailable"); return; }
    const reservation = await reserveRead(r, "resource", r.backgroundLimits.resource, Number(p.size) || 0);
    if (!reservation) { await gap(r, "resource_budget_preflight"); return; }
    try {
      const data = await cdp(t.id, "Page.getResourceContent", { frameId: cdpFrameId, url: p.url });
      if (!live(r)) return;
      const bytes = decodeBody({ body: data.content, base64Encoded: data.base64Encoded }, reservation.max);
      await append(r, { kind: "page.resource", tabId: t.id, frameId: sender.frameId, documentId: sender.documentId,
        payload: { url: p.url, type: p.type, source: "Page.getResourceContent", associatedEventId: event?.id } }, [{ field: "body", category: "resource", mime: p.mime || "application/octet-stream", bytes }]);
    } catch { if (live(r)) await gap(r, "page_resource_unavailable"); }
    finally { reservation.release(); }
  }
  function frameFor(t, params) {
    if (params.frameId && t.cdpFrames.has(params.frameId)) return t.cdpFrames.get(params.frameId);
    const url = params.documentURL || params.response?.url || params.request?.url;
    const matches = [...t.frames.values()].filter((f) => f.url === url && f.allowed);
    return matches.length === 1 ? matches[0].frameId : undefined;
  }
  async function networkRequest(r, t, p) {
    if (!live(r) || ![...BODY_TYPES, ...RESOURCE_TYPES, "EventSource"].includes(p.type)) return;
    const old = t.requests.get(p.requestId);
    if (old && p.redirectResponse) { old.redirected = true; await finishResponse(r, t, old, { encodedDataLength: p.redirectResponse.encodedDataLength || 0 }, p.redirectResponse); }
    if (t.requests.size >= r.backgroundLimits.requests && !old) { await gap(r, "request_metadata_limit"); return; }
    const request = p.request || {}, frameId = frameFor(t, p), f = t.frames.get(frameId);
    if (!f?.allowed || !http(request.url) || !await permitted(p.documentURL || f.url) || !live(r)) return;
    const q = { id: p.requestId, captureId: t.id + ":" + p.requestId + ":" + ((old?.hop || 0) + 1), hop: (old?.hop || 0) + 1,
      request: { url: request.url, method: request.method }, frameId, documentId: f.documentId, cdpFrameId: p.frameId, type: p.type, time: p.wallTime ? p.wallTime * 1000 : now(), count: 0, bytes: 0 };
    t.requests.set(p.requestId, q);
    const payload = { requestId: q.captureId, url: request.url, method: request.method, headers: request.headers || {}, type: p.type,
      cdpFrameId: p.frameId, sensitiveNote: "原 URL/query/headers 和正文可能含敏感数据" };
    const contents = [], declared = contentLength(request.headers);
    if (typeof request.postData === "string") {
      if (declared > r.backgroundLimits.body || request.postData.length > r.backgroundLimits.body || bytesOf(request.postData) > r.backgroundLimits.body) payload.bodyStatus = { status: "not_collected_policy", reason: "request_body_limit" };
      else contents.push({ field: "bodyText", category: "body", mime: "text/plain", bytes: request.postData });
    } else if (request.hasPostData) payload.bodyStatus = { status: "not_collected", reason: "post_data_unavailable_no_requery" };
    if (metadataSize(r, payload) === Infinity) { await gap(r, "request_metadata_oversized"); t.requests.delete(p.requestId); return; }
    await append(r, { kind: "network.request", captureKey: q.captureId + ":request", time: q.time, tabId: t.id, frameId, documentId: f.documentId, payload }, contents);
  }
  async function finishResponse(r, t, q, p, response = q.response) {
    if (!q || q.finished || !live(r)) return;
    q.finished = true;
    if (!response) { await gap(r, "response_metadata_unavailable"); return; }
    const mime = response.mimeType || "", resource = RESOURCE_TYPES.has(q.type), stream = q.type === "EventSource" || /text\/event-stream/i.test(mime);
    const payload = { requestId: q.captureId, url: response.url || q.request.url, status: response.status, headers: response.headers || {}, mime,
      encodedDataLength: Math.max(0, Number(p.encodedDataLength) || 0), sensitiveNote: "响应头及正文可能包含敏感数据" };
    const max = resource ? r.backgroundLimits.resource : r.backgroundLimits.body, contents = [];
    let reason;
    if (stream) reason = "stream_summary_only";
    else if (q.type === "Document") reason = "document_dom_canonical";
    else if (resource && !t.resources.has(payload.url)) reason = "unobserved_resource";
    else if (!resource && !textual(mime)) reason = "non_text_response";
    else if (q.redirected) reason = "redirect_body_unavailable";
    else if (Math.max(contentLength(response.headers), payload.encodedDataLength, Number(response.encodedDataLength) || 0) > max) reason = "known_body_limit";
    if (metadataSize(r, payload) === Infinity) { await gap(r, "response_metadata_oversized"); return; }
    if (!reason) {
      const reservation = await reserveRead(r, resource ? "resource" : "body", max, Math.max(contentLength(response.headers), payload.encodedDataLength));
      if (!reservation) reason = "body_budget_preflight";
      else try {
        // Chrome returns the complete string. Preflight and post-decode bounds do
        // not claim a physical streaming/memory limit inside the CDP transport.
        const raw = await cdp(t.id, "Network.getResponseBody", { requestId: q.id });
        if (!live(r)) return;
        contents.push({ field: "body", category: resource ? "resource" : "body", mime, bytes: decodeBody(raw, reservation.max) });
      } catch (error) { reason = errorText(error) === "decoded_body_limit" ? "decoded_body_limit" : "response_body_unavailable"; }
      finally { reservation.release(); }
    }
    if (reason) { payload.bodyStatus = { status: "not_collected_policy", reason }; if (!["unobserved_resource", "non_text_response", "stream_summary_only", "document_dom_canonical"].includes(reason)) await gap(r, reason); }
    if (stream) payload.stream = { count: q.count, bytes: q.bytes, frameBodiesStored: false };
    await append(r, { kind: "network.response", captureKey: q.captureId + ":response", time: now(), tabId: t.id, frameId: q.frameId, documentId: q.documentId, payload }, contents);
  }
  async function debuggerEvent(source, method, p) {
    const r = active, t = r?.tabs.get(source.tabId);
    if (!r || !t || !live(r) || source.sessionId) return;
    if (method === "Page.frameNavigated") {
      const f = p.frame || {}, matches = [...t.frames.values()].filter((entry) => entry.url === f.url && entry.allowed);
      if (!f.parentId) t.cdpFrames.set(f.id, 0); else if (matches.length === 1) t.cdpFrames.set(f.id, matches[0].frameId);
      return;
    }
    if (method === "Network.requestWillBeSent") {
      if ((t.pendingRequests || 0) >= r.backgroundLimits.requests) { controlledStop(r, "network_queue_limit"); return; }
      t.pendingRequests = (t.pendingRequests || 0) + 1;
      const prior = t.networkTail || Promise.resolve();
      // Only request metadata is serialized; body reads never block request entry.
      t.networkTail = track(r, prior.then(() => networkRequest(r, t, p))).catch(() => controlledStop(r, "network_write_failed", true)).finally(() => { t.pendingRequests--; });
      return t.networkTail;
    }
    if (method.startsWith("Network.webSocket")) {
      if (method === "Network.webSocketCreated") {
        if (t.streams.size >= r.backgroundLimits.streams) { await gap(r, "realtime_connection_limit"); return; }
        const frameId = t.cdpFrames.get(p.initiator?.frameId), frame = t.frames.get(frameId);
        if (!frame?.allowed || !http(frame.url)) { await gap(r, "websocket_frame_unattributed"); return; }
        if (!await permitted(frame.url) || !live(r) || t.frames.get(frameId) !== frame) { await gap(r, "websocket_frame_not_readable"); return; }
        t.streams.set(p.requestId, { requestId: t.id + ":" + p.requestId, url: p.url, count: 0, bytes: 0, frameId, documentId: frame.documentId });
        await append(r, { kind: "network.websocket", tabId: t.id, frameId, documentId: frame.documentId, payload: { type: "websocket_connect", requestId: t.id + ":" + p.requestId, url: p.url, frameBodiesStored: false } });
      } else {
        const stream = t.streams.get(p.requestId); if (!stream) return;
        if (/Frame(?:Received|Sent)$/.test(method)) { stream.count++; const data = p.response?.payloadData || ""; stream.bytes += p.response?.opcode === 2 ? Math.floor(data.length * 3 / 4) : bytesOf(data); }
        if (method === "Network.webSocketClosed") { await append(r, { kind: "network.websocket", tabId: t.id, payload: { type: "websocket_summary", ...stream, frameBodiesStored: false } }); t.streams.delete(p.requestId); }
      }
      return;
    }
    await t.networkTail;
    const q = t.requests.get(p.requestId); if (!q || !live(r)) return;
    if (method === "Network.responseReceived") q.response = p.response;
    else if (method === "Network.dataReceived") { q.bytes += Math.max(0, p.dataLength || 0); }
    else if (method === "Network.eventSourceMessageReceived") { q.count++; }
    else if (method === "Network.loadingFinished") { await finishResponse(r, t, q, p); if (t.requests.get(p.requestId) === q) t.requests.delete(p.requestId); }
    else if (method === "Network.loadingFailed") { await append(r, { kind: "network.response", tabId: t.id, frameId: q.frameId, documentId: q.documentId,
      payload: { requestId: q.captureId, status: "failed", canceled: !!p.canceled, bodyStatus: { status: "not_collected", reason: "network_failed" } } }); t.requests.delete(p.requestId); }
  }
  async function committed(p) {
    const r = active;
    if (r?.childCandidate?.tabId === p.tabId && p.frameId === 0 && http(p.url)) { r.childCandidate.url = p.url; r.childCandidate.resolve(); }
    const t = r?.tabs.get(p.tabId); if (!r || !t || !live(r)) return;
    clearTransfers(r, t.id, p.frameId === 0 ? undefined : p.frameId, "content_transfer_navigation");
    if (p.frameId === 0) { t.url = p.url; t.frames.clear(); t.cdpFrames.clear(); }
    if (!p.documentId) t.injected.delete(p.frameId); // old Chrome has no stable document identity; collector guards same-owner restart
    const allowed = await permitted(p.url);
    if (!live(r)) return;
    if (t.frames.size < r.backgroundLimits.frames || t.frames.has(p.frameId)) t.frames.set(p.frameId, { ...p, allowed });
    if (!allowed) { await gap(r, "navigation_not_readable", { tabId: t.id, frameId: p.frameId }); if (p.frameId === 0) await detach(t); return; }
    await append(r, { kind: "page.navigation", time: p.timeStamp || now(), tabId: t.id, frameId: p.frameId, documentId: p.documentId,
      payload: { url: p.url, type: "committed", transitionType: p.transitionType } });
    if (!t.attached) await attach(r, t);
    await inject(r, t);
  }
  async function created(tab) {
    const r = active; if (!r || !live(r) || !r.tabs.has(tab.openerTabId)) return;
    if (r.childUsed || r.childPending != null) { await gap(r, "child_scope_limit"); return; }
    const started = now(), candidate = { tabId: tab.id, opener: tab.openerTabId,
      url: http(tab.pendingUrl) ? tab.pendingUrl : tab.url, resolve() {} };
    r.childPending = tab.id; r.childCandidate = candidate;
    try {
      let gesture;
      while (live(r)) {
        gesture = r.gestures.get(tab.openerTabId);
        const fresh = gesture && gesture.time <= started && now() >= gesture.time && now() - gesture.time <= 2000;
        if (fresh && http(candidate.url)) break;
        const remaining = (fresh ? Math.min(started + 2000, gesture.time + 2000) : started + 250) - now();
        if (remaining <= 0) { await gap(r, fresh ? "child_url_timeout" : "child_gesture_unconfirmed"); return; }
        const changed = await new Promise((resolve) => {
          const timer = delay(() => resolve(false), remaining);
          candidate.resolve = () => { cancel(timer); resolve(true); };
        });
        if (!changed) { await gap(r, fresh ? "child_url_timeout" : "child_gesture_unconfirmed"); return; }
      }
      const url = candidate.url;
      if (!live(r) || !gesture || gesture.time > started || !http(url) || now() - gesture.time > 2000 || !await permitted(url) || !live(r)) return;
      r.childUsed = true; const t = addTab(r, { ...tab, url });
      r.session.scope.tabIds.push(tab.id);
      await store.updateSession(r.session.id, r.session.ownerToken, { scope: r.session.scope });
      await append(r, { kind: "scope.child", tabId: t.id, payload: { type: "child_opened", url, openerTabId: tab.openerTabId, associatedEventId: gesture.eventId, sourceTime: gesture.time } });
      await prepare(r, t);
    } finally { if (r.childCandidate === candidate) r.childCandidate = null; r.childPending = null; }
  }
  async function stop(sessionId) {
    await ready();
    const r = active;
    if (!r || r.session.id !== sessionId) { const saved = await store.getSession(sessionId); if (!saved) throw new Error("找不到录制批次"); return summary(saved); }
    if (r.stopPromise) return r.stopPromise;
    r.admission = false; r.flushing = !r.policyReason && !r.error; r.session.status = "stopping";
    r.childCandidate?.resolve();
    for (const entry of r.screenshots.values()) if (entry.timer) cancel(entry.timer);
    r.stopPromise = (async () => {
      let failed = !!r.error;
      try {
        await store.updateSession(r.session.id, r.session.ownerToken, { status: "stopping", diagnostics: { notice: r.policyReason || r.error || null } });
        const targets = [...r.tabs.values()].flatMap((t) => [...t.frames.values()].filter((f) => f.allowed).map((f) => ({ t, f })));
        const send = (type, { t, f }) => chrome.tabs.sendMessage(t.id, { type, sessionId: r.session.id, ownerToken: r.session.ownerToken }, f.documentId ? { documentId: f.documentId } : { frameId: f.frameId });
        if (r.flushing) await Promise.all(targets.map(async (target) => {
          try { const result = await deadline(send("FLOW_FLUSH", target), L.flushMs, "flush_timeout"); if (result?.ok !== true || result?.value?.failed || result?.value?.pending || result?.value?.confirmed === false) throw new Error("flush_failed"); }
          catch { r.error ||= "collector_flush_unconfirmed"; failed = true; r.gaps.set("collector_flush_unconfirmed", (r.gaps.get("collector_flush_unconfirmed") || 0) + 1); }
        }));
        r.flushing = false; clearTransfers(r);
        await Promise.all(targets.map(async (target) => { try { await deadline(send("STOP_CAPTURE", target), L.stopMs, "collector_stop_timeout"); } catch { r.gaps.set("collector_stop_unconfirmed", 1); } }));
        const detached = await Promise.all([...r.tabs.values()].map(detach));
        if (detached.some((ok) => !ok)) { failed = true; r.error ||= "debugger_detach_unconfirmed"; }
        await Promise.allSettled([...r.tasks]);
        await r.tail;
        for (const t of r.tabs.values()) {
          if (t.requests.size) r.gaps.set("pendingRequests", (r.gaps.get("pendingRequests") || 0) + t.requests.size);
          for (const stream of t.streams.values()) {
            // Aggregate counters only; no WebSocket/SSE payload survives Stop.
            await append(r, { kind: "session.notice", payload: { reason: "realtime_summary", ...stream, frameBodiesStored: false } }, [], { final: true });
          }
        }
        await store.closeSessionWrites(r.session.id, r.session.ownerToken);
        const reason = r.error || r.policyReason || (r.gaps.size ? "policy_gaps" : "user_stop");
        const coverage = { version: 1, policyGaps: [...r.gaps.values()].reduce((a, b) => a + b, 0), reasons: Object.fromEntries(r.gaps), physicalCdpStreamLimit: false };
        const stopOutcome = { status: failed || r.error ? "interrupted" : "ready", reason, stoppedAt: now(), policyStopped: !!r.policyReason };
        if (reason !== "user_stop") await append(r, { kind: "session.notice", captureKey: r.session.id + ":stop-notice", payload: { reason } }, [], { final: true });
        await append(r, { kind: "session.stop", captureKey: r.session.id + ":stop", time: stopOutcome.stoppedAt, payload: { stopOutcome, coverage } }, [], { final: true });
        await store.sealSession(r.session.id, r.session.ownerToken, { status: stopOutcome.status, stopOutcome, coverage });
        const saved = await store.getSession(r.session.id);
        active = null;
        return summary(saved);
      } catch (error) {
        r.flushing = false; clearTransfers(r); r.session.status = "interrupted"; r.session.storageError = true;
        await Promise.all([...r.tabs.values()].map(detach));
        await store.updateSession(r.session.id, r.session.ownerToken, { error: "stop_persistence_failed", diagnostics: { notice: "stop_persistence_failed" } }).catch(() => {});
        active = null;
        throw new Error("无法确认本地批次封存；已保存内容保留，停止失败");
      }
    })();
    return r.stopPromise;
  }
  async function recover() {
    // The new store owns an independent DB. Never inspect legacy storage/snapshots.
    for (const session of await store.listSessions()) {
      if (!["preparing", "recording", "stopping"].includes(session.status) || session.writeGate === "sealed") continue;
      if (!session.ownerToken) throw new Error("活动批次缺少所有权，不能伪造新批次");
      await store.closeSessionWrites(session.id, session.ownerToken);
      const stopOutcome = { status: "interrupted", reason: "worker_restarted", stoppedAt: now() };
      const result = await store.appendCapture(session.id, session.ownerToken, { kind: "session.stop", captureKey: session.id + ":stop", payload: { stopOutcome } }, [], { final: true });
      if (!result.accepted || result.failed) throw new Error("恢复中断批次封存失败");
      await store.sealSession(session.id, session.ownerToken, { status: "interrupted", stopOutcome, coverage: { version: 1, recoveryGaps: 1, reasons: { worker_restarted: 1 } } });
    }
  }
  function ready() { return recovery ||= recover(); }
  async function handle(message, sender = {}) {
    try {
      await ready();
      let value;
      if (["START", "STOP", "GET_STATUS", "GET_STATE", "GET_LIMIT_SETTINGS", "SAVE_LIMIT_SETTINGS", "RESET_LIMIT_SETTINGS"].includes(message?.type)) {
        if (sender.tab && !sender.url?.startsWith(chrome.runtime.getURL("")) || sender.id && sender.id !== chrome.runtime.id) throw new Error("仅扩展控制页可以操作录制批次");
        if (message.type === "GET_LIMIT_SETTINGS") value = settingsReply(await readSettings());
        if (message.type === "SAVE_LIMIT_SETTINGS") value = settingsReply(await saveFlowSettings(message.settings, settingsStorage));
        if (message.type === "RESET_LIMIT_SETTINGS") value = settingsReply(await saveFlowSettings(DEFAULT_FLOW_SETTINGS, settingsStorage));
        if (message.type === "START") value = await start(message);
        if (message.type === "STOP") value = await stop(message.sessionId);
        if (message.type === "GET_STATUS" || message.type === "GET_STATE") {
          const r = active, saved = r ? await store.getSession(r.session.id) : null;
          value = { active: r && active === r ? summary({ ...saved, ...r.session, budget: saved?.budget }) : summary(active?.session), sessions: (await store.listSessions()).map(summary) };
        }
      } else {
        const r = active, tokenRequired = message?.type !== "FLOW_SETTINGS";
        const auth = await authorized(r, sender, tokenRequired, message);
        if (!auth) throw new Error("采集来源或所有权无效");
        if (message.type === "FLOW_SETTINGS") { if (!live(r)) throw new Error("采集接纳已关闭"); value = settings(r); }
        else if (message.type === "FLOW_READY") { if (!live(r)) throw new Error("采集接纳已关闭"); value = settings(r); if (sender.frameId === 0) requestScreenshot(r, auth.t, { time: now(), frameId: sender.frameId, documentId: sender.documentId, reason: "baseline" }); }
        else if (message.type === "FLOW_CONTENT_PART") value = await track(r, contentPart(r, message, sender, auth));
        else if (message.type === "FLOW_EVENTS") value = await track(r, pageBatch(r, message, sender, auth));
        else if (message.type === "FLOW_POLICY_STOPPED") { controlledStop(r, /^content-[a-z-]{1,64}$/.test(message.reason) ? message.reason : "content_policy_limit"); value = { policyStopped: true }; }
        else throw new Error("未知录制消息");
      }
      return { ok: true, value };
    } catch (error) { return { ok: false, error: errorText(error) }; }
  }
  function listen(event, fn) { if (!event?.addListener) return; event.addListener(fn); subscriptions.push(() => event.removeListener?.(fn)); }
  function install() {
    listen(chrome.runtime.onMessage, (message, sender, respond) => { handle(message, sender).then(respond); return true; });
    listen(chrome.tabs.onCreated, (tab) => { const r = active; if (r) track(r, created(tab)).catch(() => controlledStop(r, "scope_update_failed", true)); });
    listen(chrome.tabs.onUpdated, (tabId, change) => {
      const r = active, candidate = r?.childCandidate;
      if (candidate?.tabId === tabId && http(change.url) && live(r)) { candidate.url = change.url; candidate.resolve(); }
      const t = r?.tabs.get(tabId); if (t && live(r) && change.status === "complete") track(r, inject(r, t)).catch(() => {});
    });
    listen(chrome.tabs.onRemoved, (tabId) => { const r = active; if (!r?.tabs.has(tabId)) return; if (tabId === r.session.rootTabId) controlledStop(r, "root_tab_closed"); else { r.tabs.get(tabId).closed = true; r.gaps.set("child_tab_closed", 1); } });
    listen(chrome.webNavigation.onCommitted, (p) => { const r = active; if (r && (r.tabs.has(p.tabId) || r.childCandidate?.tabId === p.tabId && p.frameId === 0) && live(r)) track(r, committed(p)).catch(() => controlledStop(r, "navigation_capture_failed", true)); });
    listen(chrome.debugger.onEvent, (source, method, p) => { const r = active; if (r?.tabs.has(source.tabId) && live(r)) track(r, debuggerEvent(source, method, p)).catch(() => controlledStop(r, "debugger_capture_failed", true)); });
    listen(chrome.debugger.onDetach, (source) => { const r = active, t = r?.tabs.get(source.tabId); if (!t) return; t.attached = false; if (live(r) && !t.closed) controlledStop(r, "debugger_disconnected", true); });
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true }).catch(() => {});
    ready().catch(() => {});
    return () => { for (const unsubscribe of subscriptions.splice(0)) unsubscribe(); };
  }
  return { handle, install, ready, debuggerEvent, committed, created };
}

if (globalThis.chrome?.runtime?.id && globalThis.chrome?.runtime?.onMessage) createFlowBackground().install();
