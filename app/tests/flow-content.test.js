import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("../src/flow-content.js", import.meta.url), "utf8");
class Events {
  listeners = new Map();
  addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type, new Set()); this.listeners.get(type).add(fn); }
  removeEventListener(type, fn) { this.listeners.get(type)?.delete(fn); }
  dispatch(type, target = this, extra = {}) {
    const event = { type, target, isTrusted: true, composedPath: () => [target], ...extra };
    for (const fn of this.listeners.get(type) || []) fn(event);
  }
  count() { return [...this.listeners.values()].reduce((n, set) => n + set.size, 0); }
}
function element(tag, attrs = {}, children = []) {
  const node = Object.assign(new Events(), { nodeType: 1, localName: tag, attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    getAttribute(name) { return this.attributes.find((a) => a.name === name)?.value ?? null; },
    cloneNode() { throw new Error("unbounded clone forbidden"); } });
  for (let i = 0; i < children.length; i++) { children[i].parentElement = node; children[i].nextSibling = children[i + 1]; }
  Object.defineProperty(node, "outerHTML", { get() { throw new Error("unbounded outerHTML forbidden"); } });
  node.firstChild = children[0]; return node;
}
const text = (data) => ({ nodeType: 3, data, length: data.length });
const input = (value = "old") => Object.assign(element("input", { id: "customer", type: "text" }), { value, checked: false, disabled: false });
function harness({ body = element("body", {}, [input()]), sheets = [], reply, settings, crypto = webcrypto } = {}) {
  let now = 10000, counter = 0;
  const jobs = new Map(), messages = [], listeners = new Set(), observers = [], acknowledgements = new Set();
  const document = Object.assign(new Events(), { documentElement: element("html", {}, [body]), baseURI: "https://sample.test/order", title: "Synthetic order", styleSheets: sheets });
  const window = new Events(), location = { href: document.baseURI };
  class DateMock extends Date { static now() { return now; } }
  class Observer { constructor(fn) { this.fn = fn; observers.push(this); } observe() { this.connected = true; } disconnect() { this.connected = false; } }
  const runtime = {
    onMessage: { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } },
    sendMessage(message) {
      messages.push(message);
      if (message.type === "FLOW_SETTINGS") return settings ? settings(message) : Promise.resolve({ ok: true, value: { sessionId: "s1", ownerToken: "t1", profile: "business-flow-v1" } });
      if (message.type === "FLOW_EVENTS") {
        const result = reply ? reply(message) : { ok: true, value: { accepted: message.events.length, failed: 0, policyStopped: false } };
        return Promise.resolve(result).then((ack) => { acknowledgements.add(message.batchId); return ack; });
      }
      return Promise.resolve({ ok: true });
    },
  };
  const context = vm.createContext({ chrome: { runtime }, document, window, location, Date: DateMock, TextEncoder, Uint8Array, URL, CSS: { escape: (s) => s },
    crypto, MutationObserver: Observer, innerWidth: 1000, innerHeight: 700, scrollX: 0, scrollY: 0,
    setTimeout(fn, ms = 0) { const id = ++counter; jobs.set(id, { fn, due: now + Math.max(ms, 0) }); return id; }, clearTimeout(id) { jobs.delete(id); } });
  const turn = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(setImmediate); };
  async function advance(ms = 0) {
    await turn(); const end = now + ms;
    for (let guard = 0; guard < 1000; guard++) {
      const [id, job] = [...jobs.entries()].sort((a, b) => a[1].due - b[1].due)[0] || [];
      if (!job || job.due > end) break;
      jobs.delete(id); now = job.due; job.fn(); await turn();
    }
    now = end; await turn();
  }
  async function until(predicate, label, timeoutMs = 3000) {
    const deadline = performance.now() + timeoutMs;
    do { await advance(); if (predicate()) return; await turn(); } while (performance.now() < deadline);
    assert.fail("Timed out waiting for " + label);
  }
  function request(type, overrides = {}) {
    return new Promise((resolve) => { for (const fn of listeners) fn({ type, sessionId: "s1", ownerToken: "t1", ...overrides }, {}, resolve); });
  }
  function mutate(target, extra = {}) { for (const observer of observers) if (observer.connected) observer.fn([{ type: "attributes", target, ...extra }]); }
  const run = () => vm.runInContext(source, context, { timeout: 2000 }); run();
  return { context, document, window, location, messages, observers, listeners, advance, until, request, mutate, run,
    allAcknowledged: () => messages.filter((m) => m.type === "FLOW_EVENTS").every((m) => acknowledgements.has(m.batchId)),
    events: () => messages.filter((m) => m.type === "FLOW_EVENTS").flatMap((m) => m.events),
    dispose: () => context.__logicRecorderFlowV1.dispose() };
}
const snapshots = (h) => h.events().filter((e) => e.kind === "page.snapshot");
const html = (event) => event.contents.find((c) => c.field === "sourceHtml").bytes;

test("standalone source keeps one bounded HTML structure, property forms, inert script policy, CSS hash and URL metadata", async () => {
  const field = input("actual property");
  const script = element("script", { src: "/app.js", onclick: "evidenceOnly()" }, [text("secret script text")]);
  const image = Object.assign(element("img"), { currentSrc: "https://sample.test/visible.png", complete: true, naturalWidth: 10 });
  const css = ':root { --x: 1; } @font-face { src: url("font.woff2"); }';
  const h = harness({ body: element("body", {}, [field, script, image]), sheets: [{ href: "https://sample.test/style.css", cssRules: [{ cssText: css }] }] });
  await h.until(() => snapshots(h).length === 1 && h.allAcknowledged(), "initial snapshot and real batch acknowledgements");
  assert.equal(h.messages.find((m) => m.type === "FLOW_READY").ownerToken, "t1");
  const first = snapshots(h)[0];
  assert.match(html(first), /actual property|<input/);
  assert.match(html(first), /<script[^>]+src="\/app.js"/);
  assert.ok(!html(first).includes("secret script text"));
  assert.equal(first.payload.forms[0].value, "actual property");
  assert.equal(first.contents.filter((c) => c.field === "sourceHtml").length, 1);
  assert.ok(first.payload.policies.includes("script-text-separate-policy"));
  assert.equal(h.events().find((e) => e.kind === "page.stylesheet").contents[0].bytes, css);
  const urls = h.events().find((e) => e.kind === "page.resources").payload.urls;
  assert.ok(urls.some((u) => u.type === "font" && u.url.endsWith("font.woff2")));
  assert.ok(urls.some((u) => u.type === "image" && u.url.endsWith("visible.png")));
  h.document.dispatch("click", field); await h.advance(600);
  await h.until(() => snapshots(h).length === 2 && h.allAcknowledged(), "click snapshot and real batch acknowledgements");
  assert.equal(h.events().filter((e) => e.kind === "page.stylesheet").length, 1);
  assert.ok(snapshots(h)[1].time - first.time >= 500);
  h.dispose();
});

test("stable input and change keep known beforeValue, large raw values use content refs without redaction", async () => {
  const field = input("original"), h = harness({ body: element("body", {}, [field]) }); await h.advance();
  h.document.dispatch("beforeinput", field); field.value = "甲乙!"; h.document.dispatch("input", field);
  field.value = "甲乙丙!"; h.document.dispatch("input", field); await h.advance(300);
  const event = h.events().find((e) => e.kind === "ui.input");
  assert.equal(event.payload.beforeValue, "original"); assert.equal(event.payload.value, "甲乙丙!");
  field.value = "changed"; h.document.dispatch("change", field); await h.advance();
  const change = h.events().find((e) => e.kind === "ui.change");
  assert.equal(change.payload.beforeValue, "甲乙丙!"); assert.equal(change.payload.value, "changed");
  const long = "私".repeat(4000); field.value = long; h.document.dispatch("change", field); await h.advance(600);
  const last = h.events().filter((e) => e.kind === "ui.change").at(-1);
  assert.equal(last.contents.find((c) => c.field === "value").bytes, long);
  assert.ok(!("value" in last.payload));
  assert.ok(snapshots(h).at(-1).contents.some((c) => c.field.startsWith("formValue") && c.bytes === long));
  h.dispose();
});

test("fast fill then blur coalesces pending input into change without losing before/current raw values", async () => {
  const field = input("old"), h = harness({ body: element("body", {}, [field]) }); await h.advance();
  h.document.dispatch("beforeinput", field); field.value = "newvalue💆"; h.document.dispatch("input", field);
  h.document.dispatch("change", field); h.document.dispatch("click", field); await h.advance(900);
  const changes = h.events().filter((e) => e.kind === "ui.change");
  assert.equal(changes.length, 1); assert.equal(changes[0].payload.beforeValue, "old");
  assert.equal(changes[0].payload.value, "newvalue💆");
  assert.equal(h.events().filter((e) => e.kind === "ui.input").length, 0);
  h.document.dispatch("beforeinput", field); field.value = "stable new"; h.document.dispatch("input", field); await h.advance(300);
  const stable = h.events().find((e) => e.kind === "ui.input");
  assert.equal(stable.payload.beforeValue, "newvalue💆"); assert.equal(stable.payload.value, "stable new"); h.dispose();
});

test("only key/validation/navigation/stable scroll are captured; mutation is coalesced checkpoints not raw stream", async () => {
  const field = input(), dialog = element("dialog", { open: "" }), h = harness({ body: element("body", {}, [field, dialog]) }); await h.advance();
  for (const type of ["pointermove", "mousemove", "mouseover", "focus", "focusin"]) h.document.dispatch(type, field);
  h.document.dispatch("keydown", field, { key: "a" }); h.document.dispatch("keydown", field, { key: "Enter" });
  h.document.dispatch("invalid", field); h.window.dispatch("popstate"); h.location.href += "#done"; h.window.dispatch("hashchange");
  for (let i = 0; i < 50; i++) h.mutate(dialog);
  for (let i = 0; i < 20; i++) h.document.dispatch("scroll", h.document);
  await h.advance(600);
  assert.equal(h.events().filter((e) => e.kind === "ui.key").length, 1);
  assert.equal(h.events().filter((e) => e.kind === "ui.scroll").length, 1);
  assert.equal(h.events().filter((e) => e.kind === "page.navigation").length, 2);
  assert.equal(snapshots(h).length, 2); assert.equal(snapshots(h)[1].payload.reason, "validation");
  assert.ok(!h.events().some((e) => /mutation|focus|pointer|hover/.test(e.kind)));
  const count = snapshots(h).length; for (let i = 0; i < 100; i++) h.mutate(field); await h.advance(600);
  assert.equal(snapshots(h).length, count); h.dispose();
});

test("FLOW_FLUSH freezes listeners, waits final checkpoint and real ACK; STOP_CAPTURE synchronously closes and rejects old tokens", async () => {
  let hold = false, release;
  const field = input(), h = harness({ body: element("body", {}, [field]), reply: (message) => hold ? new Promise((r) => { release = () => r({ ok: true, value: { accepted: message.events.length, failed: 0, policyStopped: false } }); }) :
    Promise.resolve({ ok: true, value: { accepted: message.events.length, failed: 0, policyStopped: false } }) });
  await h.advance(); const stale = await h.request("STOP_CAPTURE", { ownerToken: "older" }); assert.equal(stale.ok, false); assert.ok(h.document.count());
  hold = true; let done = false; const flushing = h.request("FLOW_FLUSH").then((r) => { done = true; return r; });
  assert.equal(h.document.count(), 0); await h.advance(500); assert.equal(done, false);
  release(); await h.advance(); const result = await flushing;
  assert.equal(result.ok, true); assert.equal(result.value.confirmed, true); assert.equal(result.value.pending, 0);
  assert.equal(snapshots(h).at(-1).payload.reason, "stop");
  const count = h.events().length; const stopped = await h.request("STOP_CAPTURE"); assert.equal(stopped.ok, true);
  h.document.dispatch("click", field); await h.advance(600); assert.equal(h.events().length, count); h.dispose();
});

test("partial write / malformed ACK never produces successful flush; policy stops and notifies", async () => {
  for (const ack of [{ ok: true, value: { accepted: 0, failed: 1, policyStopped: false } },
    { ok: true, value: { accepted: 0, failed: 0, policyStopped: false } },
    { ok: true, value: { accepted: 0, failed: 0, policyStopped: true, reason: "dom-budget" } }]) {
    const h = harness({ reply: () => Promise.resolve(ack) }); await h.advance();
    const p = h.request("FLOW_FLUSH"); await h.advance(600); const result = await p;
    assert.equal(result.ok, false); assert.equal(result.value.confirmed, false);
    assert.equal(h.document.count(), 0);
    if (ack.value.policyStopped) assert.ok(h.messages.some((m) => m.type === "FLOW_POLICY_STOPPED"));
    h.dispose();
  }
});

test("settings 5s deadline and message deadlines do not pretend a collected or flushed page", async () => {
  const h = harness({ settings: () => new Promise(() => {}) }); await h.advance(5000);
  assert.equal(h.document.count(), 0); assert.equal(h.listeners.size, 0); assert.equal(h.events().length, 0);
  const j = harness({ reply: () => new Promise(() => {}) }); await j.advance();
  const p = j.request("FLOW_FLUSH"); await j.advance(3000); const result = await p;
  assert.equal(result.ok, false); assert.ok(result.value.failed > 0); j.dispose();
});

test("DOM scan is bounded before serialization, giant text is explicit policy, and long forms never exceed 16 contents", async () => {
  const children = Array.from({ length: 13000 }, () => element("p", {}, [text("x")]));
  const h = harness({ body: element("body", {}, children) }); await h.advance();
  assert.ok(snapshots(h)[0].payload.nodes <= 12000); assert.ok(snapshots(h)[0].payload.policies.includes("dom-scan-limit"));
  assert.ok(Buffer.byteLength(html(snapshots(h)[0])) < 2 * 1024 * 1024); h.dispose();
  const fields = Array.from({ length: 20 }, () => input("原".repeat(2000)));
  const j = harness({ body: element("body", {}, [element("p", {}, [text("x".repeat(3 * 1024 * 1024))]), ...fields]) }); await j.advance();
  const snap = snapshots(j)[0]; assert.ok(snap.payload.policies.includes("text-size-limit"));
  assert.ok(snap.contents.length <= 16); assert.ok(snap.payload.forms.some((f) => f.value?.status === "policy"));
  assert.ok(snap.contents.reduce((n, c) => n + Buffer.byteLength(c.bytes), 0) < 2 * 1024 * 1024);
  j.dispose();
});

test("open shadow is bounded and form states preserved; unreadable CSS records explicit coverage policy", async () => {
  const host = element("x-order"), root = element("shadow-root", {}, [input("shadow original")]);
  host.shadowRoot = root;
  const inaccessible = { href: "https://other.test/style.css", get cssRules() { throw new Error("SecurityError"); } };
  const h = harness({ body: element("body", {}, [host]), sheets: [inaccessible] }); await h.advance();
  assert.match(html(snapshots(h)[0]), /shadowrootmode="open"/);
  assert.equal(snapshots(h)[0].payload.forms[0].value, "shadow original");
  assert.equal(snapshots(h)[0].payload.stylesheets[0].access, "unavailable");
  const field = root.firstChild; field.value = "shadow changed"; root.dispatch("change", field); await h.advance();
  assert.equal(h.events().find((e) => e.kind === "ui.change").payload.beforeValue, "shadow original");
  const listeners = root.count(), observers = h.observers.length; await h.advance(600);
  root.dispatch("change", field); await h.advance(600);
  assert.equal(root.count(), listeners); assert.equal(h.observers.length, observers); h.dispose();
});

test("shutdown while checkpoint throttle wait is pending still settles capture chain", async () => {
  const h = harness(); await h.advance();
  const flushing = h.request("FLOW_FLUSH"); await h.advance(100);
  assert.equal((await h.request("STOP_CAPTURE")).ok, true);
  let result; flushing.then((value) => { result = value; });
  await h.advance(500); assert.ok(result, "non-cancelled throttle sleep must settle before 3s flush deadline");
  assert.equal(result.value.failed, 0); h.dispose();
});



test("same-owner reinjection preserves in-flight and queued changes instead of replaying batch identifiers", async () => {
  let hold = false, release;
  const field = input("old"), h = harness({ body: element("body", {}, [field]), reply: (message) => hold ? new Promise((resolve) => {
    release = () => resolve({ ok: true, value: { accepted: message.events.length, failed: 0, policyStopped: false } });
  }) : Promise.resolve({ ok: true, value: { accepted: message.events.length, failed: 0, policyStopped: false } }) });
  await h.advance(); const identity = h.context.__logicRecorderFlowV1.identity(), count = h.document.count();
  hold = true; field.value = "first queued value"; h.document.dispatch("change", field);
  field.value = "second queued value💆"; h.document.dispatch("change", field);
  const batchCount = h.messages.filter((m) => m.type === "FLOW_EVENTS").length;
  h.run(); h.run(); await h.advance();
  assert.equal(h.document.count(), count); assert.equal(h.listeners.size, 1);
  assert.equal(h.context.__logicRecorderFlowV1.identity().ownerToken, identity.ownerToken);
  assert.equal(h.messages.filter((m) => m.type === "FLOW_READY").length, 1);
  assert.equal(snapshots(h).filter((e) => e.payload.reason === "initial").length, 1);
  assert.equal(h.messages.filter((m) => m.type === "FLOW_EVENTS").length, batchCount);
  hold = false; release(); await h.until(() => h.allAcknowledged() && h.events().some((e) => e.payload.value === "second queued value💆"), "preserved second change ACK");
  const changes = h.events().filter((e) => e.kind === "ui.change");
  assert.equal(changes.length, 2); assert.equal(changes[1].payload.beforeValue, "first queued value");
  const ids = h.messages.filter((m) => m.type === "FLOW_EVENTS").map((m) => m.batchId);
  assert.equal(new Set(ids).size, ids.length); h.dispose();
});

test("concurrent settings bootstrap is shared; same-token closed restart gets a fresh collector nonce", async () => {
  let resolveSettings;
  const h = harness({ settings: () => new Promise((resolve) => { resolveSettings = resolve; }) });
  h.run(); h.run(); await h.advance();
  assert.equal(h.messages.filter((m) => m.type === "FLOW_SETTINGS").length, 1);
  resolveSettings({ ok: true, value: { sessionId: "s1", ownerToken: "t1", profile: "business-flow-v1" } });
  await h.until(() => snapshots(h).length === 1 && h.allAcknowledged(), "shared bootstrap snapshot ACK");
  const first = h.messages.find((m) => m.type === "FLOW_EVENTS").batchId;
  assert.equal((await h.request("STOP_CAPTURE")).ok, true);
  h.run(); await h.advance();
  resolveSettings({ ok: true, value: { sessionId: "s1", ownerToken: "t1", profile: "business-flow-v1" } });
  await h.until(() => snapshots(h).length === 2 && h.allAcknowledged(), "fresh same-token restart ACK");
  const last = h.messages.filter((m) => m.type === "FLOW_EVENTS").at(-1).batchId;
  assert.notEqual(first, last); assert.equal(first.split(":").at(-1), "1"); assert.equal(last.split(":").at(-1), "1");
  assert.equal(h.listeners.size, 1); assert.equal(h.messages.filter((m) => m.type === "FLOW_READY").length, 2); h.dispose();
});

test("transient 20ms alert removed before 500ms checkpoint retains original added and removed text", async () => {
  const body = element("body"), h = harness({ body }); await h.advance();
  const message = "保存失败：余额不足💆", alert = element("div", { role: "alert" }, [text(message)]);
  await h.advance(20); body.firstChild = alert; alert.parentElement = body;
  h.mutate(body, { type: "childList", addedNodes: [alert], removedNodes: [] }); await h.advance(180);
  body.firstChild = undefined; alert.parentElement = null;
  h.mutate(body, { type: "childList", addedNodes: [], removedNodes: [alert] }); await h.advance(400);
  const notices = h.events().filter((e) => e.kind === "recorder.notice" && e.payload.reason === "transient_state");
  assert.equal(notices.length, 2); assert.equal(notices[0].payload.action, "added"); assert.equal(notices[1].payload.action, "removed");
  for (const event of notices) { assert.equal(event.payload.role, "alert"); assert.equal(event.payload.text, message); }
  assert.ok(!html(snapshots(h).at(-1)).includes(message)); assert.ok(notices[0].time < snapshots(h).at(-1).time); h.dispose();
});

test("transient original text uses top-level content and callback limits are explicit without reading whole markup", async () => {
  const body = element("body"), h = harness({ body }); await h.advance();
  const raw = "校验原值".repeat(300), alert = element("div", { role: "alert" }, [text(raw)]);
  h.mutate(body, { type: "childList", addedNodes: [alert], removedNodes: [] }); await h.advance();
  const notice = h.events().find((e) => e.payload.reason === "transient_state");
  assert.equal(notice.contents[0].field, "text"); assert.equal(notice.contents[0].bytes, raw); assert.ok(!("text" in notice.payload));
  const nodes = Array.from({ length: 20 }, () => element("div", { role: "alert" }, [text("short alert")]));
  const start = h.events().length;
  h.mutate(body, { type: "childList", addedNodes: nodes, removedNodes: [] }); await h.advance();
  const emitted = h.events().slice(start).filter((e) => e.payload.reason === "transient_state");
  assert.ok(emitted.length > 0 && emitted.length <= 8);
  assert.ok(emitted.reduce((n, e) => n + Buffer.byteLength(JSON.stringify(e.payload)) + (e.contents || []).reduce((m, c) => m + Buffer.byteLength(c.bytes), 0), 0) <= 8192);
  const large = element("div", { role: "alert" }, [text("x".repeat(1000000))]);
  h.mutate(body, { type: "childList", addedNodes: [large], removedNodes: [] }); await h.advance();
  const limited = h.events().filter((e) => e.payload.reason === "transient_state").at(-1);
  assert.equal(limited.payload.text.status, "policy"); assert.equal(limited.payload.text.reason, "transient-text-scan-limit"); h.dispose();
});

test("reinjection replaces only confirmed new ownership and old token cannot stop it", async () => {
  let generation = 0;
  const h = harness({ settings: () => Promise.resolve({ ok: true, value: { sessionId: "s1", ownerToken: "t" + (++generation), profile: "business-flow-v1" } }) });
  await h.advance(); h.run(); await h.advance();
  assert.equal(h.listeners.size, 1);
  const result = await h.request("STOP_CAPTURE"); assert.equal(result.ok, false); assert.ok(h.document.count());
  assert.equal((await h.request("STOP_CAPTURE", { ownerToken: "t2" })).ok, true); assert.equal(h.document.count(), 0); h.dispose();
});
