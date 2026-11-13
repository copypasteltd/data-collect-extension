// Owners are session objects, not the mutable global active slot. Releasing an
// owner quarantines its unresolved work; it does not cancel the original task.
export function createSessionTasks() {
  const pending = new WeakMap();
  const released = new WeakSet();
  return {
    track(owner, promise) {
      let tasks;
      if (owner && !released.has(owner)) {
        tasks = pending.get(owner);
        if (!tasks) pending.set(owner, tasks = new Set());
        tasks.add(promise);
      }
      const settled = () => {
        if (!tasks) return;
        tasks.delete(promise);
        if (!tasks.size && pending.get(owner) === tasks) pending.delete(owner);
      };
      // Do not return a finally/catch-derived Promise: callers retain the exact
      // fulfillment/rejection semantics of the supplied Promise. Both branches
      // consume the observer rejection without creating an unhandled child.
      Promise.resolve(promise).then(settled, settled);
      return promise;
    },
    snapshot(owner) {
      return [...(pending.get(owner) || [])];
    },
    async drain(owner) {
      // Work already admitted may enqueue a write or a derived task while it
      // settles. Re-snapshot until this owner is empty; callers own the deadline.
      while (pending.get(owner)?.size)
        await Promise.allSettled([...pending.get(owner)]);
    },
    release(owner) {
      if (!owner) return 0;
      const count = pending.get(owner)?.size || 0;
      released.add(owner);
      pending.delete(owner);
      return count;
    },
  };
}
