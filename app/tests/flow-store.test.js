import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, webcrypto } from "node:crypto";
import { FLOW_LIMITS as L, createBudget, MiB } from "../src/flow-budget.js";
import { DEFAULT_FLOW_SETTINGS, LEGACY_FLOW_SETTINGS, deriveFlowLimits, loadFlowSettings, saveFlowSettings } from "../src/flow-config.js";

// Executable in-memory IDB transaction VM: requests execute against transaction
// snapshots; request/commit faults roll back; a shared FIFO serializes connections.
// This is NOT a native Chrome / quota / durability claim. No real database/profile
// is opened. It is intentionally self-contained: fake-indexeddb is not installed.
function transactionVM() {
  const stores = new Map(), definitions = new Map(), opens = [], transactions = [], queue = [];
  const control = { fault: null, stallReads: false, abortCursorOnce: false, beforeCommit: null };
  let busy = false, opened = false;
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  const keyOf = (value) => JSON.stringify(value);
  const keyValue = (row, path) => Array.isArray(path) ? path.map((key) => row[key]) : row[path];
  const validKey = (key) => key !== undefined && (!Array.isArray(key) || key.every(validKey));
  function compare(a, b) {
    if (Array.isArray(a) && Array.isArray(b)) {
      for (let i = 0; i < Math.min(a.length, b.length); i++) { const order = compare(a[i], b[i]); if (order) return order; }
      return a.length - b.length;
    }
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const matches = (key, query) => query?.only !== undefined ? compare(key, query.only) === 0
    : query?.lower !== undefined ? (query.lowerOpen ? compare(key, query.lower) > 0 : compare(key, query.lower) >= 0) && (query.upperOpen ? compare(key, query.upper) < 0 : compare(key, query.upper) <= 0)
      : compare(key, query) === 0;
  function dispatch() {
    if (busy || !queue.length) return;
    busy = true; const tx = queue.shift(); tx.start();
  }
  function createTransaction(names, mode = "readonly") {
    names = Array.isArray(names) ? names : [names];
    const tx = {
      names, mode, error: null, aborted: false, finished: false, started: false, requests: [], snapshots: null, operations: [],
      objectStore(name) {
        assert.ok(names.includes(name), "scope enforcement");
        return access(name);
      },
      abort() {
        if (tx.finished) throw new Error("TransactionInactiveError");
        tx.aborted = true; tx.finished = true;
        setImmediate(() => { tx.onabort?.(); if (tx.started) { busy = false; dispatch(); } });
      },
      start() {
        if (tx.finished) { busy = false; dispatch(); return; }
        tx.started = true;
        tx.snapshots = new Map(names.map((name) => [name, new Map([...stores.get(name)].map(([key, value]) => [key, clone(value)]))]));
        pump();
      },
    };
    function fault(store, method) {
      if (control.fault?.store === store && control.fault.method === method) {
        const error = control.fault.error || new Error("synthetic-" + store + "-" + method);
        control.fault = null; throw error;
      }
    }
    function enqueue(store, method, action, request = {}) {
      if (tx.finished) throw new Error("TransactionInactiveError");
      tx.operations.push({ store, method });
      tx.requests.push(() => {
        if (tx.finished) return;
        try { fault(store, method); request.result = action(); request.onsuccess?.({ target: request }); }
        catch (error) {
          request.error = error; tx.error = error; request.onerror?.({ target: request });
          if (!tx.finished) tx.abort();
        }
      });
      return request;
    }
    function pump() {
      if (tx.finished || (control.stallReads && mode === "readonly")) return;
      if (tx.requests.length) {
        const run = tx.requests.shift();
        queueMicrotask(() => { run(); pump(); });
      } else setImmediate(() => {
        if (tx.finished) return;
        if (tx.requests.length) { pump(); return; }
        try {
          control.beforeCommit?.(tx);
          if (tx.finished) return;
          if (mode === "readwrite") for (const name of names) stores.set(name, tx.snapshots.get(name));
          tx.finished = true; tx.oncomplete?.(); busy = false; dispatch();
        } catch (error) { tx.error = error; tx.abort(); }
      });
    }
    function access(name, indexName) {
      const definition = definitions.get(name);
      const index = indexName ? definition.indexes.get(indexName) : undefined;
      if (indexName && !index) throw new Error("NotFoundError index " + indexName);
      const path = index?.keyPath || definition.keyPath;
      function rows(query) {
        return [...tx.snapshots.get(name).values()].filter((row) => query === undefined || matches(keyValue(row, path), query))
          .sort((a, b) => compare(keyValue(a, path), keyValue(b, path)) || compare(a.id, b.id));
      }
      const result = {
        index(indexName) { return access(name, indexName); },
        get(query) { return enqueue(name, "get", () => clone(rows(query)[0])); },
        count(query) { return enqueue(name, "count", () => rows(query).length); },
        openCursor(query) {
          const request = {}; let index = 0, snapshot;
          const next = () => enqueue(name, "cursor", () => {
            snapshot ||= rows(query);
            const row = snapshot[index++];
            if (!row) return null;
            const cursor = { value: clone(row), continue: next };
            if (control.abortCursorOnce) {
              control.abortCursorOnce = false;
              queueMicrotask(() => { if (!tx.finished) tx.abort(); });
            }
            return cursor;
          }, request);
          next(); return request;
        },
      };
      for (const method of ["add", "put"]) result[method] = (value) => {
        assert.equal(mode, "readwrite", "readonly writes forbidden");
        const snapshot = clone(value);
        return enqueue(name, method, () => {
          const map = tx.snapshots.get(name), key = keyOf(keyValue(snapshot, definition.keyPath));
          if (method === "add" && map.has(key)) throw new Error("ConstraintError");
          for (const item of definition.indexes.values()) if (item.unique) {
            const indexKey = keyValue(snapshot, item.keyPath);
            if (!validKey(indexKey)) continue;
            for (const [existingKey, row] of map) if (existingKey !== key && compare(keyValue(row, item.keyPath), indexKey) === 0) throw new Error("ConstraintError unique index");
          }
          map.set(key, clone(snapshot)); return keyValue(snapshot, definition.keyPath);
        });
      };
      return result;
    }
    transactions.push(tx); queue.push(tx); setImmediate(dispatch); return tx;
  }
  function connection() {
    return {
      closed: false,
      close() { this.closed = true; },
      createObjectStore(name, { keyPath }) {
        assert.equal(opened, false); assert.ok(!stores.has(name));
        stores.set(name, new Map()); const indexes = new Map(); definitions.set(name, { keyPath, indexes });
        return { createIndex(name, keyPath, options = {}) { indexes.set(name, { keyPath, ...options }); } };
      },
      transaction: createTransaction,
    };
  }
  const connections = [];
  return {
    control, opens, transactions, stores, definitions, connections,
    indexedDB: {
      open(name, version) {
        opens.push([name, version]); assert.equal(name, "logic-recorder-flow-v1"); assert.equal(version, 1);
        const request = {}, db = connection(); connections.push(db);
        queueMicrotask(() => {
          request.result = db;
          if (!opened) { request.transaction = { abort() { throw new Error("upgrade aborted"); } }; request.onupgradeneeded?.({ oldVersion: 0 }); opened = true; }
          request.onsuccess?.();
        });
        return request;
      },
      deleteDatabase() { throw new Error("Must never delete any database"); },
    },
    IDBKeyRange: { only: (only) => ({ only }), bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }) },
    row(store, id) { return clone(stores.get(store)?.get(keyOf(id))); },
    mutate(store, id, change) { const row = this.row(store, id); change(row); stores.get(store).set(keyOf(id), row); },
    remove(store, id) { stores.get(store).delete(keyOf(id)); },
  };
}

let moduleId = 0;
async function withVM(exercise) {
  const vm = transactionVM(), names = ["indexedDB", "IDBKeyRange", "crypto"], descriptors = names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: vm.indexedDB });
  Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: vm.IDBKeyRange });
  if (!globalThis.crypto?.subtle) Object.defineProperty(globalThis, "crypto", { configurable: true, value: webcrypto });
  const load = () => import("../src/flow-store.js?transactionVM=" + ++moduleId);
  try { const api = await load(); await exercise(api, vm, load); }
  finally {
    for (const connection of vm.connections) connection.onversionchange?.();
    for (const [key, descriptor] of descriptors) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key];
  }
}
const session = (id = "one") => ({ id, ownerToken: "synthetic-owner-" + id, title: "Synthetic flow", rootTabId: 3, settings: LEGACY_FLOW_SETTINGS });
const event = (value = "x") => ({ kind: "ui.input", time: 1234, payload: { value, trusted: true }, tabId: 3, frameId: 0 });
const content = (bytes, category = "body", field = "body") => ({ field, category, mime: "text/plain;charset=utf-8", bytes });
const byteSize = (raw) => new TextEncoder().encode(JSON.stringify(raw) + "\n").length;

test("only opens independent v1 schema; legacy DB is never opened/deleted/migrated", async () => withVM(async (api, vm) => {
  const result = await api.createSession(session());
  assert.equal(result.profile, "business-flow-v1"); assert.equal(result.writeGate, "open");
  assert.deepEqual(vm.opens, [["logic-recorder-flow-v1", 1]]);
  assert.deepEqual([...vm.definitions.keys()], ["sessions", "events", "contents"]);
  assert.deepEqual(vm.definitions.get("events").indexes.get("sessionSeq"), { keyPath: ["sessionId", "seq"], unique: true });
  assert.equal(vm.definitions.get("events").indexes.get("sessionCaptureKey").unique, true);
  assert.equal((await api.listSessions()).length, 1);
  assert.equal((await api.listSessions({ projection: true }))[0].ownerToken, undefined);
  assert.equal(api.projectSession(await api.getSession("one")).ownerToken, undefined);
  assert.equal((await api.getSession("one")).ownerToken, session().ownerToken);
}));

test("capturePolicy and producerVersion are canonical immutable create metadata, projected but not raw charged", async () => withVM(async (api) => {
  const created = await api.createSession({ ...session(), capturePolicy: { profile: "untrusted", limits: {} } });
  assert.equal(created.producerVersion, "0.5.0");
  assert.equal(created.capturePolicy.schemaVersion, 1);
  assert.equal(created.capturePolicy.profile, "business-flow-v1");
  assert.equal(created.capturePolicy.scope, "root-tab-and-attributed-child");
  assert.deepEqual(created.capturePolicy.limits, L);
  assert.ok(created.capturePolicy.notCollected.includes("cookies"));
  assert.ok(created.capturePolicy.notCollected.includes("indexedDB"));
  assert.equal(created.budget.usedBytes, 0);
  const projection = api.projectSession(created);
  assert.deepEqual(projection.capturePolicy, created.capturePolicy); assert.equal(projection.producerVersion, "0.5.0");
  assert.equal(projection.ownerToken, undefined);
  for (const patch of [{ capturePolicy: {} }, { producerVersion: "9.9.9" }]) await assert.rejects(async () => api.updateSession("one", session().ownerToken, patch), /protected-session-field/);
  created.capturePolicy.limits.totalBytes = 1;
  assert.equal((await api.getSession("one")).capturePolicy.limits.totalBytes, L.totalBytes);
  const custom = await api.createSession({ ...session("two"), producerVersion: " 0.4.1.3 " });
  assert.equal(custom.producerVersion, "0.4.1.3"); assert.equal(custom.budget.usedBytes, 0);
  for (const producerVersion of [null, 123, "", "v0.4.0", "0.4.0<script>", "65536.1", "0.4.0.1.2"]) {
    await assert.rejects(api.createSession({ ...session("invalid"), producerVersion }), /Invalid producerVersion/);
  }
  const appended = await api.appendCapture("one", session().ownerToken, event());
  assert.equal((await api.getSession("one")).budget.usedBytes, byteSize(appended.event));
}));

test("raw UTF-8 Blob hash references, same-session dedup and exact JSONL budget", async () => withVM(async (api) => {
  const owner = session().ownerToken; await api.createSession(session());
  const source = "你好 / YWJj / 🙂", hash = createHash("sha256").update(source).digest("hex");
  const first = await api.appendCapture("one", owner, event("first"), [content(source)]);
  const second = await api.appendCapture("one", owner, event("second"), [content(new TextEncoder().encode(source))]);
  assert.equal(first.accepted, 1); assert.equal(second.accepted, 1);
  assert.deepEqual(first.event.payload.body, { contentId: "one:" + hash, sha256: hash, size: Buffer.byteLength(source), mime: "text/plain;charset=utf-8", category: "body", status: "captured" });
  assert.equal(second.event.payload.body.contentId, first.event.payload.body.contentId);
  const rows = await api.readContents("one");
  assert.equal(rows.length, 1); assert.equal(await rows[0].blob.text(), source); assert.equal(rows[0].sha256, hash);
  assert.deepEqual(rows[0].categories, ["body"]);
  const saved = await api.getSession("one"), events = await api.readEvents("one");
  assert.deepEqual(events, [first.event, second.event]);
  assert.equal(saved.budget.usedBytes, Buffer.byteLength(source) + events.reduce((sum, row) => sum + byteSize(row), 0));
  assert.equal(saved.budget.byCategory.meta, events.reduce((sum, row) => sum + byteSize(row), 0));
  assert.equal(saved.eventCount, 2); assert.equal(saved.contentCount, 1); assert.equal(saved.lastSeq, 2);
  await api.createSession(session("two"));
  const other = await api.appendCapture("two", session("two").ownerToken, event(), [content(source)]);
  assert.equal(other.event.payload.body.contentId, "two:" + hash);
}));

test("UTF-8 strings, ArrayBuffer, offset Uint8Array and Blob all hash actual bytes", async () => withVM(async (api) => {
  await api.createSession(session()); const owner = session().ownerToken;
  const view = new Uint8Array([99, 65, 66, 77]).subarray(1, 3);
  const values = ["AB", new Uint8Array([65, 66]).buffer, view, new Blob(["AB"])];
  for (const bytes of values) assert.equal((await api.appendCapture("one", owner, event(), [content(bytes)])).accepted, 1);
  const rows = await api.readContents("one"); assert.equal(rows.length, 1); assert.equal(await rows[0].blob.text(), "AB");
}));

test("two module connections + concurrent append serialize row seq and budget", async () => withVM(async (api, vm, load) => {
  await api.createSession(session()); const second = await load();
  const calls = Array.from({ length: 72 }, (_, i) => (i % 2 ? api : second).appendCapture("one", session().ownerToken, event("value" + i), [content("same hash")], { captureKey: "batch:" + i }));
  const result = await Promise.all(calls);
  assert.ok(result.every((item) => item.accepted === 1));
  const rows = await api.readEvents("one"), saved = await second.getSession("one");
  assert.deepEqual(rows.map((row) => row.seq), Array.from({ length: 72 }, (_, i) => i + 1));
  assert.equal(new Set(rows.map((row) => row.id)).size, 72);
  assert.equal(saved.eventCount, 72); assert.equal(saved.contentCount, 1); assert.equal(saved.lastSeq, 72);
  assert.equal(saved.budget.usedBytes, Buffer.byteLength("same hash") + rows.reduce((sum, row) => sum + byteSize(row), 0));
  assert.equal(vm.connections.length, 2);
}));

test("captureKey is durable, private and idempotent before/after close/seal/restart", async () => withVM(async (api, vm, load) => {
  await api.createSession(session()); const owner = session().ownerToken;
  const calls = await Promise.all(Array.from({ length: 12 }, () => api.appendCapture("one", owner, event(), [content("abc")], { captureKey: "batch-1:0" })));
  assert.ok(calls.every((item) => item.event.seq === 1));
  assert.equal((await api.getSession("one")).eventCount, 1);
  assert.equal(calls[0].event.captureKey, undefined);
  const reopened = await load(), before = await reopened.getSession("one");
  // Malformed/huge content is never read for an already acknowledged key.
  const repeat = await reopened.appendCapture("one", owner, { ...event(), payload: { enormous: "x".repeat(100000) } }, [content(new Blob(["x"]))], { captureKey: "batch-1:0" });
  assert.equal(repeat.duplicate, true); assert.deepEqual(await api.getSession("one"), before);
  await api.closeSessionWrites("one", owner);
  const stop = await api.appendCapture("one", owner, { kind: "session.stop", payload: {} }, [], { final: true, captureKey: "session-stop" });
  const sealed = await api.sealSession("one", owner, { status: "ready", expectedSeq: stop.event.seq });
  const stopRetry = await reopened.appendCapture("one", owner, { kind: "session.stop", payload: {} }, [], { final: true, captureKey: "session-stop" });
  assert.equal(stopRetry.duplicate, true); assert.equal(stopRetry.event.id, stop.event.id);
  assert.deepEqual(await api.getSession("one"), sealed);
  const exported = await api.readEvents("one"); assert.ok(exported.every((row) => !has(row, "captureKey")));
  assert.ok(vm.row("events", calls[0].event.id).captureKey);
}));
function has(value, key) { return Object.prototype.hasOwnProperty.call(value, key); }

test("a failed event request rolls back new Blob and budget; no success acknowledgement", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const before = await api.getSession("one"), original = new Error("synthetic QuotaExceededError");
  vm.control.fault = { store: "events", method: "add", error: original };
  await assert.rejects(api.appendCapture("one", session().ownerToken, event(), [content("rollback")]), (error) => error === original);
  assert.deepEqual(await api.getSession("one"), before);
  assert.deepEqual(await api.readEvents("one"), []); assert.deepEqual(await api.readContents("one"), []);
  const result = await api.appendCapture("one", session().ownerToken, event(), [content("rollback")]);
  assert.equal(result.event.seq, 1);
}));

test("abort after all request successes still rolls back event/content/session atomically", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const before = await api.getSession("one");
  vm.control.beforeCommit = (tx) => {
    if (tx.mode === "readwrite" && tx.names.includes("events")) { vm.control.beforeCommit = null; tx.abort(); }
  };
  await assert.rejects(api.appendCapture("one", session().ownerToken, event(), [content("never committed")]), /flow-transaction-aborted/);
  assert.deepEqual(await api.getSession("one"), before);
  assert.deepEqual(await api.readEvents("one"), []); assert.deepEqual(await api.readContents("one"), []);
}));

test("owner, unknown kind and final-kind restrictions reject before hash/content read", async () => withVM(async (api) => {
  await api.createSession(session()); const owner = session().ownerToken;
  const huge = new Blob([new Uint8Array(2 * MiB + 1)]);
  await assert.rejects(api.appendCapture("one", "stale-owner", event(), [content(huge)]), /session-owner-mismatch/);
  await assert.rejects(api.appendCapture("one", owner, { kind: "ui.not-approved", payload: {} }, [content(huge)]), /unknown-event-kind/);
  await assert.rejects(api.appendCapture("one", owner, event(), [], { final: true }), /invalid-final-kind/);
  await assert.rejects(api.appendCapture("one", owner, { kind: "session.stop" }), /stop-requires-final/);
  assert.equal((await api.getSession("one")).budget.policyStopped, false);
}));

test("body known >2MiB is rejected before any Blob arrayBuffer read, policy is durable", async () => withVM(async (api) => {
  await api.createSession(session()); const owner = session().ownerToken;
  const original = Blob.prototype.arrayBuffer; let reads = 0;
  Blob.prototype.arrayBuffer = function () { reads++; return original.call(this); };
  try {
    const result = await api.appendCapture("one", owner, event(), [content(new Blob([new Uint8Array(2 * MiB + 1)]))]);
    assert.deepEqual(result, { accepted: 0, failed: 0, policyStopped: true, reason: "body-single-limit" });
    assert.equal(reads, 0);
  } finally { Blob.prototype.arrayBuffer = original; }
  const saved = await api.getSession("one"); assert.equal(saved.budget.reason, "body-single-limit"); assert.equal(saved.budget.rejectedCount, 1);
  assert.equal(saved.lastSeq, 0); assert.equal(saved.contentCount, 0); assert.equal(saved.budget.usedBytes, 0);
  await api.closeSessionWrites("one", owner);
  assert.equal((await api.appendCapture("one", owner, { kind: "session.notice", payload: { reason: "body-single-limit" } }, [], { final: true })).accepted, 1);
  const stop = await api.appendCapture("one", owner, { kind: "session.stop", payload: { reason: "policy" } }, [], { final: true });
  assert.equal((await api.sealSession("one", owner, { expectedSeq: stop.event.seq })).sealed, true);
}));

test("metadata cap stops before hashing and never silently truncates raw fields", async () => withVM(async (api) => {
  await api.createSession(session()); const original = Blob.prototype.arrayBuffer; let reads = 0;
  Blob.prototype.arrayBuffer = function () { reads++; return original.call(this); };
  try {
    const result = await api.appendCapture("one", session().ownerToken, { kind: "ui.input", payload: { tooLarge: "😀".repeat(40000) } }, [content("not read")]);
    assert.equal(result.accepted, 0); assert.equal(result.reason, "event-metadata-limit"); assert.equal(result.failed, 0);
    assert.equal(reads, 0); assert.deepEqual(await api.readEvents("one"), []);
  } finally { Blob.prototype.arrayBuffer = original; }
}));

test("same hash first charged once per category, cross category cannot evade local cap", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const owner = session().ownerToken;
  const first = await api.appendCapture("one", owner, event(), [content("same", "body")]);
  const second = await api.appendCapture("one", owner, event(), [content("same", "dom")]);
  const third = await api.appendCapture("one", owner, event(), [content("same", "dom")]);
  assert.equal(second.event.payload.body.contentId, first.event.payload.body.contentId);
  let saved = await api.getSession("one");
  assert.equal(saved.contentCount, 1); assert.equal(saved.budget.byCategory.body, 4); assert.equal(saved.budget.byCategory.dom, 4);
  assert.equal(saved.budget.usedBytes, 4 + [first, second, third].reduce((sum, result) => sum + byteSize(result.event), 0));
  const rows = await api.readContents("one"); assert.deepEqual(rows[0].categories, ["body", "dom"]);
  // Synthetic preloaded resource charge at its cap, not a native disk claim.
  vm.mutate("sessions", "one", (row) => { row.budget.byCategory.resource = L.categoryBytes.resource; });
  const denied = await api.appendCapture("one", owner, event(), [content("same", "resource")]);
  assert.equal(denied.accepted, 0); assert.equal(denied.policyStopped, true); assert.equal(denied.reason, "category-resource-limit");
  assert.deepEqual((await api.readContents("one"))[0].categories, ["body", "dom"]);
  saved = await api.getSession("one"); assert.equal(saved.eventCount, 3);
}));

test("same-hash multiple fields/categories in ONE event charge physical bytes only once", async () => withVM(async (api) => {
  await api.createSession(session());
  const result = await api.appendCapture("one", session().ownerToken, event(), [content("shared", "body", "a"), content("shared", "dom", "b"), content("shared", "body", "c")]);
  const saved = await api.getSession("one"); assert.equal(saved.contentCount, 1);
  assert.equal(saved.budget.usedBytes, 6 + byteSize(result.event)); assert.equal(saved.budget.byCategory.body, 6); assert.equal(saved.budget.byCategory.dom, 6);
  assert.equal(result.event.payload.a.contentId, result.event.payload.b.contentId);
}));

test("exactly full normal budget policy-stops next ordinary append but admits reserved stop", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const owner = session().ownerToken;
  vm.mutate("sessions", "one", (row) => { row.budget.usedBytes = L.normalBytes; row.budget.warning = true; });
  const denied = await api.appendCapture("one", owner, event());
  assert.equal(denied.reason, "total-limit"); assert.equal(denied.failed, 0); assert.equal(denied.policyStopped, true);
  await api.closeSessionWrites("one", owner);
  const stop = await api.appendCapture("one", owner, { kind: "session.stop", payload: {} }, [], { final: true });
  assert.equal(stop.accepted, 1);
  assert.equal((await api.sealSession("one", owner, { expectedSeq: stop.event.seq })).sealed, true);
  assert.ok((await api.getSession("one")).budget.usedBytes <= L.totalBytes);
}));

test("an accepted event reaching exactly63MiB persists policyStop immediately", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const owner = session().ownerToken;
  const raw = { id: "one:event:1", sessionId: "one", seq: 1, ...event(), payload: event().payload };
  // Store insertion order matters to JSON byte count only through lengths; all
  // scalar values are fixed here, so field order changes no size.
  const bytes = byteSize(raw);
  vm.mutate("sessions", "one", (row) => { row.budget.usedBytes = L.normalBytes - bytes; });
  const result = await api.appendCapture("one", owner, event());
  assert.equal(result.accepted, 1); assert.equal(result.policyStopped, true); assert.equal(result.reason, "total-limit");
  const saved = await api.getSession("one"); assert.equal(saved.budget.usedBytes, L.normalBytes); assert.equal(saved.budget.policyStopped, true);
}));

test("normal meta3MiB reserve and final meta4MiB cap are separately enforced", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const owner = session().ownerToken;
  vm.mutate("sessions", "one", (row) => { row.budget.byCategory.meta = 3 * MiB; row.budget.usedBytes = 3 * MiB; });
  const denied = await api.appendCapture("one", owner, event()); assert.equal(denied.reason, "category-meta-limit");
  await api.closeSessionWrites("one", owner);
  assert.equal((await api.appendCapture("one", owner, { kind: "session.notice", payload: {} }, [], { final: true })).accepted, 1);
  vm.mutate("sessions", "one", (row) => { row.budget.byCategory.meta = 4 * MiB; });
  const result = await api.appendCapture("one", owner, { kind: "session.stop", payload: {} }, [], { final: true });
  assert.equal(result.accepted, 0); assert.equal(result.failed, 0); assert.equal((await api.getSession("one")).sealed, false);
}));

test("closing permits only final; stop is unique/last and seal verifies expected seq/counts", async () => withVM(async (api, vm) => {
  await api.createSession(session()); const owner = session().ownerToken;
  await api.appendCapture("one", owner, event()); await api.closeSessionWrites("one", owner);
  assert.equal((await api.appendCapture("one", owner, event())).reason, "session-writes-closed");
  await assert.rejects(api.sealSession("one", owner), /seal-stop-or-count-mismatch/);
  const stop = await api.appendCapture("one", owner, { kind: "session.stop", payload: { clean: true } }, [], { final: true });
  assert.equal((await api.appendCapture("one", owner, { kind: "session.notice", payload: {} }, [], { final: true })).reason, "session-stop-exists");
  await assert.rejects(api.sealSession("one", owner, { expectedSeq: stop.event.seq - 1 }), /seal-sequence-mismatch/);
  vm.remove("events", "one:event:1");
  await assert.rejects(api.sealSession("one", owner, { expectedSeq: stop.event.seq }), /seal-store-count-mismatch/);
  assert.equal((await api.getSession("one")).sealed, false);
}));

test("terminal prevents raw writes; protected patch cannot rewind owner/counters/seal/range", async () => withVM(async (api) => {
  await api.createSession(session()); const owner = session().ownerToken;
  for (const patch of [{ budget: createBudget() }, { lastSeq: 0 }, { ownerToken: "attacker" }, { revision: 0 }, { sealed: true }, { writeGate: "open" }, { seal: {} }, { range: [] }, { eventCount: 0 }, { contentCount: 0 }]) {
    await assert.rejects(async () => api.updateSession("one", owner, patch), /protected-session-field/);
  }
  await api.closeSessionWrites("one", owner);
  const stop = await api.appendCapture("one", owner, { kind: "session.stop", payload: {} }, [], { final: true });
  const sealed = await api.sealSession("one", owner, { status: "ready", expectedSeq: stop.event.seq });
  assert.equal((await api.appendCapture("one", owner, event())).reason, "session-terminal");
  assert.equal((await api.appendCapture("one", owner, { kind: "session.stop", payload: {} }, [], { final: true })).reason, "session-terminal");
  await assert.rejects(api.updateSession("one", owner, { status: "recording" }), /session-terminal/);
  const report = await api.updateSession("one", owner, { storageError: "synthetic", hasNotice: true, needsVerification: true });
  assert.deepEqual(report.seal, sealed.seal); assert.equal(report.lastSeq, sealed.lastSeq); assert.equal(report.writeGate, "sealed");
}));

test("sequence must stay safe positive monotone, never wraps MAX_SAFE_INTEGER", async () => withVM(async (api, vm) => {
  await api.createSession(session());
  vm.mutate("sessions", "one", (row) => { row.lastSeq = Number.MAX_SAFE_INTEGER; row.eventCount = Number.MAX_SAFE_INTEGER; });
  const result = await api.appendCapture("one", session().ownerToken, event());
  assert.equal(result.accepted, 0); assert.equal(result.reason, "sequence-limit"); assert.deepEqual(await api.readEvents("one"), []);
}));

test("readEvents rejects partial cursor batch on abort, preserves explicit IDB error", async () => withVM(async (api, vm) => {
  await api.createSession(session()); await api.appendCapture("one", session().ownerToken, event());
  vm.control.abortCursorOnce = true;
  await assert.rejects(api.readEvents("one"), /flow-transaction-aborted/);
  const original = new Error("synthetic-read-error"); vm.control.fault = { store: "events", method: "cursor", error: original };
  await assert.rejects(api.readEvents("one"), (error) => error === original);
  assert.equal((await api.readEvents("one")).length, 1);
}));

test("bounded reads honor deadline/cancellation and never forge successful empty results", async () => withVM(async (api, vm) => {
  await api.createSession(session());
  vm.control.stallReads = true;
  await assert.rejects(api.readEvents("one", { timeoutMs: 10 }), /flow-transaction-timeout/);
  assert.equal(vm.transactions.at(-1).aborted, true);
  const controller = new AbortController();
  const pending = api.readContents("one", { signal: controller.signal });
  setImmediate(() => controller.abort());
  await assert.rejects(pending, /flow-operation-cancelled/);
  vm.control.stallReads = false;
  const already = new AbortController(); already.abort();
  await assert.rejects(api.getSession("one", { signal: already.signal }), /flow-operation-cancelled/);
}));

test("readContents is lazy Blob, bounded to64MiB and never arrayBuffers all rows", async () => withVM(async (api, vm) => {
  await api.createSession(session()); await api.appendCapture("one", session().ownerToken, event(), [content("lazy")]);
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = () => { throw new Error("readContents must remain lazy"); };
  try { const rows = await api.readContents("one"); assert.equal(rows.length, 1); assert.equal(rows[0].blob.size, 4); }
  finally { Blob.prototype.arrayBuffer = original; }
  // Synthetic corrupt/bloated store to test whole-batch bound.
  const row = [...vm.stores.get("contents").values()][0];
  for (let i = 0; i < 5; i++) {
    const large = { ...row, id: "one:large" + i, size: 16 * MiB, blob: new Blob([new Uint8Array(16 * MiB)]) };
    vm.stores.get("contents").set(JSON.stringify(large.id), large);
  }
  await assert.rejects(api.readContents("one"), /flow-read-batch-limit/);
}));

test("new sessions default20x and save changes only the next immutable session", async () => withVM(async (api, vm, load) => {
  const storage = { value: undefined, async get(key) { return this.value === undefined ? {} : { [key]: structuredClone(this.value) }; }, async set(record) { this.value = structuredClone(Object.values(record)[0]); } };
  const input = { ...session("current"), settings: await loadFlowSettings(storage) };
  const current = await api.createSession(input), limits = deriveFlowLimits(DEFAULT_FLOW_SETTINGS);
  assert.equal(current.producerVersion, "0.5.0");
  assert.deepEqual(current.capturePolicy.settings, DEFAULT_FLOW_SETTINGS);
  assert.deepEqual(current.budget.settings, DEFAULT_FLOW_SETTINGS);
  assert.deepEqual(current.capturePolicy.limits, limits.budget);
  assert.deepEqual(current.capturePolicy.runtimeLimits, { background: limits.background, content: limits.content });
  assert.equal(current.budget.limitBytes, 1280 * MiB); assert.equal(current.budget.reserveBytes, 20 * MiB);
  const defaultInput = { ...session("default"), capturePolicy: { settings: LEGACY_FLOW_SETTINGS, limits: L } }; delete defaultInput.settings;
  assert.deepEqual((await api.createSession(defaultInput)).capturePolicy.settings, DEFAULT_FLOW_SETTINGS);
  const nextSettings = { schemaVersion: 1, budgetMultiplier: 2, queueMultiplier: 3, samplingMultiplier: 4 };
  await saveFlowSettings(nextSettings, storage);
  const afterSave = await api.getSession("current"); assert.deepEqual(afterSave, current);
  const restarted = await load();
  assert.deepEqual((await restarted.getSession("current")).capturePolicy, current.capturePolicy);
  const next = await restarted.createSession({ ...session("next"), settings: await loadFlowSettings(storage) });
  assert.deepEqual(next.capturePolicy.settings, nextSettings); assert.equal(next.budget.limitBytes, 128 * MiB);
  nextSettings.budgetMultiplier = 20;
  current.capturePolicy.settings.budgetMultiplier = 1; current.budget.settings = LEGACY_FLOW_SETTINGS;
  assert.equal((await api.getSession("current")).capturePolicy.settings.budgetMultiplier, 20);
  assert.equal((await api.getSession("next")).capturePolicy.settings.budgetMultiplier, 2);
  for (const patch of [{ settings: LEGACY_FLOW_SETTINGS }, { capturePolicy: {} }, { runtimeLimits: {} }, { budget: createBudget() }]) {
    await assert.rejects(async () => api.updateSession("current", input.ownerToken, patch), /protected-session-field/);
  }
}));

test("legacy rows with no settings retain1x policy and reads never rewrite their book", async () => withVM(async (api, vm, load) => {
  await api.createSession(session());
  await api.appendCapture("one", session().ownerToken, event(), [content("legacy")]);
  await api.closeSessionWrites("one", session().ownerToken);
  const stop = await api.appendCapture("one", session().ownerToken, { kind: "session.stop", payload: {} }, [], { final: true });
  await api.sealSession("one", session().ownerToken, { expectedSeq: stop.event.seq });
  vm.mutate("sessions", "one", (row) => { delete row.capturePolicy.settings; delete row.capturePolicy.runtimeLimits; delete row.budget.settings; row.producerVersion = "0.4.0"; });
  const before = vm.row("sessions", "one"), reopened = await load();
  await reopened.getSession("one"); await reopened.listSessions();
  assert.equal((await reopened.readEvents("one")).length, 2);
  assert.equal((await reopened.readContents("one")).length, 1);
  assert.equal((await reopened.flowEventPage("one")).events.length, 2);
  assert.equal((await reopened.flowContentPage("one")).contents.length, 1);
  assert.deepEqual(vm.row("sessions", "one"), before);
  assert.equal(before.budget.limitBytes, 64 * MiB); assert.equal(before.capturePolicy.settings, undefined);
  const fresh = { ...session("fresh") }; delete fresh.settings;
  assert.equal((await reopened.createSession(fresh)).budget.limitBytes, 1280 * MiB);
  assert.deepEqual(vm.row("sessions", "one"), before);
}));

test("invalid settings fail before session persistence and budget-policy mismatches reject", async () => withVM(async (api, vm) => {
  const invalidSettings = [null, {}, [], { ...DEFAULT_FLOW_SETTINGS, schemaVersion: 2 }, { ...DEFAULT_FLOW_SETTINGS, extra: 1 }];
  for (const key of ["budgetMultiplier", "queueMultiplier", "samplingMultiplier"]) {
    for (const value of [0, 21, -1, 1.5, "20", true, false, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) invalidSettings.push({ ...DEFAULT_FLOW_SETTINGS, [key]: value });
  }
  for (const settings of invalidSettings) await assert.rejects(api.createSession({ ...session(), settings }));
  assert.equal(vm.opens.length, 0);
  await api.createSession(session());
  for (const value of [0, 1, "false", null]) await assert.rejects(api.appendCapture("one", session().ownerToken, event(), [], { final: value }), /boolean/);
  assert.equal((await api.getSession("one")).eventCount, 0);
  vm.mutate("sessions", "one", (row) => { row.budget.limitBytes = 1280 * MiB; });
  await assert.rejects(api.appendCapture("one", session().ownerToken, event()), /Corrupt budget limits/);
  vm.mutate("sessions", "one", (row) => { row.budget = createBudget(DEFAULT_FLOW_SETTINGS); });
  await assert.rejects(api.readEvents("one"), /session-settings-mismatch/);
  await assert.rejects(api.flowContentPage("one"), /session-settings-mismatch/);
}));

test("20x accepts actual >2MiB body with streamed immutable hashing, legacy1 rejects", async () => withVM(async (api) => {
  const fresh = { ...session("large") }; delete fresh.settings; await api.createSession(fresh);
  await api.createSession(session("small"));
  const bytes = new Uint8Array(3 * MiB + 7); bytes[0] = 65; bytes[bytes.length - 1] = 90;
  const hash = createHash("sha256").update(bytes).digest("hex");
  const rejected = await api.appendCapture("small", session("small").ownerToken, event(), [content(new Blob([bytes]))]);
  assert.equal(rejected.reason, "body-single-limit");
  const original = Blob.prototype.arrayBuffer; let largestBuffer = 0;
  Blob.prototype.arrayBuffer = function () { largestBuffer = Math.max(largestBuffer, this.size); return original.call(this); };
  let result;
  try { result = await api.appendCapture("large", fresh.ownerToken, event(), [content(bytes)]); }
  finally { Blob.prototype.arrayBuffer = original; }
  bytes.fill(0);
  assert.equal(result.accepted, 1); assert.equal(result.event.payload.body.sha256, hash);
  // Node's Blob.stream may allocate internally; production hash never requests an entire Blob buffer.
  assert.ok(largestBuffer <= 1024 * 1024, "hash API must consume bounded blocks");
  const rows = await api.readContents("large"); assert.equal(rows[0].blob.size, 3 * MiB + 7);
  assert.equal(new Uint8Array(await rows[0].blob.slice(0, 1).arrayBuffer())[0], 65);
  assert.equal((await api.getSession("large")).budget.usedBytes, rows[0].size + byteSize(result.event));
}));

test("20x metadata uses640KiB and scaled nodes; depth and protocol IDs remain bounded", async () => withVM(async (api) => {
  const fresh = { ...session("wide") }; delete fresh.settings; await api.createSession(fresh);
  const value = "x".repeat(600 * 1024);
  const result = await api.appendCapture("wide", fresh.ownerToken, event(value));
  assert.equal(result.accepted, 1); assert.equal(result.event.payload.value, value);
  const many = Array.from({ length: 2560 }, (_, index) => ({ index, value: "field", type: "input", checked: false }));
  assert.equal((await api.appendCapture("wide", fresh.ownerToken, { kind: "page.snapshot", payload: { fields: many } })).accepted, 1);
  assert.equal((await api.readEvents("wide")).length, 2);
  let deep = {}; for (let i = 0; i < 33; i++) deep = { child: deep };
  const denied = await api.appendCapture("wide", fresh.ownerToken, { kind: "ui.input", payload: deep });
  assert.equal(denied.reason, "event-metadata-limit");
  const another = { ...session("bounded") }; delete another.settings; await api.createSession(another);
  await assert.rejects(api.appendCapture("bounded", another.ownerToken, { ...event(), documentId: "d".repeat(513) }), /Invalid documentId/);
  assert.equal((await api.appendCapture("bounded", another.ownerToken, event("x".repeat(640 * 1024)))).reason, "event-metadata-limit");
}));

test("per-event content descriptors scale16x sampling setting and keep dedup category accounting", async () => withVM(async (api) => {
  const fresh = { ...session("fields"), settings: { ...LEGACY_FLOW_SETTINGS, budgetMultiplier: 20, samplingMultiplier: 20 } }; await api.createSession(fresh);
  const values = Array.from({ length: 320 }, (_, index) => content("one physical blob", index % 2 ? "dom" : "body", "field" + index));
  assert.equal((await api.appendCapture("fields", fresh.ownerToken, event(), values)).accepted, 1);
  const saved = await api.getSession("fields"); assert.equal(saved.contentCount, 1);
  assert.equal(saved.budget.byCategory.body, 17); assert.equal(saved.budget.byCategory.dom, 17);
  assert.equal((await api.appendCapture("fields", fresh.ownerToken, event(), [...values, content("extra", "body", "field320")])).reason, "capture-content-limit");
}));

test("event pages preserve order byte targets and oversized first record without missing rows", async () => withVM(async (api, vm) => {
  const fresh = { ...session("paged") }; delete fresh.settings; await api.createSession(fresh);
  for (const [index, value] of ["a", "b".repeat(200 * 1024), "c", "d", "e"].entries()) await api.appendCapture("paged", fresh.ownerToken, event(value), [], { captureKey: "private:" + index });
  const events = await api.readEvents("paged"); assert.equal(events.length, 5);
  const collected = []; let after = 0, pages = 0;
  for (;;) {
    const count = vm.transactions.length, page = await api.flowEventPage("paged", after, { limit: 2, maxBytes: 512 });
    assert.equal(vm.transactions.length, count + 1); assert.equal(vm.transactions.at(-1).mode, "readonly");
    assert.ok(page.events.length <= 2); assert.ok(page.events.every((row) => row.captureKey === undefined));
    if (page.events.reduce((sum, row) => sum + byteSize(row), 0) > 512) assert.equal(page.events.length, 1);
    collected.push(...page.events); pages++; assert.ok(pages < 10);
    if (page.done) break;
    assert.ok(page.nextSeq > after); after = page.nextSeq;
  }
  assert.deepEqual(collected, events); assert.ok(pages >= 2);
  assert.deepEqual(await api.flowEventPage("paged", Number.MAX_SAFE_INTEGER), { events: [], nextSeq: Number.MAX_SAFE_INTEGER, done: true });
  for (const options of [{ limit: 0 }, { limit: 501 }, { limit: 1.5 }, { limit: true }, { maxBytes: 0 }, { maxBytes: 8 * MiB + 1 }]) assert.throws(() => api.flowEventPage("paged", 0, options), /Invalid/);
  assert.throws(() => api.flowEventPage("paged", -1), /safe integer/);
}));

test("content pages resume by id use lazy Blob handles and ignore other sessions", async () => withVM(async (api, vm) => {
  await api.createSession(session()); await api.createSession(session("two")); await api.createSession(session("one:child"));
  await api.appendCapture("one:child", session("one:child").ownerToken, event(), [content("prefix collision")]);
  for (let index = 0; index < 5; index++) await api.appendCapture("one", session().ownerToken, event(), [content("unique" + index)]);
  await api.appendCapture("two", session("two").ownerToken, event(), [content("other")]);
  const expected = await api.readContents("one"), original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = () => { throw new Error("page must not materialize Blob"); };
  const rows = []; let after = "", pages = 0;
  try {
    for (;;) {
      const page = await api.flowContentPage("one", after, { limit: 2 });
      assert.equal(vm.transactions.at(-1).mode, "readonly"); assert.ok(page.contents.length <= 2);
      rows.push(...page.contents); pages++; assert.ok(pages < 5);
      if (page.done) break;
      assert.ok(page.nextId > after); after = page.nextId;
    }
  } finally { Blob.prototype.arrayBuffer = original; }
  assert.deepEqual(rows, expected); assert.equal(pages, 3); assert.equal(new Set(rows.map((row) => row.id)).size, 5);
  for (const options of [{ limit: 0 }, { limit: 51 }, { limit: false }]) assert.throws(() => api.flowContentPage("one", "", options), /Invalid/);
  assert.throws(() => api.flowContentPage("one", "two:any"), /Invalid afterId/);
}));

test("page cancellation, read fault and deadline reject all partial data", async () => withVM(async (api, vm) => {
  await api.createSession(session()); await api.appendCapture("one", session().ownerToken, event(), [content("one")]);
  for (const name of ["flowEventPage", "flowContentPage"]) {
    vm.control.abortCursorOnce = true; await assert.rejects(api[name]("one"), /flow-transaction-aborted/);
    vm.control.fault = { store: name === "flowEventPage" ? "events" : "contents", method: "cursor", error: new Error("page-read-error") };
    await assert.rejects(api[name]("one"), /page-read-error/);
    vm.control.stallReads = true;
    await assert.rejects(api[name]("one", name === "flowEventPage" ? 0 : "", { timeoutMs: 10 }), /flow-transaction-timeout/);
    const controller = new AbortController(), pending = api[name]("one", name === "flowEventPage" ? 0 : "", { signal: controller.signal });
    setImmediate(() => controller.abort()); await assert.rejects(pending, /flow-operation-cancelled/);
    vm.control.stallReads = false;
  }
}));


test("20x compatibility reads cross64MiB using the persisted policy, not the old global cap", async () => withVM(async (api, vm) => {
  const fresh = { ...session("largeread") }; delete fresh.settings; await api.createSession(fresh);
  // Synthetic valid-sized rows isolate read bounds; this is not a native quota or full-load claim.
  const metadata = "m".repeat(600 * 1024), blob = new Blob([new Uint8Array(16 * MiB)]);
  let eventBytes = 0;
  for (let seq = 1; seq <= 112; seq++) {
    const row = { id: "largeread:event:" + seq, sessionId: "largeread", seq, kind: "session.notice", time: 1234, payload: { metadata } };
    eventBytes += byteSize(row); vm.stores.get("events").set(JSON.stringify(row.id), row);
  }
  for (let index = 0; index < 5; index++) {
    const hash = index.toString(16).padStart(64, "0"), id = "largeread:" + hash;
    vm.stores.get("contents").set(JSON.stringify(id), { id, sessionId: "largeread", sha256: hash, size: blob.size, blob, mime: "text/plain", category: "dom", categories: ["dom"] });
  }
  vm.mutate("sessions", "largeread", (row) => {
    row.eventCount = row.lastSeq = 112; row.contentCount = 5;
    row.budget.usedBytes = eventBytes + 80 * MiB;
    row.budget.byCategory.meta = eventBytes; row.budget.byCategory.dom = 80 * MiB;
  });
  const before = vm.row("sessions", "largeread"); assert.ok(eventBytes > 64 * MiB);
  const original = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = () => { throw new Error("compatibility reads must be lazy"); };
  try {
    assert.equal((await api.readEvents("largeread")).length, 112);
    assert.equal((await api.readContents("largeread")).reduce((sum, row) => sum + row.size, 0), 80 * MiB);
    const page = await api.flowEventPage("largeread");
    assert.equal(page.done, false); assert.ok(page.events.length < 112);
    assert.ok(page.events.reduce((sum, row) => sum + byteSize(row), 0) <= 8 * MiB);
    assert.equal((await api.flowContentPage("largeread")).contents.length, 5);
  } finally { Blob.prototype.arrayBuffer = original; }
  assert.deepEqual(vm.row("sessions", "largeread"), before);
}));
