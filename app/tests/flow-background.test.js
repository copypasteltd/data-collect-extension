import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createFlowBackground, FLOW_LIMITS } from "../src/flow-background.js";
import { DEFAULT_FLOW_SETTINGS, LEGACY_FLOW_SETTINGS, MAX_MULTIPLIER, FLOW_SETTINGS_KEY, deriveFlowLimits } from "../src/flow-config.js";

const clone = (value) => structuredClone(value);
const tick = () => new Promise((resolve) => setImmediate(resolve));
function eventSource() {
  const handlers = new Set();
  return { addListener(fn) { handlers.add(fn); }, removeListener(fn) { handlers.delete(fn); }, fire(...args) { for (const fn of handlers) fn(...args); } };
}
function harness(options = {}) {
  let clock = 10000, serial = 0;
  const calls = [], events = [], contents = [], sessions = new Map(), keys = new Map();
  const root = { id: 7, url: "https://erp.test/orders" }, tabs = new Map([[7, root]]);
  const frames = new Map([[7, [{ frameId: 0, url: root.url, documentId: "doc-7" }]]]);
  const budget = () => ({ usedBytes: 0, byCategory: { body: 0, dom: 0, resource: 0, screenshot: 0, meta: 0 }, policyStopped: false });
  const store = {
    async createSession(s) { const row = { ...clone(s), writeGate: "open", budget: budget(), eventCount: 0, lastSeq: 0 }; sessions.set(s.id, row); return row; },
    async listSessions() { return [...sessions.values()].map(clone); },
    async getSession(id) { return clone(sessions.get(id)); },
    async updateSession(id, token, patch) { assert.equal(sessions.get(id).ownerToken, token); calls.push({ type: "patch", patch }); Object.assign(sessions.get(id), clone(patch)); },
    async appendCapture(id, token, e, cs = [], { final = false } = {}) {
      assert.equal(sessions.get(id).ownerToken, token);
      assert.equal(JSON.stringify(e).includes("undefined"), false);
      if (e.captureKey && keys.has(id + e.captureKey)) return { accepted: 1, failed: 0, policyStopped: false, duplicate: true, event: keys.get(id + e.captureKey) };
      if (!final && options.reject?.(e)) { sessions.get(id).budget.policyStopped = true; return { accepted: 0, failed: 0, policyStopped: true, reason: "category-body-limit" }; }
      if (!final && options.failed?.(e)) return { accepted: 0, failed: 1, policyStopped: false };
      if (!final && sessions.get(id).writeGate !== "open") return { accepted: 0, failed: 0, policyStopped: false, reason: "closed" };
      if (options.append) await options.append(e);
      const row = { ...clone(e), id: id + ":" + (sessions.get(id).lastSeq + 1), sessionId: id, seq: ++sessions.get(id).lastSeq };
      sessions.get(id).eventCount++;
      for (const c of cs) { contents.push({ event: row, ...c }); row.payload[c.field] = { status: "captured", size: typeof c.bytes === "string" ? Buffer.byteLength(c.bytes) : c.bytes.byteLength }; }
      events.push(row); calls.push({ type: "append", event: row, final });
      if (e.captureKey) keys.set(id + e.captureKey, row);
      return { accepted: 1, failed: 0, policyStopped: sessions.get(id).budget.policyStopped, event: row };
    },
    async closeSessionWrites(id) { calls.push({ type: "close" }); sessions.get(id).writeGate = "closing"; },
    async sealSession(id, token, result) { calls.push({ type: "seal" }); assert.equal(events.filter((e) => e.sessionId === id && e.kind === "session.stop").length, 1); Object.assign(sessions.get(id), clone(result), { writeGate: "sealed" }); },
  };
  const chrome = {
    runtime: { id: "test-extension", getURL: (path) => "chrome-extension://test-extension/" + path, onMessage: eventSource() },
    permissions: { async contains({ origins }) { calls.push({ type: "permission", origins }); return options.permission ? options.permission(origins[0]) : true; } },
    tabs: { onCreated: eventSource(), onUpdated: eventSource(), onRemoved: eventSource(),
      async get(id) { calls.push({ type: "get", id }); return tabs.get(id); },
      async query() { assert.fail("root must not query all tabs"); },
      async sendMessage(tabId, message, target) { calls.push({ type: "message", tabId, message, target }); return options.send ? options.send(tabId, message, target) : { ok: true, value: { accepted: 0, failed: 0, pending: 0, confirmed: true } }; } },
    webNavigation: { onCommitted: eventSource(), async getAllFrames({ tabId }) { return frames.get(tabId) || [{ frameId: 0, url: tabs.get(tabId)?.url, documentId: "doc-" + tabId }]; } },
    scripting: { async executeScript(args) { calls.push({ type: "inject", ...args }); } },
    debugger: { onEvent: eventSource(), onDetach: eventSource(), async attach({ tabId }) { calls.push({ type: "attach", tabId }); if (options.attach) await options.attach(tabId); },
      async detach({ tabId }) { calls.push({ type: "detach", tabId }); if (options.detach) await options.detach(tabId); },
      async sendCommand({ tabId }, method, params) {
        calls.push({ type: "cdp", tabId, method, params, time: clock });
        if (options.command) { const value = await options.command(tabId, method, params); if (value !== undefined) return value; }
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "cdp-" + tabId, url: tabs.get(tabId)?.url } } };
        if (method === "Page.captureScreenshot") return { data: Buffer.from("png").toString("base64") };
        if (method === "Page.getResourceContent") return { content: "cached-style", base64Encoded: false };
        if (method === "Network.getResponseBody") return { body: '{"ok":true}', base64Encoded: false };
        return {};
      } },
  };
  const settingsStorage = options.settingsStorage ?? { async get() { return { [FLOW_SETTINGS_KEY]: LEGACY_FLOW_SETTINGS }; } };
  const bg = createFlowBackground({ chrome, store, settingsStorage, now: () => clock, uuid: () => "id-" + ++serial, limits: { commandMs: 30, detachMs: 30, stopMs: 15, flushMs: 30, ...options.limits } });
  const sender = (tabId = 7, extra = {}) => ({ id: chrome.runtime.id, tab: { id: tabId }, frameId: 0, documentId: "doc-" + tabId, url: tabs.get(tabId)?.url, origin: new URL(tabs.get(tabId)?.url || root.url).origin, ...extra });
  const start = () => bg.handle({ type: "START", tab: { id: 7, url: "https://forged.test/" } });
  const settings = async (s = sender()) => (await bg.handle({ type: "FLOW_SETTINGS" }, s)).value;
  const batch = (s, settings, list, batchId = "batch-1") => bg.handle({ type: "FLOW_EVENTS", ...settings, batchId, events: list }, s);
  const stop = async () => bg.handle({ type: "STOP", sessionId: [...sessions.keys()].at(-1) });
  async function request(tabId, id, extra = {}) { await bg.debuggerEvent({ tabId }, "Network.requestWillBeSent", { requestId: id, type: "Fetch", frameId: "cdp-" + tabId, documentURL: tabs.get(tabId).url, request: { url: "https://api.test/find?q=original&token=secret", method: "GET", headers: { Authorization: "synthetic" } }, ...extra }); }
  async function response(tabId, id, response = {}, finished = {}) {
    await bg.debuggerEvent({ tabId }, "Network.responseReceived", { requestId: id, response: { url: "https://api.test/find?q=original&token=secret", status: 200, mimeType: "application/json", headers: {}, ...response } });
    await bg.debuggerEvent({ tabId }, "Network.loadingFinished", { requestId: id, encodedDataLength: 10, ...finished });
  }
  return { bg, chrome, store, sessions, calls, events, contents, tabs, frames, sender, start, settings, batch, stop, request, response, advance(ms) { clock += ms; }, now: () => clock };
}
const event = (h, kind = "ui.click", payload = {}) => ({ kind, time: h.now(), payload: { trusted: true, ...payload } });

it("binds START to exact root and excludes 20 unrelated tabs/events without global registration", async () => {
  const h = harness(); h.bg.install();
  assert.equal((await h.start()).value.status, "recording");
  for (let id = 20; id < 40; id++) {
    h.tabs.set(id, { id, url: "https://unrelated.test/" });
    h.chrome.tabs.onUpdated.fire(id, { status: "complete" });
    await h.bg.committed({ tabId: id, frameId: 0, url: h.tabs.get(id).url });
    await h.bg.created(h.tabs.get(id));
    assert.equal((await h.bg.handle({ type: "FLOW_SETTINGS" }, h.sender(id))).ok, false);
  }
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7]);
  assert.equal(h.calls.filter((c) => c.type === "inject").every((c) => c.target.tabId === 7 && c.target.documentIds?.[0] === "doc-7" && !c.target.allFrames && c.files[0] === "content.js"), true);
  assert.equal((await h.stop()).value.status, "ready");
});
it("rejects ungranted root, spoofed origin, stale owner/document and page START", async () => {
  assert.equal((await harness({ permission: () => false }).start()).ok, false);
  const h = harness(); await h.start(); const s = await h.settings();
  assert.equal((await h.bg.handle({ type: "FLOW_READY", ...s }, h.sender(7, { origin: "https://evil.test" }))).ok, false);
  assert.equal((await h.batch(h.sender(7, { documentId: "old" }), s, [event(h)])).ok, false);
  assert.equal((await h.batch(h.sender(), { ...s, ownerToken: "old" }, [event(h)])).ok, false);
  assert.equal((await h.bg.handle({ type: "START", tab: { id: 7 } }, h.sender())).ok, false);
  await h.stop();
});
it("admits one opener child only within 2 seconds of persisted trusted click/submit", async () => {
  const h = harness(); await h.start(); const s = await h.settings();
  await h.bg.created({ id: 8, openerTabId: 7, url: "https://erp.test/detail" });
  assert.equal(h.calls.some((c) => c.type === "attach" && c.tabId === 8), false);
  await h.batch(h.sender(), s, [event(h, "ui.click")]);
  h.tabs.set(8, { id: 8, url: "https://erp.test/detail" });
  await h.bg.created({ ...h.tabs.get(8), openerTabId: 7 });
  await h.bg.created({ id: 9, openerTabId: 7, url: "https://erp.test/too-many" });
  await h.bg.created({ id: 10, url: "https://erp.test/no-opener" });
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7, 8]);
  assert.equal(h.events.filter((e) => e.kind === "scope.child").length, 1);
  await h.stop();
});
it("waits at most one bounded candidate for click persistence and cannot admit two racing children", async () => {
  let saved; const saving = new Promise((resolve) => { saved = resolve; });
  const h = harness({ append: (e) => e.kind === "ui.click" ? saving : undefined });
  await h.start(); const s = await h.settings();
  const capture = h.batch(h.sender(), s, [event(h)]); await tick();
  h.tabs.set(8, { id: 8, url: "https://erp.test/child" });
  const child = h.bg.created({ ...h.tabs.get(8), openerTabId: 7 });
  const other = h.bg.created({ id: 9, openerTabId: 7, url: "https://erp.test/other" });
  assert.equal(h.calls.some((c) => c.type === "attach" && c.tabId === 8), false);
  saved(); await capture; await child; await other;
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7, 8]);
  await h.stop();
});
it("admits initial about:blank child only after HTTP update and a saved trusted gesture", async () => {
  const h = harness(); h.bg.install(); await h.start(); const s = await h.settings();
  await h.batch(h.sender(), s, [event(h)]);
  h.tabs.set(8, { id: 8, url: "about:blank" });
  const child = h.bg.created({ ...h.tabs.get(8), openerTabId: 7 }); await tick();
  assert.equal(h.calls.some((c) => c.type === "attach" && c.tabId === 8), false);
  assert.deepEqual((await h.bg.handle({ type: "GET_STATUS" })).value.active.scope.tabIds, [7]);
  h.tabs.get(8).url = "https://erp.test/child";
  h.chrome.tabs.onUpdated.fire(8, { url: h.tabs.get(8).url }); await child;
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7, 8]);
  assert.equal(h.events.find((e) => e.kind === "scope.child").payload.url, "https://erp.test/child");
  await h.stop();
});
it("accepts exact pending child commit as URL evidence without observing unrelated navigations", async () => {
  const h = harness(); h.bg.install(); await h.start(); const s = await h.settings();
  await h.batch(h.sender(), s, [event(h)]);
  h.tabs.set(8, { id: 8, url: "" });
  const child = h.bg.created({ ...h.tabs.get(8), openerTabId: 7 }); await tick();
  h.chrome.webNavigation.onCommitted.fire({ tabId: 20, frameId: 0, url: "https://unrelated.test/" });
  assert.equal(h.events.some((e) => e.tabId === 20), false);
  h.tabs.get(8).url = "https://erp.test/child";
  h.chrome.webNavigation.onCommitted.fire({ tabId: 8, frameId: 0, url: h.tabs.get(8).url }); await child;
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7, 8]);
  await h.stop();
});
it("never scopes a blank child without a trusted gesture; bounded candidate expires", async () => {
  const h = harness(); h.bg.install(); await h.start();
  h.tabs.set(8, { id: 8, url: "about:blank" });
  const child = h.bg.created({ ...h.tabs.get(8), openerTabId: 7 });
  h.tabs.get(8).url = "https://erp.test/unattributed";
  h.chrome.tabs.onUpdated.fire(8, { url: h.tabs.get(8).url }); await child;
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7]);
  assert.ok(h.events.some((e) => e.payload.reason === "child_gesture_unconfirmed"));
  const s = await h.settings(); await h.batch(h.sender(), s, [event(h)]);
  h.tabs.set(9, { id: 9, url: "https://erp.test/valid" });
  await h.bg.created({ ...h.tabs.get(9), openerTabId: 7 });
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7, 9]);
  await h.stop();
});
it("retains same root across authorized cross-origin commit; stale document cannot write", async () => {
  const h = harness(); await h.start(); const s = await h.settings();
  h.tabs.get(7).url = "https://new-origin.test/flow";
  h.frames.set(7, [{ frameId: 0, url: h.tabs.get(7).url, documentId: "new-doc" }]);
  await h.bg.committed({ tabId: 7, frameId: 0, url: h.tabs.get(7).url, documentId: "new-doc", timeStamp: h.now() });
  const sender = h.sender(7, { documentId: "new-doc" });
  assert.equal((await h.bg.handle({ type: "FLOW_READY", ...s }, sender)).ok, true);
  assert.equal((await h.batch(h.sender(), s, [event(h)])).ok, false);
  assert.equal((await h.bg.handle({ type: "GET_STATUS" })).value.active.rootTabId, 7);
  await h.stop();
});
it("injects each authorized document once and iframe navigation cannot reset root event identity", async () => {
  const h = harness({ permission: (origin) => !origin.includes("denied.test") }); h.bg.install();
  h.frames.get(7).push({ frameId: 2, url: "https://erp.test/frame", documentId: "sub-old" }, { frameId: 3, url: "https://denied.test/private", documentId: "denied" });
  await h.start(); const s = await h.settings();
  await h.batch(h.sender(), s, [event(h, "ui.change", { value: "before-frame-navigation" })], "root-batch-1");
  h.frames.get(7)[1] = { frameId: 2, url: "https://erp.test/frame-next", documentId: "sub-new" };
  await h.bg.committed({ tabId: 7, ...h.frames.get(7)[1] });
  h.chrome.tabs.onUpdated.fire(7, { status: "complete" }); await tick(); await tick();
  const injected = h.calls.filter((c) => c.type === "inject");
  assert.equal(injected.filter((c) => c.target.documentIds?.includes("doc-7")).length, 1);
  assert.equal(injected.filter((c) => c.target.documentIds?.includes("sub-old")).length, 1);
  assert.equal(injected.filter((c) => c.target.documentIds?.includes("sub-new")).length, 1);
  assert.equal(injected.some((c) => c.target.allFrames || c.target.documentIds?.includes("denied")), false);
  assert.equal((await h.batch(h.sender(), s, [event(h, "ui.change", { value: "after-frame-navigation" })], "root-batch-2")).value.accepted, 1);
  assert.deepEqual(h.events.filter((e) => e.kind === "ui.change").map((e) => e.payload.value), ["before-frame-navigation", "after-frame-navigation"]);
  assert.deepEqual((await h.bg.handle({ type: "GET_STATUS" })).value.active.scope.tabIds, [7]);
  await h.stop();
});
it("never attributes an earlier created candidate to a later user gesture", async () => {
  const h = harness(); h.bg.install(); await h.start(); const s = await h.settings();
  h.tabs.set(8, { id: 8, url: "https://erp.test/unrelated-before-click" });
  const child = h.bg.created({ ...h.tabs.get(8), openerTabId: 7 }); await tick();
  h.advance(10); await h.batch(h.sender(), s, [event(h)]); await child;
  assert.deepEqual(h.calls.filter((c) => c.type === "attach").map((c) => c.tabId), [7]);
  assert.deepEqual((await h.bg.handle({ type: "GET_STATUS" })).value.active.scope.tabIds, [7]);
  assert.ok(h.events.some((e) => e.payload.reason === "child_gesture_unconfirmed"));
  await h.stop();
});
it("preserves URL/query/headers, extracts request body once and keeps tab+CDP request identity", async () => {
  const h = harness(); await h.start();
  await h.request(7, "same", { request: { url: "https://api.test/do?q=a&a=b", method: "POST", headers: { Authorization: "original" }, postData: "hello", hasPostData: true } });
  await h.response(7, "same");
  assert.equal(h.events.find((e) => e.kind === "network.request").payload.url, "https://api.test/do?q=a&a=b");
  assert.equal(h.events.find((e) => e.kind === "network.request").payload.headers.Authorization, "original");
  assert.equal(h.contents.find((c) => c.field === "bodyText").category, "body");
  assert.equal(h.calls.some((c) => c.method === "Network.getRequestPostData"), false);
  assert.equal(h.events.find((e) => e.kind === "network.response").frameId, 0);
  await h.stop();
});
it("preflights encoded/header sizes and rejects unknown oversize after CDP decode", async () => {
  const h = harness({ command: (_tab, method) => method === "Network.getResponseBody" ? { body: "x".repeat(FLOW_LIMITS.body + 1), base64Encoded: false } : undefined });
  await h.start();
  await h.request(7, "header"); await h.response(7, "header", { headers: { "Content-Length": String(FLOW_LIMITS.body + 1) } });
  await h.request(7, "encoded"); await h.response(7, "encoded", {}, { encodedDataLength: FLOW_LIMITS.body + 1 });
  assert.equal(h.calls.filter((c) => c.method === "Network.getResponseBody").length, 0);
  await h.request(7, "unknown"); await h.response(7, "unknown");
  assert.equal(h.calls.filter((c) => c.method === "Network.getResponseBody").length, 1);
  assert.equal(h.contents.filter((c) => c.category === "body").length, 0);
  assert.equal(h.events.find((e) => e.payload.requestId === "7:unknown:1" && e.kind === "network.response").payload.bodyStatus.reason, "decoded_body_limit");
  await h.stop();
});
it("reads observed CSS resources only through Page cache; never JS/media/Document raw body", async () => {
  const h = harness(); await h.start(); const s = await h.settings();
  await h.batch(h.sender(), s, [event(h, "page.resources", { urls: [{ url: "https://erp.test/a.css", type: "stylesheet" }] })]);
  await tick();
  assert.equal(h.calls.filter((c) => c.method === "Page.getResourceContent").length, 1);
  for (const type of ["Script", "Media", "Document"]) { await h.request(7, type, { type }); await h.response(7, type, { mimeType: "text/html" }); }
  assert.equal(h.calls.filter((c) => c.method === "Network.getResponseBody").length, 0);
  assert.equal(h.events.some((e) => e.payload.bodyStatus?.reason === "document_dom_canonical"), true);
  await h.stop();
});
it("preflights current local category budget before CDP body command", async () => {
  const h = harness(); await h.start(); const session = [...h.sessions.values()][0];
  session.budget.byCategory.body = 24 * 1024 * 1024;
  await h.request(7, "budget"); await h.response(7, "budget");
  assert.equal(h.calls.some((c) => c.method === "Network.getResponseBody"), false);
  const stopped = await h.stop(); assert.equal(stopped.ok, true); assert.equal(stopped.value.status, "ready");
});
it("never stores WS/SSE message text while retaining count/byte summaries", async () => {
  const h = harness(); await h.start();
  await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketCreated", { requestId: "ws", url: "wss://erp.test/live", initiator: { frameId: "cdp-7" } });
  await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketFrameReceived", { requestId: "ws", response: { payloadData: "private-frame", opcode: 1 } });
  await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketClosed", { requestId: "ws" });
  await h.request(7, "sse", { type: "EventSource" });
  await h.bg.debuggerEvent({ tabId: 7 }, "Network.eventSourceMessageReceived", { requestId: "sse", data: "secret-sse" });
  await h.response(7, "sse", { mimeType: "text/event-stream" });
  assert.doesNotMatch(JSON.stringify(h.events), /private-frame|secret-sse/);
  assert.equal(h.events.find((e) => e.payload.type === "websocket_summary").payload.count, 1);
  assert.equal(h.events.find((e) => e.payload.stream).payload.stream.count, 1);
  await h.stop();
});
it("omits WebSocket URL/query for unattributed and unauthorized frames instead of assuming root", async () => {
  let iframeAllowed = true;
  const h = harness({ permission: (origin) => !origin.includes("ungranted.test") && (!origin.includes("frame.test") || iframeAllowed) });
  h.frames.get(7).push({ frameId: 2, url: "https://ungranted.test/private", documentId: "denied" }, { frameId: 3, url: "https://frame.test/page", documentId: "frame-3" });
  await h.start();
  await h.bg.debuggerEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "cdp-denied", parentId: "cdp-7", url: "https://ungranted.test/private" } });
  await h.bg.debuggerEvent({ tabId: 7 }, "Page.frameNavigated", { frame: { id: "cdp-frame", parentId: "cdp-7", url: "https://frame.test/page" } });
  iframeAllowed = false;
  for (const [requestId, initiator] of [["unknown", undefined], ["denied", { frameId: "cdp-denied" }], ["revoked", { frameId: "cdp-frame" }]]) {
    await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketCreated", { requestId, url: "wss://private.test/socket?secret=do-not-store-" + requestId, initiator });
    await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketClosed", { requestId });
  }
  assert.equal(h.events.some((e) => e.kind === "network.websocket"), false);
  assert.ok(h.events.some((e) => e.payload.reason === "websocket_frame_unattributed"));
  assert.ok(h.events.some((e) => e.payload.reason === "websocket_frame_not_readable"));
  await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketCreated", { requestId: "known-root", url: "wss://erp.test/allowed", initiator: { frameId: "cdp-7" } });
  await h.bg.debuggerEvent({ tabId: 7 }, "Network.webSocketClosed", { requestId: "known-root" });
  assert.equal(h.events.find((e) => e.payload.type === "websocket_connect").frameId, 0);
  await h.stop();
  assert.doesNotMatch(JSON.stringify(h.events), /private\.test|do-not-store|secret=/);
});
it("screenshots only CDP visible viewport, associates frame/time, throttles and ignores hover", async () => {
  const h = harness(); await h.start(); const s = await h.settings();
  await h.bg.handle({ type: "FLOW_READY", ...s }, h.sender()); await tick();
  await h.batch(h.sender(), s, [event(h, "page.snapshot", { reason: "click" })]);
  assert.equal(h.calls.filter((c) => c.method === "Page.captureScreenshot").length, 1);
  h.advance(1001);
  await h.batch(h.sender(), s, [event(h, "page.snapshot", { reason: "change" })], "batch-2"); await tick();
  const captures = h.calls.filter((c) => c.method === "Page.captureScreenshot");
  assert.equal(captures.length, 1); // one already scheduled stable capture, not an unbounded queue
  assert.equal(captures[0].params.captureBeyondViewport, false);
  assert.equal(captures[0].tabId, 7);
  const screenshot = h.events.find((e) => e.kind === "screenshot");
  assert.equal(screenshot.frameId, 0); assert.equal(screenshot.payload.sourceTime, 10000);
  assert.equal((await h.batch(h.sender(), s, [event(h, "ui.hover")], "hover")).ok, false);
  await h.stop();
});
it("deduplicates retry batch, ignores page-supplied attribution and isolates a second session", async () => {
  const h = harness(); await h.start(); let s = await h.settings();
  const list = [{ ...event(h), tabId: 999, frameId: 99, documentId: "evil", sessionId: "evil" }];
  assert.equal((await h.batch(h.sender(), s, list)).value.accepted, 1);
  assert.equal((await h.batch(h.sender(), s, list)).value.accepted, 1);
  assert.equal(h.events.filter((e) => e.kind === "ui.click").length, 1);
  assert.equal(h.events.find((e) => e.kind === "ui.click").tabId, 7);
  await h.stop(); await h.start();
  assert.equal((await h.batch(h.sender(), s, [event(h)])).ok, false);
  s = await h.settings(); assert.equal((await h.batch(h.sender(), s, [event(h)])).ok, true);
  await h.stop();
});
it("policy rejection auto-stops with durable reason, rejects further producers and keeps user tab untouched", async () => {
  const h = harness({ reject: (e) => e.kind === "ui.click" }); await h.start(); const s = await h.settings();
  const reply = await h.batch(h.sender(), s, [event(h)]);
  assert.equal(reply.value.accepted, 0); assert.equal(reply.value.policyStopped, true);
  const stopped = await h.stop(); assert.equal(stopped.ok, true); assert.equal(stopped.value.status, "ready");
  assert.equal(stopped.value.stopOutcome.reason, "category-body-limit");
  assert.equal((await h.batch(h.sender(), s, [event(h)], "late")).ok, false);
  assert.equal(h.tabs.get(7).url, "https://erp.test/orders");
  assert.equal(h.calls.filter((c) => c.type === "append" && c.event.kind === "session.stop").length, 1);
});
it("failed storage ACK is not success and seals interrupted rather than policy ready", async () => {
  const h = harness({ failed: (e) => e.kind === "ui.click" }); await h.start(); const s = await h.settings();
  assert.equal((await h.batch(h.sender(), s, [event(h)])).ok, false);
  const stopped = await h.stop(); assert.equal(stopped.value.status, "interrupted");
});
it("Stop flushes scoped frames concurrently, detaches then drains/gates/finalizes exactly once", async () => {
  const h = harness(); h.frames.get(7).push({ frameId: 2, url: "https://erp.test/frame", documentId: "sub" });
  await h.start();
  const [a, b] = await Promise.all([h.stop(), h.stop()]); assert.equal(a.ok, true); assert.equal(b.ok, true);
  const flushes = h.calls.filter((c) => c.type === "message" && c.message.type === "FLOW_FLUSH");
  assert.equal(flushes.length, 2); assert.equal(flushes.every((c) => c.message.ownerToken), true);
  const types = h.calls.map((c) => c.type);
  assert.ok(types.indexOf("detach") < types.indexOf("close")); assert.ok(types.indexOf("close") < types.indexOf("seal"));
  assert.equal(h.events.filter((e) => e.kind === "session.stop").length, 1);
  assert.equal(h.events.at(-1).kind, "session.stop");
});
it("Stop during preparation remains visible, prevents a second Start and cleans late attachment", async () => {
  let finish; const attached = new Promise((resolve) => { finish = resolve; });
  const h = harness({ attach: () => attached });
  const started = await h.bg.handle({ type: "START", tab: { id: 7 }, acknowledgeEarly: true });
  assert.equal(started.value.status, "preparing");
  assert.equal((await h.start()).ok, false);
  const stop = h.stop(); await tick();
  assert.equal((await h.bg.handle({ type: "GET_STATUS" })).value.active.status, "stopping");
  finish(); const result = await stop; assert.equal(result.ok, true);
  assert.ok(h.calls.some((c) => c.type === "detach"));
});
it("new-worker recovery seals only active flow sessions, missing-read failure cannot create a new record", async () => {
  const h = harness();
  await h.store.createSession({ id: "recovery", ownerToken: "owner", status: "recording", rootTabId: 7 });
  await h.bg.ready(); assert.equal(h.sessions.get("recovery").status, "interrupted"); assert.equal(h.sessions.get("recovery").writeGate, "sealed");
  const bad = createFlowBackground({ chrome: h.chrome, store: { ...h.store, listSessions: async () => { throw new Error("db-read-failed"); } } });
  assert.equal((await bad.handle({ type: "START", tab: { id: 7 } })).ok, false);
  assert.equal(h.sessions.size, 1);
});
it("source import graph contains no legacy browser-wide recorder or forbidden read commands", async () => {
  const source = await readFile(new URL("../src/flow-background.js", import.meta.url), "utf8");
  assert.deepEqual([...source.matchAll(/^import .*from "([^"]+)"/gm)].map((match) => match[1]), ["./flow-store.js", "./flow-config.js"]);
  for (const forbidden of ["registerContentScripts", "getRequestPostData", "getCookies", "getResourceTree", "captureVisibleTab", "Storage.", "IndexedDB.", "CacheStorage.", "tabs.query", "fetch("]) assert.equal(source.includes(forbidden), false, forbidden);
  assert.ok(source.split("\n").length <= 1000);
});

function memorySettings(initial) {
  let saved = initial === undefined ? {} : { [FLOW_SETTINGS_KEY]: clone(initial) };
  const calls = { gets: 0, sets: 0 };
  return { calls, async get() { calls.gets++; return clone(saved); }, async set(value) { calls.sets++; saved = clone(value); } };
}
const tokens = (settings) => ({ sessionId: settings.sessionId, ownerToken: settings.ownerToken });
const partMessage = (settings, overrides = {}) => ({ type: "FLOW_CONTENT_PART", ...tokens(settings), transferId: "synthetic-transfer", field: "sourceHtml", category: "dom", mime: "text/html", index: 0, parts: 2, byteLength: 2, text: "a", ...overrides });
const transferEvent = (h, transferId = "synthetic-transfer") => ({ ...event(h, "page.snapshot", { reason: "checkpoint" }), contents: [{ field: "sourceHtml", category: "dom", mime: "text/html", transferId }] });

it("GET/SAVE/RESET persist only exact settings and reject page or foreign controls", async () => {
  const storage = memorySettings(), h = harness({ settingsStorage: storage });
  const first = await h.bg.handle({ type: "GET_LIMIT_SETTINGS" });
  assert.equal(first.ok, true); assert.deepEqual(first.value.settings, DEFAULT_FLOW_SETTINGS); assert.equal(first.value.maximumMultiplier, 20);
  assert.equal(first.value.limits.budget.totalBytes, 1280 * 1024 * 1024);
  for (const settings of [null, {}, { ...DEFAULT_FLOW_SETTINGS, schemaVersion: 2 }, { ...DEFAULT_FLOW_SETTINGS, budgetMultiplier: 0 },
    { ...DEFAULT_FLOW_SETTINGS, queueMultiplier: 21 }, { ...DEFAULT_FLOW_SETTINGS, samplingMultiplier: 1.5 },
    { ...DEFAULT_FLOW_SETTINGS, queueMultiplier: "2" }, { ...DEFAULT_FLOW_SETTINGS, extra: 1 }]) {
    assert.equal((await h.bg.handle({ type: "SAVE_LIMIT_SETTINGS", settings })).ok, false);
  }
  assert.equal(storage.calls.sets, 0);
  for (const type of ["GET_LIMIT_SETTINGS", "SAVE_LIMIT_SETTINGS", "RESET_LIMIT_SETTINGS"]) {
    assert.equal((await h.bg.handle({ type, settings: LEGACY_FLOW_SETTINGS }, h.sender())).ok, false);
    assert.equal((await h.bg.handle({ type, settings: LEGACY_FLOW_SETTINGS }, { id: "another-extension", url: h.chrome.runtime.getURL("panel.html") })).ok, false);
  }
  assert.equal(storage.calls.sets, 0);
  const control = { id: h.chrome.runtime.id, tab: { id: 99 }, url: h.chrome.runtime.getURL("sidepanel.html") };
  assert.equal((await h.bg.handle({ type: "SAVE_LIMIT_SETTINGS", settings: LEGACY_FLOW_SETTINGS }, control)).ok, true);
  assert.deepEqual((await h.bg.handle({ type: "GET_LIMIT_SETTINGS" })).value.settings, LEGACY_FLOW_SETTINGS);
  assert.deepEqual((await h.bg.handle({ type: "RESET_LIMIT_SETTINGS" })).value.settings, DEFAULT_FLOW_SETTINGS);
  assert.equal(storage.calls.sets, 2); assert.equal(h.sessions.size, 0);
});

it("START reads once, freezes capture limits through live save and restarts with persisted settings", async () => {
  const storage = memorySettings(), h = harness({ settingsStorage: storage });
  const started = await h.start(); assert.equal(started.ok, true); assert.equal(storage.calls.gets, 1);
  assert.deepEqual(started.value.capturePolicy.settings, DEFAULT_FLOW_SETTINGS);
  assert.deepEqual(h.sessions.get(started.value.id).settings, DEFAULT_FLOW_SETTINGS);
  const before = await h.settings();
  assert.equal(before.captureLimits.background.body, 40 * 1024 * 1024);
  await h.bg.handle({ type: "SAVE_LIMIT_SETTINGS", settings: LEGACY_FLOW_SETTINGS });
  assert.deepEqual((await h.bg.handle({ type: "GET_LIMIT_SETTINGS" })).value.settings, LEGACY_FLOW_SETTINGS);
  assert.deepEqual((await h.settings()).captureLimits, before.captureLimits);
  assert.deepEqual((await h.bg.handle({ type: "FLOW_READY", ...tokens(before) }, h.sender())).value.captureLimits, before.captureLimits);
  await h.stop();
  let serial = 0;
  const restarted = createFlowBackground({ chrome: h.chrome, store: h.store, settingsStorage: storage, uuid: () => "restart-" + ++serial });
  const second = await restarted.handle({ type: "START", tab: { id: 7 } });
  assert.deepEqual(second.value.capturePolicy.settings, LEGACY_FLOW_SETTINGS);
  const current = (await restarted.handle({ type: "FLOW_SETTINGS" }, h.sender())).value;
  assert.equal(current.captureLimits.background.body, 2 * 1024 * 1024);
  await restarted.handle({ type: "STOP", sessionId: second.value.id });
  assert.equal(h.calls.filter((call) => call.type === "patch").some((call) => call.patch.settings || call.patch.capturePolicy || call.patch.budget), false);
});

it("settings storage failures are surfaced and missing mock storage alone may use defaults", async () => {
  const h = harness(), storage = { async get() { throw new Error("settings-read-failed"); }, async set() { throw new Error("settings-write-failed"); } };
  const failed = createFlowBackground({ chrome: { ...h.chrome, storage: { local: storage } }, store: h.store });
  assert.match((await failed.handle({ type: "GET_LIMIT_SETTINGS" })).error, /settings-read-failed/);
  assert.match((await failed.handle({ type: "START", tab: { id: 7 } })).error, /settings-read-failed/); assert.equal(h.sessions.size, 0);
  assert.match((await failed.handle({ type: "SAVE_LIMIT_SETTINGS", settings: LEGACY_FLOW_SETTINGS })).error, /settings-write-failed/);
  assert.match((await failed.handle({ type: "RESET_LIMIT_SETTINGS" })).error, /settings-write-failed/);
  const malformed = createFlowBackground({ chrome: { ...h.chrome, storage: {} }, store: h.store });
  assert.equal((await malformed.handle({ type: "GET_LIMIT_SETTINGS" })).ok, false);
  const mock = createFlowBackground({ chrome: h.chrome, store: h.store });
  assert.deepEqual((await mock.handle({ type: "GET_LIMIT_SETTINGS" })).value.settings, DEFAULT_FLOW_SETTINGS);
});

it("accepts a CDP body over 2 MiB at 20x while 1x skips it before reading", async () => {
  const body = "x".repeat(3 * 1024 * 1024);
  for (const settings of [LEGACY_FLOW_SETTINGS, DEFAULT_FLOW_SETTINGS]) {
    const h = harness({ settingsStorage: memorySettings(settings), command: (_tab, method) => method === "Network.getResponseBody" ? { body, base64Encoded: false } : undefined });
    await h.start(); await h.request(7, "large"); await h.response(7, "large", { headers: { "content-length": String(body.length) } }, { encodedDataLength: body.length });
    const response = h.events.find((entry) => entry.kind === "network.response");
    assert.equal(h.contents.some((content) => content.bytes === body), settings.budgetMultiplier === 20);
    assert.equal(h.calls.some((call) => call.method === "Network.getResponseBody"), settings.budgetMultiplier === 20);
    if (settings.budgetMultiplier === 1) assert.equal(response.payload.bodyStatus.reason, "known_body_limit");
    await h.stop();
  }
});

it("assembles ASCII and UTF-8 content using the content script chunk size, confirming Blob hashes and exact retries", async () => {
  const contentSource = await readFile(new URL("../src/flow-content.js", import.meta.url), "utf8");
  const partChars = Number(contentSource.match(/PART_CHARS = (\d+)/)[1]); assert.equal(partChars, 131072);
  for (const raw of ["x".repeat(3 * 1024 * 1024), "x".repeat(partChars - 1) + "💆" + "中".repeat(1000000)]) {
    const h = harness({ settingsStorage: memorySettings(DEFAULT_FLOW_SETTINGS) }); await h.start(); const settings = await h.settings(), pieces = [];
    for (let offset = 0; offset < raw.length;) { let end = Math.min(raw.length, offset + partChars); if (end < raw.length && /[\uD800-\uDBFF]/.test(raw[end - 1])) end--; pieces.push(raw.slice(offset, end)); offset = end; }
    let receivedBytes = 0;
    for (let index = 0; index < pieces.length; index++) {
      const part = partMessage(settings, { index, parts: pieces.length, byteLength: Buffer.byteLength(raw), text: pieces[index] });
      const reply = await h.bg.handle(part, h.sender()); receivedBytes += Buffer.byteLength(pieces[index]);
      assert.deepEqual(reply, { ok: true, value: { transferId: part.transferId, index, receivedBytes, complete: index + 1 === pieces.length } });
      assert.deepEqual(await h.bg.handle(part, h.sender()), reply); assert.equal(h.contents.length, 0);
    }
    const list = [transferEvent(h)], final = await h.batch(h.sender(), settings, list, "transfer-batch");
    assert.equal(final.value.accepted, 1); assert.equal(h.contents.length, 1);
    assert.ok(h.contents[0].bytes instanceof Blob); assert.equal(await h.contents[0].bytes.text(), raw);
    assert.equal(createHash("sha256").update(Buffer.from(await h.contents[0].bytes.arrayBuffer())).digest("hex"), createHash("sha256").update(raw).digest("hex"));
    assert.deepEqual(await h.batch(h.sender(), settings, list, "transfer-batch"), final); assert.equal(h.contents.length, 1);
    assert.equal((await h.batch(h.sender(), settings, list, "reused-transfer")).ok, false); await h.stop();
  }
});

it("rejects malformed, reordered, foreign and incomplete part references; navigation and Stop clear incomplete transfers", async () => {
  const h = harness(); await h.start(); const settings = await h.settings(), part = partMessage(settings);
  assert.equal((await h.bg.handle({ ...part, index: 1 }, h.sender())).ok, false);
  assert.equal((await h.bg.handle({ ...part, ownerToken: "stale" }, h.sender())).ok, false);
  assert.equal((await h.bg.handle({ ...part, parts: 999999 }, h.sender())).ok, false);
  assert.equal((await h.bg.handle({ ...part, byteLength: 2 * 1024 * 1024 + 1 }, h.sender())).ok, false);
  assert.equal((await h.bg.handle(part, h.sender())).ok, true);
  assert.equal((await h.bg.handle({ ...part, text: "b" }, h.sender())).ok, false);
  assert.equal((await h.batch(h.sender(), settings, [transferEvent(h)])).ok, false);
  const oversized = partMessage(settings, { transferId: "oversized", text: "x".repeat(262145), byteLength: 262146 });
  assert.equal((await h.bg.handle(oversized, h.sender())).ok, false);
  h.frames.set(7, [{ frameId: 0, url: h.tabs.get(7).url, documentId: "doc-next" }]);
  await h.bg.committed({ tabId: 7, frameId: 0, url: h.tabs.get(7).url, documentId: "doc-next" });
  assert.equal((await h.bg.handle({ ...part, index: 1, text: "b" }, h.sender())).ok, false);
  const current = h.sender(7, { documentId: "doc-next" });
  assert.equal((await h.bg.handle({ ...part, index: 1, text: "b" }, current)).ok, false);
  assert.equal((await h.batch(current, settings, [transferEvent(h)], "after-navigation")).ok, false);
  assert.equal((await h.bg.handle(part, current)).ok, true);
  const stopped = await h.stop(); assert.equal(stopped.value.status, "ready");
  assert.equal(stopped.value.coverage.reasons.content_transfer_navigation, 1); assert.equal(stopped.value.coverage.reasons.content_transfer_incomplete, 1);
  assert.equal(h.contents.length, 0);
});

it("preflights declared 40 MiB transfers without allocating them and atomically bounds concurrent reservations", async () => {
  const h = harness({ settingsStorage: memorySettings(DEFAULT_FLOW_SETTINGS) }); await h.start(); const settings = await h.settings();
  const max = deriveFlowLimits(DEFAULT_FLOW_SETTINGS).background.body;
  for (let n = 0; n < 4; n++) {
    const result = await h.bg.handle(partMessage(settings, { transferId: "reserved-" + n, byteLength: max, parts: Math.ceil(max / 131072) }), h.sender());
    assert.equal(result.ok, true);
  }
  const overflow = await h.bg.handle(partMessage(settings, { transferId: "overflow", byteLength: max, parts: Math.ceil(max / 131072) }), h.sender());
  assert.equal(overflow.value.policyStopped, true);
  const stopped = await h.stop(); assert.equal(stopped.value.stopOutcome.reason, "content_transfer_queue_limit"); assert.equal(h.contents.length, 0);
});
