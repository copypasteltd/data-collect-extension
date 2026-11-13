import { it } from "node:test";
import assert from "node:assert/strict";
import { openDB, eventPage, countEvents, countAssets, get, all } from "../src/db.js";

// All data/IDB notifications below are synthetic. No profile, real recording or
// disk IndexedDB is opened; the native Node test process is not OS-isolated.
const sessionId = "synthetic-private-session-id";
const row = { id: "synthetic-row", sessionId, seq: 1 };
const reads = [
  { name: "countEvents", operation: "读取记录数量", run: (options) => countEvents(sessionId, options), result: 7 },
  { name: "countAssets", operation: "读取附件数量", run: (options) => countAssets(sessionId, options), result: 3 },
  { name: "get", operation: "读取单条记录", run: (options) => get("sessions", sessionId, options), result: row },
  { name: "all", operation: "读取记录列表", run: (options) => all("assets", sessionId, options), result: [row] },
  { name: "eventPage", operation: "读取记录", run: (options) => eventPage(sessionId, 0, 20, options), result: [row], cursor: true },
];

async function withSyntheticDB(exercise, { setupError, abortThrows = false } = {}) {
  const names = ["indexedDB", "IDBKeyRange"];
  const saved = new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  let notifyTransaction;
  const transactionReady = new Promise((resolve) => { notifyTransaction = resolve; });
  const transactions = [], mutations = [];
  const mutate = () => { mutations.push("unexpected mutation"); throw new Error("readonly mutation forbidden"); };
  const db = {
    close() {},
    transaction(name, mode = "readonly") {
      assert.equal(mode, "readonly");
      const tx = {
        name, error: null, request: null, aborts: 0,
        abort() {
          this.aborts++;
          if (abortThrows) throw new Error("synthetic abort unavailable");
          this.onabort?.(); // Deliberately synchronous: timeout cause must win.
        },
        objectStore(store) {
          assert.equal(store, name);
          if (setupError) throw setupError;
          const request = () => { const req = {}; tx.request = req; return req; };
          return {
            get: request, getAll: request, put: mutate, add: mutate, delete: mutate,
            index() { return { count: request, getAll: request, openCursor: request }; },
          };
        },
      };
      transactions.push(tx);
      notifyTransaction(tx);
      return tx;
    },
  };
  try {
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
      open(name, version) {
        assert.equal(name, "logic-recorder");
        assert.equal(version, 3);
        const request = { result: db };
        queueMicrotask(() => request.onsuccess?.());
        return request;
      },
    } });
    Object.defineProperty(globalThis, "IDBKeyRange", { configurable: true, value: {
      only: (value) => ({ only: value }),
      bound: (lower, upper) => ({ lower, upper }),
    } });
    await exercise({ db, transactions, transactionReady, mutations });
    assert.deepEqual(mutations, []);
  } finally {
    db.onversionchange?.();
    for (const name of names) {
      const descriptor = saved.get(name);
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  }
}

function trackedSignal() {
  const controller = new AbortController(), listeners = new Set();
  return {
    controller, listeners,
    signal: {
      get aborted() { return controller.signal.aborted; },
      addEventListener(type, listener, options) {
        assert.equal(type, "abort");
        listeners.add(listener);
        controller.signal.addEventListener(type, listener, options);
      },
      removeEventListener(type, listener) {
        listeners.delete(listener);
        controller.signal.removeEventListener(type, listener);
      },
    },
  };
}

for (const read of reads) {
  it(`${read.name}无任何通知时small timeout拒绝并abort只读事务，不伪造空结果`, { timeout: 1000 }, async () => {
    await withSyntheticDB(async ({ transactionReady, mutations }) => {
      const pending = read.run({ timeoutMs: 5 });
      const rejection = assert.rejects(pending, (error) => {
        assert.equal(error.message, `${read.operation}超时`);
        assert.equal(error.message.includes(sessionId), false);
        return true;
      });
      const tx = await transactionReady;
      await rejection;
      assert.equal(tx.aborts, 1);
      assert.deepEqual(mutations, []);
      tx.request.result = read.cursor ? { value: row, continue() { assert.fail("late cursor continued"); } } : read.result;
      tx.request.onsuccess();
      tx.oncomplete?.();
      tx.onabort();
      assert.equal(tx.aborts, 1);
    });
  });

  it(`${read.name}无request错误的显式abort也拒绝并清理`, { timeout: 1000 }, async () => {
    await withSyntheticDB(async ({ transactionReady }) => {
      const tracked = trackedSignal();
      const pending = read.run({ timeoutMs: 100, signal: tracked.signal });
      const rejection = assert.rejects(pending, { message: `${read.operation}事务已中断` });
      const tx = await transactionReady;
      tx.onabort();
      await rejection;
      assert.equal(tracked.listeners.size, 0);
    });
  });

  it(`${read.name}事务错误保留原错误对象，未知不当作零或空数组`, { timeout: 1000 }, async () => {
    await withSyntheticDB(async ({ transactionReady }) => {
      const pending = read.run({ timeoutMs: 100 });
      const original = new Error("synthetic transaction error");
      const rejection = assert.rejects(pending, (error) => error === original);
      const tx = await transactionReady;
      tx.error = original;
      tx.onerror();
      await rejection;
    });
  });

  it(`${read.name}取消中止只读事务并去掉监听，不包含signal reason原值`, { timeout: 1000 }, async () => {
    await withSyntheticDB(async ({ transactionReady }) => {
      const tracked = trackedSignal();
      const pending = read.run({ timeoutMs: 100, signal: tracked.signal });
      const rejection = assert.rejects(pending, { message: `${read.operation}已取消` });
      const tx = await transactionReady;
      tracked.controller.abort(new Error(sessionId));
      await rejection;
      assert.equal(tx.aborts, 1);
      assert.equal(tracked.listeners.size, 0);
    });
  });

  it(`${read.name}预取消时不发request且abort失败仍结算`, { timeout: 1000 }, async () => {
    await withSyntheticDB(async ({ transactionReady }) => {
      const tracked = trackedSignal();
      tracked.controller.abort();
      const pending = read.run({ timeoutMs: 100, signal: tracked.signal });
      const rejection = assert.rejects(pending, { message: `${read.operation}已取消` });
      const tx = await transactionReady;
      await rejection;
      assert.equal(tx.request, null);
      assert.equal(tx.aborts, 1);
      assert.equal(tracked.listeners.size, 0);
    }, { abortThrows: true });
  });

  it(`${read.name}请求错误保留原因并abort，即使没有tx错误通知`, { timeout: 1000 }, async () => {
    await withSyntheticDB(async ({ transactionReady }) => {
      const pending = read.run({ timeoutMs: 100 });
      const original = new Error("synthetic request error");
      const rejection = assert.rejects(pending, (error) => error === original);
      const tx = await transactionReady;
      tx.request.error = original;
      tx.request.onerror();
      await rejection;
      assert.equal(tx.aborts, 1);
    }, { abortThrows: true });
  });

  it(`${read.name}正常结果清理timer和signal，保留request success兼容性`, { timeout: 1000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await withSyntheticDB(async ({ transactionReady }) => {
      const tracked = trackedSignal();
      const pending = read.run({ signal: tracked.signal });
      const tx = await transactionReady;
      tx.request.result = read.cursor ? { value: row, continue() {} } : read.result;
      tx.request.onsuccess();
      if (read.cursor) tx.oncomplete();
      assert.deepEqual(await pending, read.result);
      assert.equal(tracked.listeners.size, 0);
      t.mock.timers.tick(20000);
      tracked.controller.abort();
      assert.equal(tx.aborts, 0);
    });
  });
}

it("所有read默认15000ms deadline，不需真实等待15秒", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await withSyntheticDB(async ({ transactionReady, transactions }) => {
    const pending = reads.map((read) => read.run());
    const rejections = pending.map((result, index) => assert.rejects(result, { message: `${reads[index].operation}超时` }));
    await transactionReady;
    assert.equal(transactions.length, reads.length);
    t.mock.timers.tick(14999);
    assert.ok(transactions.every((tx) => tx.aborts === 0));
    t.mock.timers.tick(1);
    await Promise.all(rejections);
    assert.ok(transactions.every((tx) => tx.aborts === 1));
  });
});

it("eventPage有部分数据但tx不complete时超时拒绝，迟到cursor不能继续", { timeout: 1000 }, async () => {
  await withSyntheticDB(async ({ transactionReady }) => {
    const pending = eventPage(sessionId, 0, 20, { timeoutMs: 5 });
    const rejection = assert.rejects(pending, { message: "读取记录超时" });
    const tx = await transactionReady;
    let continued = 0;
    tx.request.result = { value: row, continue() { continued++; } };
    tx.request.onsuccess();
    assert.equal(continued, 1);
    await rejection;
    tx.request.onsuccess();
    tx.oncomplete();
    assert.equal(continued, 1);
    assert.equal(tx.aborts, 1);
  });
});

it("eventPage捕获cursor.continue异常，拒绝部分页并abort", { timeout: 1000 }, async () => {
  await withSyntheticDB(async ({ transactionReady }) => {
    const pending = eventPage(sessionId, 0, 20, { timeoutMs: 100 });
    const original = new Error("synthetic cursor failure");
    const rejection = assert.rejects(pending, (error) => error === original);
    const tx = await transactionReady;
    tx.request.result = { value: row, continue() { throw original; } };
    assert.doesNotThrow(() => tx.request.onsuccess());
    await rejection;
    assert.equal(tx.aborts, 1);
  });
});

it("eventPage收集到limit即停止继续游标，但必须等待tx complete", { timeout: 1000 }, async () => {
  await withSyntheticDB(async ({ transactionReady }) => {
    const pending = eventPage(sessionId, 0, 1, { timeoutMs: 100 });
    const tx = await transactionReady;
    let settled = false;
    pending.then(() => { settled = true; });
    tx.request.result = { value: row, continue() { assert.fail("cursor past limit"); } };
    tx.request.onsuccess();
    await Promise.resolve();
    assert.equal(settled, false);
    tx.oncomplete();
    assert.deepEqual(await pending, [row]);
  });
});

it("eventPage拒绝非正整数或超过1000的limit，且不打开数据库", async () => {
  await withSyntheticDB(async ({ db, transactions }) => {
    assert.equal(db.onversionchange, undefined);
    for (const limit of [0, -1, 1.5, NaN, Infinity, "20", 1001])
      await assert.rejects(eventPage(sessionId, 0, limit), { name: "RangeError", message: "读取记录分页大小须为1至1000的整数" });
    assert.equal(transactions.length, 0);
    assert.equal(db.onversionchange, undefined);
  });
});

it("all无sessionId的旧调用仍在request success返回", { timeout: 1000 }, async () => {
  await withSyntheticDB(async ({ transactionReady }) => {
    const pending = all("sessions");
    const tx = await transactionReady;
    tx.request.result = [row];
    tx.request.onsuccess();
    assert.deepEqual(await pending, [row]);
  });
});

it("read同步建request失败清理timer和signal，不需等deadline", { timeout: 1000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const original = new Error("synthetic source error");
  await withSyntheticDB(async ({ transactionReady }) => {
    const tracked = trackedSignal();
    const pending = countEvents(sessionId, { signal: tracked.signal });
    const rejection = assert.rejects(pending, (error) => error === original);
    const tx = await transactionReady;
    await rejection;
    assert.equal(tracked.listeners.size, 0);
    t.mock.timers.tick(20000);
    assert.equal(tx.aborts, 1);
  }, { setupError: original });
});

it("openDB既有共享连接保持兼容，read取消不关闭其他read连接", { timeout: 1000 }, async () => {
  await withSyntheticDB(async ({ db, transactionReady }) => {
    const connection = await openDB();
    assert.equal(connection, db);
    const controller = new AbortController();
    const pending = countEvents(sessionId, { signal: controller.signal });
    const rejection = assert.rejects(pending, /读取记录数量已取消/);
    await transactionReady;
    controller.abort();
    await rejection;
    assert.equal(await openDB(), connection);
  });
});
