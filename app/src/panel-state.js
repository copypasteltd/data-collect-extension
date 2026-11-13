// Operation-level projections only: never expose recorded URLs, titles or values.
export function canStartRecording(active, controlOperation, exportOperation) {
  return !active && !controlOperation && !exportOperation;
}

export function canStopRecording(active, controlOperation) {
  return !!active && ["preparing", "recording"].includes(active.status) &&
    (!controlOperation || controlOperation.type === "starting");
}

export function canExportRecording(active, selectedId, controlOperation, exportOperation) {
  return !active && !!selectedId && !controlOperation && !exportOperation;
}

export function recordingNotice(active) {
  if (!active) return "";
  if (active.storageError) return "本地保存出现异常，请停止录制。已确认保存的内容会保留。";
  if (active.communicationUnknown) return "部分采集确认尚不确定，请停止后核验；未确认不等于确定丢失。";
  if (active.captureIncomplete || active.needsVerification || active.incomplete || active.hasNotice)
    return "本次采集存在限制或异常，请停止后核验已保存内容。";
  return "";
}

export function batchStatusLabel(session) {
  if (session.status === "interrupted") return "录制中断";
  const coverage = session.coverage;
  const hasKnownGaps = coverage && (coverage.status === "unavailable" ||
    Object.entries(coverage).some(([key, value]) =>
      /(?:Gaps$|Unavailable$|^warnings$|^pendingRequests$|^canvasContextUnknown$)/.test(key) &&
      typeof value === "number" && value > 0));
  return session.storageError || session.incomplete || session.communicationUnknown ||
    session.captureIncomplete || session.needsVerification || hasKnownGaps
    ? "已停止，需核验" : "已停止，可导出";
}

export function exportPhaseLabel(phase) {
  return ({
    checking: "正在核对录制状态…",
    events: "正在整理记录包…",
    assets: "正在整理附件…",
    download: "正在等待下载确认…",
  })[phase] || "正在导出…";
}
