import { all, get, put, putMany, putIdempotentEvents, removeSession, interruptSession } from "./db.js";
import { fontMime } from "./font-format.js";
import { cleanDebuggerResponse } from "./response-body.js";
import { recoverPendingRequests, recoverRootSockets, recoverChildSockets } from "./network-recovery.js";
import { withSessionLock } from "./session-lock.js";
import { canRecoverSession } from "./session-ownership.js";
import { indexFragmentEvidence } from "./fragments.js";
import { responseBlob } from "./large-response.js";
import { indexComputedStyleEvidence } from "./computed-style-coverage.js";
import { indexDatabaseEvidence } from "./database-coverage.js";
import { indexDatabaseCatalogEvidence } from "./database-catalog-coverage.js";
import { indexCacheEvidence } from "./cache-coverage.js";
import { indexCacheCatalogEvidence } from "./cache-catalog-coverage.js";
import { indexCanvasEvidence } from "./canvas-coverage.js";
import { rawMutationComplete } from "./mutation-coverage.js";
import { indexRequestEntryEvidence } from "./request-entry-coverage.js";
import { planFullPageTiles } from "./full-page-tiles.js";
import { countFullPageGaps } from "./full-page-coverage.js";
import { countRealtimeGaps } from "./realtime-coverage.js";
import { indexShadowEvidence } from "./shadow-coverage.js";
import { countInteractionStyleGaps, countInteractionDescendantGaps } from "./interaction-style-coverage.js";
import {
  cleanBody,
  cleanCookieValue,
  cleanHeaders,
  cleanRealtimeText,
  cleanUrl,
  cleanWebSocketFrame,
} from "./privacy.js";

const uid = () => crypto.randomUUID();
const NETWORK_TOTAL_BUFFER_BYTES = 128000000;
const NETWORK_RESOURCE_BUFFER_BYTES = 32000000;
let active = null;
let currentOrigin = null;
let networkSealed = false;
let screenshotLast = 0;
let screenshotTimer;
let screenshotPending = [];
let screenshotChain = Promise.resolve();
let fullPageChain = Promise.resolve();
const fullPageRequests = new Set();
const pending = new Set();
const tabActivationVersions = new Map();
const requests = new Map();
const childScopes = new Map();
const childTargets = new Map();
const childDocuments = new Map();
const socketScopes = new Map();
const unknownSocketTabs = new Set();
const unknownRequestTabs = new Set();
const unknownDialogTabs = new Set();
const dialogScopes = new Map();
const tabConnectionQueues = new Map();
const initialPreparations = new Map();
let sequence = 0;
let writeChain = Promise.resolve();
let outstandingWrites = 0;
let childStorageChain = Promise.resolve();
let stopInFlight = false;
let recoveryCleanup;
const pendingInterruptions = new Map();
let interruptionRetry;

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(console.error);

function track(promise) {
  pending.add(promise);
  promise.finally(() => pending.delete(promise)).catch(console.error);
  return promise;
}
function withDeadline(promise, milliseconds, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}超时`)),
      milliseconds,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
async function forEachConcurrent(items, limit, task) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await task(item);
    }
  }));
}
async function persistSessionState(session) {
  let current = session;
  let status = current.status;
  await chrome.storage.session.set({ active: current });
  while (current !== active || (active && status !== active.status)) {
    current = active;
    status = current?.status;
    if (current) await chrome.storage.session.set({ active: current });
    else await chrome.storage.session.remove("active");
  }
}
function recordDroppedEvents(session, count) {
  if (!count) return;
  session.droppedEvents = (session.droppedEvents || 0) + count;
  session.incomplete = true;
  session.notice = "录制速度超过本机写入能力，部分记录已丢失。";
  if (session.droppedEvents === count) {
    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    persistSessionState(session).catch(() => {});
  }
}
function markEventWriteFailure(sessionId, error) {
  console.error("事件写入失败", error);
  if (active?.id === sessionId) {
    const session = active;
    session.storageError = true;
    session.notice = "本地存储写入失败，部分记录可能丢失，请停止并检查可用空间。";
    chrome.action.setBadgeText({ text: "!" }).catch(() => {});
    persistSessionState(session).catch(() => {});
  }
}
function append(kind, payload = {}, extra = {}) {
  if (!active) return Promise.resolve();
  if (outstandingWrites >= 5000 && !["warning", "session.stop"].includes(kind)) {
    recordDroppedEvents(active, 1);
    return Promise.resolve(false);
  }
  const event = {
    id: uid(),
    sessionId: active.id,
    seq: ++sequence,
    time: Date.now(),
    kind,
    payload,
    ...extra,
  };
  outstandingWrites++;
  const task = writeChain.then(() => put("events", event));
  const handled = task
    .then(() => true)
    .catch((error) => {
      markEventWriteFailure(event.sessionId, error);
      return false;
    });
  handled.finally(() => {
    outstandingWrites--;
  });
  writeChain = handled.then(() => undefined);
  return track(handled);
}
function appendRealtime(kind, payload, raw, encoding, extra) {
  const session = active;
  if (!session) return Promise.resolve();
  if (payload.data?.status !== "omitted_size" || typeof raw !== "string") return append(kind, payload, extra);
  const captureId = uid();
  const first = append(kind, { ...payload, observedAt: Date.now(), data: { status: "pending_asset", captureId,
    encoding, length: raw.length } }, extra);
  return track((async () => {
    if (!await first) return;
    let result;
    try {
      const blob = new Blob([JSON.stringify(raw)], { type: "application/json" });
      const assetId = uid();
      await put("assets", { id: assetId, sessionId: session.id, type: "resource", mime: "application/json", blob });
      result = { captureId, requestId: payload.requestId, status: "captured_asset", assetId, size: blob.size,
        representation: "json-string-utf8", encoding, originalLength: raw.length };
    } catch (error) {
      markEventWriteFailure(session.id, error);
      result = { captureId, requestId: payload.requestId, status: "unavailable", reason: String(error) };
    }
    if (active === session) await append("network.realtimePayload", result, extra);
  })());
}
function appendPageBatch(items, sender, session, batchId) {
  const capacity = Math.max(0, 5000 - outstandingWrites);
  const selected = batchId ? items : items.slice(0, capacity);
  if (!batchId) recordDroppedEvents(session, items.length - selected.length);
  const events = selected.map((item, index) => ({
    id: batchId ? `${batchId}_${index}` : uid(), sessionId: session.id, seq: ++sequence, time: item.time,
    kind: item.kind,
    payload: { ...item.payload, url: cleanUrl(item.payload?.url || sender.url) },
    tabId: sender.tab.id, frameId: sender.frameId, documentId: sender.documentId,
    ...(batchId ? { screenshotRequested: !!item.screenshot, batchSize: items.length } : {}),
  }));
  if (!events.length) return Promise.resolve({ events, results: [] });
  const reserved = Math.min(events.length, capacity);
  outstandingWrites += reserved;
  const handled = writeChain.then(() => batchId
    ? putIdempotentEvents(events, reserved)
    : putMany("events", events).then((values) => values.map((saved) => saved ? "created" : "failed")))
  .then((results) => {
    if (active === session) recordDroppedEvents(session, results.filter((result) => result === "capacity").length);
    if (results.some((result) => result === "failed" || result === "conflict"))
      markEventWriteFailure(session.id, new Error("部分事件写入失败或标识冲突"));
    return results;
  }).catch((error) => {
    markEventWriteFailure(session.id, error);
    return events.map(() => "failed");
  });
  handled.finally(() => { outstandingWrites -= reserved; });
  writeChain = handled.then(() => undefined);
  return track(handled).then((results) => ({ events, results }));
}
async function warning(message, details = {}) {
  if (!active) return;
  active.notice = message;
  await append("warning", { message, ...details });
}
function allowedUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      (active?.options.scope === "browser" || url.origin === currentOrigin)
    );
  } catch {
    return false;
  }
}
function isHttpUrl(raw) {
  try {
    return ["http:", "https:"].includes(new URL(raw).protocol);
  } catch {
    return false;
  }
}
function persistChildTargets() {
  const owner = active?.id;
  if (!owner || !["preparing", "recording"].includes(active.status)) return;
  const task = childStorageChain.then(async () => {
    if (active?.id !== owner || !["preparing", "recording"].includes(active.status)) return;
    await chrome.storage.session.set({ recorderFrames: { owner, entries: [...childTargets] } });
  });
  childStorageChain = task.catch(async (error) => {
    if (active?.id === owner && ["preparing", "recording"].includes(active.status))
      await warning("框架恢复信息保存失败，后台重启后可能缺失网络记录", { error: String(error) });
  });
  track(childStorageChain);
}
async function removeSessionState(session) {
  await chrome.storage.session.remove(["active", "recorderFrames"]);
  if (active && active !== session) {
    const current = active;
    await persistSessionState(current);
    if (active === current) persistChildTargets();
  }
}
function setChildScope(sessionId, tabId, allowed) {
  childScopes.set(sessionId, allowed);
  const previous = childTargets.get(sessionId);
  if (allowed) childTargets.set(sessionId, tabId);
  else childTargets.delete(sessionId);
  if (previous !== (allowed ? tabId : undefined)) persistChildTargets();
}
function clearTabContexts(tabId) {
  for (const [id, item] of socketScopes)
    if (item.tabId === tabId) socketScopes.delete(id);
  for (const id of dialogScopes.keys())
    if (id.startsWith(`${tabId}:`)) dialogScopes.delete(id);
  let changed = false;
  for (const [sessionId, ownerTab] of childTargets) {
    if (ownerTab !== tabId) continue;
    childScopes.delete(sessionId);
    childTargets.delete(sessionId);
    childDocuments.delete(sessionId);
    changed = true;
  }
  if (changed) persistChildTargets();
}
function reserveTabConnection(tabId) {
  const previous = tabConnectionQueues.get(tabId);
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const tail = previous ? previous.then(() => finished) : finished;
  tabConnectionQueues.set(tabId, tail);
  tail.then(() => { if (tabConnectionQueues.get(tabId) === tail) tabConnectionQueues.delete(tabId); });
  return { previous, finish };
}
async function detachTab(target) {
  const { previous, finish } = reserveTabConnection(target.id);
  try {
    if (previous) await previous;
    if (!target.debuggerAttached) return;
    await chrome.debugger.detach({ tabId: target.id });
    target.debuggerAttached = false;
  } finally {
    finish();
  }
}
function preparing(session) {
  return active === session && session.status === "preparing";
}
function requirePreparing(session) {
  if (!preparing(session)) throw new Error("录制准备已停止");
}
async function register(origin, scope, session) {
  const parsed = new URL(origin);
  const matches =
    scope === "browser"
      ? ["http://*/*", "https://*/*"]
      : [`${parsed.protocol}//${parsed.hostname}/*`];
  await chrome.scripting.registerContentScripts([
    {
      id: session.scriptId,
      matches,
      js: ["content.js"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: false,
    },
  ]);
  session.scriptRegistered = true;
  if (active !== session || !["preparing", "recording"].includes(session.status))
    await chrome.scripting.unregisterContentScripts({ ids: [session.scriptId] }).catch(() => {});
}
async function init() {
  const state = await withDeadline(chrome.storage.session.get(["active", "recorderFrames"]), 5000, "后台状态读取");
  if (state.active) {
    active = state.active;
    currentOrigin = active.origin;
    active.tabs ||= {
      [active.tabId]: {
        id: active.tabId,
        windowId: active.windowId,
        inScope: true,
        debuggerAttached: active.debuggerAttached,
        mainFrameId: active.mainFrameId,
      },
    };
    const stored = await withDeadline(get("sessions", active.id), 5000, "录制状态读取");
    if (stored && ["ready", "interrupted"].includes(stored.status)) {
      await clearActiveResources(active);
      return;
    }
    if (
      !stored ||
      stored.status !== "recording" ||
      active.status !== "recording"
    ) {
      await interrupt(active, "录制准备或结束时后台中断，已保存可用的部分记录");
      return;
    }
    const events = await withDeadline(all("events", active.id), 15000, "录制事件恢复");
    sequence = events.reduce((n, e) => Math.max(n, e.seq || 0), 0);
    const storedFrames = state.recorderFrames?.owner === active.id && Array.isArray(state.recorderFrames.entries)
      ? state.recorderFrames.entries : [];
    if (storedFrames.length > 1000)
      await warning("框架数量超过后台恢复上限，部分网络记录可能缺失", { total: storedFrames.length, limit: 1000 });
    const validTabs = new Map();
    await Promise.all(storedFrames.slice(0, 1000).map(async (entry) => {
      if (!Array.isArray(entry) || entry.length !== 2) return;
      const [sessionId, tabId] = entry;
      const tab = active?.tabs[tabId];
      if (typeof sessionId !== "string" || !sessionId || !Number.isSafeInteger(tabId) ||
          !tab || tab.closed || !tab.inScope || !tab.debuggerAttached) return;
      try {
        if (!validTabs.has(tabId))
          validTabs.set(tabId, withDeadline(chrome.webNavigation.getFrame({ tabId, frameId: 0 }), 1500, "页面范围检查"));
        const [top, child, tree] = await Promise.all([
          validTabs.get(tabId),
          withDeadline(chrome.debugger.sendCommand({ tabId, sessionId }, "Target.getTargetInfo"), 1500, "框架范围检查"),
          withDeadline(chrome.debugger.sendCommand({ tabId, sessionId }, "Page.getFrameTree"), 1500, "框架实例检查").catch(() => null),
        ]);
        const frame = tree?.frameTree?.frame;
        if (top && allowedUrl(top.url) && child?.targetInfo?.type === "iframe" && allowedUrl(child.targetInfo.url)) {
          childScopes.set(sessionId, true);
          childTargets.set(sessionId, tabId);
          if (frame?.id === child.targetInfo.targetId && allowedUrl(frame.url) &&
              new URL(child.targetInfo.url).origin === new URL(frame.url).origin)
            childDocuments.set(sessionId, { frameId: frame.id, loaderId: frame.loaderId, url: frame.url });
        }
      } catch {}
    }));
    for (const [key, item] of recoverPendingRequests(events, active.tabs)) {
      requests.set(key, item);
      if (item.postData?.status === "pending") {
        const body = { value: null, status: "unavailable", reason: "后台重启前请求体读取未完成" };
        item.postData = body;
        await append("network.requestBody", { requestId: item.requestId, body }, { tabId: item.tabId });
      }
    }
    const socketTabs = new Set(events.filter((event) => event.kind === "network.websocket" &&
      event.payload?.type === "webSocketCreated" && event.tabId != null).map((event) => event.tabId));
    const documents = new Map();
    await Promise.all([...socketTabs].map(async (tabId) => {
      const tab = active?.tabs[tabId];
      if (!tab || tab.closed || !tab.inScope || !tab.debuggerAttached) return;
      try {
        const frame = await withDeadline(chrome.webNavigation.getFrame({ tabId, frameId: 0 }), 1500, "页面实例检查");
        if (frame?.documentId && allowedUrl(frame.url)) documents.set(tabId, frame.documentId);
      } catch {}
    }));
    for (const [key, socket] of recoverRootSockets(events, active.tabs, documents))
      socketScopes.set(key, socket);
    for (const [key, socket] of recoverChildSockets(events, active.tabs, childTargets, childDocuments))
      socketScopes.set(key, socket);
    await warning("录制后台已重新启动，期间的部分事件或连接可能缺失");
  } else {
    for (const session of await withDeadline(all("sessions"), 10000, "录制批次恢复")) {
      if (["preparing", "recording", "stopping"].includes(session.status)) {
        session.status = "interrupted";
        session.interruptedAt = Date.now();
        await put("sessions", session);
      }
    }
  }
}
let ready;
function ensureReady() {
  if (recoveryCleanup) return recoveryCleanup.then(() => ensureReady());
  if (!ready) {
    const current = init();
    ready = current;
    current.catch(() => { if (ready === current) ready = undefined; });
  }
  return ready;
}
void ensureReady().catch(console.error);
const afterReady =
  (handler) =>
  (...args) => {
    track(ensureReady().then(() => handler(...args)));
  };

async function start(tab, options, onCreated) {
  await ensureReady();
  if (active) throw new Error("已有录制任务进行中");
  networkSealed = false;
  const url = new URL(tab.url);
  if (!["https:", "http:"].includes(url.protocol))
    throw new Error("请选择普通 HTTP 或 HTTPS 页面");
  const origin = url.origin;
  const origins =
    options.scope === "browser"
      ? ["http://*/*", "https://*/*"]
      : [`${url.protocol}//${url.hostname}/*`];
  const allowed = await chrome.permissions.contains({ origins });
  if (!allowed) throw new Error("尚未授予当前站点权限");
  if (active) throw new Error("已有录制任务进行中");
  const session = {
    id: uid(),
    title: tab.title || url.hostname,
    origin,
    tabId: tab.id,
    windowId: tab.windowId,
    tabs: {
      [tab.id]: {
        id: tab.id,
        windowId: tab.windowId,
        inScope: true,
        url: cleanUrl(tab.url),
      },
    },
    cookieOrigins: [],
    startedAt: Date.now(),
    status: "preparing",
    // A late registration can then be removed without touching a newer session.
    scriptId: `recorder-${uid()}`,
    options,
    browser: navigator.userAgent,
    gaps: [],
  };
  active = session;
  onCreated(session);
  childTargets.clear();
  currentOrigin = origin;
  sequence = 0;
  const initial = (async () => {
    await chrome.storage.session.remove("recorderFrames");
    if (active && active !== session) persistChildTargets();
    requirePreparing(session);
    if (options.scope === "browser") {
      const tabs = await chrome.tabs.query({});
      requirePreparing(session);
      for (const item of tabs)
        if (!item.incognito && allowedUrl(item.url) && !session.tabs[item.id])
          session.tabs[item.id] = {
            id: item.id,
            windowId: item.windowId,
            inScope: true,
            url: cleanUrl(item.url),
          };
    }
    await put("sessions", session);
    requirePreparing(session);
    await persistSessionState(session);
    requirePreparing(session);
    await append("session.start", {
      url: cleanUrl(tab.url),
      note: "开始前发生的操作和请求未记录",
    });
    requirePreparing(session);
  })();
  initialPreparations.set(session.id, initial);
  try { await initial; }
  finally { initialPreparations.delete(session.id); }
  try {
    await withDeadline(register(origin, options.scope, session), 5000, "页面采集器注册");
  } catch (error) {
    requirePreparing(session);
    session.incomplete = true;
    await warning("页面采集器注册失败", { error: String(error) });
  }
  requirePreparing(session);
  await forEachConcurrent(Object.values(session.tabs), 4, async (target) => {
    requirePreparing(session);
    try { await withDeadline(attachTab(target.id), 5000, "网络调试连接"); }
    catch (error) {
      requirePreparing(session);
      session.incomplete = true;
      await warning("网络调试连接超时，网络记录可能不完整", { tabId: target.id, error: String(error) });
    }
    requirePreparing(session);
  });
  const resourceDeadline = Date.now() + 6000;
  await forEachConcurrent(Object.values(session.tabs), 4, async (target) => {
    requirePreparing(session);
    await captureInitialResources(target, resourceDeadline);
    requirePreparing(session);
  });
  await forEachConcurrent(Object.values(session.tabs), 4, async (target) => {
    requirePreparing(session);
    try {
      const frames = await withDeadline(chrome.webNavigation.getAllFrames({ tabId: target.id }), 2000, "页面框架检查");
      const frameIds = (frames || []).filter((frame) => allowedUrl(frame.url)).map((frame) => frame.frameId);
      if (!frameIds.length) throw new Error("没有可采集的页面框架");
      let results;
      try {
        results = await withDeadline(chrome.scripting.executeScript({
          target: { tabId: target.id, frameIds }, files: ["content.js"],
        }), 5000, "页面采集器注入");
      } catch (batchError) {
        requirePreparing(session);
        const attempts = await Promise.all(frameIds.map(async (frameId) => {
          try {
            return await withDeadline(chrome.scripting.executeScript({
              target: { tabId: target.id, frameIds: [frameId] }, files: ["content.js"],
            }), 5000, "单框架采集器注入");
          } catch (error) {
            if (preparing(session)) {
              session.incomplete = true;
              await warning("页面框架采集器注入失败，部分页面操作可能缺失", { tabId: target.id, frameId, error: String(error) });
            }
            return [];
          }
        }));
        results = attempts.flat();
        if (!results.length) throw batchError;
      }
      requirePreparing(session);
      if (!results?.length) throw new Error("没有可确认的页面框架");
      await Promise.all((results || []).map(async (frame) => {
        const deadline = Date.now() + 5000;
        while (preparing(session) && Date.now() < deadline) {
          try {
            const response = await withDeadline(chrome.tabs.sendMessage(target.id,
              { type: "COLLECTOR_READY", sessionId: session.id }, { frameId: frame.frameId }),
              Math.min(1000, deadline - Date.now()), "页面采集器就绪检查");
            if (response?.ok) return;
          } catch {}
          if (preparing(session) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (preparing(session)) {
          session.incomplete = true;
          await warning("页面采集器未确认就绪，页面操作可能缺失", { tabId: target.id, frameId: frame.frameId });
        }
      }));
    } catch (error) {
      requirePreparing(session);
      session.incomplete = true;
      await warning("页面采集器注入失败", {
        tabId: target.id,
        error: String(error),
      });
    }
    requirePreparing(session);
  });
  await forEachConcurrent(Object.values(session.tabs), 4, async (target) => {
    requirePreparing(session);
    try { await withDeadline(snapshotCookies(target.url), 5000, "Cookie 初始状态"); }
    catch (error) {
      requirePreparing(session);
      session.incomplete = true;
      await warning("Cookie 初始状态采集超时", { tabId: target.id, error: String(error) });
    }
    requirePreparing(session);
  });
  await withDeadline(chrome.action.setBadgeBackgroundColor({ color: "#b43f36" }), 2000, "录制标记").catch(() => {});
  requirePreparing(session);
  await withDeadline(chrome.action.setBadgeText({ text: "REC" }), 2000, "录制标记").catch(() => {});
  requirePreparing(session);
  await withDeadline(chrome.action.setTitle({ title: "逻辑记录：录制中" }), 2000, "录制标题").catch(() => {});
  requirePreparing(session);
  session.status = "recording";
  await put("sessions", session);
  if (active !== session || session.status !== "recording") throw new Error("录制准备已停止");
  await withDeadline(persistSessionState(session), 5000, "录制状态保存");
  if (active !== session || session.status !== "recording") throw new Error("录制准备已停止");
  const readyEventId = uid();
  await append(
    "session.ready",
    { debuggerAttached: !!session.tabs[tab.id]?.debuggerAttached },
    { id: readyEventId, tabId: tab.id },
  );
  if (active !== session || session.status !== "recording") throw new Error("录制准备已停止");
  if (options.screenshots)
    requestScreenshot(readyEventId, tab.id, 0, undefined, cleanUrl(tab.url));
  return session;
}

async function snapshotCookies(raw) {
  const session = active;
  if (!session || !allowedUrl(raw)) return;
  const parsed = new URL(raw),
    site = parsed.origin;
  session.cookieOrigins ||= [];
  if (session.cookieOrigins.includes(site)) return;
  session.cookieOrigins.push(site);
  try {
    const records = [
      ...(await chrome.cookies.getAll({ url: raw })),
      ...(await chrome.cookies.getAll({ domain: parsed.hostname })),
    ];
    const items = new Map();
    for (const cookie of records) {
      const { name, value, domain, path, partitionKey, storeId } = cookie;
      const suffix = domain.replace(/^\./, "");
      if (parsed.hostname !== suffix && !parsed.hostname.endsWith("." + suffix))
        continue;
      items.set(JSON.stringify([name, domain, path, partitionKey, storeId]), {
        ...cookie,
        ...cleanCookieValue(name, value),
      });
    }
    if (active === session && ["preparing", "recording"].includes(session.status))
      await append("cookie.initial", {
        origin: site,
        items: [...items.values()],
      });
  } catch (error) {
    session.cookieOrigins = session.cookieOrigins.filter((origin) => origin !== site);
    if (active === session && ["preparing", "recording"].includes(session.status))
      await warning("Cookie 初始状态无法读取", {
        origin: site,
        error: String(error),
      });
  }
}

async function snapshotFrameCookies(tabId, frame) {
  const session = active;
  if (!session || !allowedUrl(frame.url)) return;
  const documentId = frame.documentId || null;
  const key = JSON.stringify([tabId, frame.frameId, documentId, frame.url]);
  session.cookieFrames ||= [];
  if (session.cookieFrames.includes(key)) return;
  session.cookieFrames.push(key);
  try {
    await snapshotCookies(frame.url);
    if (typeof chrome.cookies.getPartitionKey !== "function")
      throw new Error("浏览器版本不支持按框架获取 Cookie 分区");
    const details = { tabId, frameId: frame.frameId, ...(documentId ? { documentId } : {}) };
    const result = await chrome.cookies.getPartitionKey(details);
    if (!result?.partitionKey) throw new Error("浏览器未提供 Cookie 分区键");
    const hostname = new URL(frame.url).hostname;
    const cookies = [
      ...await chrome.cookies.getAll({ url: frame.url, partitionKey: result.partitionKey }),
      ...await chrome.cookies.getAll({ domain: hostname, partitionKey: result.partitionKey }),
    ];
    const itemsByKey = new Map();
    for (const cookie of cookies) {
      const domain = cookie.domain.replace(/^\./, "");
      if (hostname === domain || hostname.endsWith("." + domain))
        itemsByKey.set(JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey, cookie.storeId]),
          { ...cookie, ...cleanCookieValue(cookie.name, cookie.value) });
    }
    if (active === session) await append("cookie.partitionSnapshot", { url: frame.url, status: "captured",
      partitionKey: result.partitionKey, items: [...itemsByKey.values()] }, { tabId, frameId: frame.frameId, documentId });
  } catch (error) {
    session.cookieFrames = session.cookieFrames.filter((item) => item !== key);
    if (active === session) await append("cookie.partitionSnapshot", { url: frame.url, status: "unavailable", reason: String(error) },
      { tabId, frameId: frame.frameId, documentId });
  }
}

async function attachTab(tabId) {
  const session = active,
    target = session?.tabs[tabId];
  if (!target || target.attaching || target.debuggerAttached) return;
  const isCurrent = () => active === session &&
    ["preparing", "recording"].includes(session.status) &&
    session.tabs[tabId] === target && !target.closed;
  target.attaching = true;
  const { previous, finish: finishAttach } = reserveTabConnection(tabId);
  let attached = false;
  try {
    if (previous) await withDeadline(previous, 3000, "等待旧调试连接关闭");
    if (!isCurrent()) return;
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
    if (!isCurrent()) return;
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    const tree = await chrome.debugger.sendCommand(
      { tabId },
      "Page.getFrameTree",
    );
    target.mainFrameId = tree.frameTree.frame.id;
    await chrome.debugger.sendCommand({ tabId }, "Network.enable", {
      maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
      maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
      maxPostDataSize: 65536,
    });
    if (!isCurrent()) return;
    target.debuggerAttached = true;
    try {
      await enableChildTargets({ tabId });
    } catch (error) {
      if (isCurrent())
        await warning("嵌入页面的网络采集不可用", {
          tabId,
          error: String(error),
        });
    }
  } catch (error) {
    if (attached) {
      await chrome.debugger.detach({ tabId }).catch(() => {});
      attached = false;
    }
    target.debuggerAttached = false;
    if (active?.id === session.id)
      await warning("网络调试连接失败，网络记录可能不完整", {
        tabId,
        error: String(error),
      });
  } finally {
    if (attached && !isCurrent()) {
      target.debuggerAttached = false;
      await chrome.debugger.detach({ tabId }).catch(() => {});
    }
    target.attaching = false;
    try {
      if (active?.id === session.id)
        await withDeadline(persistSessionState(session), 2000, "调试状态保存").catch(() => {});
    } finally {
      finishAttach();
    }
  }
}

async function enableChildTargets(debugSession) {
  await chrome.debugger.sendCommand(debugSession, "Target.setAutoAttach", {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
    filter: [{ type: "iframe", exclude: false }],
  });
}

async function captureLoadedResources(target, deadline, session) {
  const summary = { total: 0, captured: 0, failed: 0, omitted: 0, status: "captured" };
  const current = () => active === session && ["preparing", "recording"].includes(session.status);
  try {
    if (!target.debuggerAttached) throw new Error("调试连接不可用");
    const tree = await withDeadline(chrome.debugger.sendCommand({ tabId: target.id }, "Page.getResourceTree"),
      Math.max(1, Math.min(1500, deadline - Date.now())), "已加载资源目录读取");
    const pending = [tree.frameTree], resources = [];
    while (pending.length) {
      const frame = pending.pop();
      if (!frame?.frame) continue;
      pending.push(...(frame.childFrames || []));
      if (!allowedUrl(frame.frame.url)) continue;
      for (const item of frame.resources || []) {
        if (["Stylesheet", "Font", "Image"].includes(item.type) && isHttpUrl(item.url))
          resources.push({ ...item, protocolFrameId: frame.frame.id, frameUrl: frame.frame.url, loaderId: frame.frame.loaderId });
      }
    }
    summary.total = resources.length;
    let totalBytes = 0;
    for (const item of resources) {
      if (!current()) return;
      if (Date.now() >= deadline || summary.captured + summary.failed >= 50 || totalBytes >= 10000000) {
        summary.omitted = summary.total - summary.captured - summary.failed;
        break;
      }
      const meta = { url: item.url, resourceType: item.type, mime: item.mimeType,
        protocolFrameId: item.protocolFrameId, frameUrl: item.frameUrl, loaderId: item.loaderId,
        expectedSize: item.contentSize ?? null, observedAt: Date.now() };
      try {
        if (item.failed || item.canceled) throw new Error("浏览器报告资源加载失败或取消");
        const result = await withDeadline(chrome.debugger.sendCommand({ tabId: target.id }, "Page.getResourceContent",
          { frameId: item.protocolFrameId, url: item.url }), Math.max(1, Math.min(1200, deadline - Date.now())), "已加载资源读取");
        if (!current()) return;
        const currentTree = await withDeadline(chrome.debugger.sendCommand({ tabId: target.id }, "Page.getFrameTree"),
          Math.max(1, Math.min(1000, deadline - Date.now())), "资源页面复核");
        const frameQueue = [currentTree.frameTree];
        let matchingFrame;
        while (frameQueue.length) {
          const frame = frameQueue.pop();
          if (frame?.frame?.id === item.protocolFrameId) { matchingFrame = frame.frame; break; }
          frameQueue.push(...(frame?.childFrames || []));
        }
        if (!matchingFrame || matchingFrame.loaderId !== item.loaderId)
          throw new Error("资源读取时框架已导航，无法确认页面归属");
        if (!current()) return;
        const bytes = result.base64Encoded
          ? Uint8Array.from(atob(result.content), (character) => character.charCodeAt(0))
          : new TextEncoder().encode(result.content);
        if (bytes.length > 10000000 || totalBytes + bytes.length > 10000000) throw new Error("已加载资源超过采集字节预算");
        const assetId = uid();
        await put("assets", { id: assetId, sessionId: session.id, type: "resource", mime: item.mimeType || "application/octet-stream",
          blob: new Blob([bytes], { type: item.mimeType || "application/octet-stream" }) });
        if (!current()) return;
        const saved = await append("resource.loaded", { ...meta, status: "captured", assetId, size: bytes.length,
          representation: result.base64Encoded ? "browser-provided-bytes" : "browser-decoded-text-utf8" }, { tabId: target.id });
        if (saved) { summary.captured++; totalBytes += bytes.length; }
        else { summary.failed++; session.storageError = true; }
      } catch (error) {
        summary.failed++;
        if (current()) await append("resource.loaded", { ...meta, status: "unavailable", reason: String(error) }, { tabId: target.id });
      }
    }
    if (summary.failed || summary.omitted) summary.status = "partial";
  } catch (error) {
    summary.status = "unavailable";
    summary.reason = String(error);
  }
  if (current()) await append("resource.loadedSummary", summary, { tabId: target.id });
}

async function captureInitialResources(target, deadline) {
  const session = active;
  if (!session) return;
  const summary = { total: 0, captured: 0, omitted: 0, status: "captured" };
  try {
    if (Date.now() >= deadline) throw new Error("初始资源采集时间已用完");
    const frames = await withDeadline(
      chrome.webNavigation.getAllFrames({ tabId: target.id }),
      Math.max(1, Math.min(1500, deadline - Date.now())),
      "初始页面检查",
    );
    if (!frames?.length) throw new Error("无法取得初始页面");
    for (const frame of frames) if (allowedUrl(frame.url)) track(snapshotFrameCookies(target.id, frame));
    if (active === session) await append("frame.tree", {
      tabId: target.id,
      frames: frames.map((frame) => ({ frameId: frame.frameId, parentFrameId: frame.parentFrameId,
        documentId: frame.documentId || null, parentDocumentId: frame.parentDocumentId || null,
        url: allowedUrl(frame.url) ? cleanUrl(frame.url) : null,
        scope: allowedUrl(frame.url) ? "eligible" : "outside_scope",
        documentLifecycle: frame.documentLifecycle || null, errorOccurred: !!frame.errorOccurred })),
    }, { tabId: target.id });
    await captureLoadedResources(target, deadline, session);
    let totalBytes = 0, complete = true;
    for (const frame of frames || []) {
      if (!allowedUrl(frame.url)) continue;
      if (Date.now() >= deadline || summary.captured >= 50 || totalBytes >= 10000000) {
        complete = false;
        break;
      }
      try {
        const [execution] = await withDeadline(
          chrome.scripting.executeScript({
            target: { tabId: target.id, frameIds: [frame.frameId] },
            injectImmediately: true,
            args: [50 - summary.captured, 10000000 - totalBytes],
            func: (maxItems, maxBytes) => {
              const roots = [document], images = [], seen = new Set();
              let scanned = 0, truncated = false;
              for (let i = 0; i < roots.length; i++) {
                for (const element of roots[i].querySelectorAll("*")) {
                  if (++scanned > 10000) { truncated = true; break; }
                  if (element instanceof HTMLImageElement) images.push(element);
                  const shadow = element.shadowRoot || (element instanceof HTMLElement ? chrome.dom?.openOrClosedShadowRoot?.(element) : null);
                  if (shadow) roots.push(shadow);
                }
                if (truncated) break;
              }
              const items = [];
              let total = 0, bytes = 0;
              const until = performance.now() + 800;
              for (const image of images) {
                const url = image.currentSrc || image.src;
                if (!url || seen.has(url)) continue;
                seen.add(url);
                total++;
                if (items.length >= maxItems || performance.now() > until ||
                    !image.complete || !image.naturalWidth || !image.naturalHeight ||
                    image.naturalWidth * image.naturalHeight > 1000000 ||
                    !/^https?:\/\//i.test(url)) continue;
                try {
                  const canvas = document.createElement("canvas");
                  canvas.width = image.naturalWidth;
                  canvas.height = image.naturalHeight;
                  canvas.getContext("2d").drawImage(image, 0, 0);
                  const data = canvas.toDataURL("image/png");
                  const size = Math.floor((data.length - 22) * 3 / 4);
                  if (!data.startsWith("data:image/png;base64,") || size > 1500000 || bytes + size > maxBytes) continue;
                  bytes += size;
                  items.push({ url, data });
                } catch {}
              }
              return { items, total, truncated };
            },
          }),
          Math.max(1, Math.min(1500, deadline - Date.now())),
          "初始图片读取",
        );
        const result = execution?.result;
        summary.total += result?.total || 0;
        if (result?.truncated) complete = false;
        const current = await withDeadline(
          chrome.webNavigation.getFrame({ tabId: target.id, frameId: frame.frameId }),
          Math.max(1, Math.min(1000, deadline - Date.now())),
          "初始页面复核",
        );
        if (!frame.documentId || execution?.documentId !== frame.documentId || current?.documentId !== frame.documentId) {
          complete = false;
          continue;
        }
        for (const item of result?.items || []) {
          if (active !== session || !["preparing", "recording"].includes(session.status)) return;
          const binary = atob(item.data.slice("data:image/png;base64,".length));
          const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
          if (bytes.length > 1500000 || totalBytes + bytes.length > 10000000) continue;
          const id = uid(), url = new URL(cleanUrl(item.url));
          url.hash = "";
          try {
            await put("assets", { id, sessionId: session.id, type: "resource", mime: "image/png", blob: new Blob([bytes], { type: "image/png" }) });
          } catch {
            session.storageError = true;
            complete = false;
            continue;
          }
          if (active !== session || !["preparing", "recording"].includes(session.status)) return;
          const saved = await append("resource.initial", { url: url.href, assetId: id, mime: "image/png", frameId: frame.frameId, documentId: frame.documentId, mode: "canvas_preview" }, { tabId: target.id, frameId: frame.frameId, documentId: frame.documentId });
          if (saved) { summary.captured++; totalBytes += bytes.length; }
          else session.storageError = true;
        }
      } catch {
        complete = false;
      }
    }
    summary.omitted = Math.max(0, summary.total - summary.captured);
    if (summary.omitted || !complete) summary.status = "partial";
    if (!complete) summary.reason = "部分页面或图片未完成检查";
  } catch (error) {
    summary.status = "unavailable";
    summary.reason = String(error);
  }
  if (active === session && ["preparing", "recording"].includes(session.status))
    await append("resource.initialSummary", summary, { tabId: target.id });
}

function capture() {
  const task = screenshotChain.then(captureOne);
  screenshotChain = task.catch(() => {});
  return task;
}
async function captureOne() {
  if (!active || !screenshotPending.length) return;
  const first = screenshotPending[0];
  const sameContext = (item) =>
    item.tabId === first.tabId &&
    item.frameId === first.frameId &&
    item.documentId === first.documentId &&
    item.url === first.url;
  const batch = screenshotPending
    .filter(sameContext)
    .map((item) => item.eventId);
  screenshotPending = screenshotPending.filter((item) => !sameContext(item));
  const sessionId = active.id,
    tabId = first.tabId,
    target = active.tabs[tabId],
    windowId = target?.windowId;
  try {
    const delay = (target?.debuggerAttached ? 200 : 600) - (Date.now() - screenshotLast);
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    if (!active || active.id !== sessionId) throw new Error("录制任务已结束");
    const activationVersion = tabActivationVersions.get(windowId) || 0;
    const [tab] = await chrome.tabs.query({ active: true, windowId });
    if (tab?.id !== tabId) throw new Error("目标标签不在前台");
    const topFrame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!topFrame?.documentId) throw new Error("无法确认截图所属页面");
    const sourceFrame =
      first.frameId === 0
        ? topFrame
        : await chrome.webNavigation
            .getFrame({ tabId, frameId: first.frameId })
            .catch(() => null);
    const contextChanged =
      !sourceFrame ||
      (first.documentId && sourceFrame.documentId !== first.documentId) ||
      (first.url && cleanUrl(sourceFrame.url) !== first.url);
    const info = await chrome.tabs.sendMessage(tabId, { type: "VIEWPORT_INFO" }, { frameId: 0 });
    if (!info?.viewport) throw new Error("无法读取页面视口");
    screenshotLast = Date.now();
    const captureStartedAt = screenshotLast;
    let data;
    if (target?.debuggerAttached) {
      if (
        info.viewport.scale !== 1 ||
        info.viewport.offsetX !== 0 ||
        info.viewport.offsetY !== 0
      )
        throw new Error("页面视口缩放或偏移无法安全截图");
      const result = await chrome.debugger.sendCommand(
        { tabId },
        "Page.captureScreenshot",
        { format: "png", fromSurface: true },
      );
      data = `data:image/png;base64,${result.data}`;
    } else {
      data = await chrome.tabs.captureVisibleTab(windowId, {
        format: "png",
      });
    }
    const capturedAt = Date.now();
    const [after] = await chrome.tabs.query({ active: true, windowId });
    if (!active || active.id !== sessionId || after?.id !== tabId)
      throw new Error("截图期间标签已变化");
    const afterTop = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
    if (!afterTop || afterTop.documentId !== topFrame.documentId)
      throw new Error("截图期间页面已变化");
    if (first.frameId !== 0 && sourceFrame) {
      const afterSource = await chrome.webNavigation
        .getFrame({ tabId, frameId: first.frameId })
        .catch(() => null);
      if (!afterSource || afterSource.documentId !== sourceFrame.documentId)
        throw new Error("截图期间操作所在页面已变化");
    }
    const afterInfo = await chrome.tabs.sendMessage(tabId, { type: "VIEWPORT_INFO" }, { frameId: 0 });
    if (JSON.stringify(info) !== JSON.stringify(afterInfo))
      throw new Error("截图期间页面视口发生变化");
    if ((tabActivationVersions.get(windowId) || 0) !== activationVersion)
      throw new Error("截图期间标签曾切换");
    const blob = await (await fetch(data)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const expectedWidth = info.viewport.width * info.viewport.dpr,
        expectedHeight = info.viewport.height * info.viewport.dpr;
      if (
        Math.abs(bitmap.width - expectedWidth) > 2 ||
        Math.abs(bitmap.height - expectedHeight) > 2
      )
        throw new Error(
          `截图尺寸 ${bitmap.width}×${bitmap.height} 与页面视口 ${expectedWidth}×${expectedHeight} 不一致`,
        );
    } finally {
      bitmap.close();
    }
    const id = uid();
    if (active?.id !== sessionId) return;
    await put("assets", {
      id,
      sessionId,
      type: "screenshot",
      mime: "image/png",
      blob,
    });
    if (active?.id === sessionId)
      await append(
        "screenshot",
        {
          assetId: id,
          mime: "image/png",
          eventIds: batch,
          url: cleanUrl(info.url),
          documentId: topFrame.documentId,
          contextChanged: Boolean(contextChanged),
          viewport: info.viewport,
          captureStartedAt,
          capturedAt,
          status: batch.length > 1 ? "shared" : "captured",
        },
        { tabId },
      );
  } catch (error) {
    if (active?.id === sessionId)
      await append(
        "screenshot",
        { eventIds: batch, status: "unavailable", reason: String(error) },
        { tabId },
      );
  }
  if (screenshotPending.length && active?.status !== "stopping")
    scheduleScreenshot();
}
function scheduleScreenshot() {
  if (screenshotTimer) return;
  const target = active?.tabs[screenshotPending[0]?.tabId];
  const interval = target?.debuggerAttached ? 200 : 600;
  screenshotTimer = setTimeout(
    () => {
      screenshotTimer = null;
      track(capture());
    },
    Math.max(80, interval - (Date.now() - screenshotLast)),
  );
}
function requestScreenshot(eventId, tabId, frameId, documentId, url) {
  screenshotPending.push({ eventId, tabId, frameId, documentId, url });
  scheduleScreenshot();
}
async function captureFullPageTiles({ tabId, frameId, documentId, session, info, size, dpr, windowId, activationVersion }) {
  const plan = planFullPageTiles(size.width, size.height, dpr);
  const captureId = uid(), deadline = Date.now() + 6000;
  let captured = 0, reason = null;
  for (let index = 0; index < plan.total; index++) {
    if (active !== session) return;
    if (index >= 128 || Date.now() >= deadline) { reason = "整页分片采集预算已用完"; break; }
    const clip = plan.tile(index), startedAt = Date.now();
    try {
      const result = await withDeadline(chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: "png", fromSurface: true, captureBeyondViewport: true, clip: { ...clip, scale: 1 },
      }), Math.max(1, Math.min(3000, deadline - Date.now())), "整页分片截图");
      const after = await withDeadline(chrome.webNavigation.getFrame({ tabId, frameId: 0 }),
        Math.max(1, Math.min(1200, deadline - Date.now())), "分片页面复核");
      const afterTab = await withDeadline(chrome.tabs.get(tabId),
        Math.max(1, Math.min(1200, deadline - Date.now())), "分片标签复核");
      if (active !== session || !afterTab.active || (tabActivationVersions.get(windowId) || 0) !== activationVersion ||
          !after || after.documentId !== documentId || after.url !== info.url) throw new Error("分片截图期间页面已变化");
      const binary = atob(result.data);
      const blob = new Blob([Uint8Array.from(binary, (character) => character.charCodeAt(0))], { type: "image/png" });
      const bitmapPromise = createImageBitmap(blob);
      let bitmap;
      try { bitmap = await withDeadline(bitmapPromise, Math.max(1, Math.min(1200, deadline - Date.now())), "分片图片解码"); }
      catch (error) { bitmapPromise.then((late) => late.close(), () => {}); throw error; }
      const pixelSize = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      if (Math.abs(pixelSize.width - clip.width * dpr) > 4 || Math.abs(pixelSize.height - clip.height * dpr) > 4)
        throw new Error("分片像素尺寸与页面范围不一致");
      const assetId = uid();
      await put("assets", { id: assetId, sessionId: session.id, type: "screenshot", mime: "image/png", blob });
      if (active !== session) return;
      const saved = await append("screenshot.fullPageTile", { ...info, captureId, index, total: plan.total, clip, pixelSize,
        dpr, status: "captured", assetId, mime: "image/png", captureStartedAt: startedAt, capturedAt: Date.now() },
      { tabId, frameId, documentId });
      if (!saved) throw new Error("分片记录写入失败");
      captured++;
    } catch (error) { reason = String(error); break; }
  }
  if (active === session) await append("screenshot.fullPage", { ...info, captureId, captureMode: "tiles",
    status: captured === plan.total ? "captured" : "partial", capturedTiles: captured, totalTiles: plan.total,
    contentSize: { width: size.width, height: size.height }, dpr, ...(reason ? { reason } : {}),
    limitation: "分片分别采集，仅包含各自采集时已渲染内容；嵌套滚动容器仅记录当前可见区域，不主动滚动或加载未渲染区域" }, { tabId, frameId, documentId });
}
function requestFullPageScreenshot(event, session) {
  const { tabId, frameId, documentId } = event;
  if (frameId !== 0 || !event.payload?.snapshotId) return;
  const capturePhase = event.payload.reason === "stop" ? "final" : "initial";
  const key = JSON.stringify([session.id, tabId, documentId, event.payload.url, capturePhase]);
  if (fullPageRequests.has(key)) return;
  fullPageRequests.add(key);
  const task = fullPageChain.then(async () => {
    const info = { captureRequestId: uid(), snapshotId: event.payload.snapshotId, snapshotEventId: event.id, url: event.payload.url, capturePhase };
    try {
      if (active !== session) return;
      await append("screenshot.fullPageStarted", info, { tabId, frameId, documentId });
      if (active !== session || !documentId) throw new Error("无法确认页面文档");
      const target = session.tabs[tabId];
      if (!target?.debuggerAttached) { const error = new Error("页面调试连接不可用"); error.retryable = true; throw error; }
      const tab = await chrome.tabs.get(tabId);
      if (!tab.active) { const error = new Error("目标标签不在前台"); error.retryable = true; throw error; }
      const activationVersion = tabActivationVersions.get(tab.windowId) || 0;
      const frame = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      if (!frame || frame.documentId !== documentId || frame.url !== event.payload.url)
        throw new Error("截图前页面已变化");
      const metrics = await withDeadline(chrome.debugger.sendCommand({ tabId }, "Page.getLayoutMetrics"), 5000, "整页尺寸读取");
      const size = metrics.cssContentSize;
      if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0)
        throw new Error("浏览器未提供有效的页面尺寸");
      const viewport = await chrome.tabs.sendMessage(tabId, { type: "VIEWPORT_INFO" }, { frameId: 0 });
      const dpr = viewport?.viewport?.dpr;
      if (!Number.isFinite(dpr) || dpr <= 0) throw new Error("无法确认设备像素比");
      if (size.width * size.height * dpr * dpr > 64000000) {
        await captureFullPageTiles({ tabId, frameId, documentId, session, info, size, dpr, windowId: tab.windowId, activationVersion });
        return;
      }
      const startedAt = Date.now();
      const result = await withDeadline(chrome.debugger.sendCommand({ tabId }, "Page.captureScreenshot", {
        format: "png", fromSurface: true, captureBeyondViewport: true,
        clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
      }), 5000, "整页截图");
      const finishedAt = Date.now();
      const after = await chrome.webNavigation.getFrame({ tabId, frameId: 0 });
      const afterTab = await chrome.tabs.get(tabId);
      if (active !== session || !afterTab.active || (tabActivationVersions.get(tab.windowId) || 0) !== activationVersion ||
          !after || after.documentId !== documentId || after.url !== event.payload.url)
        throw new Error("截图期间页面已变化");
      const binary = atob(result.data);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const blob = new Blob([bytes], { type: "image/png" });
      const bitmap = await createImageBitmap(blob);
      const pixelSize = { width: bitmap.width, height: bitmap.height };
      bitmap.close();
      const expectedHeight = pixelSize.width * size.height / size.width;
      if (!pixelSize.width || !pixelSize.height || Math.abs(pixelSize.height - expectedHeight) > Math.max(4, expectedHeight * 0.005))
        throw new Error("整页截图尺寸与页面范围不一致");
      const assetId = uid();
      if (active !== session) return;
      await put("assets", { id: assetId, sessionId: session.id, type: "screenshot", mime: "image/png", blob });
      if (active === session) await append("screenshot.fullPage", { ...info, status: "captured", assetId,
        mime: "image/png", contentSize: { width: size.width, height: size.height }, pixelSize, dpr,
        captureStartedAt: startedAt, capturedAt: finishedAt,
        limitation: "仅包含截图时已渲染内容；嵌套滚动容器仅记录当前可见区域，不主动滚动或加载未渲染区域" }, { tabId, frameId, documentId });
    } catch (error) {
      if (session.status === "preparing" || error?.retryable) fullPageRequests.delete(key);
      if (active === session) await append("screenshot.fullPage", { ...info, status: "unavailable", reason: String(error) },
        { tabId, frameId, documentId });
    }
  });
  fullPageChain = task.catch(() => {});
  track(task);
}
async function stop(onStopping) {
  await ensureReady();
  if (!active) throw new Error("没有正在录制的任务");
  const session = active;
  if (!["preparing", "recording"].includes(session.status))
    throw new Error("录制任务正在准备或停止，请稍候");
  const stoppedDuringPreparation = session.status === "preparing";
  session.status = "stopping";
  onStopping(session);
  session.stopRequestedAt = Date.now();
  if (stoppedDuringPreparation) {
    session.incomplete = true;
    session.notice = "录制在准备完成前停止，已保存可用的部分记录。";
  }
  const initial = initialPreparations.get(session.id);
  if (initial) await withDeadline(initial.catch(() => {}), 5000, "录制准备收尾");
  await put("sessions", session);
  await withDeadline(persistSessionState(session), 5000, "停止状态保存");
  const frameGroups = await Promise.all(Object.values(session.tabs).filter((target) => !target.closed).map(async (target) => {
    let frames;
    try {
      frames = await withDeadline(
        chrome.webNavigation.getAllFrames({ tabId: target.id }),
        5000,
        "页面状态检查",
      );
    } catch {
      const exists = await withDeadline(chrome.tabs.get(target.id), 2000, "标签检查").then(
        () => true,
        (error) => !String(error).includes("No tab with id"),
      );
      if (!exists) {
        target.closed = true;
        return [];
      }
      frames = [];
      session.incomplete = true;
      void warning("结束时无法枚举页面框架", { tabId: target.id });
    }
    return (frames || []).filter((frame) => allowedUrl(frame.url)).map((frame) => ({ tabId: target.id, frameId: frame.frameId }));
  }));
  const activeFrames = frameGroups.flat();
  await Promise.all(activeFrames.map(async (frame) => {
      try {
        const result = await withDeadline(
          chrome.tabs.sendMessage(
            frame.tabId,
            { type: "FLUSH", sessionId: session.id },
            { frameId: frame.frameId },
          ),
          12000,
          "页面状态收尾",
        );
        if (!result?.ok)
          throw new Error(
            `页面采集消息未确认：${result?.failedEvents || 0} 条`,
          );
      } catch (error) {
        session.incomplete = true;
        void warning("结束时无法取得页面最终状态", {
          tabId: frame.tabId,
          frameId: frame.frameId,
          error: String(error),
        });
      }
  }));
  if (screenshotTimer) {
    clearTimeout(screenshotTimer);
    screenshotTimer = null;
  }
  const screenshotDeadline = Date.now() + 5000;
  while (screenshotPending.length) {
    try {
      await withDeadline(capture(), Math.max(0, screenshotDeadline - Date.now()), "截图收尾");
    } catch {
      session.incomplete = true;
      screenshotPending = [];
      void warning("截图收尾超时，部分截图可能缺失");
      break;
    }
  }
  try {
    await withDeadline(Promise.allSettled([...pending]), 8000, "数据收尾");
  } catch {
    session.incomplete = true;
    void warning("数据收尾超时，部分记录可能缺失");
  }
  await withDeadline(writeChain, 10000, "记录写入收尾");
  await Promise.all(activeFrames.map(async (frame) => {
    try {
      await withDeadline(
        chrome.tabs.sendMessage(
          frame.tabId,
          { type: "STOP_CAPTURE", sessionId: session.id },
          { frameId: frame.frameId },
        ),
        2000,
        "采集器关闭",
      );
    } catch {
      session.incomplete = true;
      void warning("页面采集器未能正常关闭", frame);
    }
  }));
  if (session.droppedEvents)
    void warning("本地写入队列过载，部分记录未保存", {
      droppedEvents: session.droppedEvents,
    });
  await Promise.all(Object.values(session.tabs).filter((target) => !target.closed && target.debuggerAttached).map(async (target) => {
      try {
        await withDeadline(
          detachTab(target),
          3000,
          "调试连接关闭",
        );
      } catch {
        session.incomplete = true;
        void warning("调试连接未能正常关闭", { tabId: target.id });
      }
  }));
  networkSealed = true;
  try {
    await withDeadline(Promise.allSettled([...pending]), 2000, "网络收尾");
  } catch {
    session.incomplete = true;
    void warning("网络收尾超时，部分响应内容可能缺失");
  }
  await withDeadline(writeChain, 10000, "网络记录写入收尾");
  const finalRequests = [];
  for (const item of requests.values()) {
    if (item.finalized) continue;
    item.finalized = true;
    finalRequests.push(append("network.incomplete", {
      requestId: item.requestId,
      reason: item.loadingFinished ? "response_capture_incomplete" : "recording_stopped",
      responseReceived: Boolean(item.response),
    }, { tabId: item.tabId }));
  }
  await withDeadline(Promise.all(finalRequests), 10000, "未完成请求收尾");
  try {
    await withDeadline(chrome.scripting.unregisterContentScripts({ ids: [session.scriptId || "recorder"] }), 2000, "页面采集器清理");
  } catch {
    if (!session.scriptId || session.scriptRegistered) {
      session.incomplete = true;
      void warning("页面采集器注册未能清理");
    }
  }
  await append("session.stop", { note: "停止时仍在进行的请求可能不完整" });
  const markCoverageUnavailable = (error) => {
    session.incomplete = true;
    session.notice = "录制已停止，但记录完整性检查失败，已保存内容仍可导出。";
    session.coverage = { status: "unavailable", reason: String(error) };
  };
  let recorded;
  try {
    recorded = await withDeadline(all("events", session.id), 5000, "记录检查");
  } catch (error) {
    markCoverageUnavailable(error);
  }
  if (recorded) {
    try {
      const fragmentComplete = indexFragmentEvidence(recorded);
      const computedStyleComplete = indexComputedStyleEvidence(recorded);
      const databaseComplete = indexDatabaseEvidence(recorded, fragmentComplete);
      const databaseCatalogComplete = indexDatabaseCatalogEvidence(recorded, fragmentComplete);
      const cacheComplete = indexCacheEvidence(recorded, fragmentComplete);
      const cacheCatalogComplete = indexCacheCatalogEvidence(recorded, fragmentComplete);
      const canvasComplete = indexCanvasEvidence(recorded, fragmentComplete);
      const shadowComplete = indexShadowEvidence(recorded, fragmentComplete);
      const requestEntriesComplete = indexRequestEntryEvidence(recorded);
      session.coverage = {
        warnings: recorded.filter((event) => event.kind === "warning").length,
        frameScopeGaps: recorded.reduce((count, event) => count + (event.kind === "frame.tree"
          ? (event.payload.frames || []).filter((frame) => frame.scope === "outside_scope" || frame.errorOccurred).length
          : event.kind === "navigation.frameUnavailable" ? 1 : 0), 0),
        pendingRequests: recorded.filter((event) => event.kind === "network.incomplete").length,
        networkExtraGaps: recorded.filter((event) => event.kind === "network.extraInfoGap").length,
        requestEntryGaps: recorded.filter((event) => event.kind === "network.request" &&
          ((event.payload.postDataEntriesStatus === "pending" && !requestEntriesComplete(event)) ||
            (event.payload.hasRequestBody && event.payload.postDataEntriesStatus === "not_provided"))).length,
        cookieGaps: recorded.filter((event) => event.kind === "cookie.partitionSnapshot" && event.payload.status !== "captured").length,
        snapshotGaps: recorded.filter(
          (event) => event.kind === "page.snapshot" && (
            (event.payload.status === "fragmented"
              ? !fragmentComplete(event.payload.htmlReference) || !!event.payload.truncatedNodes
              : event.payload.status !== "captured") ||
            (event.payload.sourceStatus === "fragmented"
              ? !fragmentComplete(event.payload.sourceReference)
              : !!event.payload.sourceStatus && event.payload.sourceStatus !== "captured")),
        ).length,
        databaseGaps: recorded.filter(
          (event) => (event.kind === "database.catalog" && !databaseCatalogComplete(event)) || (event.kind === "database.snapshot" &&
            (event.payload.status || event.payload.database?.status !== "captured" ||
              event.payload.database?.storesTruncated ||
              (event.payload.graphCaptureId ? !databaseComplete(event.payload.graphCaptureId) :
                event.payload.database?.stores?.some((store) => store.truncated)))),
        ).length,
        cacheGaps: recorded.filter(
          (event) => (event.kind === "cache.catalog" && !cacheCatalogComplete(event)) ||
            (event.kind === "cache.snapshot" &&
            (event.payload.truncated || event.payload.status !== "captured" || !cacheComplete(event))) ||
            (event.kind === "cache.entry" && (event.payload.status !== "captured" ||
              (event.payload.body?.status === "fragmented" && !fragmentComplete(event.payload.body.reference)))) ||
            event.kind === "cache.entryFailure",
        ).length,
        stateCaptureGaps: recorded.filter((event) => event.kind === "state.capture" &&
          ["timeout", "failed"].includes(event.payload.status)).length,
        initialResourceGaps: recorded.filter(
          (event) => ["resource.initialSummary", "resource.loadedSummary"].includes(event.kind) && event.payload.status !== "captured",
        ).length,
        screenshotsUnavailable: recorded.filter(
          (event) =>
            event.kind === "screenshot" && event.payload.status === "unavailable",
        ).length,
        fullPageScreenshotGaps: countFullPageGaps(recorded),
        realtimePayloadGaps: countRealtimeGaps(recorded),
        shadowSourceGaps: recorded.filter((event) => event.kind === "page.snapshot" && event.payload.shadowSourceCaptureId && !shadowComplete(event)).length,
        interactionStyleGaps: countInteractionStyleGaps(recorded),
        interactionDescendantGaps: countInteractionDescendantGaps(recorded),
        canvasGaps: recorded.filter((event) => event.kind === "page.snapshot" &&
          (event.payload.snapshotId ? !canvasComplete(event.payload.snapshotId) :
          ((event.payload.canvas?.total > 0 && (event.payload.canvas.status !== "captured" ||
            event.payload.canvas.omitted > 0 || event.payload.canvas.unavailable > 0 || event.payload.canvas.geometryOmitted > 0)) ||
            event.payload.canvas?.scanTruncated))).length,
        canvasContextUnknown: recorded.filter((event) => event.kind === "canvas.capture" && event.payload.drawingContext === "unknown").length,
        popoverGaps: recorded.filter((event) =>
          (event.kind === "page.snapshot" && (event.payload.popover?.omitted || event.payload.popover?.unavailable || event.payload.popover?.scanTruncated)) ||
          (event.kind === "page.popover" && event.payload.status === "unavailable")).length,
        dialogGaps: recorded.filter((event) =>
          (event.kind === "page.snapshot" && (event.payload.dialog?.omitted || event.payload.dialog?.unavailable || event.payload.dialog?.scanTruncated)) ||
          (event.kind === "page.dialog" && event.payload.status === "unavailable")).length,
        inputGaps: recorded.filter(
          (event) => event.kind.startsWith("interaction.") &&
            (["truncated", "redacted_truncated"].includes(event.payload.valueStatus) ||
              ["truncated", "redacted_truncated"].includes(event.payload.beforeValueStatus) ||
              (event.payload.valueStatus === "fragmented" && !fragmentComplete(event.payload.valueReference)) ||
              (event.payload.beforeValueStatus === "fragmented" && !fragmentComplete(event.payload.beforeValueReference)) ||
              (event.payload.formState?.status === "fragmented" && !fragmentComplete(event.payload.formState.reference)) ||
              (event.payload.beforeFormState?.status === "fragmented" && !fragmentComplete(event.payload.beforeFormState.reference)) ||
              event.payload.files?.some((file) => file.contentStatus === "fragmented" && !fragmentComplete(file.contentReference))),
        ).length,
        storageGaps: recorded.filter(
          (event) => event.kind === "storage.unavailable" ||
            (event.kind === "storage.snapshot" &&
              ((event.payload.storageStatus === "fragmented" && !fragmentComplete(event.payload.storageReference)) ||
                (event.payload.coverage && Object.values(event.payload.coverage).some((item) => item?.status !== "captured")))),
        ).length,
        mutationGaps: recorded.filter((event) => event.kind === "page.mutation" &&
          (event.payload.status !== "captured" || !rawMutationComplete(event, fragmentComplete))).length,
        styleGaps: recorded.filter(
          (event) =>
            (event.kind === "page.stylesheet" && (event.payload.status === "fragmented"
              ? !fragmentComplete(event.payload.cssReference) : event.payload.status !== "captured")) ||
            event.kind === "page.snapshot" &&
            ((event.payload.snapshotId && !computedStyleComplete(event.payload.snapshotId)) ||
              event.payload.styles?.unavailable > 0 ||
              event.payload.styles?.truncated ||
              event.payload.styles?.backgroundUnavailable > 0 ||
              event.payload.styles?.backgroundTruncated ||
              event.payload.scroll?.truncated ||
              (event.payload.scroll?.status === "fragmented" && !fragmentComplete(event.payload.scroll.reference)) ||
              event.payload.shadow?.roots > 0 ||
              event.payload.shadow?.truncated ||
              event.payload.shadow?.unavailable),
        ).length,
        fontGaps: recorded.filter((event) => event.kind === "page.fonts" &&
          (event.payload.status !== "captured" || (event.payload.facesStatus === "fragmented" && !fragmentComplete(event.payload.reference)))).length,
        responseGaps: recorded.filter(
          (event) =>
            event.kind === "network.finished" &&
            (["unavailable", "omitted_size", "omitted_encoding", "omitted_unparseable", "omitted_redirect"].includes(
              event.payload.body?.status,
            ) || Boolean(event.payload.body?.textStatus)),
        ).length,
      };
    } catch (error) {
      markCoverageUnavailable(error);
    }
  }
  const status = session.storageError || session.incomplete ? "interrupted" : "ready";
  const endedAt = Date.now();
  await put("sessions", { ...session, status, endedAt });
  currentOrigin = null;
  requests.clear();
  childScopes.clear();
  childTargets.clear();
  childDocuments.clear();
  socketScopes.clear();
  unknownSocketTabs.clear();
  unknownRequestTabs.clear();
  unknownDialogTabs.clear();
  dialogScopes.clear();
  screenshotChain = Promise.resolve();
  fullPageChain = Promise.resolve();
  fullPageRequests.clear();
  await withDeadline(chrome.action.setBadgeText({ text: "" }), 2000, "录制标记清理").catch(() => {});
  await withDeadline(chrome.action.setTitle({ title: "打开逻辑记录" }), 2000, "录制标题清理").catch(() => {});
  await withDeadline(childStorageChain, 2000, "框架恢复信息收尾").catch(() => {});
  await withDeadline(removeSessionState(session), 2000, "录制状态清理");
  session.status = status;
  session.endedAt = endedAt;
  active = null;
  return session;
}

async function saveInterruption(session, reason) {
  const item = { session, reason };
  pendingInterruptions.set(session.id, item);
  const saved = await interruptSession(session, reason);
  if (pendingInterruptions.get(session.id) === item) pendingInterruptions.delete(session.id);
  return saved;
}
function retryInterruptions() {
  if (!interruptionRetry) {
    const retry = (async () => {
      for (const [id, item] of pendingInterruptions) {
        await interruptSession(item.session, item.reason);
        if (pendingInterruptions.get(id) === item) pendingInterruptions.delete(id);
      }
    })();
    interruptionRetry = retry;
    retry.finally(() => { if (interruptionRetry === retry) interruptionRetry = undefined; }).catch(() => {});
  }
  return interruptionRetry;
}
function interruptionFailure(saveError, failures) {
  const messages = [];
  if (saveError) messages.push(`无法更新本地批次：${String(saveError)}`);
  if (failures.length) messages.push(`部分清理未能确认：${[...new Set(failures)].join("、")}`);
  return messages.length ? new Error(`已请求停止，但${messages.join("；")}`) : null;
}
async function interrupt(session, reason) {
  if (!session || active?.id !== session.id) return;
  session.status = "interrupted";
  session.interruptedAt = Date.now();
  session.notice = reason;
  let saveError;
  try { await saveInterruption(session, reason); } catch (error) { saveError = error; }
  const failures = [];
  await clearActiveResources(session, (stage, error) => {
    failures.push(stage);
    console.warn(`${stage}失败`, error);
  });
  writeChain = Promise.resolve();
  pending.clear();
  const failure = interruptionFailure(saveError, failures);
  if (failure) throw failure;
}

async function clearActiveResources(session, onFailure = (stage, error) => console.warn(`${stage}失败`, error)) {
  if (screenshotTimer) clearTimeout(screenshotTimer);
  screenshotTimer = null;
  screenshotPending = [];
  await Promise.all(Object.values(session.tabs || {}).map(async (target) => {
    let frames;
    let enumerateFailed = false;
    try {
      frames = await withDeadline(chrome.webNavigation.getAllFrames({ tabId: target.id }), 5000, "页面框架检查");
    } catch (error) {
      if (!/No tab with id/i.test(String(error))) {
        enumerateFailed = true;
        onFailure("页面框架检查", error);
      }
    }
    const eligible = (frames || []).filter((frame) => allowedUrl(frame.url));
    const destinations = enumerateFailed ? [null] : eligible;
    await Promise.all(destinations.map(async (frame) => {
      try {
        const response = await withDeadline(chrome.tabs.sendMessage(target.id,
          { type: "STOP_CAPTURE", sessionId: session.id }, ...(frame ? [{ frameId: frame.frameId }] : [])), 2000, "采集器关闭");
        if (!response?.ok) throw new Error("页面采集器未确认关闭");
      } catch (error) {
        if (!/Receiving end does not exist|No tab with id/i.test(String(error))) onFailure("采集器关闭", error);
      }
    }));
    if (target.debuggerAttached)
      await withDeadline(detachTab(target), 3000, "调试连接关闭").catch((error) => onFailure("调试连接关闭", error));
  }));
  await withDeadline(chrome.scripting
    .unregisterContentScripts({ ids: [session.scriptId || "recorder"] }), 2000, "页面采集器清理")
    .catch((error) => { if (session.scriptRegistered) onFailure("页面采集器清理", error); });
  currentOrigin = null;
  requests.clear();
  childScopes.clear();
  childTargets.clear();
  childDocuments.clear();
  socketScopes.clear();
  unknownSocketTabs.clear();
  unknownRequestTabs.clear();
  unknownDialogTabs.clear();
  dialogScopes.clear();
  screenshotChain = Promise.resolve();
  fullPageChain = Promise.resolve();
  fullPageRequests.clear();
  await withDeadline(childStorageChain, 2000, "框架恢复信息清理").catch((error) => onFailure("框架恢复信息清理", error));
  await withDeadline(removeSessionState(session), 2000, "录制状态清理").catch((error) => onFailure("录制状态清理", error));
  if (active === session) active = null;
  await withDeadline(chrome.action.setBadgeText({ text: "" }), 2000, "录制标记清理").catch((error) => onFailure("录制标记清理", error));
  await withDeadline(chrome.action.setTitle({ title: "打开逻辑记录" }), 2000, "录制标题清理").catch((error) => onFailure("录制标题清理", error));
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    if (message.type === "GET_STATUS" && active)
      return { active: { id: active.id, status: active.status } };
    if (message.type === "STOP") {
      if (stopInFlight) throw new Error("录制任务正在停止，请稍候");
      stopInFlight = true;
      try {
        try {
          await ensureReady();
        } catch (error) {
          const cleanup = (async () => {
            let session = active;
            if (!session && message.sessionId) {
              session = await withDeadline(get("sessions", message.sessionId), 5000, "录制批次读取");
              if (!session || !["preparing", "recording", "stopping"].includes(session.status)) throw error;
              const sessions = await withDeadline(all("sessions"), 5000, "录制批次核对");
              if (!canRecoverSession(session, sessions))
                throw new Error("无法确认当前录制批次，请等待后台状态恢复后重试");
              active = session;
            }
            if (!session || (message.sessionId && message.sessionId !== session.id)) throw error;
            if (!["preparing", "recording", "stopping"].includes(session.status)) throw error;
            session.status = "stopping";
            let saved, saveError;
            try {
              saved = await saveInterruption(session, "后台恢复失败，录制已中断；已保存的数据可供导出。");
            } catch (reason) { saveError = reason; }
            const cleanupFailures = [];
            await clearActiveResources(session, (stage, reason) => {
              cleanupFailures.push(stage);
              console.warn(`${stage}失败`, reason);
            });
            writeChain = Promise.resolve();
            pending.clear();
            const failure = interruptionFailure(saveError, cleanupFailures);
            if (failure) throw failure;
            return saved;
          })();
          recoveryCleanup = cleanup;
          try { return await cleanup; }
          finally { if (recoveryCleanup === cleanup) recoveryCleanup = undefined; }
        }
        if (message.sessionId && active?.id !== message.sessionId)
          throw new Error("录制状态已变化，请刷新后重试");
        let stopping;
        try {
          return await stop((session) => { stopping = session; });
        } catch (error) {
          if (stopping && active === stopping)
            await interrupt(stopping, "录制异常结束，已保存可用的部分记录");
          throw error;
        }
      } finally { stopInFlight = false; }
    }
    await ensureReady();
    if (message.type === "GET_STATUS")
      return { active: active ? { id: active.id, status: active.status } : null };
    if (message.type === "GET_STATE")
      return {
        active,
        sessions: (await withDeadline(retryInterruptions().then(() => all("sessions")), 6000, "录制批次读取")).sort(
          (a, b) => b.startedAt - a.startedAt,
        ),
      };
    if (message.type === "START") {
      if (message.acknowledgeEarly) {
        let created, resolveStart, rejectStart;
        const acknowledged = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
        const preparation = start(message.tab, message.options || {}, (session) => {
          created = session;
          resolveStart({ id: session.id });
        }).catch(async (error) => {
          if (created && active === created && ["preparing", "recording"].includes(created.status))
            await interrupt(created, "录制准备失败，已保存可用的部分记录");
          if (!created) rejectStart(error);
        });
        track(preparation);
        return acknowledged;
      }
      let created;
      try {
        return await start(message.tab, message.options || {}, (session) => {
          created = session;
        });
      } catch (error) {
        if (created && active === created && ["preparing", "recording"].includes(created.status))
          await interrupt(created, "录制准备失败，已保存可用的部分记录");
        throw error;
      }
    }
    if (message.type === "DELETE") {
      if (active?.id === message.id) throw new Error("无法删除正在录制的任务");
      await withSessionLock(message.id, "exclusive", () => removeSession(message.id));
      return true;
    }
    if (message.type === "CANVAS_OPTIONS") {
      if (!active || !active.tabs[sender.tab?.id] || !allowedUrl(sender.url) ||
          !["preparing", "recording"].includes(active.status)) return { enabled: false };
      return { enabled: active.options?.canvasSnapshots === true, sessionId: active.id };
    }
    if (["COLLECTOR_OVERFLOW", "COLLECTOR_UNRESPONSIVE"].includes(message.type)) {
      if (!active || message.sessionId !== active.id || !active.tabs[sender.tab?.id] ||
          !allowedUrl(sender.url) || !["preparing", "recording", "stopping"].includes(active.status)) return false;
      const session = active;
      const overflow = message.type === "COLLECTOR_OVERFLOW";
      const key = overflow ? "collectorQueueOverflow" : "collectorUnresponsive";
      if (!session[key]) {
        session[key] = true;
        session.incomplete = true;
        chrome.action.setBadgeText({ text: "!" }).catch(() => {});
        await warning(overflow ? "页面事件发送队列已满，部分事件未保存" : "页面事件通信未确认，部分记录可能缺失", { tabId: sender.tab.id, frameId: sender.frameId });
        if (active === session) await persistSessionState(session).catch(() => {});
      }
      return true;
    }
    if (message.type === "EVENTS") {
      if (
        !active ||
        message.sessionId !== active.id ||
        !active.tabs[sender.tab?.id] ||
        !["preparing", "recording", "stopping"].includes(active.status)
      )
        return false;
      const origin = (() => {
        try {
          return new URL(sender.url).origin;
        } catch {
          return null;
        }
      })();
      if (!allowedUrl(origin)) return false;
      if (!Array.isArray(message.events) || message.events.length > 100 ||
          (message.batchId != null && (typeof message.batchId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.batchId)))) return false;
      const session = active;
      const { events, results } = await appendPageBatch(message.events, sender, session, message.batchId);
      const accepted = results.filter((result) => result === "created" || result === "existing").length;
      if (active === session && session.options.screenshots)
        for (let index = 0; index < events.length; index++) {
          if (results[index] === "created" && message.events[index].screenshot)
            requestScreenshot(events[index].id, sender.tab.id, sender.frameId, sender.documentId, events[index].payload.url);
          if (results[index] === "created" && events[index].kind === "page.snapshot")
            requestFullPageScreenshot(events[index], session);
        }
      if (active === session && session.options.screenshots && !session.retryScreenshotGap &&
          results.some((result, index) => result === "existing" && message.events[index].screenshot)) {
        session.retryScreenshotGap = true;
        track(warning("重试前已保存的操作可能缺少截图，请检查截图记录"));
      }
      return { accepted, failed: message.events.length - accepted };
    }
    return null;
  })()
    .then((value) => reply({ ok: true, value }))
    .catch((error) =>
      reply({ ok: false, error: String(error.message || error) }),
    );
  return true;
});

chrome.debugger.onEvent.addListener(
  afterReady((source, method, params) => {
    if (!active || !active.tabs[source.tabId]) return;
    if (method === "Target.detachedFromTarget") {
      childScopes.delete(params.sessionId);
      childDocuments.delete(params.sessionId);
      if (childTargets.delete(params.sessionId)) persistChildTargets();
      dialogScopes.delete(`${source.tabId}:${params.sessionId}`);
      for (const [id, item] of socketScopes)
        if (item.tabId === source.tabId && item.sessionId === params.sessionId)
          socketScopes.delete(id);
      return;
    }
    if (method === "Target.attachedToTarget") {
      if (active.status === "stopping") return;
      const child = { tabId: source.tabId, sessionId: params.sessionId };
      childDocuments.set(params.sessionId, { frameId: params.targetInfo.targetId, loaderId: null, url: params.targetInfo.url });
      setChildScope(params.sessionId, source.tabId, allowedUrl(params.targetInfo?.url));
      const sessionId = active.id;
      const task = (async () => {
        try {
          await chrome.debugger.sendCommand(child, "Network.enable", {
            maxTotalBufferSize: NETWORK_TOTAL_BUFFER_BYTES,
            maxResourceBufferSize: NETWORK_RESOURCE_BUFFER_BYTES,
            maxPostDataSize: 65536,
          });
          await chrome.debugger.sendCommand(child, "Page.enable");
          await enableChildTargets(child);
          const before = childDocuments.get(params.sessionId);
          try {
            const tree = await withDeadline(chrome.debugger.sendCommand(child, "Page.getFrameTree"), 1500, "框架实例检查");
            const frame = tree?.frameTree?.frame;
            if (before && childDocuments.get(params.sessionId) === before && frame?.id === before.frameId) {
              childDocuments.set(params.sessionId, { frameId: frame.id, loaderId: frame.loaderId, url: frame.url });
              setChildScope(params.sessionId, source.tabId, allowedUrl(frame.url));
            }
          } catch {}
          if (active?.id === sessionId && childScopes.get(params.sessionId))
            await append("frame.attached", {
              tabId: source.tabId,
              protocolSessionId: params.sessionId,
              url: cleanUrl(childDocuments.get(params.sessionId)?.url),
              note: "连接前的请求可能未记录",
            });
        } catch (error) {
          if (active?.id === sessionId)
            await warning("嵌入页面网络采集失败", {
              tabId: source.tabId,
              error: String(error),
            });
        }
      })();
      track(task);
      return;
    }
    if (
      method === "Page.javascriptDialogOpening" &&
      active.status === "recording"
    ) {
      const dialogKey = `${source.tabId}:${source.sessionId || "root"}`;
      const inScope =
        active.tabs[source.tabId].inScope &&
        (!source.sessionId || childScopes.get(source.sessionId)) &&
        allowedUrl(params.url);
      if (
        active.tabs[source.tabId].inScope &&
        (!source.sessionId || childScopes.get(source.sessionId)) &&
        !isHttpUrl(params.url) &&
        !unknownDialogTabs.has(source.tabId)
      ) {
        unknownDialogTabs.add(source.tabId);
        track(warning("对话框来源页面无法确认，未采集该对话框", {
          tabId: source.tabId,
        }));
      }
      dialogScopes.set(dialogKey, inScope);
      if (inScope)
        track(
          append(
            "dialog.open",
            {
              type: params.type,
              message: params.message || "",
              url: cleanUrl(params.url || ""),
            },
            { tabId: source.tabId },
          ),
        );
      return;
    }
    if (
      method === "Page.javascriptDialogClosed" &&
      active.status === "recording"
    ) {
      const dialogKey = `${source.tabId}:${source.sessionId || "root"}`;
      const inScope = dialogScopes.get(dialogKey);
      dialogScopes.delete(dialogKey);
      if (
        inScope && active.tabs[source.tabId].inScope &&
        (!source.sessionId || childScopes.get(source.sessionId))
      )
        track(
          append(
            "dialog.closed",
            { accepted: params.result, userInput: params.userInput ?? null },
            { tabId: source.tabId },
          ),
        );
      return;
    }
    if (method === "Page.frameNavigated" && source.sessionId) {
      const current = childDocuments.get(source.sessionId), frame = params.frame;
      if (current && frame?.id === current.frameId) {
        childDocuments.set(source.sessionId, { frameId: frame.id, loaderId: frame.loaderId, url: frame.url });
        setChildScope(source.sessionId, source.tabId, allowedUrl(frame.url));
      }
      return;
    }
    if (!method.startsWith("Network.") || networkSealed) return;
    if (
      active.status === "stopping" &&
      ![
        "Network.responseReceived",
        "Network.loadingFinished",
        "Network.loadingFailed",
        "Network.requestWillBeSentExtraInfo",
        "Network.responseReceivedExtraInfo",
      ].includes(method)
    )
      return;
    const target = active.tabs[source.tabId],
      rawRequestId = params.requestId,
      requestId = `${source.tabId}:${source.sessionId || "root"}:${rawRequestId}`;
    if (["Network.requestWillBeSentExtraInfo", "Network.responseReceivedExtraInfo"].includes(method)) {
      if (active.options?.scope === "browser" && target?.inScope && (!source.sessionId || childScopes.get(source.sessionId))) {
        track(append(method === "Network.requestWillBeSentExtraInfo" ? "network.requestExtraInfo" : "network.responseExtraInfo", {
          protocolRequestKey: requestId, protocolRequestId: rawRequestId, protocolSessionId: source.sessionId || null,
          correlation: "protocol_id_only", details: params,
        }, { tabId: source.tabId }));
      } else if (!active.extraInfoGapReported) {
        active.extraInfoGapReported = true;
        track(append("network.extraInfoGap", { reason: "scope_unconfirmed" }, { tabId: source.tabId }));
      }
      return;
    }
    if (method === "Network.requestWillBeSent") {
      const previous = params.redirectResponse && requests.get(requestId);
      if (previous) {
        previous.superseded = true;
        previous.finalized = true;
        const response = params.redirectResponse;
        track(
          append(
            "network.response",
            {
              requestId: previous.requestId,
              url: cleanUrl(response.url),
              status: response.status,
              mimeType: response.mimeType,
              headers: cleanHeaders(response.headers, response.url),
              fromDiskCache: response.fromDiskCache,
              fromServiceWorker: response.fromServiceWorker,
              protocolResponse: response,
              redirectHasExtraInfo: params.redirectHasExtraInfo ?? null,
            },
            { tabId: source.tabId },
          ),
        );
        track(
          append(
            "network.finished",
            {
              requestId: previous.requestId,
              body: { value: null, status: "omitted_redirect" },
            },
            { tabId: source.tabId },
          ),
        );
        requests.delete(requestId);
      }
      if (
        !source.sessionId &&
        params.type === "Document" &&
        params.frameId === target.mainFrameId
      ) {
        target.inScope = allowedUrl(params.request.url);
      }
      if (source.sessionId && params.type === "Document")
        setChildScope(source.sessionId, source.tabId, allowedUrl(params.request.url));
      const isMainFrame = Boolean(
        params.frameId && target.mainFrameId && params.frameId === target.mainFrameId,
      );
      const unknownDocument = params.documentURL
        ? !isHttpUrl(params.documentURL)
        : !isMainFrame;
      if (
        target.inScope && unknownDocument &&
        (!source.sessionId || childScopes.get(source.sessionId)) &&
        !unknownRequestTabs.has(source.tabId)
      ) {
        unknownRequestTabs.add(source.tabId);
        track(warning("部分请求来源页面无法确认，未采集这些请求", {
          tabId: source.tabId,
        }));
      }
      if (
        !target.inScope ||
        (source.sessionId && !childScopes.get(source.sessionId)) ||
        (params.documentURL && !allowedUrl(params.documentURL)) ||
        (params.type === "Document" && !isMainFrame &&
          !allowedUrl(params.request.url)) ||
        (!params.documentURL && !isMainFrame)
      )
        return;
      const req = params.request;
      const ct =
        Object.entries(req.headers || {}).find(
          ([k]) => k.toLowerCase() === "content-type",
        )?.[1] || "";
      const initialBody = cleanBody(req.postData, ct);
      const { postData: _postData, postDataEntries: _postDataEntries, ...protocolRequest } = req;
      const item = {
        requestId: previous ? `${requestId}:redirect:${uid()}` : requestId,
        protocolRequestId: rawRequestId,
        protocolRequestKey: requestId,
        ...(previous ? { redirectFrom: previous.requestId } : {}),
        tabId: source.tabId,
        protocolSessionId: source.sessionId || null,
        url: cleanUrl(req.url),
        method: req.method,
        headers: cleanHeaders(req.headers, req.url),
        postData: (req.hasPostData && req.postData == null) || initialBody.status === "omitted_size"
          ? { value: null, status: "pending" }
          : initialBody,
        ...(/^multipart\/form-data/i.test(ct) ? { requestBodyLimitations: ["browser_may_omit_file_content"] } : {}),
        type: params.type,
        frameId: params.frameId,
        documentUrl: params.documentURL ? cleanUrl(params.documentURL) : null,
        sourceFrame: source.sessionId ? "embedded" : params.frameId && target.mainFrameId === params.frameId ? "main" : "unknown",
        initiator: params.initiator || null,
        protocolRequest,
        postDataEntriesStatus: Array.isArray(req.postDataEntries) ? "pending" : "not_provided",
        hasRequestBody: req.hasPostData === true || typeof req.postData === "string" || Array.isArray(req.postDataEntries),
        ...(Array.isArray(req.postDataEntries) ? { postDataEntriesCount: req.postDataEntries.length } : {}),
        loaderId: params.loaderId || null,
        timestamp: params.timestamp,
        wallTime: params.wallTime ?? null,
      };
      requests.set(requestId, item);
      track(append("network.request", item, { tabId: source.tabId }));
      if (Array.isArray(req.postDataEntries)) {
        const sessionId = active.id;
        track((async () => {
          const entries = [];
          for (let index = 0; index < req.postDataEntries.length; index++) {
            const entry = req.postDataEntries[index];
            if (!entry || typeof entry !== "object") { entries.push({ index, status: "unavailable" }); continue; }
            const { bytes, ...metadata } = entry;
            if (typeof bytes !== "string") { entries.push({ index, metadata, status: "unavailable" }); continue; }
            try {
              const captured = responseBlob({ body: bytes, base64Encoded: true }, "application/octet-stream");
              const id = uid();
              if (active?.id !== sessionId) return;
              await put("assets", { id, sessionId, type: "resource", mime: "application/octet-stream", blob: captured.blob });
              entries.push({ index, metadata, status: "captured", assetId: id, size: captured.blob.size });
            } catch (error) { entries.push({ index, metadata, status: "unavailable", reason: String(error) }); }
          }
          if (active?.id === sessionId) await append("network.requestDataEntries", { requestId: item.requestId,
            entries, status: entries.some((entry) => entry.status !== "captured") ? "partial" : "captured",
            coverage: "browser_provided_entries_only" }, { tabId: source.tabId });
        })());
      }
      if (item.postData.status === "pending") {
        const sessionId = active.id;
        const debugSession = source.sessionId
          ? { tabId: source.tabId, sessionId: source.sessionId }
          : { tabId: source.tabId };
        track(
          (async () => {
            let body;
            try {
              const result = initialBody.status === "omitted_size"
                ? { postData: req.postData, base64Encoded: false }
                : await withDeadline(
                    chrome.debugger.sendCommand(debugSession, "Network.getRequestPostData", { requestId: rawRequestId }),
                    5000, "请求体读取",
                  );
              if (item.superseded)
                throw new Error("请求已重定向，无法确认请求体归属");
              if (result.postData.length > 1000000) {
                const captured = responseBlob({ body: result.postData, base64Encoded: result.base64Encoded }, ct.split(";")[0]);
                const id = uid();
                if (active?.id !== sessionId) return;
                await put("assets", { id, sessionId, type: "resource", mime: captured.blob.type || "application/octet-stream", blob: captured.blob });
                body = { value: null, status: "captured_asset", assetId: id, size: captured.blob.size,
                  representation: captured.representation, encoding: captured.encoding,
                  ...(/^multipart\/form-data/i.test(ct) ? { fileContent: "browser_may_omit" } : {}) };
              } else {
                const text = result.base64Encoded
                  ? new TextDecoder("utf-8", { fatal: true }).decode(
                      Uint8Array.from(atob(result.postData), (char) =>
                        char.charCodeAt(0),
                      ),
                    )
                  : result.postData;
                body = cleanBody(text, ct);
              }
            } catch (error) {
              body = {
                value: null,
                status: "unavailable",
                reason: String(error),
              };
            }
            if (active?.id === sessionId)
              await append(
                "network.requestBody",
                { requestId: item.requestId, body },
                { tabId: source.tabId },
              );
          })(),
        );
      }
    } else if (method === "Network.responseReceived") {
      if (!requests.has(requestId)) return;
      const response = params.response;
      const item = requests.get(requestId) || {};
      item.response = {
        url: cleanUrl(response.url),
        status: response.status,
        mimeType: response.mimeType,
        headers: cleanHeaders(response.headers, response.url),
        fromDiskCache: response.fromDiskCache,
        fromServiceWorker: response.fromServiceWorker,
        protocolResponse: response,
        timestamp: params.timestamp,
      };
      requests.set(requestId, item);
      track(
        append(
          "network.response",
          { requestId: item.requestId, ...item.response },
          { tabId: source.tabId },
        ),
      );
    } else if (method === "Network.eventSourceMessageReceived") {
      const item = requests.get(requestId);
      if (!item) return;
      track(
        appendRealtime(
          "network.eventSourceMessage",
          {
            requestId: item.requestId,
            eventName: String(params.eventName || ""),
            eventId: String(params.eventId || ""),
            timestamp: params.timestamp,
            data: cleanRealtimeText(params.data),
          },
          params.data,
          "text",
          { tabId: source.tabId },
        ),
      );
    } else if (method === "Network.loadingFinished") {
      const item = requests.get(requestId);
      if (!item || item.loadingFinished || item.finalized) return;
      item.loadingFinished = true;
      const tabId = source.tabId,
        finishedAt = Date.now(),
        sessionId = active.id,
        debugSession = source.sessionId
          ? { tabId, sessionId: source.sessionId }
          : { tabId };
      const task = (async () => {
        let body = { value: null, status: "omitted_type" },
          assetId = null, responseResult = null;
        const mime = item.response?.mimeType || "";
        if (item.type === "Font" || /^image\//i.test(mime)) {
          try {
            const result = await chrome.debugger.sendCommand(debugSession, "Network.getResponseBody", { requestId: rawRequestId });
            const captured = responseBlob(result, mime);
            const fontType = item.type === "Font" && result.base64Encoded
              ? fontMime(new Uint8Array(await captured.blob.slice(0, 12).arrayBuffer())) : null;
            const assetMime = fontType || captured.blob.type || "application/octet-stream";
            assetId = uid();
            if (active?.id !== sessionId || item.finalized) return;
            await put("assets", { id: assetId, sessionId, type: "resource", mime: assetMime, blob: captured.blob });
            body = { value: null, status: "captured_asset", assetId, size: captured.blob.size,
              representation: captured.representation, encoding: captured.encoding };
          } catch (error) {
            body = { value: null, status: "unavailable", reason: String(error) };
          }
        } else if (
          /json|x-www-form-urlencoded|^text\/|javascript|xml|graphql/i.test(
            mime,
          )
        ) {
          try {
            const result = await chrome.debugger.sendCommand(
              debugSession,
              "Network.getResponseBody",
              { requestId: rawRequestId },
            );
            responseResult = result;
            body = cleanDebuggerResponse(result, item.response, item.method);
          } catch (error) {
            body = {
              value: null,
              status: "unavailable",
              reason: String(error),
            };
          }
        } else {
          try {
            const result = await chrome.debugger.sendCommand(debugSession, "Network.getResponseBody", { requestId: rawRequestId });
            responseResult = result;
            body = cleanDebuggerResponse(result, item.response, item.method);
          } catch (error) {
            body = { value: null, status: "unavailable", reason: String(error) };
          }
        }
        if (body.status === "omitted_size" || body.textStatus === "omitted_size") {
          try {
            const captured = responseBlob(responseResult, mime);
            const id = uid();
            if (active?.id !== sessionId || item.finalized) return;
            await put("assets", { id, sessionId, type: "resource", mime: captured.blob.type || "application/octet-stream", blob: captured.blob });
            assetId = id;
            body = { value: null, status: "captured_asset", assetId: id, size: captured.blob.size,
              representation: captured.representation, encoding: captured.encoding };
          } catch (error) {
            body = { value: null, status: "unavailable", reason: String(error), previousStatus: "omitted_size" };
          }
        }
        if (active?.id === sessionId && !item.finalized) {
          item.finalized = true;
          await append(
            "network.finished",
            {
              requestId: item.requestId,
              encodedDataLength: params.encodedDataLength,
              protocolTimestamp: params.timestamp,
              body,
              assetId,
            },
            { tabId, time: finishedAt },
          );
        }
        if (active?.id === sessionId && requests.get(requestId) === item)
          requests.delete(requestId);
      })();
      track(task);
    } else if (method === "Network.loadingFailed") {
      const item = requests.get(requestId);
      if (!item || item.finalized) return;
      item.finalized = true;
      track(
        append(
          "network.failed",
          {
            requestId: item.requestId,
            errorText: params.errorText,
            canceled: params.canceled,
            protocolDetails: params,
          },
          { tabId: source.tabId },
        ),
      );
      requests.delete(requestId);
    } else if (method === "Network.webSocketCreated") {
      if (
        !target.inScope ||
        (source.sessionId && !childScopes.get(source.sessionId))
      )
        return;
      socketScopes.set(requestId, {
        tabId: source.tabId,
        sessionId: source.sessionId || null,
        url: cleanUrl(params.url || ""),
        createdAt: Date.now(),
        allowed: false,
        frameDocument: source.sessionId ? childDocuments.get(source.sessionId) : null,
      });
    } else if (method === "Network.webSocketWillSendHandshakeRequest") {
      const socket = socketScopes.get(requestId);
      if (!socket) return;
      const origin = Object.entries(params.request?.headers || {}).find(
        ([name]) => name.toLowerCase() === "origin",
      )?.[1];
      if (typeof origin !== "string" || !origin || origin === "null") {
        if (!unknownSocketTabs.has(source.tabId)) {
          unknownSocketTabs.add(source.tabId);
          track(warning("WebSocket 来源无法确认，未采集该连接", {
            tabId: source.tabId,
          }));
        }
        return;
      }
      if (
        !target.inScope || !allowedUrl(origin) ||
        (source.sessionId && !childScopes.get(source.sessionId))
      ) {
        return;
      }
      socket.allowed = true;
      const frameDocument = source.sessionId ? childDocuments.get(source.sessionId) : null;
      let frameContext = {};
      try {
        if (frameDocument?.loaderId && frameDocument.loaderId === socket.frameDocument?.loaderId &&
            frameDocument.frameId === socket.frameDocument.frameId && allowedUrl(frameDocument.url) &&
            new URL(frameDocument.url).origin === new URL(origin).origin)
          frameContext = { frameLoaderId: frameDocument.loaderId, frameUrl: cleanUrl(frameDocument.url) };
      } catch {}
      track(
        append(
          "network.websocket",
          {
            requestId,
            type: "webSocketCreated",
            url: socket.url,
            ...frameContext,
          },
          { tabId: source.tabId, time: socket.createdAt },
        ),
      );
    } else if (method === "Network.webSocketClosed") {
      const socket = socketScopes.get(requestId);
      socketScopes.delete(requestId);
      if (
        socket?.allowed && target.inScope &&
        (!source.sessionId || childScopes.get(source.sessionId))
      )
        track(append("network.websocket", {
          requestId, type: "webSocketClosed", url: "",
        }, { tabId: source.tabId }));
    } else if (
      method === "Network.webSocketFrameReceived" ||
      method === "Network.webSocketFrameSent"
    ) {
      if (
        target.inScope && !socketScopes.has(requestId) &&
        (!source.sessionId || childScopes.get(source.sessionId)) &&
        !unknownSocketTabs.has(source.tabId)
      ) {
        unknownSocketTabs.add(source.tabId);
        track(warning("WebSocket 来源无法确认，未采集该连接", {
          tabId: source.tabId,
        }));
      }
      if (
        !target.inScope || !socketScopes.get(requestId)?.allowed ||
        (source.sessionId && !childScopes.get(source.sessionId))
      )
        return;
      track(
        appendRealtime(
          "network.websocketFrame",
          {
            requestId,
            direction: method.endsWith("Sent") ? "sent" : "received",
            opcode: params.response?.opcode,
            data: cleanWebSocketFrame(
              params.response?.payloadData,
              params.response?.opcode,
            ),
          },
          params.response?.payloadData,
          params.response?.opcode === 1 ? "text" : "base64",
          { tabId: source.tabId },
        ),
      );
    }
  }),
);
chrome.debugger.onDetach.addListener(
  afterReady((source, reason) => {
    clearTabContexts(source.tabId);
    if (active?.tabs[source.tabId] && active.status === "recording") {
      active.tabs[source.tabId].debuggerAttached = false;
      if (reason !== "target_closed" && !active.tabs[source.tabId].closed)
        track(warning("网络调试连接中断", { tabId: source.tabId, reason }));
    }
  }),
);
chrome.tabs.onCreated.addListener(
  afterReady((tab) => {
    if (
      !active ||
      (active.options.scope !== "browser" && !active.tabs[tab.openerTabId]) ||
      !["preparing", "recording"].includes(active.status) ||
      tab.incognito
    )
      return;
    if (active.tabs[tab.id]) return;
    active.tabs[tab.id] = {
      id: tab.id,
      windowId: tab.windowId,
      inScope: false,
      openerTabId: tab.openerTabId,
    };
    track(
      append("tab.created", { tabId: tab.id, openerTabId: tab.openerTabId }),
    );
    track(warning("新标签的初始请求可能在采集器连接前发生", { tabId: tab.id }));
    track(persistSessionState(active));
  }),
);
chrome.tabs.onActivated.addListener(({ windowId }) => {
  tabActivationVersions.set(windowId, (tabActivationVersions.get(windowId) || 0) + 1);
});
chrome.tabs.onActivated.addListener(
  afterReady(({ tabId, windowId }) => {
    if (active?.status === "recording" && active.tabs[tabId]) {
      track(append("tab.activated", { tabId, windowId }));
      track(chrome.tabs.sendMessage(tabId, { type: "SNAPSHOT" }, { frameId: 0 }).catch(() => {}));
    }
  }),
);
chrome.windows.onRemoved.addListener((windowId) => tabActivationVersions.delete(windowId));
chrome.webNavigation.onHistoryStateUpdated.addListener(
  afterReady((details) => {
    if (
      active?.status !== "recording" ||
      !active.tabs[details.tabId] ||
      details.frameId !== 0
    )
      return;
    const target = active.tabs[details.tabId];
    target.inScope = allowedUrl(details.url);
    track(persistSessionState(active));
    if (!target.inScope) {
      track(append("navigation.out_of_scope", { tabId: details.tabId }, { tabId: details.tabId, frameId: 0 }));
      track(warning("页面已离开授权范围", { tabId: details.tabId }));
      return;
    }
    track(
      append(
        "navigation.spa",
        { tabId: details.tabId, url: cleanUrl(details.url) },
        { tabId: details.tabId },
      ),
    );
    track(snapshotFrameCookies(details.tabId, details));
    if (target.inScope)
      track(
        chrome.tabs
          .sendMessage(details.tabId, { type: "SNAPSHOT" }, { frameId: 0 })
          .catch(() =>
            warning("路由变化时无法取得页面状态", { tabId: details.tabId }),
          ),
      );
  }),
);
chrome.webNavigation.onCommitted.addListener(
  afterReady((details) => {
    if (active?.status !== "recording" || !active.tabs[details.tabId]) return;
    if (!allowedUrl(details.url)) {
      if (details.frameId !== 0) track(append("navigation.frameUnavailable", {
        tabId: details.tabId, frameId: details.frameId, parentFrameId: details.parentFrameId,
        documentId: details.documentId, parentDocumentId: details.parentDocumentId || null,
        documentLifecycle: details.documentLifecycle || null, reason: "outside_scope",
      }, { tabId: details.tabId, frameId: details.frameId, documentId: details.documentId }));
      return;
    }
    track(
      append(
        "navigation.committed",
        {
          tabId: details.tabId,
          frameId: details.frameId,
          documentId: details.documentId,
          parentFrameId: details.parentFrameId,
          parentDocumentId: details.parentDocumentId || null,
          documentLifecycle: details.documentLifecycle || null,
          url: cleanUrl(details.url),
          transitionType: details.transitionType,
          transitionQualifiers: details.transitionQualifiers,
        },
        { tabId: details.tabId, frameId: details.frameId, documentId: details.documentId },
      ),
    );
    track(snapshotFrameCookies(details.tabId, details));
  }),
);
chrome.tabs.onRemoved.addListener(
  afterReady((tabId) => {
    clearTabContexts(tabId);
    unknownSocketTabs.delete(tabId);
    unknownRequestTabs.delete(tabId);
    unknownDialogTabs.delete(tabId);
    if (active?.tabs[tabId]) {
      active.tabs[tabId].closed = true;
      track(append("tab.closed", { tabId }));
      track(persistSessionState(active));
    }
  }),
);
chrome.tabs.onUpdated.addListener(
  afterReady((tabId, info, tab) => {
    if (!active || !["preparing", "recording"].includes(active.status) || !active.tabs[tabId] || !info.url)
      return;
    const target = active.tabs[tabId];
    target.windowId = tab.windowId;
    target.inScope = allowedUrl(info.url);
    if (!target.inScope) {
      target.url = null;
      track(append("navigation.out_of_scope", { tabId }, { tabId, frameId: 0 }));
      track(warning("已离开授权范围，页面操作不会被采集", { tabId }));
    } else {
      target.url = cleanUrl(info.url);
      track(
        append(
          "navigation",
          { tabId, url: target.url, title: tab.title },
          { tabId },
        ),
      );
      if (!target.debuggerAttached) track(attachTab(tabId));
      track(snapshotCookies(info.url));
    }
    track(persistSessionState(active));
  }),
);
chrome.cookies.onChanged.addListener(
  afterReady(({ cookie, cause, removed }) => {
    if (
      active?.status !== "recording" ||
      !Object.values(active.tabs).some((tab) => tab.inScope && !tab.closed)
    )
      return;
    const domain = cookie.domain.replace(/^\./, "");
    const hosts = new Set([
      new URL(currentOrigin).hostname,
      ...Object.values(active.tabs)
        .map((tab) => {
          try {
            return new URL(tab.url).hostname;
          } catch {
            return null;
          }
        })
        .filter(Boolean),
      ...(active.cookieOrigins || []).map((origin) => { try { return new URL(origin).hostname; } catch { return null; } }).filter(Boolean),
    ]);
    if (
      ![...hosts].some((host) => host === domain || host.endsWith("." + domain))
    )
      return;
    track(
      append("cookie.change", {
        ...cookie,
        removed,
        cause,
        source: "domain_scope_unconfirmed",
        ...cleanCookieValue(cookie.name, cookie.value),
      }),
    );
  }),
);
function allowedDownloadUrl(raw) {
  try {
    const url = new URL(raw);
    return (
      allowedUrl(raw) || (url.protocol === "blob:" && allowedUrl(url.origin))
    );
  } catch {
    return false;
  }
}
chrome.downloads.onCreated.addListener(
  afterReady((item) => {
    if (active?.status !== "recording" || !allowedDownloadUrl(item.url)) return;
    track(
      append("download.started", {
        downloadId: item.id,
        url: cleanUrl(item.url),
        filename: item.filename?.split(/[\\/]/).pop() || "",
        mime: item.mime,
        totalBytes: item.totalBytes,
      }),
    );
  }),
);
chrome.downloads.onChanged.addListener(
  afterReady((delta) => {
    if (active?.status !== "recording" || !delta.state) return;
    const sessionId = active.id;
    const task = (async () => {
      const [item] = await chrome.downloads.search({ id: delta.id });
      if (active?.id === sessionId && item && allowedDownloadUrl(item.url))
        await append("download.changed", {
          downloadId: delta.id,
          state: delta.state.current,
          error: delta.error?.current,
        });
    })();
    track(task);
  }),
);
chrome.runtime.onStartup.addListener(() => {
  track(
    (async () => {
      await ensureReady();
      if (!active) {
        await chrome.action.setBadgeText({ text: "" });
        await chrome.action.setTitle({ title: "打开逻辑记录" });
      }
      for (const session of await all("sessions")) {
        if (
          ["preparing", "recording", "stopping"].includes(session.status) &&
          session.id !== active?.id
        ) {
          session.status = "interrupted";
          session.interruptedAt = Date.now();
          await put("sessions", session);
        }
      }
    })(),
  );
});
