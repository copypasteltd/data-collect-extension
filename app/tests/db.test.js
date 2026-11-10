import { it } from "node:test";
import assert from "node:assert/strict";
import { openDB, put, putMany, putIdempotentEvents } from "../src/db.js";

it("存储打开失败后可重试，版本变化后关闭旧连接并重新打开", async () => {
  const original = globalThis.indexedDB;
  let attempts = 0;
  const connections = [];
  globalThis.indexedDB = {
    open() {
      const request = {};
      attempts++;
      if (attempts === 1) {
        request.error = new Error("临时打开失败");
        queueMicrotask(() => request.onerror());
      } else {
        const db = {
          closed: false,
          close() {
            this.closed = true;
          },
        };
        connections.push(db);
        request.result = db;
        queueMicrotask(() => request.onsuccess());
      }
      return request;
    },
  };
  try {
    await assert.rejects(openDB(), /临时打开失败/);
    const first = await openDB();
    assert.equal(await openDB(), first);
    first.onversionchange();
    assert.equal(first.closed, true);
    assert.equal(await openDB(), connections[1]);
    assert.equal(attempts, 3);
    connections[1].onversionchange();
  } finally {
    globalThis.indexedDB = original;
  }
});

it("写入事务无响应时中止并报告超时", async () => {
  const original = globalThis.indexedDB;
  const transactions = [];
  const db = {
    close() {},
    transaction() {
      const tx = {
        aborted: false,
        objectStore() { return { put() { return {}; }, get() { return {}; } }; },
        abort() { this.aborted = true; queueMicrotask(() => this.onabort?.()); },
      };
      transactions.push(tx);
      return tx;
    },
  };
  globalThis.indexedDB = {
    open() {
      const request = { result: db };
      queueMicrotask(() => request.onsuccess());
      return request;
    },
  };
  try {
    const results = await Promise.allSettled([
      put("events", { id: "one" }),
      putMany("events", [{ id: "two" }]),
      putIdempotentEvents([{ id: "three" }], 1),
    ]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.match(result.reason.message, /本地存储写入超时/);
    }
    assert.equal(transactions.length, 3);
    assert.ok(transactions.every((tx) => tx.aborted));
  } finally {
    db.onversionchange?.();
    globalThis.indexedDB = original;
  }
});

it("存储打开超时后可重试，并关闭迟到的旧连接", async () => {
  const original = globalThis.indexedDB;
  const requests = [];
  const makeDb = () => ({ closed: false, close() { this.closed = true; } });
  globalThis.indexedDB = {
    open() {
      const request = {};
      requests.push(request);
      if (requests.length > 1) {
        request.result = makeDb();
        queueMicrotask(() => request.onsuccess());
      }
      return request;
    },
  };
  let current;
  try {
    await assert.rejects(openDB(), /本地存储打开超时/);
    current = await openDB();
    const late = makeDb();
    requests[0].result = late;
    requests[0].onsuccess();
    assert.equal(late.closed, true);
    assert.equal(current.closed, false);
    assert.equal(await openDB(), current);
  } finally {
    current?.onversionchange?.();
    globalThis.indexedDB = original;
  }
});
