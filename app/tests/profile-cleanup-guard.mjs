import path from "node:path";

// In-memory ownership evidence only; no filesystem access or deletion policy.
export function createProfileCleanupGuard() {
  const profiles = new Map();

  function begin(profile) {
    const key = path.resolve(profile);
    let entry = profiles.get(key);
    if (entry?.removal) throw new Error("profile_removal_in_progress");
    if (!entry) {
      entry = { attempts: new Map(), removal: null };
      profiles.set(key, entry);
    }
    const token = Symbol("profile-launch-attempt");
    entry.attempts.set(token, false);
    return token;
  }

  function report(profile, token, result) {
    const entry = profiles.get(path.resolve(profile));
    if (!entry || entry.removal || !entry.attempts.has(token)) return false;
    entry.attempts.set(token, result?.status === "confirmed" &&
      result.rootClosed === true && result.setupSettled === true);
    return true;
  }

  function remove(profile, removeCallback) {
    const key = path.resolve(profile);
    let entry = profiles.get(key);
    if (entry?.removal) return entry.removal;
    if (entry && [...entry.attempts.values()].some((confirmed) => !confirmed)) {
      return Promise.resolve({ status: "preserved" });
    }
    if (!entry) {
      entry = { attempts: new Map(), removal: null };
      profiles.set(key, entry);
    }
    // Lock before invoking/awaiting the existing callback; begin cannot race removal.
    entry.removal = Promise.resolve().then(() => removeCallback()).then(() => {
      profiles.delete(key); // Only a successful, safe removal clears attempt evidence.
      return { status: "removed" };
    }, (error) => {
      entry.removal = null; // Keep all evidence and permit an explicit retry.
      throw error;
    });
    return entry.removal;
  }

  return { begin, report, remove };
}
