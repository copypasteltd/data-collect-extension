import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Circle,
  Square,
  Download,
  Trash2,
  ChevronRight,
  ShieldCheck,
  AlertTriangle,
  RefreshCw,
  Eye,
} from "lucide-react";
import { createArchive } from "./archive.js";
import { downloadBlob } from "./downloads.js";
import Viewer from "./viewer.jsx";
import "./style.css";

async function call(type, data = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result.ok) throw new Error(result.error);
  return result.value;
}
function App() {
  const [state, setState] = useState({ active: null, sessions: [] });
  const [tab, setTab] = useState(null);
  const [screenshots, setScreenshots] = useState(true);
  const [cookieValues, setCookieValues] = useState(false);
  const [scope, setScope] = useState("site");
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(null);
  const [info, setInfo] = useState("");
  const [page, setPage] = useState("record");
  const [viewSession, setViewSession] = useState(null);
  const starting = useRef(false);
  const refresh = useCallback(async () => {
    try {
      setState(await call("GET_STATE"));
      const [t] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      setTab(t);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [refresh]);
  async function start() {
    if (starting.current) return;
    starting.current = true;
    setError("");
    setBusy(true);
    try {
      if (!tab?.url) throw new Error("请先切换到需要录制的网页");
      const url = new URL(tab?.url);
      if (!["http:", "https:"].includes(url.protocol))
        throw new Error("请选择 HTTP 或 HTTPS 页面");
      const origins =
        scope === "browser"
          ? ["http://*/*", "https://*/*"]
          : [`${url.protocol}//${url.hostname}/*`];
      const granted = await chrome.permissions.request({ origins });
      if (!granted)
        throw new Error(
          scope === "browser"
            ? "需要授予所有网页访问权限才能录制"
            : "需要授予当前站点访问权限才能录制",
        );
      const [current] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (
        !current?.url ||
        new URL(current.url).origin !== url.origin ||
        current.id !== tab.id
      )
        throw new Error("当前页面已变化，请确认后重新开始");
      await call("START", {
        tab: current,
        options: { screenshots, cookieValues, scope },
      });
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      starting.current = false;
      setBusy(false);
    }
  }
  async function stop() {
    setBusy(true);
    setError("");
    try {
      await call("STOP");
      await refresh();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function download(session) {
    setBusy(true);
    setError("");
    setInfo("");
    setProgress({ phase: "准备记录包", current: 0, total: 0 });
    try {
      const { blob, importIssues } = await createArchive(session.id, setProgress);
      if (importIssues.length)
        setInfo(`记录包仍可下载备份，但当前侧边栏无法导入：${importIssues.join("；")}。建议分段录制。`);
      setProgress({ phase: "等待浏览器完成下载", current: 0, total: 0 });
      await downloadBlob(blob, `逻辑记录-${session.id.slice(0, 8)}.zip`);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }
  async function remove(session) {
    if (!confirm(`删除“${session.title}”的录制记录？`)) return;
    try {
      await call("DELETE", { id: session.id });
      await refresh();
    } catch (e) {
      setError(e.message);
    }
  }
  const active = state.active;
  if (page === "viewer")
    return <Viewer sessionId={viewSession} onBack={() => setPage("record")} />;
  return (
    <main className="panel">
      <header className="top">
        <div className="brand">
          <img
            className="brand-mark"
            src={chrome.runtime.getURL("icons/icon-32.png")}
            alt=""
          />
          <div>
            <strong>逻辑记录</strong>
            <small>浏览器操作档案</small>
          </div>
        </div>
        <button className="icon" title="刷新" onClick={refresh}>
          <RefreshCw size={16} />
        </button>
      </header>
      <section className="status-section">
        <div className="section-label">
          当前任务{" "}
          <span
            className={"status " + (active?.status === "recording" ? "on" : "")}
          >
            <i />
            {!active
              ? "未录制"
              : active.status === "preparing"
                ? "准备中"
                : active.status === "stopping"
                  ? "正在结束"
                  : "录制中"}
          </span>
        </div>
        <h1>{active ? active.title : "准备开始"}</h1>
        <p className="muted url">
          {active
            ? active.options?.scope === "browser"
              ? "所有打开的网页"
              : active.origin
            : tab?.url || "请选择要记录的页面"}
        </p>
        {active ? (
          <>
            <div className="meta">
              开始于 {new Date(active.startedAt).toLocaleString()}
            </div>
            <button
              className="primary stop"
              disabled={busy || active.status !== "recording"}
              onClick={stop}
            >
              <Square size={16} fill="currentColor" />{" "}
              {active.status === "preparing"
                ? "正在准备…"
                : busy || active.status === "stopping"
                  ? "正在整理…"
                  : "停止录制"}
            </button>
          </>
        ) : (
          <>
            <label className="scope-label">
              录制范围
              <select
                value={scope}
                onChange={(e) => {
                  setScope(e.target.value);
                  setConsent(false);
                }}
              >
                <option value="site">当前站点及其新标签</option>
                <option value="browser">所有打开的网页</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={screenshots}
                onChange={(e) => setScreenshots(e.target.checked)}
              />
              <span>记录操作截图</span>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={cookieValues}
                onChange={(e) => {
                  setCookieValues(e.target.checked);
                  setConsent(false);
                }}
              />
              <span>保存非认证 Cookie 值（可能含敏感信息）</span>
            </label>
            <label className="check consent">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                我有权记录{scope === "browser" ? "所有打开的网页" : "当前站点"}
                ，并同意在本机保存页面、操作、文件名、截图、图片资源、相关请求及站点状态。
              </span>
            </label>
            <button
              className="primary"
              disabled={!consent || busy}
              onClick={start}
            >
              <Circle size={16} fill="currentColor" />{" "}
              {busy ? "正在准备…" : "开始录制"}
            </button>
          </>
        )}
      </section>
      {error && (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      {info && (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{info}</span>
        </div>
      )}
      {progress && (
        <div className="notice">
          <RefreshCw size={16} />
          <span>
            {progress.phase}
            {progress.total ? `：${progress.current} / ${progress.total}` : "…"}
          </span>
        </div>
      )}
      {active?.notice && (
        <div className="notice error">
          <AlertTriangle size={16} />
          <span>{active.notice}</span>
        </div>
      )}
      <div className="notice">
        <ShieldCheck size={16} />
        <span>
          记录保存在本机。页面内容与截图可能包含敏感信息，分享前请检查。
        </span>
      </div>
      <section className="history">
        <div className="section-heading">
          <h2>录制记录</h2>
          <span>{state.sessions.length}</span>
        </div>
        {state.sessions.length === 0 ? (
          <div className="empty">还没有录制记录</div>
        ) : (
          state.sessions.map((session) => (
            <div className="record" key={session.id}>
              <div className="record-info">
                <strong title={session.title}>{session.title}</strong>
                <small>
                  {new Date(session.startedAt).toLocaleString()} ·{" "}
                  {session.status === "ready"
                    ? session.coverage?.warnings ||
                      session.coverage?.snapshotGaps ||
                      session.coverage?.databaseGaps ||
                      session.coverage?.cacheGaps ||
                      session.coverage?.initialResourceGaps ||
                      session.coverage?.screenshotsUnavailable ||
                      session.coverage?.inputGaps ||
                      session.coverage?.storageGaps ||
                      session.coverage?.styleGaps ||
                      session.coverage?.responseGaps ||
                      session.coverage?.pendingRequests
                      ? "完成（有采集提示）"
                      : "已完成"
                    : session.status === "recording"
                      ? "录制中"
                      : session.status === "interrupted"
                        ? "异常中断（可导出部分记录）"
                        : session.status}
                </small>
              </div>
              <div className="record-actions">
                <button
                  className="icon"
                  title="查看记录"
                  onClick={() => {
                    setViewSession(session.id);
                    setPage("viewer");
                  }}
                >
                  <Eye size={17} />
                </button>
                <button
                  className="icon"
                  disabled={
                    !["ready", "interrupted"].includes(session.status) || busy
                  }
                  title="下载记录包"
                  onClick={() => download(session)}
                >
                  <Download size={17} />
                </button>
                <button
                  className="icon"
                  disabled={session.id === active?.id}
                  title="删除记录"
                  onClick={() => remove(session)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          ))
        )}
      </section>
      <button
        className="viewer-link"
        onClick={() => {
          setViewSession(null);
          setPage("viewer");
        }}
      >
        导入记录包 <ChevronRight size={15} />
      </button>
    </main>
  );
}
createRoot(document.getElementById("root")).render(<App />);
