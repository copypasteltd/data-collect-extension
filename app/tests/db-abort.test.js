import { it } from "node:test";
import assert from "node:assert/strict";
import { eventPage, removeSession } from "../src/db.js";

// Synthetic transaction notifications only. Written, not run; this is not
// real-IDB/Chrome acceptance and never opens an existing recording database.
async function withSyntheticDB(exercise) {
  const names = ["indexedDB", "IDBKeyRange"];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let notifyTransaction;
  const transactionReady = new Promise((resolve) => { notifyTransaction = resolve; });
  const db = {
    close() {},
    transaction() {
      const tx = {
        error: null, request: null,
        objectStore() { return {
          delete() {},
          index() { return {
            openCursor() { const request = {}; tx.request = request; return request; },
            openKeyCursor() { const request = {}; tx.requests ||= []; tx.requests.push(request); return request; },
          }; },
        }; },
      };
      notifyTransaction(tx);
      return tx;
    },
  };
  try {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
      open() { const request = { result: db }; queueMicrotask(() => request.onsuccess?.()); return request; },
    } });
    Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: {
      only: (value) => ({ only: value }), bound: (lower, upper) => ({ lower, upper }),
    } });
    await exercise(transactionReady);
  } finally {
    db.onversionchange?.();
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

it("eventPage无request错误的显式abort也结算，并拒绝已收到的部分页", { timeout: 1000 }, async () => {
  await withSyntheticDB(async (transactionReady) => {
    const pending = eventPage("synthetic");
    const rejection = assert.rejects(pending, /读取记录事务已中断/);
    const tx = await transactionReady;
    let continued = false;
    tx.request.result = { value: { id: "part", sessionId: "synthetic", seq: 1 }, continue() { continued = true; } };
    tx.request.onsuccess();
    assert.equal(continued, true);
    assert.equal(typeof tx.onabort, "function");
    tx.onabort();
    await rejection;
  });
});

it("eventPage abort保留浏览器的原错误对象", { timeout: 1000 }, async () => {
  await withSyntheticDB(async (transactionReady) => {
    const original = new Error("synthetic-abort");
    const pending = eventPage("synthetic");
    const rejection = assert.rejects(pending, (error) => error === original);
    const tx = await transactionReady;
    tx.error = original;
    tx.onabort();
    await rejection;
  });
});

it("eventPage正常complete仍返回收集页，后到通知不能改已结算结果", { timeout: 1000 }, async () => {
  await withSyntheticDB(async (transactionReady) => {
    const pending = eventPage("synthetic");
    const tx = await transactionReady;
    tx.request.result = { value: { id: "row", sessionId: "synthetic", seq: 1 }, continue() {} };
    tx.request.onsuccess();
    tx.oncomplete();
    tx.onabort();
    assert.deepEqual(await pending, [{ id: "row", sessionId: "synthetic", seq: 1 }]);
  });
});

it("已有删除API显式abort不保持永久pending，不新增删除策略", { timeout: 1000 }, async () => {
  await withSyntheticDB(async (transactionReady) => {
    const pending = removeSession("synthetic");
    const rejection = assert.rejects(pending, /删除记录事务已中断/);
    const tx = await transactionReady;
    tx.onabort();
    await rejection;
  });
});
