export function canRecoverSession(session, sessions) {
  return Number.isFinite(session?.startedAt) && !sessions.some((item) => item.id !== session.id &&
    (["preparing", "recording", "stopping"].includes(item.status) ||
      !Number.isFinite(item.startedAt) || item.startedAt >= session.startedAt));
}
