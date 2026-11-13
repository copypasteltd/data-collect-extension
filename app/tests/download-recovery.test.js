import { it } from "node:test";
import assert from "node:assert/strict";
import { downloadBlob } from "../src/downloads.js";

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (value) => [...listeners].forEach((listener) => listener(value)),
  };
}

function clock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();
  return {
    timers,
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    async tick(ms) {
      const end = now + ms;
      await flush();
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].callback();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}

async function fixture(overrides, run) {
  const previousChrome = globalThis.chrome;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const time = clock();
  const revoked = [];
  const cancelled = [];
  const requests = [];
  let urlSequence = 0;
  const downloads = {
    onChanged: event(),
    onErased: event(),
    download: async (request) => { requests.push(request); return 42; },
    search: async () => [{ state: "in_progress" }],
    cancel: async (id) => { cancelled.push(id); },
    ...overrides,
  };
  globalThis.chrome = { downloads };
  URL.createObjectURL = () => `blob:synthetic-${++urlSequence}`;
  URL.revokeObjectURL = (url) => revoked.push(url);
  const options = {
    launchTimeoutMs: 50, completionTimeoutMs: 100, pollMs: 10,
    searchTimeoutMs: 20, cancelTimeoutMs: 5,
    setTimeout: time.setTimeout, clearTimeout: time.clearTimeout,
  };
  try {
    await run({ downloads, time, revoked, cancelled, requests, options });
    assert.equal(time.timers.size, 0, "all owned timers cleared");
    assert.equal(downloads.onChanged.listeners.size, 0);
    assert.equal(downloads.onErased.listeners.size, 0);
  } finally {
    globalThis.chrome = previousChrome;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
}

it("遗漏终态事件时通过有限轮询确认完成，完成之前保留 Blob URL", async () => {
  let searches = 0;
  await fixture({ search: async () => [{ state: ++searches === 3 ? "complete" : "in_progress" }] },
    async ({ time, revoked, cancelled, options, requests }) => {
      const result = downloadBlob(new Blob(["synthetic"]), "retry.zip", options);
      await time.tick(10);
      assert.equal(searches, 2);
      assert.deepEqual(revoked, []);
      await time.tick(10);
      assert.equal(await result, 42);
      assert.equal(searches, 3);
      assert.deepEqual(requests, [{ url: "blob:synthetic-1", filename: "retry.zip", saveAs: false }]);
      assert.deepEqual(cancelled, []);
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
    });
});

it("持续 in_progress/paused 到整体 deadline 后请求取消，保留原 Blob 可重试", async () => {
  await fixture({ search: async () => [{ state: "in_progress", paused: true }] },
    async ({ downloads, time, revoked, cancelled, options }) => {
      const blob = new Blob(["retained synthetic batch"]);
      const result = downloadBlob(blob, "retry.zip", options);
      const failure = assert.rejects(result, /下载确认超时.*最终状态未知.*不代表文件已删除/);
      await time.tick(99);
      downloads.onChanged.emit({ id: 42, paused: { current: true } });
      assert.deepEqual(revoked, []);
      await time.tick(1);
      await failure;
      assert.deepEqual(cancelled, [42]);
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
      assert.equal(await blob.text(), "retained synthetic batch");
      downloads.search = async () => [{ state: "complete" }];
      assert.equal(await downloadBlob(blob, "retry.zip", options), 42);
      assert.deepEqual(revoked, ["blob:synthetic-1", "blob:synthetic-2"]);
    });
});

it("每次 search 有独立 deadline，迟到结果不影响新操作", async () => {
  const pending = deferred();
  let searches = 0;
  await fixture({ search: () => ++searches === 1 ? Promise.resolve([{ state: "in_progress" }]) : pending.promise },
    async ({ downloads, time, revoked, cancelled, options }) => {
      const result = downloadBlob(new Blob(), "old.zip", options);
      const failure = assert.rejects(result, /查询下载状态超时/);
      await time.tick(29);
      assert.equal(searches, 2);
      assert.deepEqual(revoked, []);
      await time.tick(1);
      await failure;
      assert.deepEqual(cancelled, [42]);
      downloads.download = async () => 43;
      downloads.search = async () => [{ state: "in_progress" }];
      let completed = false;
      const retry = downloadBlob(new Blob(), "new.zip", options).then((id) => { completed = true; return id; });
      await flush();
      pending.resolve([{ state: "complete" }]);
      downloads.onChanged.emit({ id: 42, state: { current: "complete" } });
      await flush();
      assert.equal(completed, false);
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
      downloads.onChanged.emit({ id: 43, state: { current: "complete" } });
      assert.equal(await retry, 43);
      assert.deepEqual(revoked, ["blob:synthetic-1", "blob:synthetic-2"]);
    });
});

it("启动超时清理 URL，观察 late id 仅取消旧下载而不完成重试", async () => {
  const launch = deferred();
  await fixture({ download: () => launch.promise },
    async ({ downloads, time, revoked, cancelled, options }) => {
      const result = downloadBlob(new Blob(), "old.zip", options);
      const failure = assert.rejects(result, /启动下载超时.*启动结果未知.*不代表文件已删除/);
      await time.tick(50);
      await failure;
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
      assert.deepEqual(cancelled, []);
      downloads.download = async () => 43;
      let complete = false;
      const retry = downloadBlob(new Blob(), "retry.zip", options).then((id) => { complete = true; return id; });
      await flush();
      launch.resolve(42);
      await flush();
      assert.deepEqual(cancelled, [42]);
      downloads.onChanged.emit({ id: 42, state: { current: "complete" } });
      await flush();
      assert.equal(complete, false);
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
      downloads.onChanged.emit({ id: 43, state: { current: "complete" } });
      assert.equal(await retry, 43);
    });
});

it("cancel 不响应时也有边界，先请求取消再释放 URL，迟到拒绝已观察", async () => {
  const cancellation = deferred();
  const calls = [];
  await fixture({ cancel: (id) => { calls.push(id); return cancellation.promise; } },
    async ({ time, revoked, downloads, options }) => {
      const result = downloadBlob(new Blob(), "record.zip", options);
      const failure = assert.rejects(result, /下载确认超时.*最终状态未知/);
      await time.tick(100);
      assert.deepEqual(calls, [42]);
      assert.deepEqual(revoked, []);
      assert.equal(downloads.onChanged.listeners.size, 0);
      assert.equal(downloads.onErased.listeners.size, 0);
      await time.tick(5);
      await failure;
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
      cancellation.reject(new Error("late cancel rejection"));
      await flush();
    });
});

it("optional signal 中止完成等待并清 listeners/timers；已中止则不启动", async () => {
  const search = deferred();
  await fixture({ search: () => search.promise },
    async ({ downloads, time, revoked, cancelled, options, requests }) => {
      const controller = new AbortController();
      const result = downloadBlob(new Blob(), "record.zip", { ...options, signal: controller.signal });
      const failure = assert.rejects(result, { name: "AbortError" });
      await flush();
      controller.abort();
      await failure;
      assert.deepEqual(cancelled, [42]);
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
      assert.equal(time.timers.size, 0);
      assert.equal(downloads.onChanged.listeners.size, 0);
      search.reject(new Error("late search rejection"));
      await flush();
      await assert.rejects(downloadBlob(new Blob(), "not-started.zip", { ...options, signal: controller.signal }), { name: "AbortError" });
      assert.equal(requests.length, 1);
      assert.equal(revoked.length, 1);
    });
});

it("默认 launch15s/completion180s/poll1s 仅约束下载确认，不把 paused 视作完成", async () => {
  let searches = 0;
  await fixture({ search: async () => { searches += 1; return [{ state: "in_progress", paused: true }]; } },
    async ({ time, options, revoked }) => {
      const defaults = { setTimeout: options.setTimeout, clearTimeout: options.clearTimeout };
      const result = downloadBlob(new Blob(), "record.zip", defaults);
      const failure = assert.rejects(result, /下载确认超时（180000ms）/);
      assert.deepEqual([...time.timers.values()].map((timer) => timer.at), [15000]);
      await time.tick(999);
      assert.equal(searches, 1);
      await time.tick(1);
      assert.equal(searches, 2);
      await time.tick(178999);
      assert.deepEqual(revoked, []);
      await time.tick(1);
      await failure;
      assert.deepEqual(revoked, ["blob:synthetic-1"]);
    });
});
