import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Circle, Download, Square } from "lucide-react";
import { createArchive } from "./archive.js";
import { downloadBlob } from "./downloads.js";
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
  const operation = useRef(null);
  const refreshNumber = useRef(0);
  const appliedRefresh = useRef(0);
  const batchInFlight = useRef(false);
  const preferredSession = useRef("");
  const uncertainStop = useRef("");

  const refreshBatches = useCallback(() => {
    if (batchInFlight.current) return;
    batchInFlight.current = true;
    call("GET_STATE").then((next) => {
      setBatchError("");
      setState((previous) => ({ ...previous, sessions: next.sessions }));
      const available = next.sessions.filter((session) => ["ready", "interrupted"].includes(session.status));
      const preferred = preferredSession.current;
      if (preferred && available.some((session) => session.id === preferred)) preferredSession.current = "";
      setSelectedId((previous) => {
        if (preferred && available.some((session) => session.id === preferred)) return preferred;
        return available.some((session) => session.id === previous) ? previous : available[0]?.id || "";
      });
    }).catch((reason) => setBatchError(reason.message)).finally(() => { batchInFlight.current = false; });
  }, []);

  const refresh = useCallback(async (preferredId) => {
    if (preferredId) preferredSession.current = preferredId;
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
      }
    } catch (reason) {
      if (request >= appliedRefresh.current) {
        appliedRefresh.current = request;
        setStatusError(reason.message);
      }
      throw reason;
    } finally {
      refreshBatches();
    }
  }, [refreshBatches]);

  useEffect(() => {
    const update = () => refresh().catch(() => {});
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function start() {
    if (operation.current) return;
    const currentOperation = { type: "starting" };
    operation.current = currentOperation;
    uncertainStop.current = "";
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
    if (operation.current && operation.current.type !== "starting") return;
    const currentOperation = { type: "stopping" };
    const sessionId = state.active?.id;
    operation.current = currentOperation;
    uncertainStop.current = "";
    setError("");
    setBusy("stopping");
    try {
      const session = await call("STOP", { sessionId });
      await refresh(session.id).catch(() => {});
    } catch (reason) {
      if (reason.message === "后台响应超时，请等待状态刷新" && sessionId) uncertainStop.current = sessionId;
      setError(reason.message);
      await refresh().catch(() => {});
    } finally {
      operation.current = null;
      setBusy("");
    }
  }

  async function download() {
    if (operation.current || !selectedId) return;
    operation.current = { type: "exporting" };
    setError("");
    setBusy("exporting");
    try {
      const { blob } = await createArchive(selectedId);
      await downloadBlob(blob, `逻辑记录-${selectedId.slice(0, 8)}.zip`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      operation.current = null;
      setBusy("");
    }
  }

  const active = state.active;
  const sessions = state.sessions.filter((session) => ["ready", "interrupted"].includes(session.status));
  const visibleError = error || statusError || batchError;
  const status = !active ? "未录制" : active.status === "preparing" ? "准备中" : active.status === "recording" ? "录制中" : "正在结束";
  return (
    <main className="panel">
      <header className="top">
        <img className="brand-mark" src={chrome.runtime.getURL("icons/icon-32.png")} alt="" />
        <div><strong>逻辑记录</strong><small>浏览器操作档案</small></div>
      </header>
      <section className="recording" aria-label="录制">
        <div className="section-label"><span>录制状态</span><span className={active ? "status active" : "status"}><i />{status}</span></div>
        <h1>{active?.status === "preparing" ? "准备录制" : active ? "正在录制" : "准备录制"}</h1>
        {active ? (
          <button className="primary stop" disabled={(!!busy && busy !== "starting") || !["preparing", "recording"].includes(active.status)} onClick={stop}>
            <Square size={16} fill="currentColor" />{busy === "stopping" || !["preparing", "recording"].includes(active.status) ? "正在结束…" : "停止录制"}
          </button>
        ) : (
          <button className="primary" disabled={!!busy} onClick={start}>
            <Circle size={16} fill="currentColor" />{busy === "starting" ? "正在准备…" : "开始录制"}
          </button>
        )}
      </section>
      {visibleError && <div className="error" role="alert"><AlertTriangle size={16} /><span>{visibleError}</span></div>}
      <section className="batches" aria-label="录制批次">
        <h2>录制批次</h2>
        {sessions.length ? (
          <div className="batch-list" role="radiogroup" aria-label="选择录制批次">
            {sessions.map((session) => (
              <label className="batch" key={session.id}>
                <input type="radio" name="batch" checked={selectedId === session.id} disabled={!!busy}
                  onChange={() => { preferredSession.current = ""; setSelectedId(session.id); }} />
                <span className="batch-info"><strong>{new Date(session.startedAt).toLocaleString()}</strong>
                  <small>{session.status === "interrupted" ? "录制中断" : "已完成"} · {session.id.slice(0, 8)}</small></span>
              </label>
            ))}
          </div>
        ) : <div className="empty">暂无录制批次</div>}
        <button className="export" disabled={!selectedId || !!busy} onClick={download}>
          <Download size={16} />{busy === "exporting" ? "正在导出…" : "导出记录包"}
        </button>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
