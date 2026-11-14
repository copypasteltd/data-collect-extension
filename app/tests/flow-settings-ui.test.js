import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";
const { build } = createRequire(import.meta.resolve("vite"))("esbuild");
import { DEFAULT_FLOW_SETTINGS, MAX_MULTIPLIER, deriveFlowLimits, MiB } from "../src/flow-config.js";
import { recordingNotice } from "../src/panel-state.js";

// Execute the real JSX and its event callbacks in Node with isolated hook slots.
// Native Chrome permission/user-gesture and viewport layout need separate E2E.
const compiled = await build({ entryPoints: [fileURLToPath(new URL("../src/sidepanel.jsx", import.meta.url))], bundle: true, write: false, format: "cjs", platform: "node", loader: { ".css": "empty" },
  plugins: [{ name: "pure-panel-boundaries", setup(api) {
    api.onResolve({ filter: /^(react|react-dom\/client|lucide-react)$|\/(flow-archive|downloads)\.js$/ }, ({ path }) => ({ path, namespace: "fixture" }));
    api.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path }) => ({ contents: path === "react" ? "module.exports = globalThis.hooks" : path === "react-dom/client"
      ? "exports.createRoot = () => ({render: (tree) => {globalThis.rootTree = tree}})" : path === "lucide-react"
        ? "exports.AlertTriangle = exports.Circle = exports.Download = exports.Square = () => null" : path.endsWith("flow-archive.js")
          ? "exports.createArchive = (...args) => globalThis.archive(...args)" : "exports.downloadBlob = (...args) => globalThis.download(...args)" }));
  } }],
});
const code = compiled.outputFiles[0].text;
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const reply = (settings = DEFAULT_FLOW_SETTINGS) => ({ settings, defaults: DEFAULT_FLOW_SETTINGS, maximumMultiplier: MAX_MULTIPLIER, limits: deriveFlowLimits(settings) });
const text = (node) => Array.isArray(node) ? node.map(text).join("") : React.isValidElement(node) ? text(node.props.children) : node === false || node == null ? "" : String(node);
function descendants(node) { return Array.isArray(node) ? node.flatMap(descendants) : React.isValidElement(node) ? [node, ...descendants(node.props.children)] : []; }

async function panel(options = {}) {
  const slots = new Map(), timers = new Map(), intervals = new Map(), messages = [], effects = [], events = [];
  let current, cursor = 0, changed = true, tree, timerId = 0, saved = options.settings || DEFAULT_FLOW_SETTINGS;
  let active = options.active || null;
  const sessions = [{ id: "synthetic-ready", startedAt: 1, status: "ready" }];
  const same = (a, b) => !!a && !!b && a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
  const hooks = { ...React,
    useState(initial) { const instance = current, index = cursor++; if (!Object.hasOwn(instance, index)) instance[index] = { value: typeof initial === "function" ? initial() : initial };
      return [instance[index].value, (value) => { const next = typeof value === "function" ? value(instance[index].value) : value; if (!Object.is(next, instance[index].value)) { instance[index].value = next; changed = true; } }]; },
    useRef(initial) { const index = cursor++; return current[index] ||= { current: initial }; },
    useCallback(callback, deps) { const index = cursor++; if (!same(current[index]?.deps, deps)) current[index] = { deps, value: callback }; return current[index].value; },
    useEffect(callback, deps) { const instance = current, index = cursor++; if (!same(instance[index]?.deps, deps)) { const previous = instance[index]; instance[index] = { deps }; effects.push(() => { previous?.cleanup?.(); instance[index].cleanup = callback(); }); } },
  };
  const context = vm.createContext({ hooks, AbortController, URL, document: { getElementById: () => ({}) },
    setTimeout: (run, ms) => { timers.set(++timerId, { run, ms }); return timerId; }, clearTimeout: (id) => timers.delete(id),
    setInterval: (run, ms) => { intervals.set(++timerId, { run, ms }); return timerId; }, clearInterval: (id) => intervals.delete(id),
    archive: options.archive || (async () => ({ blob: new Blob(["synthetic"]), cleanup: async () => { events.push("cleanup"); }, metrics: { largeFormat: "zip64", storage: "opfs" } })),
    download: options.download || (async () => { events.push("download"); }),
    chrome: { runtime: { getURL: (path) => `chrome-extension://synthetic/${path}`, async sendMessage(message) {
      messages.push(message); events.push(message.type);
      if (options.handlers?.[message.type]) return { ok: true, value: await options.handlers[message.type](message) };
      if (message.type === "GET_STATUS") return { ok: true, value: { active } };
      if (message.type === "GET_STATE") return { ok: true, value: { sessions } };
      if (message.type === "GET_LIMIT_SETTINGS") return { ok: true, value: reply(saved) };
      if (message.type === "SAVE_LIMIT_SETTINGS") { saved = message.settings; return { ok: true, value: reply(saved) }; }
      if (message.type === "RESET_LIMIT_SETTINGS") { saved = DEFAULT_FLOW_SETTINGS; return { ok: true, value: reply(saved) }; }
      if (message.type === "STOP") { active = null; return { ok: true, value: { id: message.sessionId } }; }
      if (message.type === "START") { active = { id: "synthetic-active", status: "recording" }; return { ok: true }; }
      throw new Error(`Unexpected message ${message.type}`);
    } }, tabs: { query: async () => { events.push("tabs"); return [{ id: 7, url: "https://synthetic.test/business" }]; } },
    permissions: { request: async () => { events.push("permission"); return true; } } },
  });
  function materialize(node, path = "root") {
    if (Array.isArray(node)) return node.map((child, index) => materialize(child, `${path}/${index}`));
    if (!React.isValidElement(node)) return node;
    if (typeof node.type === "function") {
      const key = `${path}:${node.type.name}`; if (!slots.has(key)) slots.set(key, []); current = slots.get(key); cursor = 0;
      return materialize(node.type(node.props), `${key}/output`);
    }
    return React.cloneElement(node, { key: node.key ?? path }, materialize(node.props.children, `${path}/children`));
  }
  async function flush() {
    for (let round = 0; round < 6; round++) {
      for (let render = 0; changed; render++) { assert.ok(render < 20, "hook state should settle"); changed = false; tree = materialize(context.rootTree); for (const run of effects.splice(0)) run(); }
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  vm.runInContext(code, context, { timeout: 2000 });
  await flush();
  const find = (predicate) => descendants(tree).find(predicate);
  return { messages, events, flush, text: () => text(tree), html: () => renderToStaticMarkup(tree), nodes: () => descendants(tree),
    button: (label) => find((node) => node.type === "button" && text(node).includes(label)),
    field: (key) => find((node) => node.type === "input" && node.props.name === key),
    submit: () => find((node) => node.type === "form").props.onSubmit({ preventDefault() {} }),
    async change(key, value) { this.field(key).props.onChange({ target: { value } }); await flush(); },
    async poll(next = active) { active = next; for (const { run, ms } of intervals.values()) if (ms === 2000) run(); await flush(); },
    async timeout(ms) { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.run(); } await flush(); },
    close() { for (const instance of slots.values()) for (const slot of instance) slot?.cleanup?.(); },
  };
}

test("initial read timeout blocks Start without inventing defaults, retry loads persisted values", async () => {
  const pending = deferred(); let reads = 0;
  const h = await panel({ handlers: { GET_LIMIT_SETTINGS: () => ++reads === 1 ? pending.promise : reply({ ...DEFAULT_FLOW_SETTINGS, queueMultiplier: 3 }) } });
  assert.equal(h.button("开始录制").props.disabled, true); assert.equal(h.field("budgetMultiplier").props.value, "");
  await h.timeout(8000); assert.match(h.text(), /读取设置失败.*后台响应超时/); assert.equal(h.button("开始录制").props.disabled, true);
  await h.button("重新读取设置").props.onClick(); await h.flush();
  assert.equal(h.field("queueMultiplier").props.value, 3); assert.equal(h.button("开始录制").props.disabled, false);
  assert.match(h.text(), /当前已保存 3 倍/); h.close();
});

test("three labelled integer controls show twentyfold concrete budgets, categories, queues and sampling", async () => {
  const h = await panel();
  const fields = [["budgetMultiplier", "容量倍率"], ["queueMultiplier", "待处理队列倍率"], ["samplingMultiplier", "页面采样倍率"]];
  for (const [key, label] of fields) { const node = h.field(key);
    assert.deepEqual([node.props.type, Number(node.props.min), node.props.max, Number(node.props.step), node.props.value], ["number", 1, 20, 1, 20]);
    assert.ok(h.nodes().some((n) => n.type === "label" && n.props.htmlFor === node.props.id && text(n) === label));
  }
  for (const value of ["1280 MiB（1.25 GiB）", "960 MiB", "40 MiB", "480 MiB", "320 MiB", "160 MiB", "240 MiB", "80 MiB", "1,280 项", "640 项", "240,000 个节点"]) assert.ok(h.text().includes(value), value);
  assert.equal(h.nodes().find((n) => n.type === "details").props.open, undefined);
  assert.match(h.html(), /<summary>/); assert.doesNotMatch(h.text(), /ZIP64|zip64|OPFS|opfs|largeFormat|200 倍/); h.close();
});

test("invalid drafts have nearby announced errors, cannot save or start, and polls preserve drafts", async () => {
  const h = await panel();
  for (const key of ["budgetMultiplier", "queueMultiplier", "samplingMultiplier"]) {
    for (const value of ["", "0", "21", "1.5", "NaN"]) {
      await h.change(key, value); const input = h.field(key);
      assert.equal(input.props["aria-invalid"], true); assert.equal(h.button("保存到本机").props.disabled, true); assert.equal(h.button("开始录制").props.disabled, true);
      const error = h.nodes().find((n) => n.props.id === `${input.props.id}-error`); assert.equal(error.props.role, "alert"); assert.match(text(error), /1–20/);
      assert.ok(input.props["aria-describedby"].includes(error.props.id)); h.submit(); await h.flush();
    }
    await h.change(key, "20"); assert.equal(h.button("开始录制").props.disabled, false);
  }
  await h.change("budgetMultiplier", "1"); await h.change("queueMultiplier", "2"); await h.poll();
  assert.equal(h.field("budgetMultiplier").props.value, "1"); assert.equal(h.field("queueMultiplier").props.value, "2");
  assert.match(h.text(), /草稿尚未保存.*先保存草稿/); assert.match(h.text(), /64 MiB/);
  await h.button("开始录制").props.onClick(); assert.equal(h.events.includes("permission"), false); assert.equal(h.events.includes("SAVE_LIMIT_SETTINGS"), false);
  assert.equal(h.messages.filter((m) => m.type === "GET_LIMIT_SETTINGS").length, 1); h.close();
});

test("save failure retains dirty inputs without success, successful save needs a separate Start gesture", async () => {
  let fail = true;
  const h = await panel({ handlers: { SAVE_LIMIT_SETTINGS: ({ settings }) => { if (fail) throw new Error("本机存储不可用"); return reply(settings); } } });
  await h.change("budgetMultiplier", "1"); h.submit(); await h.flush();
  assert.match(h.text(), /保存设置失败：本机存储不可用/); assert.doesNotMatch(h.text(), /已保存到本机；/);
  assert.equal(h.field("budgetMultiplier").props.value, "1"); assert.equal(h.button("开始录制").props.disabled, true);
  fail = false; h.submit(); await h.flush(); assert.match(h.text(), /已保存到本机；仅下一批生效/); assert.equal(h.events.includes("permission"), false);
  assert.equal(h.button("开始录制").props.disabled, false);
  await h.button("开始录制").props.onClick(); await h.flush();
  const save = h.messages.find((m) => m.type === "SAVE_LIMIT_SETTINGS"); assert.equal(save.settings.budgetMultiplier, 1);
  const start = h.messages.find((m) => m.type === "START"); assert.equal(Object.hasOwn(start, "settings"), false); assert.ok(h.events.indexOf("permission") < h.events.indexOf("START")); h.close();
});

test("recording can save and reset next-batch settings while current legacy budget and Stop remain available", async () => {
  const pending = deferred();
  const active = { id: "synthetic-legacy", status: "recording", budget: { usedBytes: 49 * MiB, limitBytes: 64 * MiB, warning: true } };
  const h = await panel({ active, handlers: { SAVE_LIMIT_SETTINGS: () => pending.promise } });
  await h.change("budgetMultiplier", "1"); h.submit(); await h.flush();
  assert.equal(h.button("停止录制").props.disabled, false); assert.match(h.text(), /正在录制时保存仅下一批生效/);
  assert.ok(h.text().includes("已保存 49 MiB / 64 MiB"));
  pending.reject(new Error("保存失败")); await h.flush(); assert.equal(h.button("停止录制").props.disabled, false);
  await h.button("恢复默认 20 倍").props.onClick(); await h.flush(); assert.equal(h.field("budgetMultiplier").props.value, 20); assert.match(h.text(), /已恢复默认 20 倍并保存到本机/);
  assert.ok(h.text().includes("已保存 49 MiB / 64 MiB"));
  await h.button("停止录制").props.onClick(); await h.flush(); assert.ok(h.messages.some((m) => m.type === "STOP" && m.sessionId === active.id)); h.close();
});

test("settings read failure keeps Stop usable during an active recording", async () => {
  const h = await panel({ active: { id: "synthetic-active", status: "recording" }, handlers: { GET_LIMIT_SETTINGS: () => { throw new Error("无法读取本机设置"); } } });
  assert.match(h.text(), /读取设置失败：无法读取本机设置/); assert.equal(h.button("停止录制").props.disabled, false);
  await h.button("停止录制").props.onClick(); await h.flush(); assert.ok(h.messages.some((m) => m.type === "STOP")); h.close();
});

test("active budget notices follow session limitBytes independently of settings presence", () => {
  assert.match(recordingNotice({ budget: { warning: true, limitBytes: 1280 * MiB } }), /1280 MiB（1.25 GiB）/);
  assert.match(recordingNotice({ budget: { warning: true, limitBytes: 64 * MiB } }), /64 MiB/);
  assert.doesNotMatch(recordingNotice({ budget: { warning: true } }), /48|64/);
});

test("closing during archive creation aborts its producer and cleans its eventual result without downloading", async () => {
  const pending = deferred(), events = []; let signal;
  const h = await panel({ archive: async (_id, _progress, options) => { signal = options.signal; return pending.promise; }, download: async () => { events.push("download"); } });
  const operation = h.button("导出记录包").props.onClick(); await h.flush(); h.close(); assert.equal(signal.aborted, true);
  pending.resolve({ blob: new Blob(["synthetic"]), cleanup: async () => { events.push("cleanup"); } });
  await operation; assert.deepEqual(events, ["cleanup"]);
});

for (const outcome of ["complete", "failed", "closed"]) test(`archive cleanup waits for download settlement (${outcome}), Stop stays independent`, async () => {
  const waiting = deferred(), events = []; let signal;
  const h = await panel({ archive: async (_id, _progress, options) => { signal = options.signal; events.push("archive"); return { blob: new Blob(["synthetic"]), cleanup: async () => { events.push("cleanup"); }, metrics: { largeFormat: "zip64" } }; },
    download: async () => { events.push("download"); return waiting.promise; } });
  const operation = h.button("导出记录包").props.onClick(); await h.flush(); assert.deepEqual(events, ["archive", "download"]);
  await h.poll({ id: "synthetic-other-panel", status: "recording" }); assert.equal(h.button("停止录制").props.disabled, false);
  if (outcome === "closed") { h.close(); assert.equal(signal.aborted, true); assert.deepEqual(events, ["archive", "download"]); }
  if (outcome === "failed") waiting.reject(new Error("下载未完成")); else waiting.resolve(7);
  await operation; await h.flush(); assert.deepEqual(events, ["archive", "download", "cleanup"]);
  if (outcome === "failed") { assert.match(h.text(), /下载未完成/); assert.doesNotMatch(h.text(), /记录包已保存/); }
  assert.doesNotMatch(h.text(), /ZIP64|zip64|OPFS|opfs/); h.close();
});
