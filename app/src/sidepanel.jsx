import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Circle, Download, Square } from "lucide-react";
import { createArchive } from "./archive.js";
import { downloadBlob } from "./downloads.js";
import { canStartRecording, canStopRecording, canExportRecording, recordingNotice, batchStatusLabel, exportPhaseLabel } from "./panel-state.js";
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

function App() {
  const [state, setState] = useState({ active: null, sessions: [] });
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [statusError, setStatusError] = useState("");
  const [batchError, setBatchError] = useState("");
  const [exportPhase, setExportPhase] = useState("");
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

  async function start() {
    if (!canStartRecording(state.active, operation.current, exportOperation.current)) return;
    const currentOperation = { type: "starting" };
    operation.current = currentOperation;
    uncertainStop.current = "";
    pendingArchiveError.current = "";
    setError("");
    setBusy("starting");
    try {
      const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
      if (!granted) throw new Error("未授予网页访问权限");
      const [current] = await withTimeout(chrome.tabs.query({ active: true, currentWindow: true }), 8000);
      if (!current?.url || !["http:", "https:"].includes(new URL(current.url).protocol))
        throw new Error("请先切换到需要录制的网页");
      await call("START", { tab: current, options: { screenshots: true, canvasSnapshots: true, scope: "browser" }, acknowledgeEarly: true });
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
    const currentExport = { id: selectedId };
    exportOperation.current = currentExport;
    setError("");
    setExportNotice("");
    setExportPhase("checking");
    try {
      // A second panel may have started recording since the last poll. Do not
      // open a new historical export in that state; an already running export
      // never owns the recording Stop control.
      const next = await readStatus();
      if (!next.applied) throw new Error("录制状态已更新，请确认后重试导出");
      if (next.active) throw new Error("请先停止当前录制，再导出记录包");
      setExportPhase("events");
      const { blob, importIssues = [] } = await createArchive(currentExport.id, (progress) => {
        if (exportOperation.current !== currentExport) return;
        setExportPhase(progress.phase === "整理截图与资源" ? "assets" : "events");
      });
      if (exportOperation.current !== currentExport) return;
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
      if (exportOperation.current === currentExport) {
        exportOperation.current = null;
        setExportPhase("");
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
          <button className="primary" disabled={!canStartRecording(active, busy ? { type: busy } : null, exporting)} onClick={start}>
            <Circle size={16} fill="currentColor" />{busy === "starting" ? "正在准备…" : "开始录制"}
          </button>
        )}
        <p className="disclosure">默认记录本 Chrome 配置中所有已授权的普通网页，包含其他窗口和新标签；请使用仅含获准页面的专用配置。</p>
        <p className="disclosure">记录保留原值和未遮挡截图，可能包含密码、Cookie 及业务资料；ZIP 未加密。关闭侧边栏不会停止录制。</p>
      </section>
      {activeNotice && <div className="notice" role="status">{activeNotice}</div>}
      {visibleError && <div className="error" role="alert"><AlertTriangle size={16} /><span>{visibleError}</span></div>}
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
        {active && <p className="disclosure">请先停止当前录制，再导出记录包。</p>}
        {exportNotice && <p className="notice" role="status">{exportNotice}</p>}
        <p className="disclosure">导出会保留本地批次，当前不会自动到期删除；分享与后续副本的保存范围需另行控制。</p>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
