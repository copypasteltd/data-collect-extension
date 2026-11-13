const nonemptyString = (value) => typeof value === "string" && value.length > 0;
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const FRAGMENT_LENGTH = 100000; // Existing transfer framing, shared with fragments.js; not an export capacity policy.
const terminalKey = (item) => item && typeof item === "object" && !Array.isArray(item) &&
  nonemptyString(item.captureId) && nonemptyString(item.field)
  ? JSON.stringify([item.captureId, item.field]) : null;

// An export prepass feeds this index the whole event stream, retaining terminal/order facts, never fragment bodies.
// Transport ACK/unknown outcomes are not terminal facts and must not be guessed here.
export function createFragmentTerminals() {
  const terminals = new Map();
  return {
    add(event) {
      if (!["capture.fragment", "capture.fragmentEnd", "capture.fragmentFailure"].includes(event.kind)) return;
      const item = event.payload || {}, key = terminalKey(item);
      if (!key) return;
      const terminal = terminals.get(key) || { endCount: 0, failed: false, latePart: false, end: null };
      if (event.kind === "capture.fragment") {
        // The main pass drops pending at its first End; preserve later body/order invalidity before that point.
        if (terminal.endCount) terminal.latePart = true;
        return;
      }
      if (event.kind === "capture.fragmentFailure") terminal.failed = true;
      else {
        terminal.endCount = Math.min(2, terminal.endCount + 1);
        if (!terminal.end) terminal.end = { confirmed: item.status === "confirmed",
          parts: positiveInteger(item.parts) ? item.parts : null, length: positiveInteger(item.length) ? item.length : null };
      }
      terminals.set(key, terminal);
    },
    validate(reference) {
      const key = terminalKey(reference);
      if (!key || !positiveInteger(reference.length) || !positiveInteger(reference.parts) ||
          reference.parts !== Math.ceil(reference.length / FRAGMENT_LENGTH)) throw new Error("分段引用无效");
      const terminal = terminals.get(key);
      if (terminal?.failed) throw new Error("分段传输存在失败终态");
      if (!terminal || terminal.endCount === 0) throw new Error("未收到分段结束确认");
      if (terminal.endCount !== 1) throw new Error("分段结束确认重复");
      if (!terminal.end.confirmed || terminal.end.parts !== reference.parts || terminal.end.length !== reference.length)
        throw new Error("分段结束确认无效");
      if (terminal.latePart) throw new Error("分段结束确认后仍有分段数据");
      // Body/part order/length validation before End remains with validateFragments/reconstructFragments.
      return true;
    },
  };
}
