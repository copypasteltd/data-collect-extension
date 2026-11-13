import { isActiveSession, sessionWriteError, mergeInterruptionDiagnostics } from "./session-lifecycle.js";

const NAME = "logic-recorder";
const OPEN_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 5000;
let promise;
function limitWrite(tx, reject) {
  const timer = setTimeout(() => {
    try { tx.abort(); } catch {}
    reject(new Error("本地存储写入超时"));
  }, WRITE_TIMEOUT_MS);
  return () => clearTimeout(timer);
}
export function openDB() {
  if (!promise) {
    let opening;
    opening = new Promise((resolve, reject) => {
      const request = indexedDB.open(NAME, 3);
      let finished = false;
      const timer = setTimeout(() => {
        finished = true;
        if (promise === opening) promise = undefined;
        reject(new Error("本地存储打开超时"));
      }, OPEN_TIMEOUT_MS);
      request.onupgradeneeded = (event) => {
        if (finished) { try { request.transaction.abort(); } catch {} return; }
        const db = request.result;
        let events;
        if (event.oldVersion < 1) {
          db.createObjectStore("sessions", { keyPath: "id" });
          events = db.createObjectStore("events", { keyPath: "id" });
          events.createIndex("session", "sessionId");
          const assets = db.createObjectStore("assets", { keyPath: "id" });
          assets.createIndex("session", "sessionId");
        } else events = request.transaction.objectStore("events");
        if (!events.indexNames.contains("sessionSeq"))
          events.createIndex("sessionSeq", ["sessionId", "seq"]);
        if (!db.objectStoreNames.contains("imports"))
          db.createObjectStore("imports", { keyPath: "id" });
      };
      request.onsuccess = () => {
        const db = request.result;
        if (finished) { db.close(); return; }
        finished = true;
        clearTimeout(timer);
        db.onversionchange = () => {
          db.close();
          if (promise === opening) promise = undefined;
        };
        resolve(db);
      };
      request.onerror = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        if (promise === opening) promise = undefined;
        reject(request.error);
      };
    });
    promise = opening;
    opening.catch(() => { if (promise === opening) promise = undefined; });
  }
  return promise;
}
export async function eventPage(sessionId, after = 0, limit = 20) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("events");
    const range = IDBKeyRange.bound(
      [sessionId, after],
      [sessionId, Number.MAX_SAFE_INTEGER],
      true,
      false,
    );
    const request = tx
      .objectStore("events")
      .index("sessionSeq")
      .openCursor(range);
    const results = [];
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve(results);
    tx.onerror = () => reject(tx.error || new Error("读取记录事务失败"));
    // An explicit abort need not dispatch an individual request error. Never
    // leave an export page waiting only for an oncomplete that cannot happen.
    tx.onabort = () => reject(tx.error || new Error("读取记录事务已中断"));
  });
}
export async function countEvents(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db
      .transaction("events")
      .objectStore("events")
      .index("session")
      .count(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function countAssets(sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const request = db.transaction("assets").objectStore("assets").index("session")
      .count(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function writeError(reason) {
  return Object.assign(new Error(`会话拒绝写入：${reason}`), { code: reason });
}
function revisionOf(session) {
  return Number.isSafeInteger(session?.revision) && session.revision >= 0 ? session.revision : 0;
}
function lastSequenceRange(sessionId) {
  return IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]);
}
const sameEvent = (left, right) =>
  ["sessionId", "time", "kind", "tabId", "frameId", "documentId", "screenshotRequested", "batchSize"]
    .every((key) => left[key] === right[key]) && JSON.stringify(left.payload) === JSON.stringify(right.payload);

async function writeEvidence(name, values, { ownerId, capacity = Infinity, idempotent = false, finalEvent = false } = {}) {
  if (!values.length) return { results: [] };
  const db = await openDB();
  return new Promise((resolve, reject) => {
    // The session authority and the evidence share the transaction lock. A
    // terminal commit/close fence cannot race an evidence-only transaction.
    const tx = db.transaction(["sessions", name], "readwrite");
    const clear = limitWrite(tx, reject);
    const sessions = tx.objectStore("sessions"), store = tx.objectStore(name);
    const results = values.map(() => "failed");
    let reason, failure;
    const abort = (error) => { failure = error; try { tx.abort(); } catch {} };
    try {
      const readSession = sessions.get(values[0].sessionId);
      readSession.onsuccess = () => {
        try {
          const session = readSession.result;
          if (!session || values.some((value) => value.sessionId !== session.id)) {
            reason = "session_missing";
            return;
          }
          if (session.ownerId !== ownerId) { reason = "session_owner_mismatch"; return; }
          let lastSeq = Number.isSafeInteger(session.lastSeq) ? session.lastSeq : 0;
          let pendingReads = values.length + (name === "events" && !Number.isSafeInteger(session.lastSeq) ? 1 : 0);
          const missing = [];
          const finishRead = () => {
            if (--pendingReads) return;
            if (results.includes("conflict")) { results.fill("conflict"); return; }
            let remaining = capacity, pendingWrites = 0, created = 0, committedLastSeq = lastSeq, finalStopEventId;
            const commitMetadata = () => {
              if (pendingWrites || !created) return;
              const next = { ...session, revision: revisionOf(session) + 1 };
              if (name === "events") next.lastSeq = committedLastSeq;
              if (finalStopEventId) next.finalStopEventId = finalStopEventId;
              sessions.put(next);
            };
            for (const index of missing.sort((a, b) => a - b)) {
              const value = values[index];
              const isFinal = finalEvent && name === "events" && values.length === 1 && value.kind === "session.stop";
              const denied = sessionWriteError(session, ownerId, isFinal);
              if (denied) { reason = denied; results[index] = "closed"; continue; }
              if (name === "events" && (!Number.isSafeInteger(value.seq) || value.seq <= 0 || lastSeq >= Number.MAX_SAFE_INTEGER)) {
                reason = "event_sequence_invalid_or_exhausted";
                continue;
              }
              if (remaining <= 0) { results[index] = "capacity"; continue; }
              remaining--;
              // Partial batches may already have committed a later slot. Retry
              // missing IDs at a fresh sequence above the committed watermark,
              // not below an eventPage cursor; never rewrite existing raw rows.
              const stored = name === "events" ? { ...value, seq: Math.max(value.seq, lastSeq + 1) } : value;
              if (name === "events") lastSeq = stored.seq;
              try {
                const write = store.add(stored);
                pendingWrites++;
                write.onsuccess = () => {
                  results[index] = "created";
                  created++;
                  if (name === "events") committedLastSeq = Math.max(committedLastSeq, stored.seq);
                  if (isFinal) finalStopEventId = value.id;
                  pendingWrites--;
                  commitMetadata();
                };
                write.onerror = (event) => {
                  event.preventDefault(); event.stopPropagation();
                  pendingWrites--;
                  commitMetadata();
                };
              } catch {}
            }
          };
          if (pendingReads > values.length) {
            const last = store.index("sessionSeq").openCursor(lastSequenceRange(session.id), "prev");
            last.onsuccess = () => {
              lastSeq = Math.max(lastSeq, last.result?.value.seq || 0);
              finishRead();
            };
          }
          values.forEach((value, index) => {
            const read = store.get(value.id);
            read.onsuccess = () => {
              if (read.result) results[index] = idempotent && sameEvent(read.result, value) ? "existing" : "conflict";
              else missing.push(index);
              finishRead();
            };
            read.onerror = (event) => { event.preventDefault(); event.stopPropagation(); finishRead(); };
          });
        } catch (error) { abort(error); }
      };
    } catch (error) { abort(error); }
    tx.oncomplete = () => { clear(); resolve({ results, reason }); };
    tx.onabort = () => { clear(); reject(failure || tx.error || new Error("存储事务已中断")); };
    tx.onerror = () => {};
  });
}

export async function put(store, value, options) {
  if (["events", "assets"].includes(store)) {
    const { results, reason } = await writeEvidence(store, [value], options);
    if (results[0] !== "created") throw writeError(reason || results[0]);
    return;
  }
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite"), target = tx.objectStore(store);
    const clear = limitWrite(tx, reject);
    let result, failure;
    const abort = (error) => { failure = error; try { tx.abort(); } catch {} };
    try {
      if (store === "sessions") {
        const read = target.get(value.id);
        read.onsuccess = () => {
          try {
            const existing = read.result;
            if (existing && !isActiveSession(existing)) { result = existing; return; }
            if (existing && existing.ownerId !== value.ownerId) throw writeError("session_owner_mismatch");
            result = { ...value, revision: revisionOf(existing) + 1 };
            // Callers may have an older in-memory copy. Never roll back the
            // writer's watermark, close fence, owner or original producer tag.
            for (const key of ["lastSeq", "writeState", "finalStopEventId", "ownerId", "producerVersion"])
              if (existing && Object.hasOwn(existing, key)) result[key] = existing[key];
            target.put(result);
          } catch (error) { abort(error); }
        };
      } else target.put(value);
    } catch (error) { abort(error); }
    tx.oncomplete = () => { clear(); resolve(result); };
    tx.onerror = () => { clear(); reject(failure || tx.error); };
    tx.onabort = () => { clear(); reject(failure || tx.error || new Error("存储事务已中断")); };
  });
}

export async function closeSessionWrites(sessionId, ownerId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("sessions", "readwrite"), store = tx.objectStore("sessions");
    const clear = limitWrite(tx, reject);
    let result, failure;
    const read = store.get(sessionId);
    read.onsuccess = () => {
      const session = read.result;
      const reason = sessionWriteError(session, ownerId);
      if (reason && reason !== "session_writes_closed") {
        failure = writeError(reason); tx.abort(); return;
      }
      result = session;
      if (session.writeState !== "closed") {
        result = { ...session, writeState: "closed", revision: revisionOf(session) + 1 };
        store.put(result);
      }
    };
    tx.oncomplete = () => { clear(); resolve(result); };
    tx.onerror = () => { clear(); reject(failure || tx.error); };
    tx.onabort = () => { clear(); reject(failure || tx.error || new Error("存储事务已中断")); };
  });
}

// No Chrome resource is part of this transaction. It seals only the IDB evidence
// set, counts, sequence watermark, coverage and terminal session metadata.
export async function sealSession(session, { interrupted = false, reason, expectedRevision } = {}) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "events", "assets"], "readwrite");
    const clear = limitWrite(tx, reject), sessions = tx.objectStore("sessions");
    let result, failure;
    const abort = (error) => { failure = error; try { tx.abort(); } catch {} };
    try {
      const read = sessions.get(session.id);
      read.onsuccess = () => {
        try {
          const existing = read.result;
          // Older ready/interrupted rows are readable as-is. Do not manufacture
          // a seal for them, and never overwrite a terminal row on STOP retry.
          if (existing && !isActiveSession(existing)) { result = existing; return; }
          if (!existing && !interrupted) throw writeError("session_missing");
          if (existing && existing.ownerId !== session.ownerId) throw writeError("session_owner_mismatch");
          if (expectedRevision != null && existing?.revision !== expectedRevision) throw writeError("session_revision_mismatch");
          if (!interrupted && (existing.writeState !== "closed" || !existing.finalStopEventId))
            throw writeError("session_not_drained");
          if (!interrupted && !["ready", "interrupted"].includes(session.status)) throw writeError("session_not_terminal");
          const base = existing || session;
          let eventCount = 0, assetCount = 0, lastSeq = 0, pendingReads = 3;
          const finish = () => {
            if (--pendingReads) return;
            const now = Date.now(), revision = revisionOf(base) + 1;
            result = interrupted ? mergeInterruptionDiagnostics(existing, session, reason) : { ...base, ...session };
            for (const key of ["ownerId", "producerVersion", "finalStopEventId"])
              if (Object.hasOwn(base, key)) result[key] = base[key];
            Object.assign(result, {
              status: interrupted ? "interrupted" : session.status,
              endedAt: session.endedAt || now,
              ...(interrupted ? { interruptedAt: session.interruptedAt || now, incomplete: true } : {}),
              revision, lastSeq, eventCount, assetCount, writeState: "sealed",
              seal: { revision, lastSeq, eventCount, assetCount, sealedAt: now },
            });
            sessions.put(result);
          };
          const events = tx.objectStore("events"), assets = tx.objectStore("assets");
          const count = events.index("session").count(IDBKeyRange.only(session.id));
          count.onsuccess = () => { eventCount = count.result; finish(); };
          const assetTotal = assets.index("session").count(IDBKeyRange.only(session.id));
          assetTotal.onsuccess = () => { assetCount = assetTotal.result; finish(); };
          const last = events.index("sessionSeq").openCursor(lastSequenceRange(session.id), "prev");
          last.onsuccess = () => { lastSeq = last.result?.value.seq || 0; finish(); };
        } catch (error) { abort(error); }
      };
    } catch (error) { abort(error); }
    tx.oncomplete = () => { clear(); resolve(result); };
    tx.onerror = () => { clear(); reject(failure || tx.error); };
    tx.onabort = () => { clear(); reject(failure || tx.error || new Error("存储事务已中断")); };
  });
}
export function interruptSession(session, reason) {
  return sealSession(session, { interrupted: true, reason });
}

export async function putMany(store, values, options) {
  if (["events", "assets"].includes(store)) {
    const { results } = await writeEvidence(store, values, options);
    return results.map((result) => result === "created");
  }
  if (store === "sessions") return Promise.all(values.map((value) => put(store, value).then(() => true)));
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, "readwrite");
    const clear = limitWrite(tx, reject);
    const results = values.map(() => true);
    const target = tx.objectStore(store);
    values.forEach((value, index) => {
      try {
        const request = target.put(value);
        request.onerror = (event) => { results[index] = false; event.preventDefault(); event.stopPropagation(); };
      } catch { results[index] = false; }
    });
    tx.oncomplete = () => { clear(); resolve(results); };
    tx.onabort = () => { clear(); reject(tx.error || new Error("存储事务已中断")); };
    tx.onerror = () => {};
  });
}
export async function putIdempotentEvents(values, capacity, options) {
  const { results } = await writeEvidence("events", values, { ...options, capacity, idempotent: true });
  return results;
}
export async function get(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(store).objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function all(store, sessionId) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const source = db.transaction(store).objectStore(store);
    const req = sessionId
      ? source.index("session").getAll(sessionId)
      : source.getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function saveImport(session, blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "imports"], "readwrite");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("保存事务已中断"));
    try {
      tx.objectStore("sessions").add(session);
      tx.objectStore("imports").add({ id: session.id, blob });
    } catch (error) {
      tx.abort();
      reject(error);
    }
  });
}
export async function removeSession(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["sessions", "events", "assets", "imports"], "readwrite");
    tx.objectStore("sessions").delete(id);
    tx.objectStore("imports").delete(id);
    for (const name of ["events", "assets"]) {
      const request = tx
        .objectStore(name)
        .index("session")
        .openKeyCursor(IDBKeyRange.only(id));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) {
          tx.objectStore(name).delete(cursor.primaryKey);
          cursor.continue();
        }
      };
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("删除记录事务失败"));
    tx.onabort = () => reject(tx.error || new Error("删除记录事务已中断"));
  });
}
