import { it } from "node:test";
import assert from "node:assert/strict";
import { openDB } from "../src/db.js";

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
  } finally {
    globalThis.indexedDB = original;
  }
});
