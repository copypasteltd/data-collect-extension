export function recoverySessionDiagnostic(session, sessions) {
  if (!Number.isFinite(session?.startedAt)) return "目标开始时间未知";
  for (const item of sessions) {
    if (item.id === session.id) continue;
    if (["preparing", "recording", "stopping"].includes(item.status)) return "存在其他活动批次";
    if (!Number.isFinite(item.startedAt)) return "其他批次开始时间未知";
    if (item.startedAt >= session.startedAt) return "存在同刻或更新批次，无法仅按时间确认 owner";
  }
  return null;
}
export function canRecoverSession(session, sessions) {
  return recoverySessionDiagnostic(session, sessions) === null;
}
