import { it } from "node:test";
import assert from "node:assert/strict";
import { openDB, put, putMany, putIdempotentEvents, get, all, closeSessionWrites, sealSession, interruptSession } from "../src/db.js";

// Synthetic transaction fixture only. NOT RUN during this repair; it does not
// replace future isolated real-IDB/browser validation of commit/abort ordering.
function syntheticDB(seed = {}) {
  const tables = Object.fromEntries(["sessions", "events", "assets", "imports"].map((name) =>
    [name, new Map((seed[name] || []).map((value) => [value.id, structuredClone(value)]))]));
  const transactions = [], waiting = [], failAdds = new Set(seed.failAdds || []);
  let running = false;
  const key = (value) => Array.isArray(value) ? value : [value];
  const compare = (a, b) => {
    const left = key(a), right = key(b);
    for (let i = 0; i < Math.min(left.length, right.length); i++) {
      if (left[i] < right[i]) return -1;
      if (left[i] > right[i]) return 1;
    }
    return left.length - right.length;
  };
  const inRange = (value, range) => !range || (range.only !== undefined ? compare(value, range.only) === 0 :
    (compare(value, range.lower) > 0 || !range.lowerOpen && compare(value, range.lower) === 0) &&
    (compare(value, range.upper) < 0 || !range.upperOpen && compare(value, range.upper) === 0));
  const next = () => {
    if (running || !waiting.length) return;
    running = true;
    waiting.shift()();
  };
  const db = {
    close() {},
    transaction(names, mode = "readonly") {
      const enlisted = typeof names === "string" ? [names] : names;
      const jobs = [];
      let active = false, aborted = false, staged, finishing = false;
      const tx = {
        names: enlisted, mode,
        abort() {
          if (aborted || finishing) return;
          aborted = true;
          setImmediate(() => { tx.onabort?.(); if (active) { running = false; next(); } });
        },
        objectStore(name) {
          assert.ok(enlisted.includes(name), "request must enlist its store");
          const request = (read) => {
            const req = {};
            jobs.push(() => {
              try { req.result = read(); req.onsuccess?.(); }
              catch (error) {
                req.error = error;
                let prevented = false;
                req.onerror?.({ preventDefault() { prevented = true; }, stopPropagation() {} });
                if (!prevented) { tx.error = error; tx.abort(); }
              }
            });
            if (active) setImmediate(pump);
            return req;
          };
          const values = () => [...staged[name].values()];
          return {
            get(id) { return request(() => structuredClone(staged[name].get(id))); },
            getAll() { return request(() => structuredClone(values())); },
            put(value) { return request(() => { staged[name].set(value.id, structuredClone(value)); return value.id; }); },
            add(value) { return request(() => {
              if (failAdds.delete(value.id)) throw new Error("synthetic transient add failure");
              if (staged[name].has(value.id)) throw new Error("ConstraintError");
              staged[name].set(value.id, structuredClone(value)); return value.id;
            }); },
            index(indexName) {
              const indexedKey = (value) => indexName === "sessionSeq" ? [value.sessionId, value.seq] : value.sessionId;
              const selected = (range) => values().filter((value) => inRange(indexedKey(value), range));
              return {
                count(range) { return request(() => selected(range).length); },
                getAll(id) { return request(() => structuredClone(values().filter((value) => value.sessionId === id))); },
                openCursor(range, direction) { return request(() => {
                  const ordered = selected(range).sort((a, b) => compare(indexedKey(a), indexedKey(b)));
                  const value = direction === "prev" ? ordered.at(-1) : ordered[0];
                  return value ? { value: structuredClone(value) } : null;
                }); },
              };
            },
          };
        },
      };
      function pump() {
        if (!active || aborted || finishing) return;
        if (jobs.length) { jobs.shift()(); setImmediate(pump); return; }
        finishing = true;
        if (mode === "readwrite") for (const name of enlisted) tables[name] = staged[name];
        tx.oncomplete?.(); running = false; next();
      }
      transactions.push(tx);
      waiting.push(() => {
        active = true;
        staged = Object.fromEntries(enlisted.map((name) => [name, new Map([...tables[name]].map(([id, value]) => [id, structuredClone(value)]))]));
        setImmediate(pump);
      });
      setImmediate(next);
      return tx;
    },
  };
  return { db, tables, transactions };
}
async function withSyntheticDB(seed, test) {
  const oldDB = globalThis.indexedDB, oldRange = globalThis.IDBKeyRange;
  const fixture = syntheticDB(seed);
  globalThis.IDBKeyRange = { only: (only) => ({ only }), bound: (lower, upper, lowerOpen = false, upperOpen = false) =>
    ({ lower, upper, lowerOpen, upperOpen }) };
  globalThis.indexedDB = { open() {
    const request = { result: fixture.db };
    queueMicrotask(() => request.onsuccess()); return request;
  } };
  try { await test(fixture); }
  finally { (await openDB()).onversionchange(); globalThis.indexedDB = oldDB; globalThis.IDBKeyRange = oldRange; }
}
const session = (extra = {}) => ({ id: "A", ownerId: "owner-A", producerVersion: "test-1", status: "stopping",
  revision: 1, lastSeq: 0, writeState: "open", ...extra });
const event = (id, seq, extra = {}) => ({ id, sessionId: "A", seq, kind: "test.event", time: 1, payload: { raw: "original" }, ...extra });
const owner = { ownerId: "owner-A" };

it("close fence 后只准一次内部 stop，seal 同事务固定 count/revision/lastSeq，终态后所有 evidence 写拒绝", async () => {
  const original = session();
  await withSyntheticDB({ sessions: [original] }, async ({ transactions }) => {
    await put("events", event("first", 1), owner);
    await put("assets", { id: "asset", sessionId: "A", blob: "synthetic raw bytes" }, owner);
    await closeSessionWrites("A", owner.ownerId);
    await assert.rejects(put("events", event("late", 2), owner), /session_writes_closed/);
    await assert.rejects(put("assets", { id: "late-asset", sessionId: "A" }, owner), /session_writes_closed/);
    await put("events", event("stop", 3, { kind: "session.stop" }), { ...owner, finalEvent: true });
    await assert.rejects(put("events", event("stop-again", 4, { kind: "session.stop" }), { ...owner, finalEvent: true }), /session_writes_closed/);
    const closed = await get("sessions", "A");
    const sealed = await sealSession({ ...original, status: "ready", coverage: { warnings: 0 } }, { expectedRevision: closed.revision });
    assert.deepEqual(transactions.at(-1).names, ["sessions", "events", "assets"]);
    assert.equal(sealed.status, "ready");
    assert.equal(sealed.revision, closed.revision + 1);
    assert.equal(sealed.seal.revision, sealed.revision);
    assert.equal(sealed.seal.lastSeq, 3);
    assert.equal(sealed.seal.eventCount, 2);
    assert.equal(sealed.seal.assetCount, 1);
    assert.deepEqual(sealed.coverage, { warnings: 0 });
    await assert.rejects(put("events", event("tab.closed", 5), owner), /session_finalized/);
    await assert.rejects(put("assets", { id: "post-seal", sessionId: "A" }, owner), /session_finalized/);
    assert.deepEqual(await putMany("events", [event("page-late", 6)], owner), [false]);
    assert.deepEqual(await putMany("assets", [{ id: "asset-late", sessionId: "A" }], owner), [false]);
    assert.deepEqual(await get("sessions", "A"), sealed);
    assert.equal((await all("events", "A")).length, 2);
  });
});

it("已有 batch 重试幂等不改 seq/revision，seal 后同内容 ACK 仍只读，冲突不追加", async () => {
  await withSyntheticDB({ sessions: [session()] }, async () => {
    const batch = [event("batch_0", 1), event("batch_1", 2)];
    assert.deepEqual(await putIdempotentEvents(batch, 2, owner), ["created", "created"]);
    const before = await get("sessions", "A");
    const retry = batch.map((value) => ({ ...value, seq: value.seq + 100 }));
    assert.deepEqual(await putIdempotentEvents(retry, 0, owner), ["existing", "existing"]);
    assert.deepEqual(await get("sessions", "A"), before);
    assert.deepEqual(await putIdempotentEvents([{ ...batch[0], payload: { raw: "changed" } }, event("new", 3)], 2, owner), ["conflict", "conflict"]);
    assert.equal((await all("events", "A")).length, 2);
    const sealed = await interruptSession(session(), "synthetic stop");
    assert.deepEqual(await putIdempotentEvents(retry, 2, owner), ["existing", "existing"]);
    assert.deepEqual(await putIdempotentEvents([event("missing", 8)], 2, owner), ["closed"]);
    assert.deepEqual(await get("sessions", "A"), sealed);
    assert.deepEqual((await all("events", "A")).map((value) => value.seq), [1, 2]);
  });
});

it("owner 不匹配/缺失拒绝新批写；旧 active 无 token 仍可按原 owner 约束收尾", async () => {
  const legacy = { id: "legacy", status: "recording", startedAt: 1 };
  await withSyntheticDB({ sessions: [session(), legacy], events: [{ ...event("legacy-event", 7), sessionId: "legacy" }] }, async () => {
    await assert.rejects(put("events", event("wrong-owner", 1), { ownerId: "other" }), /session_owner_mismatch/);
    await assert.rejects(put("assets", { id: "missing-owner", sessionId: "A" }), /session_owner_mismatch/);
    await put("events", { ...event("legacy-next", 8), sessionId: "legacy" });
    const updated = await get("sessions", "legacy");
    assert.equal(updated.lastSeq, 8);
    assert.equal(updated.ownerId, undefined);
    await put("events", { ...event("legacy-next-requested-old-seq", 8), sessionId: "legacy" });
    assert.equal((await get("events", "legacy-next-requested-old-seq")).seq, 9);
    for (const seq of [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1])
      await assert.rejects(put("events", event("invalid-" + seq, seq), owner), /event_sequence_invalid_or_exhausted/);
  });
});

it("interrupt 合并最新诊断原值但保护已有 ready/interrupted，旧终态不补 seal/producer", async () => {
  const rawEvent = event("raw", 1), existing = session({ status: "recording", storageError: true, droppedEvents: 2, notice: "disk failed" });
  const ready = { id: "old-ready", status: "ready", raw: "keep old value" };
  const interrupted = { id: "old-interrupted", status: "interrupted", notice: "old cause" };
  await withSyntheticDB({ sessions: [existing, ready, interrupted], events: [rawEvent] }, async () => {
    const saved = await interruptSession({ ...existing, communicationUnknown: true, unknownEvents: 3, captureIncomplete: true, needsVerification: true,
      collectorFailedEvents: 1, droppedEvents: 1, notice: "late diagnostic" }, "stop failed");
    assert.equal(saved.storageError, true);
    assert.equal(saved.communicationUnknown, true);
    assert.equal(saved.captureIncomplete, true); assert.equal(saved.needsVerification, true);
    assert.equal(saved.unknownEvents, 3);
    assert.equal(saved.collectorFailedEvents, 1);
    assert.equal(saved.droppedEvents, 2);
    assert.match(saved.notice, /disk failed/); assert.match(saved.notice, /late diagnostic/); assert.match(saved.notice, /stop failed/);
    assert.deepEqual(await get("events", "raw"), rawEvent);
    assert.deepEqual(await interruptSession({ ...saved, notice: "must not overwrite" }, "retry"), saved);
    for (const old of [ready, interrupted]) {
      assert.deepEqual(await interruptSession({ ...old, storageError: true }, "new cause"), old);
      await put("sessions", { ...old, status: "recording", producerVersion: "must-not-relabel" });
      assert.deepEqual(await get("sessions", old.id), old);
    }
  });
});

it("陈旧 sessions 写不回退 writer 水位/producer，seal 检查 expected revision", async () => {
  const original = session();
  await withSyntheticDB({ sessions: [original] }, async () => {
    await put("events", event("first", 1), owner);
    await put("sessions", { ...original, producerVersion: "wrong-new-version", lastSeq: 0 });
    const updated = await get("sessions", "A");
    assert.equal(updated.lastSeq, 1); assert.equal(updated.producerVersion, "test-1");
    await closeSessionWrites("A", owner.ownerId);
    await put("events", event("stop", 2, { kind: "session.stop" }), { ...owner, finalEvent: true });
    await assert.rejects(sealSession({ ...original, status: "ready" }, { expectedRevision: 1 }), /session_revision_mismatch/);
    const closed = await get("sessions", "A");
    assert.equal(closed.writeState, "closed");
    assert.equal(closed.seal, undefined);
  });
});

it("batch 首项临时失败/后项成功后，同 values 重试可补齐，补项序号高于已提交水位", async () => {
  const first = event("partial_0", 1), second = event("partial_1", 2);
  await withSyntheticDB({ sessions: [session()], failAdds: [first.id] }, async () => {
    assert.deepEqual(await putIdempotentEvents([first, second], 2, owner), ["failed", "created"]);
    assert.equal((await get("sessions", "A")).lastSeq, 2);
    assert.deepEqual(await putIdempotentEvents([first, second], 2, owner), ["created", "existing"]);
    const repaired = await get("events", first.id), unchanged = await get("events", second.id);
    assert.equal(repaired.seq, 3);
    assert.equal(repaired.id, first.id); assert.equal(repaired.time, first.time); assert.deepEqual(repaired.payload, first.payload);
    assert.deepEqual(unchanged, second);
    // A later normal writer whose local requested seq lagged the DB is also
    // assigned a fresh unique seq rather than losing the original observation.
    await put("events", event("next", 3), owner);
    assert.equal((await get("events", "next")).seq, 4);
    const sealed = await interruptSession(session(), "partial retry complete");
    assert.equal(sealed.seal.lastSeq, 4); assert.equal(sealed.seal.eventCount, 3);
  });
});

it("final stop 写失败不得 ready seal；中断可封存原有证据和 storageError", async () => {
  await withSyntheticDB({ sessions: [session()], failAdds: ["stop-fails"] }, async () => {
    await put("events", event("first", 1), owner);
    await closeSessionWrites("A", owner.ownerId);
    await assert.rejects(put("events", event("stop-fails", 2, { kind: "session.stop" }), { ...owner, finalEvent: true }));
    await assert.rejects(sealSession(session({ status: "ready" })), /session_not_drained/);
    const saved = await interruptSession(session({ storageError: true }), "stop row failed");
    assert.equal(saved.status, "interrupted"); assert.equal(saved.storageError, true);
    assert.equal(saved.seal.eventCount, 1); assert.equal(saved.seal.lastSeq, 1);
  });
});

