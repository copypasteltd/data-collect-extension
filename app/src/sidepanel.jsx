import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AlertTriangle, Circle, Download, Square } from "lucide-react";
import { createArchive } from "./archive.js";
import { downloadBlob } from "./downloads.js";
import "./style.css";

async function call(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function App() {
  const [state, setState] = useState({ active: null, sessions: [] });
  const [tab, setTab] = useState(null);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const operation = useRef(false);

  const refresh = useCallback(async (preferredId) => {
    const next = await call("GET_STATE");
    const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
    setState(next);
    setTab(current);
    const available = next.sessions.filter((session) => ["ready", "interrupted"].includes(session.status));
    setSelectedId((previous) => {
      if (preferredId && available.some((session) => session.id === preferredId)) return preferredId;
      return available.some((session) => session.id === previous) ? previous : available[0]?.id || "";
    });
  }, []);

  useEffect(() => {
    const update = () => refresh().catch((reason) => setError(reason.message));
    update();
    const timer = setInterval(update, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  async function start() {
    if (operation.current) return;
    operation.current = true;
    setError("");
    setBusy("starting");
    try {
      if (!tab?.url || !["http:", "https:"].includes(new URL(tab.url).protocol))
        throw new Error("请先切换到需要录制的网页");
      const granted = await chrome.permissions.request({ origins: ["http://*/*", "https://*/*"] });
      if (!granted) throw new Error("未授予网页访问权限");
      const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!current?.url || current.id !== tab.id || new URL(current.url).origin !== new URL(tab.url).origin)
        throw new Error("当前页面已变化，请重新开始");
      await call("START", { tab: current, options: { screenshots: true, canvasSnapshots: true, scope: "browser" } });
      await refresh();
    } catch (reason) {
      setError(reason.message);
      await refresh().catch(() => {});
    } finally {
      operation.current = false;
      setBusy("");
    }
  }

  async function stop() {
    if (operation.current) return;
    operation.current = true;
    setError("");
    setBusy("stopping");
    try {
      const session = await call("STOP");
      await refresh(session.id);
    } catch (reason) {
      setError(reason.message);
      await refresh().catch(() => {});
    } finally {
      operation.current = false;
      setBusy("");
    }
  }

  async function download() {
    if (operation.current || !selectedId) return;
    operation.current = true;
    setError("");
    setBusy("exporting");
    try {
      const { blob } = await createArchive(selectedId);
      await downloadBlob(blob, `逻辑记录-${selectedId.slice(0, 8)}.zip`);
    } catch (reason) {
      setError(reason.message);
    } finally {
      operation.current = false;
      setBusy("");
    }
  }

  const active = state.active;
  const sessions = state.sessions.filter((session) => ["ready", "interrupted"].includes(session.status));
  const status = !active ? "未录制" : active.status === "preparing" ? "准备中" : active.status === "stopping" ? "正在结束" : "录制中";
  return (
    <main className="panel">
      <header className="top">
        <img className="brand-mark" src={chrome.runtime.getURL("icons/icon-32.png")} alt="" />
        <div><strong>逻辑记录</strong><small>浏览器操作档案</small></div>
      </header>
      <section className="recording" aria-label="录制">
        <div className="section-label"><span>录制状态</span><span className={active ? "status active" : "status"}><i />{status}</span></div>
        <h1>{active ? "正在录制" : "准备录制"}</h1>
        {active ? (
          <button className="primary stop" disabled={!!busy || active.status !== "recording"} onClick={stop}>
            <Square size={16} fill="currentColor" />{busy === "stopping" || active.status === "stopping" ? "正在结束…" : "停止录制"}
          </button>
        ) : (
          <button className="primary" disabled={!!busy || !tab} onClick={start}>
            <Circle size={16} fill="currentColor" />{busy === "starting" ? "正在准备…" : "开始录制"}
          </button>
        )}
      </section>
      {error && <div className="error" role="alert"><AlertTriangle size={16} /><span>{error}</span></div>}
      <section className="batches" aria-label="录制批次">
        <h2>录制批次</h2>
        {sessions.length ? (
          <div className="batch-list" role="radiogroup" aria-label="选择录制批次">
            {sessions.map((session) => (
              <label className="batch" key={session.id}>
                <input type="radio" name="batch" checked={selectedId === session.id} disabled={!!busy}
                  onChange={() => setSelectedId(session.id)} />
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
