import {
  FLOW_LIMITS, FLOW_CATEGORIES, createBudget, evaluateBudget, preflightContent,
  knownByteLength, utf8ByteLength, stopBudget, byteCount, validateBudget,
} from "./flow-budget.js";

export const FLOW_DB_NAME = "logic-recorder-flow-v1";
export const FLOW_DB_VERSION = 1;
export const FLOW_EVENT_KINDS = Object.freeze([
  "session.start", "session.ready", "session.stop", "session.notice",
  "page.snapshot", "page.stylesheet", "page.resources", "page.navigation", "page.frame", "page.dialog", "page.resource", "page.screenshot", "screenshot",
  "ui.click", "ui.change", "ui.input", "ui.submit", "ui.key", "ui.scroll",
  "network.request", "network.response", "network.finished", "network.failed", "network.incomplete", "network.redirect", "network.websocket", "network.eventSource", "network.requestBody",
  "scope.child", "scope.excluded", "recorder.notice", "policy.limit", "policy.omitted",
]);
const KINDS = new Set(FLOW_EVENT_KINDS);
const FINAL_KINDS = new Set(["session.stop", "session.notice"]);
const META_FIELDS = new Set([
  "status", "title", "url", "rootTabId", "tabId", "tabs", "scope", "coverage", "stopOutcome",
  "error", "diagnostics", "lastError", "updatedAt", "stoppedAt", "endedAt", "startedAt", "profile",
  "hasNotice", "notice", "storageError", "needsVerification", "incomplete", "communicationUnknown",
]);
const TERMINAL_STATUSES = new Set(["ready", "stopped", "completed", "failed", "error", "interrupted", "aborted"]);
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const DEFAULT_DEADLINE = 15000;
let opening;

function failure(code) { const error = new Error(code); error.code = code; return error; }
function validText(value, name, maximum = 256) {
  if (typeof value !== "string" || !value.length || value.length > maximum) throw new TypeError("Invalid " + name);
  return value;
}
function deadline(options = {}) {
  const value = options.timeoutMs ?? DEFAULT_DEADLINE;
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("Invalid timeoutMs");
  return Math.min(DEFAULT_DEADLINE, value);
}

// A bounded JSON writer, not JSON.stringify of an unbounded input followed by a
// size check. No toJSON/getter execution, cycles, binary inline payloads or silent
// truncation. Metadata is deliberately a small JSON tree; large values go in Blob.
function boundedJSON(value, maximum = FLOW_LIMITS.eventBytes) {
  const parts = [], ancestors = new Set();
  let size = 0, nodes = 0;
  function emit(text) {
    if (text.length > maximum - size) throw failure("event-metadata-limit");
    size += utf8ByteLength(text);
    if (size > maximum) throw failure("event-metadata-limit");
    parts.push(text);
  }
  function visit(item, depth) {
    if (++nodes > 8192 || depth > 32) throw failure("event-metadata-limit");
    if (item === null) { emit("null"); return; }
    if (typeof item === "string") {
      if (item.length > maximum - size) throw failure("event-metadata-limit");
      emit(JSON.stringify(item)); return;
    }
    if (typeof item === "boolean") { emit(item ? "true" : "false"); return; }
    if (typeof item === "number" && Number.isFinite(item)) { emit(JSON.stringify(item)); return; }
    if (!item || typeof item !== "object") throw new TypeError("Metadata must be finite JSON");
    if (ancestors.has(item)) throw new TypeError("Cyclic metadata");
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null) throw new TypeError("Metadata must be plain JSON");
    ancestors.add(item);
    emit(array ? "[" : "{");
    let count = 0;
    // Avoid Object.keys allocation on untrusted huge objects.
    for (const key in item) {
      if (!has(item, key)) continue;
      if (array && !/^(0|[1-9][0-9]*)$/.test(key)) throw new TypeError("Invalid JSON array");
      const descriptor = Object.getOwnPropertyDescriptor(item, key);
      if (!descriptor || !has(descriptor, "value")) throw new TypeError("Metadata accessors forbidden");
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new TypeError("Unsafe metadata key");
      if (count++) emit(",");
      if (!array) { visit(key, depth + 1); emit(":"); }
      visit(descriptor.value, depth + 1);
    }
    if (array && count !== item.length) throw new TypeError("Sparse JSON array");
    emit(array ? "]" : "}");
    ancestors.delete(item);
  }
  visit(value, 0);
  return { json: parts.join(""), size };
}
function jsonClone(value, maximum) { return JSON.parse(boundedJSON(value, maximum).json); }
function nextRevision(session) {
  byteCount(session.revision, "revision");
  if (session.revision >= Number.MAX_SAFE_INTEGER) throw failure("revision-limit");
  return session.revision + 1;
}
function requireOwner(session, ownerToken) {
  if (!session) throw failure("session-not-found");
  validText(ownerToken, "ownerToken", 512);
  if (session.ownerToken !== ownerToken) throw failure("session-owner-mismatch");
  return session;
}
function terminal(session) { return session.writeGate === "sealed" || session.sealed || TERMINAL_STATUSES.has(session.status); }
export function projectSession(session) {
  if (!session) return session;
  const { ownerToken, ...projection } = session;
  return projection;
}
function projectEvent(row) {
  if (!row) return row;
  const { captureKey, ...event } = row;
  return event;
}

export function openFlowDB() {
  if (opening) return opening;
  let current;
  current = new Promise((resolve, reject) => {
    let request, settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (opening === current) opening = undefined;
      reject(error);
    };
    const timer = setTimeout(() => finishError(failure("flow-open-timeout")), DEFAULT_DEADLINE);
    try { request = indexedDB.open(FLOW_DB_NAME, FLOW_DB_VERSION); }
    catch (error) { finishError(error); return; }
    request.onupgradeneeded = () => {
      if (settled) { try { request.transaction.abort(); } catch {} return; }
      try {
        const db = request.result;
        db.createObjectStore("sessions", { keyPath: "id" });
        const events = db.createObjectStore("events", { keyPath: "id" });
        events.createIndex("session", "sessionId");
        events.createIndex("sessionSeq", ["sessionId", "seq"], { unique: true });
        events.createIndex("sessionCaptureKey", ["sessionId", "captureKey"], { unique: true });
        db.createObjectStore("contents", { keyPath: "id" }).createIndex("session", "sessionId");
      } catch (error) { try { request.transaction.abort(); } catch {} finishError(error); }
    };
    request.onerror = () => finishError(request.error || failure("flow-open-failed"));
    request.onblocked = () => finishError(failure("flow-open-blocked"));
    request.onsuccess = () => {
      const db = request.result;
      if (settled) { db.close(); return; }
      settled = true; clearTimeout(timer);
      const reset = () => { db.close(); if (opening === current) opening = undefined; };
      db.onversionchange = reset;
      db.onclose = () => { if (opening === current) opening = undefined; };
      resolve(db);
    };
  });
  opening = current;
  // Covers a synchronous open() exception before current/opening were assigned.
  current.catch(() => { if (opening === current) opening = undefined; });
  return current;
}

// Every operation settles on transaction COMPLETE, never a request success.
// Fail/timeout/cancel drops partial reads and aborts pending writes.
async function transaction(names, mode, build, options = {}) {
  const timeoutMs = deadline(options);
  if (options.signal?.aborted) throw failure("flow-operation-cancelled");
  const expires = Date.now() + timeoutMs;
  // Include an outstanding open in the caller's deadline/cancellation. A late
  // connection may still be reused, but this caller never waits another15s.
  const db = await new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return; done = true; clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => finish(failure("flow-operation-cancelled"));
    const timer = setTimeout(() => finish(failure("flow-transaction-timeout")), timeoutMs);
    options.signal?.addEventListener("abort", cancel, { once: true });
    openFlowDB().then((value) => finish(null, value), (error) => finish(error));
    if (options.signal?.aborted) cancel();
  });
  if (options.signal?.aborted) throw failure("flow-operation-cancelled");
  const remaining = expires - Date.now();
  if (remaining <= 0) throw failure("flow-transaction-timeout");
  return new Promise((resolve, reject) => {
    let tx, result, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", cancel);
      if (error) reject(error); else resolve(result);
    };
    const abort = (error) => { finish(error); try { tx?.abort(); } catch {} };
    const cancel = () => abort(failure("flow-operation-cancelled"));
    const timer = setTimeout(() => abort(failure("flow-transaction-timeout")), remaining);
    const context = {
      result(value) { result = value; }, fail: abort,
      request(request, success = () => {}) {
        request.onerror = () => abort(request.error || tx.error || failure("flow-request-failed"));
        request.onsuccess = () => {
          if (settled) return;
          try { success(request.result); } catch (error) { abort(error); }
        };
        return request;
      },
    };
    try {
      tx = db.transaction(names, mode);
      tx.onerror = () => abort(tx.error || failure("flow-transaction-failed"));
      tx.onabort = () => finish(tx.error || failure("flow-transaction-aborted"));
      tx.oncomplete = () => finish();
      options.signal?.addEventListener("abort", cancel, { once: true });
      if (options.signal?.aborted) { cancel(); return; }
      build(tx, context);
    } catch (error) { abort(error); }
  });
}

export async function createSession(input) {
  if (!input || typeof input !== "object") throw new TypeError("Session required");
  const id = input.id === undefined ? crypto.randomUUID() : validText(input.id, "session id");
  const ownerToken = validText(input.ownerToken, "ownerToken", 512);
  const producerVersion = input.producerVersion === undefined ? "0.4.0" : validText(input.producerVersion, "producerVersion", 64).trim();
  if (!/^[0-9]{1,5}(\.[0-9]{1,5}){1,3}$/.test(producerVersion) || producerVersion.split(".").some((part) => Number(part) > 65535)) throw new TypeError("Invalid producerVersion");
  // Canonical create-only contract, never caller supplied or patchable. This is
  // bounded manifest metadata, not an extra raw-content ledger charge.
  const capturePolicy = jsonClone({
    schemaVersion: 1, profile: "business-flow-v1", scope: "root-tab-and-attributed-child",
    limits: FLOW_LIMITS,
    notCollected: [
      "cookies", "storage", "indexedDB", "cacheStorage", "fullComputedStyles", "fontInventory",
      "canvasPixels", "fullPageScreenshots", "websocketPayloads", "eventSourcePayloads",
    ],
  });
  const metadata = {};
  for (const key of META_FIELDS) if (has(input, key)) metadata[key] = input[key];
  const clean = jsonClone(metadata);
  const status = clean.status ?? "recording";
  if (TERMINAL_STATUSES.has(status)) throw failure("session-must-start-open");
  const row = {
    ...clean, id, ownerToken, profile: "business-flow-v1", producerVersion, capturePolicy, status,
    createdAt: Date.now(), startedAt: clean.startedAt ?? Date.now(), updatedAt: Date.now(),
    writeGate: "open", sealed: false, revision: 0, eventCount: 0, contentCount: 0, lastSeq: 0,
    stopEventCount: 0, budget: createBudget(),
  };
  return transaction(["sessions"], "readwrite", (tx, ctx) => {
    ctx.request(tx.objectStore("sessions").add(row)); ctx.result(row);
  });
}

export function getSession(id, options = {}) {
  validText(id, "session id");
  return transaction(["sessions"], "readonly", (tx, ctx) => {
    ctx.request(tx.objectStore("sessions").get(id), (row) => ctx.result(options.projection ? projectSession(row) : row));
  }, options);
}

export function listSessions(options = {}) {
  return transaction(["sessions"], "readonly", (tx, ctx) => {
    const rows = []; let size = 0;
    const request = tx.objectStore("sessions").openCursor();
    ctx.request(request, function visit(cursor) {
      if (!cursor) { rows.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); ctx.result(rows); return; }
      const row = options.projection ? projectSession(cursor.value) : cursor.value;
      size += boundedJSON(row, 64 * 1024).size;
      if (size > FLOW_LIMITS.totalBytes || rows.length >= 10000) throw failure("flow-read-batch-limit");
      rows.push(row); cursor.continue();
    });
  }, options);
}

function rejected(session, reason) { return { accepted: 0, failed: 0, policyStopped: Boolean(session?.budget.policyStopped), reason }; }
function rememberPolicy(tx, ctx, session, reason) {
  const row = { ...session, revision: nextRevision(session), updatedAt: Date.now(), budget: stopBudget(session.budget, reason) };
  ctx.request(tx.objectStore("sessions").put(row));
  ctx.result(rejected(row, row.budget.reason));
}
function gateReason(session, final) {
  if (terminal(session)) return "session-terminal";
  if (session.stopEventCount) return "session-stop-exists";
  if (session.writeGate !== "open" && !(final && session.writeGate === "closing")) return "session-writes-closed";
  if (!final && session.budget.policyStopped) return session.budget.reason || "policy-stopped";
}
function captureKeyFor(event, options) {
  const key = options.captureKey ?? event.captureKey;
  if (key === undefined) return undefined;
  return validText(key, "captureKey", 512);
}
function rawEvent(id, seq, event, payload) {
  const row = { id: id + ":event:" + seq, sessionId: id, seq, kind: event.kind, time: event.time ?? Date.now(), payload };
  if (typeof row.time !== "number" && typeof row.time !== "string") throw new TypeError("Invalid event time");
  for (const key of ["tabId", "frameId"]) if (event[key] !== undefined) {
    if (!Number.isSafeInteger(event[key])) throw new TypeError("Invalid " + key);
    row[key] = event[key];
  }
  if (event.documentId !== undefined) row.documentId = validText(event.documentId, "documentId", 512);
  return row;
}
function descriptorsFor(contents) {
  if (!Array.isArray(contents)) throw new TypeError("contents must be an array");
  if (contents.length > 16) throw failure("capture-content-limit");
  const fields = new Set();
  return contents.map((item) => {
    if (!item || typeof item !== "object") throw new TypeError("Invalid content");
    const field = validText(item.field, "content field", 128);
    if (["__proto__", "constructor", "prototype"].includes(field) || fields.has(field)) throw new TypeError("Invalid or duplicate content field");
    fields.add(field);
    if (!FLOW_CATEGORIES.includes(item.category)) throw new TypeError("Unknown content category");
    const mime = item.mime === undefined ? "application/octet-stream" : validText(item.mime, "mime", 256);
    return { field, category: item.category, mime, source: item.bytes };
  });
}
function payloadWithoutContents(input, descriptors) {
  if (input === undefined) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Event payload must be an object");
  const omit = new Set(descriptors.map((item) => item.field)), object = {};
  let keys = 0;
  for (const key in input) if (has(input, key)) {
    if (++keys > 8192 || key.length > FLOW_LIMITS.eventBytes) throw failure("event-metadata-limit");
    if (omit.has(key)) continue;
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("Unsafe payload key");
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!has(descriptor, "value")) throw new TypeError("Payload accessors forbidden");
    object[key] = descriptor.value;
  }
  return jsonClone(object);
}
function reference(item, id, sha256) {
  return { contentId: id + ":" + sha256, sha256, size: item.size, mime: item.mime, category: item.category, status: "captured" };
}
async function hashContent(item) {
  // Blob takes an immutable snapshot before awaiting; Uint8Array byteOffset is
  // respected, strings are raw UTF-8 (never interpreted as base64).
  const blob = new Blob([item.source], { type: item.mime });
  if (blob.size !== item.size) throw failure("content-size-changed");
  const bytes = await blob.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return { ...item, source: undefined, blob, sha256 };
}

// The pre-read is only an optimization (owner/gate/idempotency before hashing).
// The authoritative session read is in EACH readwrite transaction; overlapping
// calls and independent worker instances serialize on the IDB sessions row.
export async function appendCapture(id, ownerToken, event, contents = [], options = {}) {
  validText(id, "session id");
  if (!event || !KINDS.has(event.kind)) throw failure("unknown-event-kind");
  const final = options.final === true;
  if (final && !FINAL_KINDS.has(event.kind)) throw failure("invalid-final-kind");
  if (!final && event.kind === "session.stop") throw failure("stop-requires-final");
  if (final && contents.length) throw failure("final-content-forbidden");
  const captureKey = captureKeyFor(event, options);
  let early = await transaction(["sessions", "events"], "readonly", (tx, ctx) => {
    ctx.request(tx.objectStore("sessions").get(id), (session) => {
      requireOwner(session, ownerToken);
      const finish = (existing) => ctx.result({ session, existing, reason: existing ? undefined : gateReason(session, final) });
      if (captureKey !== undefined) ctx.request(tx.objectStore("events").index("sessionCaptureKey").get([id, captureKey]), finish);
      else finish();
    });
  }, options);
  if (early.existing) return { accepted: 1, failed: 0, policyStopped: early.session.budget.policyStopped, event: projectEvent(early.existing), duplicate: true };
  if (early.reason) return rejected(early.session, early.reason);
  let descriptors = [], payload, policyReason;
  try {
    descriptors = descriptorsFor(contents);
    payload = payloadWithoutContents(event.payload, descriptors);
    // Reject oversized metadata before scanning even a content string for its
    // UTF-8 length. Fields replaced by references are not traversed.
    boundedJSON(rawEvent(id, early.session.lastSeq + 1, event, payload));
    const probe = { ...payload };
    for (const item of descriptors) {
      item.size = knownByteLength(item.source);
      const check = preflightContent(early.session.budget, { category: item.category, knownBytes: item.size }, { final });
      if (!check.accepted) { policyReason = check.reason; break; }
      probe[item.field] = reference(item, id, "0".repeat(64));
    }
    if (!policyReason) boundedJSON(rawEvent(id, early.session.lastSeq + 1, event, probe));
  } catch (error) {
    if (["event-metadata-limit", "capture-content-limit"].includes(error.code)) policyReason = error.code;
    else throw error;
  }
  const prepared = [];
  if (!policyReason) {
    // Hashes and Blob reads must finish BEFORE opening any write transaction.
    for (const descriptor of descriptors) prepared.push(await hashContent(descriptor));
  }
  return transaction(["sessions", "events", "contents"], "readwrite", (tx, ctx) => {
    const sessions = tx.objectStore("sessions"), events = tx.objectStore("events"), contentStore = tx.objectStore("contents");
    ctx.request(sessions.get(id), (session) => {
      requireOwner(session, ownerToken);
      const continueWrite = (existing) => {
        if (existing) { ctx.result({ accepted: 1, failed: 0, policyStopped: session.budget.policyStopped, event: projectEvent(existing), duplicate: true }); return; }
        const reason = gateReason(session, final);
        if (reason) { ctx.result(rejected(session, reason)); return; }
        if (policyReason) { rememberPolicy(tx, ctx, session, policyReason); return; }
        byteCount(session.lastSeq, "lastSeq");
        if (session.lastSeq >= Number.MAX_SAFE_INTEGER) { rememberPolicy(tx, ctx, session, "sequence-limit"); return; }
        const seq = session.lastSeq + 1, rawPayload = { ...payload };
        for (const item of prepared) rawPayload[item.field] = reference(item, id, item.sha256);
        const raw = rawEvent(id, seq, event, rawPayload);
        let eventBytes;
        try { eventBytes = boundedJSON(raw).size + 1; }
        catch (error) { if (error.code !== "event-metadata-limit") throw error; rememberPolicy(tx, ctx, session, error.code); return; }
        if (eventBytes > FLOW_LIMITS.eventBytes) { rememberPolicy(tx, ctx, session, "event-metadata-limit"); return; }
        const unique = new Map();
        for (const item of prepared) {
          let candidate = unique.get(item.sha256);
          if (!candidate) { candidate = { ...item, categories: new Set() }; unique.set(item.sha256, candidate); }
          candidate.categories.add(item.category);
        }
        const candidates = [...unique.values()], stored = new Map();
        let pending = candidates.length;
        const write = () => {
          const charges = [], changes = []; let added = 0;
          for (const item of candidates) {
            const previous = stored.get(item.sha256);
            if (previous && (previous.sessionId !== id || previous.size !== item.size || previous.sha256 !== item.sha256)) throw failure("content-hash-conflict");
            const categories = new Set(previous?.categories || previous?.chargedCategories || []);
            let first = true;
            for (const category of item.categories) {
              charges.push({ category, size: item.size, isNew: !previous && first, chargeCategory: !categories.has(category) });
              categories.add(category); first = false;
            }
            const row = previous || { id: id + ":" + item.sha256, sessionId: id, sha256: item.sha256, size: item.size, mime: item.mime, category: item.category, blob: item.blob };
            if (!previous) added++;
            changes.push({ ...row, categories: [...categories], chargedCategories: [...categories] });
          }
          const decision = evaluateBudget(session.budget, { eventBytes, contents: charges, final });
          if (!decision.accepted) { rememberPolicy(tx, ctx, session, decision.reason); return; }
          const row = {
            ...session, budget: decision.budget, revision: nextRevision(session), updatedAt: Date.now(),
            lastSeq: seq, eventCount: session.eventCount + 1, contentCount: session.contentCount + added,
          };
          if (event.kind === "session.stop") { row.stopEventCount = 1; row.stopEventId = raw.id; row.stopSeq = seq; row.writeGate = "closing"; }
          for (const change of changes) ctx.request(contentStore.put(change));
          ctx.request(events.add(captureKey === undefined ? raw : { ...raw, captureKey }));
          ctx.request(sessions.put(row));
          ctx.result({ accepted: 1, failed: 0, policyStopped: row.budget.policyStopped, ...(row.budget.reason ? { reason: row.budget.reason } : {}), event: raw });
        };
        if (!pending) write();
        else for (const item of candidates) ctx.request(contentStore.get(id + ":" + item.sha256), (row) => {
          stored.set(item.sha256, row); if (--pending === 0) write();
        });
      };
      if (captureKey !== undefined) ctx.request(events.index("sessionCaptureKey").get([id, captureKey]), continueWrite);
      else continueWrite();
    });
  }, options);
}

export function updateSession(id, ownerToken, patch) {
  validText(id, "session id");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new TypeError("Patch required");
  for (const key of Object.keys(patch)) if (!META_FIELDS.has(key)) throw failure("protected-session-field");
  const clean = jsonClone(patch);
  return transaction(["sessions"], "readwrite", (tx, ctx) => {
    const store = tx.objectStore("sessions");
    ctx.request(store.get(id), (session) => {
      requireOwner(session, ownerToken);
      // Raw terminal records remain immutable. Only a small operational error
      // report may be added afterwards; it never manufactures/rewinds a seal.
      if (terminal(session) && Object.keys(clean).some((key) => !["error", "lastError", "diagnostics", "hasNotice", "notice", "storageError", "needsVerification", "incomplete", "communicationUnknown"].includes(key))) throw failure("session-terminal");
      const row = { ...session, ...clean, updatedAt: Date.now(), revision: nextRevision(session) };
      boundedJSON(projectSession(row), 64 * 1024);
      ctx.request(store.put(row)); ctx.result(row);
    });
  });
}

export function closeSessionWrites(id, ownerToken) {
  validText(id, "session id");
  return transaction(["sessions"], "readwrite", (tx, ctx) => {
    const store = tx.objectStore("sessions");
    ctx.request(store.get(id), (session) => {
      requireOwner(session, ownerToken);
      if (terminal(session) || session.writeGate === "closing") { ctx.result(session); return; }
      const row = { ...session, writeGate: "closing", revision: nextRevision(session), updatedAt: Date.now() };
      ctx.request(store.put(row)); ctx.result(row);
    });
  });
}

export function sealSession(id, ownerToken, options = {}) {
  validText(id, "session id");
  const metadata = jsonClone({ status: options.status ?? "stopped", stopOutcome: options.stopOutcome ?? null, coverage: options.coverage ?? null });
  if (!TERMINAL_STATUSES.has(metadata.status)) throw failure("invalid-seal-status");
  if (options.expectedSeq !== undefined) byteCount(options.expectedSeq, "expectedSeq");
  return transaction(["sessions", "events", "contents"], "readwrite", (tx, ctx) => {
    const sessions = tx.objectStore("sessions"), events = tx.objectStore("events");
    ctx.request(sessions.get(id), (session) => {
      requireOwner(session, ownerToken);
      if (session.sealed && session.writeGate === "sealed") {
        if (options.expectedSeq !== undefined && options.expectedSeq !== session.lastSeq) throw failure("seal-sequence-mismatch");
        ctx.result(session); return;
      }
      if (terminal(session) || session.writeGate !== "closing") throw failure("seal-requires-closing");
      if (session.stopEventCount !== 1 || session.stopSeq !== session.lastSeq || !session.stopEventId || session.lastSeq !== session.eventCount) throw failure("seal-stop-or-count-mismatch");
      if (options.expectedSeq !== undefined && options.expectedSeq !== session.lastSeq) throw failure("seal-sequence-mismatch");
      let pending = 3, eventCount, contentCount, stop;
      const check = () => {
        if (--pending) return;
        if (eventCount !== session.eventCount || contentCount !== session.contentCount || stop?.kind !== "session.stop" || stop.seq !== session.lastSeq || stop.id !== session.stopEventId) throw failure("seal-store-count-mismatch");
        validateBudget(session.budget);
        const seal = { lastSeq: session.lastSeq, eventCount, contentCount, sealedAt: Date.now(), revision: session.revision + 1 };
        const row = { ...session, ...metadata, sealed: true, seal, writeGate: "sealed", revision: nextRevision(session), updatedAt: Date.now(), stoppedAt: session.stoppedAt ?? Date.now() };
        boundedJSON(projectSession(row), 64 * 1024);
        ctx.request(sessions.put(row)); ctx.result(row);
      };
      ctx.request(events.index("session").count(IDBKeyRange.only(id)), (count) => { eventCount = count; check(); });
      ctx.request(tx.objectStore("contents").index("session").count(IDBKeyRange.only(id)), (count) => { contentCount = count; check(); });
      ctx.request(events.index("sessionSeq").get([id, session.lastSeq]), (row) => { stop = row; check(); });
    });
  });
}

export function readEvents(id, options = {}) {
  validText(id, "session id");
  return transaction(["events"], "readonly", (tx, ctx) => {
    const rows = []; let size = 0, lastSeq = 0;
    const range = IDBKeyRange.bound([id, 1], [id, Number.MAX_SAFE_INTEGER]);
    ctx.request(tx.objectStore("events").index("sessionSeq").openCursor(range), (cursor) => {
      if (!cursor) { ctx.result(rows); return; }
      const row = projectEvent(cursor.value);
      if (row.sessionId !== id || !Number.isSafeInteger(row.seq) || row.seq <= lastSeq) throw failure("flow-invalid-sequence");
      size += boundedJSON(row).size + 1;
      if (size > FLOW_LIMITS.totalBytes) throw failure("flow-read-batch-limit");
      lastSeq = row.seq; rows.push(row); cursor.continue();
    });
  }, options);
}

export function readContents(id, options = {}) {
  validText(id, "session id");
  return transaction(["contents"], "readonly", (tx, ctx) => {
    const rows = []; let size = 0;
    ctx.request(tx.objectStore("contents").index("session").openCursor(IDBKeyRange.only(id)), (cursor) => {
      if (!cursor) { ctx.result(rows); return; }
      const row = cursor.value;
      if (row.sessionId !== id || !(row.blob instanceof Blob) || row.blob.size !== row.size) throw failure("flow-invalid-content");
      size += byteCount(row.size);
      if (size > FLOW_LIMITS.totalBytes) throw failure("flow-read-batch-limit");
      // Blob handles are lazy: never materialize every row as ArrayBuffer.
      rows.push(row); cursor.continue();
    });
  }, options);
}
