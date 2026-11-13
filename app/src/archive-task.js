// A stalled task never owns the export control forever. Cancelling this read-only
// operation does not alter recordings; every awaited step observes the same abort.
export function createArchiveTask(onProgress = () => {}, {
  signal: parentSignal, idleTimeoutMs = 45000, now = () => Date.now(),
  setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || idleTimeoutMs > 2147483647)
    throw new RangeError("导出无进展等待上限无效");
  const controller = new AbortController(), signal = controller.signal;
  let timer, phase = "等待记录访问", disposed = false, lastYield = now(), lastReport = 0;
  let current = 0, total = 0, bytesDone = 0;
  const check = () => { if (signal.aborted) throw signal.reason || new Error("导出已停止，本地批次仍保留"); };
  const renew = () => {
    clearTimer(timer);
    if (!disposed && !signal.aborted) timer = setTimer(() => controller.abort(new Error(
      phase + "长时间无进展，已结束本次导出；本地批次仍保留，请重试或检查浏览器存储",
    )), idleTimeoutMs);
  };
  const fromParent = () => controller.abort(parentSignal.reason || new Error("导出已停止，本地批次仍保留"));
  parentSignal?.addEventListener("abort", fromParent, { once: true });
  if (parentSignal?.aborted) fromParent();
  renew();
  return {
    signal, check,
    stage(next, values = {}) {
      check(); phase = next; current = values.current ?? 0; total = values.total ?? 0; bytesDone = values.bytesDone ?? 0;
      renew(); lastReport = now(); onProgress({ phase, current, total, bytesDone });
    },
    progress(values = {}, force = false) {
      check(); current = values.current ?? current; total = values.total ?? total; bytesDone = values.bytesDone ?? bytesDone;
      renew();
      if (force || now() - lastReport >= 100) { lastReport = now(); onProgress({ phase, current, total, bytesDone }); }
    },
    async wait(operation) {
      check();
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (callback, value) => {
          if (settled) return; settled = true; signal.removeEventListener("abort", aborted); callback(value);
        };
        const aborted = () => finish(reject, signal.reason || new Error("导出已停止，本地批次仍保留"));
        signal.addEventListener("abort", aborted, { once: true });
        if (signal.aborted) { aborted(); return; }
        Promise.resolve().then(() => typeof operation === "function" ? operation() : operation)
          .then((value) => { if (!signal.aborted) { renew(); finish(resolve, value); } }, (error) => finish(reject, error));
      });
    },
    async yield(force = false) {
      check();
      if (!force && now() - lastYield < 8) return;
      await this.wait(() => new Promise((resolve) => setTimeout(resolve, 0)));
      lastYield = now(); check();
    },
    dispose() { disposed = true; clearTimer(timer); parentSignal?.removeEventListener("abort", fromParent); },
  };
}
