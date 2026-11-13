export function exportProgressPhase(progress) {
  return ({ "等待记录访问": "waiting", "读取批次与附件索引": "waiting", "核对分段终态": "fragments",
    "整理操作与页面": "events", "整理字段与关系索引": "indexes", "整理截图与资源": "assets",
    "生成清单与完整性校验": "verifying", "核对封存与下载准备": "verifying" })[progress?.phase] || "events";
}
export function exportProgressDetail(progress, elapsedMs = 0) {
  // Only work counts; never a recorded path/title/URL or invented percentage.
  const current = Number.isSafeInteger(progress?.current) && progress.current >= 0 ? progress.current : 0;
  const total = Number.isSafeInteger(progress?.total) && progress.total > 0 ? progress.total : 0;
  const bytes = Number.isSafeInteger(progress?.bytesDone) && progress.bytesDone >= 0 ? progress.bytesDone : 0;
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  return [total ? "已处理 " + Math.min(current, total) + " / " + total + " 项" : "正在处理已保存的数据",
    bytes ? "已打包 " + (bytes / 1000000).toFixed(1) + " MB原数据" : "", "用时 " + seconds + " 秒"].filter(Boolean).join(" · ");
}
