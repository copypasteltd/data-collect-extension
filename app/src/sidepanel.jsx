import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Circle, Download, Square } from "lucide-react";
import { createArchive } from "./flow-archive.js";
import { exportProgressPhase, exportProgressDetail } from "./export-progress.js";
import { downloadBlob } from "./downloads.js";
import { canStartRecording, canStopRecording, canExportRecording, recordingNotice, batchStatusLabel, exportPhaseLabel, formatBudgetBytes } from "./panel-state.js";
import { DEFAULT_FLOW_SETTINGS, MAX_MULTIPLIER, validateFlowSettings, deriveFlowLimits } from "./flow-config.js";
import "./style.css";

function withTimeout(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("后台响应超时，请等待状态刷新")), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function call(type, data = {}) {
  const timeout = type === "STOP" ? 90000 : type === "START" ? 30000 : 8000;
  const result = await withTimeout(chrome.runtime.sendMessage({ type, ...data }), timeout);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

const LIMIT_FIELDS = [["budgetMultiplier", "容量倍率"], ["queueMultiplier", "待处理队列倍率"], ["samplingMultiplier", "页面采样倍率"]];

function LimitPreview({ limits }) {
  const { budget: b, background: bg, content: c } = limits;
  const count = (n) => n.toLocaleString("zh-CN");
  const rows = [
    ["单批总量", formatBudgetBytes(b.totalBytes)], ["提醒阈值", formatBudgetBytes(b.warningBytes)],
    ["普通采集 / 收尾预留", `${formatBudgetBytes(b.normalBytes)} / ${formatBudgetBytes(b.reserveBytes)}`],
    ["单份接口正文", formatBudgetBytes(b.singleBodyBytes)], ["单条记录说明", formatBudgetBytes(b.eventBytes)],
    ...Object.entries({ body: "接口正文合计", dom: "页面快照合计", resource: "资源合计", screenshot: "截图合计", meta: "记录说明合计" }).map(([key, label]) => [label, formatBudgetBytes(b.categoryBytes[key])]),
    ["后台待处理", `${count(bg.queue)} 项 / ${formatBudgetBytes(bg.queuedBytes)}`], ["待处理请求", `${count(bg.requests)} 项`],
    ["页面待处理", `${count(c.queueEvents)} 项 / ${formatBudgetBytes(c.queueBytes)}`],
    ["每次提交", `页面 ${count(c.batchEvents)} 项；后台 ${count(bg.batch)} 项 / ${formatBudgetBytes(bg.batchBytes)}`],
    ["页面快照采样", `${count(c.domNodes)} 个节点；${count(bg.frames)} 个框架`],
    ["表单 / 资源采样", `${count(c.formCount)} / ${count(c.resourceUrls)} 项`],
    ["样式采样", `${count(c.stylesheetCount)} 份 / ${count(c.stylesheetRules)} 条规则`],
    ["Shadow 页面采样", `${count(c.shadowHosts)} 个宿主 / ${count(c.shadowNodes)} 个节点`],
  ];
  return <dl className="limit-preview" aria-label="限额预览">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

function LimitSettings({ active, controlBusy, onAvailabilityChange }) {
  const [saved, setSaved] = useState(null);
  const [draft, setDraft] = useState({});
  const [busy, setBusy] = useState("GET_LIMIT_SETTINGS");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const request = useRef(false);
  const mounted = useRef(true);
  const dirty = !!saved && LIMIT_FIELDS.some(([key]) => Number(draft[key]) !== saved.settings[key]);
  const errors = Object.fromEntries(LIMIT_FIELDS.filter(([key]) => saved &&
    (String(draft[key] ?? "").trim() === "" || !Number.isSafeInteger(Number(draft[key])) || Number(draft[key]) < 1 || Number(draft[key]) > MAX_MULTIPLIER))
    .map(([key]) => [key, `请输入 1–${MAX_MULTIPLIER} 之间的整数。`]));
  const limits = saved && !Object.keys(errors).length ? deriveFlowLimits({ schemaVersion: 1, ...Object.fromEntries(LIMIT_FIELDS.map(([key]) => [key, Number(draft[key])])) }) : null;
  const ready = !!saved && !busy && !dirty && !Object.keys(errors).length;

  async function update(type) {
    if (request.current || (type !== "GET_LIMIT_SETTINGS" && controlBusy) || (type === "SAVE_LIMIT_SETTINGS" && (!limits || !dirty))) return;
    request.current = true;
    onAvailabilityChange(false);
    setBusy(type); setError(""); setNotice("");
    try {
      const next = await call(type, type === "SAVE_LIMIT_SETTINGS" ? { settings: limits.settings } : {});
      validateFlowSettings(next.settings); validateFlowSettings(next.defaults);
      if (next.maximumMultiplier !== MAX_MULTIPLIER || !next.limits?.budget) throw new Error("设置响应无效，请重试");
      if (!mounted.current) return;
      setSaved(next); setDraft(next.settings);
      if (type !== "GET_LIMIT_SETTINGS") setNotice(type === "RESET_LIMIT_SETTINGS" ? "已恢复默认 20 倍并保存到本机；仅下一批生效。" : "已保存到本机；仅下一批生效。");
    } catch (reason) {
      if (mounted.current) setError(`${type === "GET_LIMIT_SETTINGS" ? "读取" : "保存"}设置失败：${reason.message}`);
    } finally {
      request.current = false;
      if (mounted.current) setBusy("");
    }
  }
  useEffect(() => { mounted.current = true; update("GET_LIMIT_SETTINGS"); return () => { mounted.current = false; }; }, []);
  useEffect(() => { onAvailabilityChange(ready); }, [ready, draft, onAvailabilityChange]);

  return <details className="limit-settings">
    <summary>录制限额设置<span>{!saved ? busy ? "正在读取…" : "读取失败" : dirty ? "未保存" : "已保存"}</span></summary>
    <form noValidate onSubmit={(event) => { event.preventDefault(); update("SAVE_LIMIT_SETTINGS"); }} aria-busy={!!busy}>
      <p className="disclosure">三项倍率均为 1–{MAX_MULTIPLIER} 的整数，默认 20 倍。设置保存在本机，{active ? "正在录制时保存仅下一批生效，当前批次保持原限额。" : "仅下一批生效。"}</p>
      {LIMIT_FIELDS.map(([key, label]) => <div className="limit-field" key={key}>
        <label htmlFor={`limit-${key}`}>{label}</label>
        <input id={`limit-${key}`} name={key} type="number" min="1" max={MAX_MULTIPLIER} step="1" value={draft[key] ?? ""}
          disabled={!saved || !!busy || controlBusy} aria-invalid={!!errors[key]} aria-describedby={`limit-${key}-hint${errors[key] ? ` limit-${key}-error` : ""}`}
          onChange={(event) => { onAvailabilityChange(false); setDraft((previous) => ({ ...previous, [key]: event.target.value })); setNotice(""); }} />
        <small id={`limit-${key}-hint`}>{saved ? `当前已保存 ${saved.settings[key]} 倍 · 默认 ${saved.defaults[key]} 倍` : "等待读取本机设置"}</small>
        {errors[key] && <p className="field-error" id={`limit-${key}-error`} role="alert">{errors[key]}</p>}
      </div>)}
      {error && <p className="error" role="alert">{error}</p>}
      {!saved && !busy && <button className="settings-button" type="button" onClick={() => update("GET_LIMIT_SETTINGS")}>重新读取设置</button>}
      <div className="settings-actions">
        <button className="settings-button save" type="submit" disabled={!limits || !dirty || !!busy || controlBusy}>{busy === "SAVE_LIMIT_SETTINGS" ? "正在保存…" : "保存到本机"}</button>
        <button className="settings-button" type="button" disabled={!saved || !!busy || controlBusy} onClick={() => update("RESET_LIMIT_SETTINGS")}>恢复默认 20 倍</button>
      </div>
      {busy && <p className="disclosure" role="status">{busy === "GET_LIMIT_SETTINGS" ? "正在读取本机设置…" : "正在保存本机设置…"}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
      {dirty && <p className="disclosure" role="status">草稿尚未保存；开始录制使用已保存设置，请先保存草稿再开始。</p>}
      {limits && <><p className="preview-label">{dirty ? "草稿限额预览" : "当前已保存限额"}</p><LimitPreview limits={limits} /></>}
      <p className="disclosure">以上是采集策略上限，不代表磁盘可用空间或浏览器保证。空间不足或浏览器限制会显示错误；倍率不会扩大录制页面范围。</p>
    </form>
  </details>;
}

function App() {
  const [state, setState] = useState({ active: null, sessions: [] });
  const [selectedId, setSelectedId] = useState("");
  const [settingsReady, setSettingsReady] = useState(false);
  const settingsAvailable = useRef(false);
  const updateSettingsAvailability = useCallback((ready) => { settingsAvailable.current = ready; setSettingsReady(ready); }, []);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [batchError, setBatchError] = useState("");
  const [exportPhase, setExportPhase] = useState("");
  const [exportProgress, setExportProgress] = useState(null);
  const [exportElapsed, setExportElapsed] = useState(0);
  const [exportNotice, setExportNotice] = useState("");
  const operation = useRef(null);
  const exportOperation = useRef(null);
  const refreshNumber = useRef(0);
  const appliedRefresh = useRef(0);
  const batchInFlight = useRef(false);
  const preferredSession = useRef("");
  const uncertainStop = useRef("");
  const pendingArchiveError = useRef("");

  const refreshBatches = useCallback(() => {
    if (batchInFlight.current) return;
    batchInFlight.current = true;
    call("GET_STATE").then((next) => {
      setBatchError("");
      setState((previous) => ({ ...previous, sessions: next.sessions }));
      const available = next.sessions.filter((session) => ["ready", "interrupted"].includes(session.status));
      if (pendingArchiveError.current && available.some((session) => session.id === pendingArchiveError.current)) {
        pendingArchiveError.current = "";
        setError((previous) => previous.includes("无法更新本地批次") && !previous.includes("部分清理未能确认") ? "" : previous);
      }
      const preferred = preferredSession.current;
      if (preferred && available.some((session) => session.id === preferred)) preferredSession.current = "";
      setSelectedId((previous) => {
        if (preferred && available.some((session) => session.id === preferred)) return preferred;
        return available.some((session) => session.id === previous) ? previous : available[0]?.id || "";
      });
    }).catch((reason) => setBatchError(reason.message)).finally(() => { batchInFlight.current = false; });
  }, []);

  // Polls and export preflight share the same status generation. A late
  // response must not hide a newer active session (and its Stop control).
  const readStatus = useCallback(async () => {
    const request = ++refreshNumber.current;
    try {
      const next = await call("GET_STATUS");
      if (request >= appliedRefresh.current) {
        appliedRefresh.current = request;
        setStatusError("");
        if (uncertainStop.current && next.active?.id !== uncertainStop.current) {
          uncertainStop.current = "";
          setError((previous) => previous === "后台响应超时，请等待状态刷新" ? "" : previous);
        }
        setState((previous) => ({ ...previous, active: next.active }));
        return { ...next, applied: true };
      }
      return { ...next, applied: false };
    } catch (reason) {
      if (request >= appliedRefresh.current) {
        appliedRefresh.current = request;
        setStatusError(reason.message);
      }
      throw reason;
    }
  }, []);

  const refresh = useCallback(async (preferredId) => {
    if (preferredId) preferredSession.current = preferredId;
    try {
      return await readStatus();
    } finally {
      refreshBatches();
    }
  }, [readStatus, refreshBatches]);

  useEffect(() => {
    const update = () => refresh().catch(() => {});
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  useEffect(() => () => {
    exportOperation.current?.controller.abort(new Error("侧边栏已关闭，本地批次仍保留，可重新导出"));
  }, []);

  async function start() {
    if (!canStartRecording(state.active, operation.current, exportOperation.current, settingsAvailable.current)) return;
    const currentOperation = { type: "starting" };
    operation.current = currentOperation;
    uncertainStop.current = "";
    pendingArchiveError.current = "";
    setError("");
    setBusy("starting");
    try {
      const [current] = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 8000);
      if (!current?.url || !["http:", "https:"].includes(new URL(current.url).protocol))
        throw new Error("请先切换到需要录制的网页");
      const origin = new URL(current.url).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) throw new Error("未授予当前业务页面的访问权限");
      await call("START", { tab: current, options: { screenshots: true, scope: "business-flow" }, acknowledgeEarly: true });
      await refresh().catch(() => {});
    } catch (reason) {
      if (operation.current === currentOperation) {
        setError(reason.message);
        await refresh().catch(() => {});
      }
    } finally {
      if (operation.current === currentOperation) {
        operation.current = null;
        setBusy("");
      }
    }
  }

  async function stop() {
    if (!canStopRecording(state.active, operation.current)) return;
    const currentOperation = { type: "stopping" };
    const sessionId = state.active?.id;
    operation.current = currentOperation;
    uncertainStop.current = "";
    pendingArchiveError.current = "";
    setError("");
    setBusy("stopping");
    try {
      const session = await call("STOP", { sessionId });
      await refresh(session.id).catch(() => {});
    } catch (reason) {
      if (reason.message === "后台响应超时，请等待状态刷新" && sessionId) uncertainStop.current = sessionId;
      if (reason.message.includes("无法更新本地批次") && sessionId) pendingArchiveError.current = sessionId;
      setError(reason.message);
      await refresh().catch(() => {});
    } finally {
      if (operation.current === currentOperation) {
        operation.current = null;
        setBusy("");
      }
    }
  }

  async function download() {
    if (!canExportRecording(state.active, selectedId, operation.current, exportOperation.current)) return;
    const currentExport = { id: selectedId, startedAt: Date.now(), controller: new AbortController() };
    exportOperation.current = currentExport;
    setError("");
    setExportNotice("");
    setExportPhase("checking");
    setExportProgress(null);
    setExportElapsed(0);
    const elapsedTimer = setInterval(() => setExportElapsed(Date.now() - currentExport.startedAt), 1000);
    let archiveResult;
    try {
      // A second panel may have started recording since the last poll. Do not
      // open a new historical export in that state; an already running export
      // never owns the recording Stop control.
      const next = await readStatus();
      if (!next.applied) throw new Error("录制状态已更新，请确认后重试导出");
      if (next.active) throw new Error("请先停止当前录制，再导出记录包");
      setExportPhase("events");
      archiveResult = await createArchive(currentExport.id, (progress) => {
        if (exportOperation.current !== currentExport) return;
        setExportPhase(exportProgressPhase(progress));
        setExportProgress(progress);
      }, { signal: currentExport.controller.signal });
      if (exportOperation.current !== currentExport || currentExport.controller.signal.aborted) return;
      const { blob, importIssues = [] } = archiveResult;
      setExportPhase("download");
      await downloadBlob(blob, `逻辑记录-${currentExport.id.slice(0, 8)}.zip`);
      if (exportOperation.current === currentExport) {
        setExportNotice(importIssues.length
          ? "记录包已保存。存在解析兼容性限制；完整性和可用范围仍须由接收端核验。"
          : "记录包已保存。导出完成不表示所有采集内容均完整，使用前请核验记录包。");
      }
    } catch (reason) {
      if (exportOperation.current === currentExport) setError(reason.message);
    } finally {
      clearInterval(elapsedTimer);
      try { await archiveResult?.cleanup?.(); } catch {
        if (exportOperation.current === currentExport) setError((previous) => previous || "临时导出文件未能清理，请重新打开侧栏后重试。");
      }
      if (exportOperation.current === currentExport) {
        exportOperation.current = null;
        setExportPhase("");
        setExportProgress(null);
      }
    }
  }

  const active = state.active;
  const sessions = state.sessions.filter((session) => ["ready", "interrupted"].includes(session.status));
  const visibleError = error || statusError || batchError;
  const activeNotice = recordingNotice(active);
  const exporting = !!exportPhase;
  const status = !active ? "未录制" : active.status === "preparing" ? "准备中" : active.status === "recording" ? "录制中" : "正在结束";
  return (
    <main className="panel">
      <header className="top">
        <img className="brand-mark" src={chrome.runtime.getURL("icons/icon-32.png")} alt="" />
        <div><strong>逻辑记录</strong><small>浏览器操作档案</small></div>
      </header>
      <section className="recording" aria-label="录制">
        <div className="section-label"><span>录制状态</span><span role="status" className={active ? "status active" : "status"}><i />{status}</span></div>
        <h1>{active?.status === "preparing" ? "准备录制" : active ? "正在录制" : "准备录制"}</h1>
        {active ? (
          <button className="primary stop" disabled={!canStopRecording(active, busy ? { type: busy } : null)} onClick={stop}>
            <Square size={16} fill="currentColor" />{busy === "stopping" || !["preparing", "recording"].includes(active.status) ? "正在结束…" : "停止录制"}
          </button>
        ) : (
          <button className="primary" disabled={!canStartRecording(active, busy ? { type: busy } : null, exporting, settingsReady)} onClick={start}>
            <Circle size={16} fill="currentColor" />{busy === "starting" ? "正在准备…" : "开始录制"}
          </button>
        )}
        {!active && !settingsReady && <p className="disclosure" role="status">请先在“录制限额设置”中完成读取并保存草稿，再开始录制。</p>}
        <p className="disclosure">只记录开始时的业务标签、必要框架及可明确归属的一个流程子页；切换到其它已开页面不会扩大范围。</p>
        <p className="disclosure">保留已采集的输入、接口样本和未遮挡截图，可能含认证头及业务原值；ZIP 未加密。关闭侧边栏不会停止录制。</p>
        {active?.budget && <p className="disclosure" role="status">已保存 {formatBudgetBytes(active.budget.usedBytes)} / {formatBudgetBytes(active.budget.limitBytes)}{active.budget.warning ? " · 接近容量上限" : ""}</p>}
      </section>
      {activeNotice && <div className="notice" role="status">{activeNotice}</div>}
      {visibleError && <div className="error" role="alert"><AlertTriangle size={16} /><span>{visibleError}</span></div>}
      <LimitSettings active={active} controlBusy={!!busy} onAvailabilityChange={updateSettingsAvailability} />
      <section className="batches" aria-label="录制批次">
        <h2>录制批次</h2>
        {sessions.length ? (
          <div className="batch-list" role="radiogroup" aria-label="选择录制批次">
            {sessions.map((session) => (
              <label className="batch" key={session.id}>
                <input type="radio" name="batch" checked={selectedId === session.id} disabled={!!busy || exporting}
                  onChange={() => { preferredSession.current = ""; setSelectedId(session.id); }} />
                <span className="batch-info"><strong>{new Date(session.startedAt).toLocaleString()}</strong>
                  <small>{batchStatusLabel(session)} · {session.id.slice(0, 8)}</small></span>
              </label>
            ))}
          </div>
        ) : <div className="empty">暂无录制批次</div>}
        <button className="export" disabled={!canExportRecording(active, selectedId, busy ? { type: busy } : null, exporting)} onClick={download} aria-busy={exporting}>
          <Download size={16} />{exporting ? exportPhaseLabel(exportPhase) : "导出记录包"}
        </button>
        {exporting && <p className="disclosure" role="status" aria-live="polite">{exportProgressDetail(exportProgress, exportElapsed)}。较大批次需要更长时间；无进展时会结束等待，本地批次不删除。</p>}
        {active && <p className="disclosure">请先停止当前录制，再导出记录包。</p>}
        {exportNotice && <p className="notice" role="status">{exportNotice}</p>}
        <p className="disclosure">默认三项倍率均为 {DEFAULT_FLOW_SETTINGS.budgetMultiplier} 倍，可在“录制限额设置”中调整；达到本批预算会停止采集并保留可导出部分。新版本不迁移或显示旧版批次，也不会删除旧数据。</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
