const FRAGMENT_LENGTH = 100000;

export function validateFragments(reference, events) {
  if (!reference || typeof reference !== "object" || Array.isArray(reference) ||
      typeof reference.captureId !== "string" || !reference.captureId ||
      typeof reference.field !== "string" || !reference.field ||
      !Number.isSafeInteger(reference.length) || reference.length <= 0 ||
      !Number.isSafeInteger(reference.parts) ||
      reference.parts !== Math.ceil(reference.length / FRAGMENT_LENGTH))
    throw new Error("分段引用无效");
  const parts = new Map();
  let complete = false;
  for (const event of events) {
    const item = event.payload || {};
    if (item.captureId !== reference.captureId || item.field !== reference.field) continue;
    // A confirmed End never overrides explicit failure evidence, even if failure arrives later.
    if (event.kind === "capture.fragmentFailure") throw new Error("分段传输失败");
    if (event.kind === "capture.fragmentEnd") {
      if (complete || item.status !== "confirmed" || item.parts !== reference.parts ||
          item.length !== reference.length || parts.size !== reference.parts)
        throw new Error("分段传输未确认");
      complete = true;
    } else if (event.kind === "capture.fragment") {
      if (complete || !Number.isSafeInteger(item.index) || item.index < 0 || item.index >= reference.parts ||
          item.parts !== reference.parts || item.length !== reference.length || typeof item.data !== "string" ||
          item.data.length !== Math.min(FRAGMENT_LENGTH, reference.length - item.index * FRAGMENT_LENGTH) ||
          parts.has(item.index))
        throw new Error("分段数据无效或重复");
      parts.set(item.index, item.data);
    }
  }
  if (!complete || parts.size !== reference.parts) throw new Error("分段数据不完整");
  return Array.from({ length: reference.parts }, (_, index) => parts.get(index));
}

export function reconstructFragments(reference, events) {
  return validateFragments(reference, events).join("");
}

// The caller supplies one session's complete evidence; capture IDs are not cross-session identities.
export function indexFragmentEvidence(events) {
  const groups = new Map();
  for (const event of events) {
    if (event.kind !== "capture.fragment" && event.kind !== "capture.fragmentEnd" &&
        event.kind !== "capture.fragmentFailure") continue;
    const payload = event.payload || {};
    const key = JSON.stringify([payload.captureId, payload.field]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return (reference) => {
    try {
      const items = groups.get(JSON.stringify([reference.captureId, reference.field])) || [];
      validateFragments(reference, [...items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)));
      return true;
    } catch { return false; }
  };
}
