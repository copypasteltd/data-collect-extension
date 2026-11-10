import { all, get, put, putMany, putIdempotentEvents, removeSession } from "./db.js";
import { fontMime } from "./font-format.js";
import { cleanDebuggerResponse } from "./response-body.js";
import { recoverPendingRequests, recoverRootSockets, recoverChildSockets } from "./network-recovery.js";
import { withSessionLock } from "./session-lock.js";
import {
  cleanBody,
  cleanCookieValue,
  cleanHeaders,
  cleanRealtimeText,
  cleanUrl,
  cleanWebSocketFrame,
} from "./privacy.js";

const uid = () => crypto.randomUUID();
let active = null;
let currentOrigin = null;
let networkSealed = false;
let screenshotLast = 0;
let screenshotTimer;
let screenshotPending = [];
let screenshotChain = Promise.resolve();
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
  const state = await chrome.storage.session.get(["active", "recorderFrames"]);
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
    const stored = await get("sessions", active.id);
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
    const events = await all("events", active.id);
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
    for (const session of await all("sessions")) {
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
  for (const target of Object.values(session.tabs)) {
    try { await withDeadline(attachTab(target.id), 5000, "网络调试连接"); }
    catch (error) {
      requirePreparing(session);
      session.incomplete = true;
      await warning("网络调试连接超时，网络记录可能不完整", { tabId: target.id, error: String(error) });
    }
    requirePreparing(session);
  }
  const resourceDeadline = Date.now() + 6000;
  for (const target of Object.values(session.tabs)) {
    await captureInitialResources(target, resourceDeadline);
    requirePreparing(session);
  }
  for (const target of Object.values(session.tabs)) {
    try {
      await withDeadline(chrome.scripting.executeScript({
        target: { tabId: target.id, allFrames: true },
        files: ["content.js"],
      }), 5000, "页面采集器注入");
    } catch (error) {
      requirePreparing(session);
      session.incomplete = true;
      await warning("页面采集器注入失败", {
        tabId: target.id,
        error: String(error),
      });
    }
    requirePreparing(session);
  }
  for (const target of Object.values(session.tabs)) {
    try { await withDeadline(snapshotCookies(target.url), 5000, "Cookie 初始状态"); }
    catch (error) {
      requirePreparing(session);
      session.incomplete = true;
      await warning("Cookie 初始状态采集超时", { tabId: target.id, error: String(error) });
    }
    requirePreparing(session);
  }
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
    for (const {
      name,
      value,
      domain,
      path,
      secure,
      httpOnly,
      sameSite,
      expirationDate,
      partitionKey,
      storeId,
    } of records) {
      const suffix = domain.replace(/^\./, "");
      if (parsed.hostname !== suffix && !parsed.hostname.endsWith("." + suffix))
        continue;
      items.set(JSON.stringify([name, domain, path, partitionKey, storeId]), {
        name,
        domain,
        path,
        secure,
        httpOnly,
        sameSite,
        expirationDate,
        partitionKey,
        storeId,
        ...cleanCookieValue(name, value),
      });
    }
    if (active?.id === session.id)
      await append("cookie.initial", {
        origin: site,
        items: [...items.values()],
      });
  } catch (error) {
    if (active?.id === session.id)
      await warning("Cookie 初始状态无法读取", {
        origin: site,
        error: String(error),
      });
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
      maxTotalBufferSize: 20000000,
      maxResourceBufferSize: 2000000,
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
          if (active?.id !== session.id) return;
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
  if (active?.id === session.id)
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
        { format: "jpeg", quality: 75, fromSurface: true },
      );
      data = `data:image/jpeg;base64,${result.data}`;
    } else {
      data = await chrome.tabs.captureVisibleTab(windowId, {
        format: "jpeg",
        quality: 75,
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
      mime: "image/jpeg",
      blob,
    });
    if (active?.id === sessionId)
      await append(
        "screenshot",
        {
          assetId: id,
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
  const recorded = await withDeadline(all("events", session.id), 5000, "记录检查");
  session.coverage = {
    warnings: recorded.filter((event) => event.kind === "warning").length,
    pendingRequests: recorded.filter((event) => event.kind === "network.incomplete").length,
    snapshotGaps: recorded.filter(
      (event) => event.kind === "page.snapshot" && (event.payload.status !== "captured" ||
        (event.payload.sourceStatus && event.payload.sourceStatus !== "captured")),
    ).length,
    databaseGaps: recorded.filter(
      (event) => event.kind === "database.snapshot" &&
        (event.payload.status || event.payload.database?.status !== "captured" ||
          event.payload.database?.storesTruncated ||
          event.payload.database?.stores?.some((store) => store.truncated)),
    ).length,
    cacheGaps: recorded.filter(
      (event) => event.kind === "cache.snapshot" &&
        (event.payload.truncated || !["metadata_only", "name_only"].includes(event.payload.status)),
    ).length,
    stateCaptureGaps: recorded.filter((event) => event.kind === "state.capture" &&
      ["timeout", "failed"].includes(event.payload.status)).length,
    initialResourceGaps: recorded.filter(
      (event) => event.kind === "resource.initialSummary" && event.payload.status !== "captured",
    ).length,
    screenshotsUnavailable: recorded.filter(
      (event) =>
        event.kind === "screenshot" && event.payload.status === "unavailable",
    ).length,
    canvasGaps: recorded.filter((event) => event.kind === "page.snapshot" &&
      ((event.payload.canvas?.total > 0 && (event.payload.canvas.status !== "captured" ||
        event.payload.canvas.omitted > 0 || event.payload.canvas.unavailable > 0 || event.payload.canvas.geometryOmitted > 0)) ||
        event.payload.canvas?.scanTruncated)).length,
    popoverGaps: recorded.filter((event) =>
      (event.kind === "page.snapshot" && (event.payload.popover?.omitted || event.payload.popover?.unavailable || event.payload.popover?.scanTruncated)) ||
      (event.kind === "page.popover" && event.payload.status === "unavailable")).length,
    dialogGaps: recorded.filter((event) =>
      (event.kind === "page.snapshot" && (event.payload.dialog?.omitted || event.payload.dialog?.unavailable || event.payload.dialog?.scanTruncated)) ||
      (event.kind === "page.dialog" && event.payload.status === "unavailable")).length,
    inputGaps: recorded.filter(
      (event) => ["interaction.input", "interaction.change"].includes(event.kind) &&
        (["truncated", "redacted_truncated"].includes(event.payload.valueStatus) ||
          ["truncated", "redacted_truncated"].includes(event.payload.beforeValueStatus)),
    ).length,
    storageGaps: recorded.filter(
      (event) => event.kind === "storage.unavailable" ||
        (event.kind === "storage.snapshot" && event.payload.coverage &&
          Object.values(event.payload.coverage).some((item) => item?.status !== "captured")),
    ).length,
    styleGaps: recorded.filter(
      (event) =>
        event.kind === "page.snapshot" &&
        (event.payload.styles?.unavailable > 0 ||
          event.payload.styles?.truncated ||
          event.payload.styles?.backgroundUnavailable > 0 ||
          event.payload.styles?.backgroundTruncated ||
          event.payload.scroll?.truncated ||
          event.payload.shadow?.roots > 0 ||
          event.payload.shadow?.truncated ||
          event.payload.shadow?.unavailable),
    ).length,
    responseGaps: recorded.filter(
      (event) =>
        event.kind === "network.finished" &&
        (["unavailable", "omitted_size", "omitted_encoding", "omitted_unparseable"].includes(
          event.payload.body?.status,
        ) || Boolean(event.payload.body?.textStatus)),
    ).length,
  };
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
  await withDeadline(chrome.action.setBadgeText({ text: "" }), 2000, "录制标记清理").catch(() => {});
  await withDeadline(chrome.action.setTitle({ title: "打开逻辑记录" }), 2000, "录制标题清理").catch(() => {});
  await withDeadline(childStorageChain, 2000, "框架恢复信息收尾").catch(() => {});
  await withDeadline(removeSessionState(session), 2000, "录制状态清理");
  session.status = status;
  session.endedAt = endedAt;
  active = null;
  return session;
}

async function interrupt(session, reason) {
  if (!session || active?.id !== session.id) return;
  session.status = "interrupted";
  session.interruptedAt = Date.now();
  session.notice = reason;
  await withDeadline(put("sessions", session), 6000, "中断记录保存").catch(console.error);
  await clearActiveResources(session);
  writeChain = Promise.resolve();
  pending.clear();
}

async function clearActiveResources(session) {
  if (screenshotTimer) clearTimeout(screenshotTimer);
  screenshotTimer = null;
  screenshotPending = [];
  await Promise.all(Object.values(session.tabs || {}).map(async (target) => {
    await withDeadline(chrome.tabs
      .sendMessage(target.id, { type: "STOP_CAPTURE", sessionId: session.id }), 2000, "采集器关闭")
      .catch(() => {});
    if (target.debuggerAttached)
      await withDeadline(detachTab(target), 3000, "调试连接关闭").catch(() => {});
  }));
  await withDeadline(chrome.scripting
    .unregisterContentScripts({ ids: [session.scriptId || "recorder"] }), 2000, "页面采集器清理")
    .catch(() => {});
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
  await withDeadline(childStorageChain, 2000, "框架恢复信息清理").catch(() => {});
  await withDeadline(removeSessionState(session), 2000, "录制状态清理").catch(() => {});
  if (active === session) active = null;
  await withDeadline(chrome.action.setBadgeText({ text: "" }), 2000, "录制标记清理").catch(() => {});
  await withDeadline(chrome.action.setTitle({ title: "打开逻辑记录" }), 2000, "录制标题清理").catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    await ensureReady();
    if (message.type === "GET_STATE")
      return {
        active,
        sessions: (await withDeadline(all("sessions"), 5000, "录制批次读取")).sort(
          (a, b) => b.startedAt - a.startedAt,
        ),
      };
    if (message.type === "START") {
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
    if (message.type === "STOP") {
      let stopping;
      try {
        return await stop((session) => { stopping = session; });
      } catch (error) {
        if (stopping && active === stopping)
          await interrupt(stopping, "录制异常结束，已保存可用的部分记录");
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
        for (let index = 0; index < events.length; index++)
          if (results[index] === "created" && message.events[index].screenshot)
            requestScreenshot(events[index].id, sender.tab.id, sender.frameId, sender.documentId, events[index].payload.url);
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
            maxTotalBufferSize: 10000000,
            maxResourceBufferSize: 2000000,
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
      ].includes(method)
    )
      return;
    const target = active.tabs[source.tabId],
      rawRequestId = params.requestId,
      requestId = `${source.tabId}:${source.sessionId || "root"}:${rawRequestId}`;
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
      const item = {
        requestId: previous ? `${requestId}:redirect:${uid()}` : requestId,
        ...(previous ? { redirectFrom: previous.requestId } : {}),
        tabId: source.tabId,
        protocolSessionId: source.sessionId || null,
        url: cleanUrl(req.url),
        method: req.method,
        headers: cleanHeaders(req.headers, req.url),
        postData:
          req.hasPostData && req.postData == null
            ? { value: null, status: "pending" }
            : cleanBody(req.postData, ct),
        type: params.type,
        frameId: params.frameId,
        documentUrl: params.documentURL ? cleanUrl(params.documentURL) : null,
        sourceFrame: source.sessionId ? "embedded" : params.frameId && target.mainFrameId === params.frameId ? "main" : "unknown",
        initiator: { type: params.initiator?.type },
        timestamp: params.timestamp,
      };
      requests.set(requestId, item);
      track(append("network.request", item, { tabId: source.tabId }));
      if (item.postData.status === "pending") {
        const sessionId = active.id;
        const debugSession = source.sessionId
          ? { tabId: source.tabId, sessionId: source.sessionId }
          : { tabId: source.tabId };
        track(
          (async () => {
            let body;
            try {
              const result = await withDeadline(
                chrome.debugger.sendCommand(
                  debugSession,
                  "Network.getRequestPostData",
                  { requestId: rawRequestId },
                ),
                5000,
                "请求体读取",
              );
              if (item.superseded)
                throw new Error("请求已重定向，无法确认请求体归属");
              if (result.base64Encoded && result.postData.length > 1400000)
                body = { value: null, status: "omitted_size" };
              else {
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
        append(
          "network.eventSourceMessage",
          {
            requestId: item.requestId,
            eventName: String(params.eventName || "").slice(0, 1000),
            eventId: String(params.eventId || "").slice(0, 4000),
            timestamp: params.timestamp,
            data: cleanRealtimeText(params.data),
          },
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
          assetId = null;
        const mime = item.response?.mimeType || "";
        if (item.type === "Font" && params.encodedDataLength < 1500000) {
          try {
            const result = await chrome.debugger.sendCommand(debugSession, "Network.getResponseBody", { requestId: rawRequestId });
            if (!result.base64Encoded) throw new Error("字体内容编码不可用");
            const binary = atob(result.body);
            if (binary.length > 1500000) throw new Error("字体超过大小限制");
            const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            const fontType = fontMime(bytes);
            if (!fontType) throw new Error("仅支持 WOFF 和 WOFF2 字体");
            assetId = uid();
            if (active?.id !== sessionId || item.finalized) return;
            await put("assets", { id: assetId, sessionId, type: "resource", mime: fontType, blob: new Blob([bytes], { type: fontType }) });
            body = { value: null, status: "captured_asset" };
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
            body = cleanDebuggerResponse(result, item.response, item.method);
          } catch (error) {
            body = {
              value: null,
              status: "unavailable",
              reason: String(error),
            };
          }
        } else if (
          /^image\/(png|jpeg|webp|gif)$/i.test(mime) &&
          params.encodedDataLength < 1500000
        ) {
          try {
            const result = await chrome.debugger.sendCommand(
              debugSession,
              "Network.getResponseBody",
              { requestId: rawRequestId },
            );
            if (!result.base64Encoded) throw new Error("图像内容编码不可用");
            const binary = atob(result.body);
            if (binary.length > 1500000) throw new Error("图像超过大小限制");
            const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
            assetId = uid();
            if (active?.id !== sessionId || item.finalized) return;
            await put("assets", {
              id: assetId,
              sessionId,
              type: "resource",
              mime,
              blob: new Blob([bytes], { type: mime }),
            });
            body = { value: null, status: "captured_asset" };
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
            body = cleanDebuggerResponse(result, item.response, item.method);
          } catch (error) {
            body = { value: null, status: "unavailable", reason: String(error) };
          }
        }
        if (active?.id === sessionId && !item.finalized) {
          item.finalized = true;
          await append(
            "network.finished",
            {
              requestId: item.requestId,
              encodedDataLength: params.encodedDataLength,
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
        append(
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
    if (active?.status === "recording" && active.tabs[tabId])
      track(append("tab.activated", { tabId, windowId }));
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
    if (
      active?.status !== "recording" ||
      !active.tabs[details.tabId] ||
      !allowedUrl(details.url)
    )
      return;
    track(
      append(
        "navigation.committed",
        {
          tabId: details.tabId,
          frameId: details.frameId,
          documentId: details.documentId,
          url: cleanUrl(details.url),
          transitionType: details.transitionType,
          transitionQualifiers: details.transitionQualifiers,
        },
        { tabId: details.tabId, frameId: details.frameId },
      ),
    );
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
    ]);
    if (
      ![...hosts].some((host) => host === domain || host.endsWith("." + domain))
    )
      return;
    track(
      append("cookie.change", {
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
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
