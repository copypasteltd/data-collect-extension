import { all, get, put, removeSession } from "./db.js";
import { fontMime } from "./font-format.js";
import { cleanDebuggerResponse } from "./response-body.js";
import {
  cleanBody,
  cleanCookieValue,
  cleanHeaders,
  cleanRealtimeText,
  cleanUrl,
  cleanWebSocketFrame,
  redactText,
  scrubEventPayload,
} from "./privacy.js";

const uid = () => crypto.randomUUID();
let active = null;
let currentOrigin = null;
let screenshotLast = 0;
let screenshotTimer;
let screenshotPending = [];
let screenshotChain = Promise.resolve();
const pending = new Set();
const requests = new Map();
const childScopes = new Map();
const socketScopes = new Map();
const unknownSocketTabs = new Set();
const unknownRequestTabs = new Set();
const unknownDialogTabs = new Set();
const dialogScopes = new Map();
let sequence = 0;
let writeChain = Promise.resolve();
let outstandingWrites = 0;

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
function append(kind, payload = {}, extra = {}) {
  if (!active) return Promise.resolve();
  if (
    outstandingWrites >= 5000 &&
    !["warning", "session.stop"].includes(kind)
  ) {
    active.droppedEvents = (active.droppedEvents || 0) + 1;
    active.incomplete = true;
    active.notice = "录制速度超过本机写入能力，部分记录已丢失。";
    if (active.droppedEvents === 1) {
      chrome.action.setBadgeText({ text: "!" }).catch(() => {});
      chrome.storage.session.set({ active }).catch(() => {});
    }
    return Promise.resolve(false);
  }
  const event = {
    id: uid(),
    sessionId: active.id,
    seq: ++sequence,
    time: Date.now(),
    kind,
    payload: scrubEventPayload(kind, payload),
    ...extra,
  };
  outstandingWrites++;
  const task = writeChain.then(() => put("events", event));
  const handled = task
    .then(() => true)
    .catch((error) => {
      console.error("事件写入失败", error);
      if (active?.id === event.sessionId) {
        active.storageError = true;
        active.notice =
          "本地存储写入失败，部分记录可能丢失，请停止并检查可用空间。";
        chrome.action.setBadgeText({ text: "!" }).catch(() => {});
        chrome.storage.session.set({ active }).catch(() => {});
      }
      return false;
    });
  handled.finally(() => {
    outstandingWrites--;
  });
  writeChain = handled.then(() => undefined);
  return track(handled);
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
function clearTabContexts(tabId) {
  for (const [id, item] of socketScopes)
    if (item.tabId === tabId) socketScopes.delete(id);
  for (const id of dialogScopes.keys())
    if (id.startsWith(`${tabId}:`)) dialogScopes.delete(id);
}
async function register(origin, scope) {
  const parsed = new URL(origin);
  const matches =
    scope === "browser"
      ? ["http://*/*", "https://*/*"]
      : [`${parsed.protocol}//${parsed.hostname}/*`];
  await chrome.scripting
    .unregisterContentScripts({ ids: ["recorder"] })
    .catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: "recorder",
      matches,
      js: ["content.js"],
      allFrames: true,
      runAt: "document_start",
      persistAcrossSessions: false,
    },
  ]);
}
async function init() {
  const state = await chrome.storage.session.get("active");
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
const ready = init();
const afterReady =
  (handler) =>
  (...args) => {
    track(ready.then(() => handler(...args)));
  };

async function start(tab, options, onCreated) {
  await ready;
  if (active) throw new Error("已有录制任务进行中");
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
    options,
    browser: navigator.userAgent,
    gaps: [],
  };
  active = session;
  onCreated(session);
  currentOrigin = origin;
  sequence = 0;
  if (options.scope === "browser") {
    const tabs = await chrome.tabs.query({});
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
  await chrome.storage.session.set({ active: session });
  await append("session.start", {
    url: cleanUrl(tab.url),
    note: "开始前发生的操作和请求未记录",
  });
  for (const target of Object.values(session.tabs)) await attachTab(target.id);
  const resourceDeadline = Date.now() + 6000;
  for (const target of Object.values(session.tabs))
    await captureInitialResources(target, resourceDeadline);
  try {
    await register(origin, options.scope);
    for (const target of Object.values(session.tabs)) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: target.id, allFrames: true },
          files: ["content.js"],
        });
      } catch (error) {
        await warning("页面采集器注入失败", {
          tabId: target.id,
          error: String(error),
        });
      }
    }
  } catch (error) {
    await warning("页面采集器注册失败", { error: String(error) });
  }
  for (const target of Object.values(session.tabs))
    await snapshotCookies(target.url);
  session.status = "recording";
  await chrome.action.setBadgeBackgroundColor({ color: "#b43f36" });
  await chrome.action.setBadgeText({ text: "REC" });
  await chrome.action.setTitle({ title: "逻辑记录：录制中" });
  await put("sessions", session);
  await chrome.storage.session.set({ active: session });
  const readyEventId = uid();
  await append(
    "session.ready",
    { debuggerAttached: !!session.tabs[tab.id]?.debuggerAttached },
    { id: readyEventId, tabId: tab.id },
  );
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
        ...cleanCookieValue(name, value, session.options.cookieValues),
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
  target.attaching = true;
  let attached = false;
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
    attached = true;
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
    target.debuggerAttached = true;
    try {
      await enableChildTargets({ tabId });
    } catch (error) {
      await warning("嵌入页面的网络采集不可用", {
        tabId,
        error: String(error),
      });
    }
  } catch (error) {
    if (attached) await chrome.debugger.detach({ tabId }).catch(() => {});
    target.debuggerAttached = false;
    if (active?.id === session.id)
      await warning("网络调试连接失败，网络记录可能不完整", {
        tabId,
        error: String(error),
      });
  } finally {
    target.attaching = false;
    if (active?.id === session.id)
      await chrome.storage.session.set({ active: session });
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
async function inspectSensitive(tabId) {
  const top = await chrome.tabs.sendMessage(
    tabId,
    { type: "SENSITIVE_CHECK" },
    { frameId: 0 },
  );
  if (!top?.viewport) throw new Error(top?.error || "无法检查页面敏感区域");
  const rects = [...top.rects],
    children = [];
  if (top.frames.length) {
    const frameList = await chrome.webNavigation.getAllFrames({ tabId });
    for (const frame of top.frames) {
      if (!frame.safe || !allowedUrl(frame.url))
        throw new Error("嵌入页面未授权或坐标无法确认");
      const matches = (frameList || []).filter(
        (item) => item.parentFrameId === 0 && item.url === frame.url,
      );
      if (matches.length !== 1) throw new Error("嵌入页面无法唯一匹配");
      const child = await chrome.tabs.sendMessage(
        tabId,
        { type: "SENSITIVE_CHECK" },
        { frameId: matches[0].frameId },
      );
      if (
        !child?.viewport ||
        child.frames.length ||
        child.viewport.scale !== 1 ||
        child.viewport.offsetX !== 0 ||
        child.viewport.offsetY !== 0 ||
        Math.abs(frame.clientWidth - child.viewport.width) > 2 ||
        Math.abs(frame.clientHeight - child.viewport.height) > 2
      )
        throw new Error("嵌入页面的敏感区域无法确认");
      children.push({ frameId: matches[0].frameId, frame, child });
      for (const rect of child.rects) {
        const left = Math.max(0, rect.x),
          topEdge = Math.max(0, rect.y),
          right = Math.min(child.viewport.width, rect.x + rect.width),
          bottom = Math.min(child.viewport.height, rect.y + rect.height);
        if (right > left && bottom > topEdge)
          rects.push({
            x: frame.x + frame.borderX + left,
            y: frame.y + frame.borderY + topEdge,
            width: right - left,
            height: bottom - topEdge,
          });
      }
    }
  }
  return { top, children, rects };
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
    const inspection = await inspectSensitive(tabId),
      info = inspection.top;
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
    const afterInspection = await inspectSensitive(tabId);
    if (JSON.stringify(inspection) !== JSON.stringify(afterInspection))
      throw new Error("截图期间页面或敏感区域发生变化");
    let blob = await (await fetch(data)).blob();
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
      if (inspection.rects.length) {
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = canvas.getContext("2d");
        if (!context || !info.viewport?.width || !info.viewport?.height)
          throw new Error("敏感区域遮挡不可用");
        context.drawImage(bitmap, 0, 0);
        context.fillStyle = "#000";
        const sx = bitmap.width / info.viewport.width,
          sy = bitmap.height / info.viewport.height;
        for (const rect of inspection.rects)
          context.fillRect(
            Math.floor((rect.x - 4) * sx),
            Math.floor((rect.y - 4) * sy),
            Math.ceil((rect.width + 8) * sx),
            Math.ceil((rect.height + 8) * sy),
          );
        blob = await canvas.convertToBlob({
          type: "image/jpeg",
          quality: 0.75,
        });
      }
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
async function stop() {
  await ready;
  if (!active) throw new Error("没有正在录制的任务");
  const session = active;
  if (session.status !== "recording")
    throw new Error("录制任务正在准备或停止，请稍候");
  session.status = "stopping";
  session.stopRequestedAt = Date.now();
  await put("sessions", session);
  await chrome.storage.session.set({ active: session });
  const activeFrames = [];
  for (const target of Object.values(session.tabs)) {
    if (target.closed) continue;
    let frames;
    try {
      frames = await withDeadline(
        chrome.webNavigation.getAllFrames({ tabId: target.id }),
        5000,
        "页面状态检查",
      );
    } catch {
      const exists = await chrome.tabs.get(target.id).then(
        () => true,
        () => false,
      );
      if (!exists) {
        target.closed = true;
        continue;
      }
      frames = [];
      session.incomplete = true;
      await warning("结束时无法枚举页面框架", { tabId: target.id });
    }
    for (const frame of frames || []) {
      if (!allowedUrl(frame.url)) continue;
      try {
        const result = await withDeadline(
          chrome.tabs.sendMessage(
            target.id,
            { type: "FLUSH" },
            { frameId: frame.frameId },
          ),
          6000,
          "页面状态收尾",
        );
        if (!result?.ok)
          throw new Error(
            `页面采集消息未送达：${result?.failedEvents || 0} 条`,
          );
      } catch (error) {
        session.incomplete = true;
        await warning("结束时无法取得页面最终状态", {
          tabId: target.id,
          frameId: frame.frameId,
          error: String(error),
        });
      }
      activeFrames.push({ tabId: target.id, frameId: frame.frameId });
    }
  }
  if (screenshotTimer) {
    clearTimeout(screenshotTimer);
    screenshotTimer = null;
  }
  while (screenshotPending.length) {
    try {
      await withDeadline(capture(), 5000, "截图收尾");
    } catch {
      session.incomplete = true;
      screenshotPending = [];
      await warning("截图收尾超时，部分截图可能缺失");
      break;
    }
  }
  try {
    await withDeadline(Promise.allSettled([...pending]), 8000, "数据收尾");
  } catch {
    session.incomplete = true;
    await warning("数据收尾超时，部分记录可能缺失");
  }
  await writeChain;
  for (const frame of activeFrames) {
    try {
      await withDeadline(
        chrome.tabs.sendMessage(
          frame.tabId,
          { type: "STOP_CAPTURE" },
          { frameId: frame.frameId },
        ),
        2000,
        "采集器关闭",
      );
    } catch {
      session.incomplete = true;
      await warning("页面采集器未能正常关闭", frame);
    }
  }
  if (session.droppedEvents)
    await warning("本地写入队列过载，部分记录未保存", {
      droppedEvents: session.droppedEvents,
    });
  await append("session.stop", { note: "停止时仍在进行的请求可能不完整" });
  for (const target of Object.values(session.tabs))
    if (!target.closed && target.debuggerAttached) {
      try {
        await withDeadline(
          chrome.debugger.detach({ tabId: target.id }),
          3000,
          "调试连接关闭",
        );
      } catch {
        session.incomplete = true;
        await warning("调试连接未能正常关闭", { tabId: target.id });
      }
    }
  try {
    await chrome.scripting.unregisterContentScripts({ ids: ["recorder"] });
  } catch {
    session.incomplete = true;
    await warning("页面采集器注册未能清理");
  }
  const recorded = await all("events", session.id);
  session.coverage = {
    warnings: recorded.filter((event) => event.kind === "warning").length,
    initialResourceGaps: recorded.filter(
      (event) => event.kind === "resource.initialSummary" && event.payload.status !== "captured",
    ).length,
    screenshotsUnavailable: recorded.filter(
      (event) =>
        event.kind === "screenshot" && event.payload.status === "unavailable",
    ).length,
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
        ["unavailable", "omitted_size", "omitted_encoding", "omitted_unparseable"].includes(
          event.payload.body?.status,
        ),
    ).length,
  };
  session.status =
    session.storageError || session.incomplete ? "interrupted" : "ready";
  session.endedAt = Date.now();
  await put("sessions", session);
  active = null;
  currentOrigin = null;
  requests.clear();
  childScopes.clear();
  socketScopes.clear();
  unknownSocketTabs.clear();
  unknownRequestTabs.clear();
  unknownDialogTabs.clear();
  dialogScopes.clear();
  screenshotChain = Promise.resolve();
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "打开逻辑记录" });
  await chrome.storage.session.remove("active");
  return session;
}

async function interrupt(session, reason) {
  if (!session || active?.id !== session.id) return;
  session.status = "interrupted";
  session.interruptedAt = Date.now();
  session.notice = reason;
  await put("sessions", session).catch(console.error);
  await clearActiveResources(session);
}

async function clearActiveResources(session) {
  if (screenshotTimer) clearTimeout(screenshotTimer);
  screenshotTimer = null;
  screenshotPending = [];
  for (const target of Object.values(session.tabs || {})) {
    await chrome.tabs
      .sendMessage(target.id, { type: "STOP_CAPTURE" })
      .catch(() => {});
    if (target.debuggerAttached)
      await chrome.debugger.detach({ tabId: target.id }).catch(() => {});
  }
  await chrome.scripting
    .unregisterContentScripts({ ids: ["recorder"] })
    .catch(() => {});
  active = null;
  currentOrigin = null;
  requests.clear();
  childScopes.clear();
  socketScopes.clear();
  unknownSocketTabs.clear();
  unknownRequestTabs.clear();
  unknownDialogTabs.clear();
  dialogScopes.clear();
  screenshotChain = Promise.resolve();
  await chrome.storage.session.remove("active").catch(() => {});
  await chrome.action.setBadgeText({ text: "" }).catch(() => {});
  await chrome.action.setTitle({ title: "打开逻辑记录" }).catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  (async () => {
    await ready;
    if (message.type === "GET_STATE")
      return {
        active,
        sessions: (await all("sessions")).sort(
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
        if (created && active === created && created.status === "preparing")
          await interrupt(created, "录制准备失败，已保存可用的部分记录");
        throw error;
      }
    }
    if (message.type === "STOP") {
      try {
        return await stop();
      } catch (error) {
        if (active?.status === "stopping")
          await interrupt(active, "录制异常结束，已保存可用的部分记录");
        throw error;
      }
    }
    if (message.type === "DELETE") {
      if (active?.id === message.id) throw new Error("无法删除正在录制的任务");
      await removeSession(message.id);
      return true;
    }
    if (message.type === "EVENTS") {
      if (
        !active ||
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
      for (const item of message.events) {
        const eventId = uid();
        const itemPayload = {
          ...item.payload,
          url: cleanUrl(item.payload?.url || sender.url),
        };
        const saved = await append(item.kind, itemPayload, {
          id: eventId,
          time: item.time,
          tabId: sender.tab.id,
          frameId: sender.frameId,
          documentId: sender.documentId,
        });
        if (saved && item.screenshot && active.options.screenshots)
          requestScreenshot(
            eventId,
            sender.tab.id,
            sender.frameId,
            sender.documentId,
            itemPayload.url,
          );
      }
      return true;
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
      dialogScopes.delete(`${source.tabId}:${params.sessionId}`);
      for (const [id, item] of socketScopes)
        if (item.tabId === source.tabId && item.sessionId === params.sessionId)
          socketScopes.delete(id);
      return;
    }
    if (method === "Target.attachedToTarget") {
      if (active.status === "stopping") return;
      const child = { tabId: source.tabId, sessionId: params.sessionId };
      if (!allowedUrl(params.targetInfo?.url)) {
        track(
          warning("嵌入页面不在授权范围或地址尚未确定", {
            tabId: source.tabId,
          }),
        );
        return;
      }
      childScopes.set(params.sessionId, true);
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
          if (active?.id === sessionId)
            await append("frame.attached", {
              tabId: source.tabId,
              protocolSessionId: params.sessionId,
              url: cleanUrl(params.targetInfo.url),
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
              message: redactText(params.message || ""),
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
            { accepted: params.result, userInput: "[已隐藏]" },
            { tabId: source.tabId },
          ),
        );
      return;
    }
    if (!method.startsWith("Network.")) return;
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
        childScopes.set(source.sessionId, allowedUrl(params.request.url));
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
            eventName: redactText(
              String(params.eventName || "").slice(0, 1000),
            ),
            eventId: redactText(String(params.eventId || "").slice(0, 4000)),
            timestamp: params.timestamp,
            data: cleanRealtimeText(params.data),
          },
          { tabId: source.tabId },
        ),
      );
    } else if (method === "Network.loadingFinished") {
      const item = requests.get(requestId);
      if (!item) return;
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
            if (active?.id !== sessionId) return;
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
            if (active?.id !== sessionId) return;
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
        }
        if (active?.id === sessionId)
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
        if (active?.id === sessionId && requests.get(requestId) === item)
          requests.delete(requestId);
      })();
      track(task);
    } else if (method === "Network.loadingFailed") {
      const item = requests.get(requestId);
      if (!item) return;
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
      track(
        append(
          "network.websocket",
          {
            requestId,
            type: "webSocketCreated",
            url: socket.url,
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
      active.status !== "recording" ||
      tab.incognito
    )
      return;
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
    track(chrome.storage.session.set({ active }));
  }),
);
chrome.tabs.onActivated.addListener(
  afterReady(({ tabId, windowId }) => {
    if (active?.status === "recording" && active.tabs[tabId])
      track(append("tab.activated", { tabId, windowId }));
  }),
);
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
    track(chrome.storage.session.set({ active }));
    if (!target.inScope) {
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
      track(chrome.storage.session.set({ active }));
    }
  }),
);
chrome.tabs.onUpdated.addListener(
  afterReady((tabId, info, tab) => {
    if (active?.status !== "recording" || !active.tabs[tabId] || !info.url)
      return;
    const target = active.tabs[tabId];
    target.windowId = tab.windowId;
    target.inScope = allowedUrl(info.url);
    if (!target.inScope) {
      target.url = null;
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
    track(chrome.storage.session.set({ active }));
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
        ...cleanCookieValue(
          cookie.name,
          cookie.value,
          active.options.cookieValues,
        ),
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
      await ready;
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
