const UNKNOWN_DOWNLOAD = "下载最终状态未知，请检查浏览器下载列表后重试；取消不代表文件已删除";

function duration(options, name, fallback) {
  const value = options[name] ?? fallback;
  if (!Number.isFinite(value) || value <= 0 || value > 2147483647) {
    throw new RangeError(`${name} 必须是有效的正毫秒数`);
  }
  return value;
}

function aborted(message) {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

const validId = (id) => Number.isInteger(id) && id >= 0;

// Chrome APIs themselves cannot be aborted. Observe their eventual rejection and
// bound cancellation acknowledgement instead of claiming a timeout cancelled I/O.
function cancelDownload(downloads, id, config) {
  if (typeof downloads.cancel !== "function") return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      config.clearTimeout(timer);
      resolve();
    };
    const timer = config.setTimeout(finish, config.cancelTimeoutMs);
    Promise.resolve().then(() => downloads.cancel(id)).then(finish, finish);
  });
}

function launchDownload(downloads, request, config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, id) => {
      if (settled) return;
      settled = true;
      config.clearTimeout(timer);
      config.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(id);
    };
    const abort = () => finish(aborted(`已中止下载启动等待；启动结果未知；${UNKNOWN_DOWNLOAD}`));
    const timer = config.setTimeout(() => finish(new Error(
      `启动下载超时（${config.launchTimeoutMs}ms）；启动结果未知，若稍后取得编号将尝试取消；${UNKNOWN_DOWNLOAD}`,
    )), config.launchTimeoutMs);
    config.signal?.addEventListener("abort", abort, { once: true });
    if (config.signal?.aborted) abort();
    Promise.resolve()
      .then(() => settled ? undefined : downloads.download(request))
      .then((id) => {
        if (settled) {
          // An abandoned launch must never settle a retry or retain its Blob URL.
          if (validId(id)) void cancelDownload(downloads, id, config);
          return;
        }
        if (!validId(id)) {
          finish(new Error(`未取得有效下载编号；启动结果未知；${UNKNOWN_DOWNLOAD}`));
          return;
        }
        finish(null, id);
      }, (error) => finish(error));
  });
}

function waitForDownload(downloads, id, config) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let pollTimer;
    let searchTimer;
    let deadlineTimer;
    const cleanup = () => {
      downloads.onChanged.removeListener(changed);
      downloads.onErased.removeListener(erased);
      config.signal?.removeEventListener("abort", abort);
      for (const timer of [pollTimer, searchTimer, deadlineTimer]) config.clearTimeout(timer);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const unknown = (message) => fail(new Error(`${message}；正在尝试取消；${UNKNOWN_DOWNLOAD}`));
    const finish = (state, reason) => {
      if (settled || !["complete", "interrupted"].includes(state)) return;
      if (state === "interrupted") {
        fail(new Error(`下载未完成${reason ? `：${reason}` : ""}`));
        return;
      }
      settled = true;
      cleanup();
      resolve();
    };
    const changed = (delta) => {
      if (delta.id === id) finish(delta.state?.current, delta.error?.current);
    };
    const erased = (erasedId) => {
      if (erasedId === id) unknown("下载记录已移除，无法确认是否完成");
    };
    const abort = () => fail(aborted(`已中止下载确认；正在尝试取消；${UNKNOWN_DOWNLOAD}`));
    const poll = () => {
      if (settled) return;
      searchTimer = config.setTimeout(() => unknown(
        `查询下载状态超时（${config.searchTimeoutMs}ms）`,
      ), config.searchTimeoutMs);
      Promise.resolve()
        .then(() => settled ? undefined : downloads.search({ id }))
        .then((items) => {
          if (settled) return;
          config.clearTimeout(searchTimer);
          const item = items?.[0];
          if (!item) {
            unknown("无法查询下载状态");
            return;
          }
          finish(item.state, item.error);
          if (!settled) pollTimer = config.setTimeout(poll, config.pollMs);
        }, (error) => {
          if (!settled) unknown(`查询下载状态失败：${error?.message || error}`);
        });
    };
    downloads.onChanged.addListener(changed);
    downloads.onErased.addListener(erased);
    config.signal?.addEventListener("abort", abort, { once: true });
    deadlineTimer = config.setTimeout(() => unknown(
      `下载确认超时（${config.completionTimeoutMs}ms）`,
    ), config.completionTimeoutMs);
    if (config.signal?.aborted) abort();
    // Listen first, then query: retain the early-terminal/event-query race guard.
    poll();
  });
}

// These deadlines start only after the Blob exists; they are not export/recording SLOs.
export async function downloadBlob(blob, filename, options = {}) {
  const config = {
    launchTimeoutMs: duration(options, "launchTimeoutMs", 15000),
    completionTimeoutMs: duration(options, "completionTimeoutMs", 180000),
    pollMs: duration(options, "pollMs", 1000),
    searchTimeoutMs: duration(options, "searchTimeoutMs", 15000),
    cancelTimeoutMs: duration(options, "cancelTimeoutMs", 1000),
    setTimeout: options.setTimeout ?? globalThis.setTimeout.bind(globalThis),
    clearTimeout: options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis),
    signal: options.signal,
  };
  if (config.signal?.aborted) throw aborted("下载尚未启动，已中止");
  const downloads = chrome.downloads;
  const url = URL.createObjectURL(blob);
  let id;
  try {
    id = await launchDownload(downloads, { url, filename, saveAs: false }, config);
    await waitForDownload(downloads, id, config);
    return id;
  } catch (error) {
    // Keep the URL alive through the bounded cancel request, never indefinitely.
    if (validId(id)) await cancelDownload(downloads, id, config);
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
