import { it } from "node:test";
import assert from "node:assert/strict";
import { downloadBlob } from "../src/downloads.js";

function event() {
  const listeners = new Set();
  return {
    listeners,
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (value) => listeners.forEach((listener) => listener(value)),
  };
}

async function withDownloads(search, run) {
  const previousChrome = globalThis.chrome;
  const create = URL.createObjectURL;
  const revoke = URL.revokeObjectURL;
  const revoked = [];
  const downloads = {
    onChanged: event(),
    onErased: event(),
    download: async () => 42,
    search,
  };
  globalThis.chrome = { downloads };
  URL.createObjectURL = () => "blob:test";
  URL.revokeObjectURL = (url) => revoked.push(url);
  try {
    await run(downloads, revoked);
    assert.deepEqual(revoked, ["blob:test"]);
    assert.equal(downloads.onChanged.listeners.size, 0);
    assert.equal(downloads.onErased.listeners.size, 0);
  } finally {
    globalThis.chrome = previousChrome;
    URL.createObjectURL = create;
    URL.revokeObjectURL = revoke;
  }
}

it("等待下载完成，忽略其他下载的事件", async () => {
  await withDownloads(
    async () => [{ state: "in_progress" }],
    async (downloads, revoked) => {
      let completed = false;
      const result = downloadBlob(new Blob(), "record.zip").then((id) => {
        completed = true;
        return id;
      });
      await new Promise((resolve) => setImmediate(resolve));
      downloads.onChanged.emit({ id: 10, state: { current: "complete" } });
      assert.equal(completed, false);
      assert.deepEqual(revoked, []);
      downloads.onChanged.emit({ id: 42, state: { current: "complete" } });
      assert.equal(await result, 42);
    },
  );
});

it("提示下载中断并清理资源", async () => {
  await withDownloads(
    async () => [{ state: "in_progress" }],
    async (downloads) => {
      const result = downloadBlob(new Blob(), "record.zip");
      await new Promise((resolve) => setImmediate(resolve));
      downloads.onChanged.emit({
        id: 42,
        state: { current: "interrupted" },
        error: { current: "FILE_FAILED" },
      });
      await assert.rejects(result, /下载未完成：FILE_FAILED/);
    },
  );
});

it("通过查询识别在监听之前已结束的下载", async () => {
  await withDownloads(
    async () => [{ state: "complete" }],
    async () => {
      assert.equal(await downloadBlob(new Blob(), "record.zip"), 42);
    },
  );
  await withDownloads(
    async () => [{ state: "interrupted", error: "USER_CANCELED" }],
    async () => {
      await assert.rejects(
        downloadBlob(new Blob(), "record.zip"),
        /USER_CANCELED/,
      );
    },
  );
});

it("处理下载记录移除、查询失败和事件与查询竞态", async () => {
  await withDownloads(
    async () => [{ state: "in_progress" }],
    async (downloads) => {
      const result = downloadBlob(new Blob(), "record.zip");
      await new Promise((resolve) => setImmediate(resolve));
      downloads.onErased.emit(42);
      await assert.rejects(result, /下载记录已移除/);
    },
  );
  await withDownloads(
    () => {
      throw new Error("查询失败");
    },
    async () => {
      await assert.rejects(downloadBlob(new Blob(), "record.zip"), /查询失败/);
    },
  );
  let finishSearch;
  await withDownloads(
    () =>
      new Promise((resolve) => {
        finishSearch = resolve;
      }),
    async (downloads) => {
      const result = downloadBlob(new Blob(), "record.zip");
      await new Promise((resolve) => setImmediate(resolve));
      downloads.onChanged.emit({ id: 42, state: { current: "complete" } });
      assert.equal(await result, 42);
      finishSearch([]);
      await new Promise((resolve) => setImmediate(resolve));
    },
  );
});
