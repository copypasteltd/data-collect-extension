export function withSessionLock(id, mode, task, { signal } = {}) {
  if (!globalThis.navigator?.locks?.request)
    throw new Error("浏览器无法协调记录访问，请更新 Chrome 后重试");
  return navigator.locks.request(`logic-recorder:session:${id}`, { mode, ...(signal ? { signal } : {}) }, task);
}
