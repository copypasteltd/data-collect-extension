import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Upload,
  Download,
  Search,
  ChevronLeft,
  ChevronRight,
  Play,
  Pause,
  Image as ImageIcon,
  FileJson,
  AlertTriangle,
  ArrowLeft,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { readArchive, readLocalSession } from "./archive.js";
import { buildCatalog, buildResourceMap } from "./analysis.js";
import Replay, { replayableKinds } from "./replay.jsx";
import { buildOpenApi } from "./openapi.js";
import { downloadBlob } from "./downloads.js";
import { sanitizeCss, sanitizeSnapshotHtml } from "./snapshot.js";
import { buildStylesheetMap } from "./stylesheet-resources.js";
import { fontMime } from "./font-format.js";
import { recordedFontFaces, recordedFontMetadata } from "./font-resources.js";
import { applyRecordedMutations } from "./mutations.js";
import { recordedScrollState, restoreScrollState } from "./scroll-state.js";
import { assessScreenshotTiming } from "./screenshots.js";
import { findReplayOutcome } from "./replay-outcome.js";
import { strToU8, zipSync } from "fflate";
import "./style.css";

const labels = {
  "interaction.click": "点击",
  "interaction.dblclick": "双击",
  "interaction.input": "输入",
  "interaction.change": "更改",
  "interaction.submit": "提交",
  "interaction.scroll": "滚动",
  "interaction.keydown": "按键",
  "page.snapshot": "页面状态",
  "page.mutation": "页面变化",
  screenshot: "截图",
  "network.request": "请求",
  "network.requestBody": "请求体",
  "network.response": "响应",
  "network.finished": "请求完成",
  "network.failed": "请求失败",
  "network.websocket": "实时连接",
  "network.websocketFrame": "实时消息",
  "network.eventSourceMessage": "推送消息",
  "resource.initial": "已有页面资源",
  "resource.initialSummary": "初始资源采集",
  warning: "采集提示",
  navigation: "页面跳转",
  "session.start": "开始录制",
  "session.ready": "采集已就绪",
  "session.stop": "停止录制",
  "cookie.initial": "Cookie 初始状态",
  "cookie.change": "Cookie 变更",
  "storage.snapshot": "站点存储状态",
  "storage.unavailable": "站点存储不可用",
  "tab.created": "打开标签",
  "tab.closed": "关闭标签",
};
const title = (event) =>
  event.kind === "network.failed" && event.payload?.canceled
    ? "请求取消"
    : labels[event.kind] || event.kind;
const bodyStatus = {
  omitted_size: "请求体超过大小限制",
  omitted_type: "请求体类型未采集",
  omitted_binary: "二进制请求体未采集",
  omitted_unparseable: "请求体无法解析",
  unavailable: "请求体无法读取",
};
function snapshotIssues(payload) {
  const issues = [];
  if (payload.status && payload.status !== "captured")
    issues.push({ truncated: "页面快照已截断", omitted_size: "页面快照过大未保存", failed: "页面快照采集失败" }[payload.status] || `页面快照状态：${payload.status}`);
  if (payload.styles?.unavailable) issues.push(`${payload.styles.unavailable} 个样式无法直接读取，将尝试使用已采集的资源`);
  if (payload.styles?.truncated) issues.push("页面样式超过采集上限");
  if (payload.styles?.backgroundUnavailable) issues.push(`${payload.styles.backgroundUnavailable} 个背景样式无法读取`);
  if (payload.styles?.backgroundTruncated) issues.push("背景样式检查超过元素数量上限");
  if (payload.scroll?.truncated) issues.push("页面滚动状态超过采集上限");
  if (payload.shadow?.roots && payload.shadow.captured == null)
    issues.push(`组件内部结构未采集：${payload.shadow.roots} 个`);
  else if (payload.shadow?.roots)
    issues.push("组件内部的快照间变化可能不完整");
  if (payload.shadow?.omitted) issues.push(`组件快照未采集：${payload.shadow.omitted} 个`);
  if (payload.shadow?.stylesUnavailable) issues.push(`组件样式无法读取：${payload.shadow.stylesUnavailable} 个`);
  if (payload.shadow?.stylesTruncated) issues.push("组件样式超过采集上限");
  if (payload.shadow?.truncated || payload.shadow?.unavailable) issues.push("组件内部结构检查不完整");
  return issues;
}
function Report({ archive, showEvent }) {
  const events = archive.events;
  const warnings = events.filter(
    (e) =>
      e.kind === "warning" ||
      e.kind === "network.failed" ||
      (e.kind === "resource.initialSummary" &&
        e.payload.status !== "captured") ||
      (e.kind === "network.requestBody" &&
        ![
          "captured_redacted",
          "captured_redacted_best_effort",
          "empty",
        ].includes(e.payload.body?.status)) ||
      (e.kind === "screenshot" && e.payload.status === "unavailable") ||
      (e.kind === "page.snapshot" &&
        (e.payload.status !== "captured" ||
          e.payload.styles?.unavailable > 0 ||
          e.payload.styles?.truncated ||
          e.payload.styles?.backgroundUnavailable > 0 ||
          e.payload.styles?.backgroundTruncated ||
          e.payload.scroll?.truncated ||
          e.payload.shadow?.roots > 0 ||
          e.payload.shadow?.truncated ||
          e.payload.shadow?.unavailable)) ||
      (e.kind === "page.mutation" && e.payload.status !== "captured") ||
      e.kind === "storage.unavailable" ||
      (e.kind === "storage.snapshot" && e.payload.coverage &&
        Object.values(e.payload.coverage).some((item) => item?.status !== "captured")) ||
      ((e.kind === "interaction.input" || e.kind === "interaction.change") &&
        (["truncated", "redacted_truncated"].includes(e.payload.valueStatus) ||
          ["truncated", "redacted_truncated"].includes(e.payload.beforeValueStatus) ||
          e.payload.formState?.truncated ||
          e.payload.formState?.optionsTruncated)) ||
      (e.kind === "database.snapshot" &&
        (e.payload.status ||
          e.payload.database?.status !== "captured" ||
          e.payload.database?.storesTruncated ||
          e.payload.database?.stores?.some((store) => store.truncated))),
  );
  const shots = events.filter((e) => e.kind === "screenshot");
  const network = events.filter((e) => e.kind === "network.finished");
  const unavailableBodies = network.filter(
    (e) =>
      ![
        "captured_redacted",
        "captured_redacted_best_effort",
        "captured_asset",
        "empty",
      ].includes(e.payload.body?.status),
  ).length;
  return (
    <section className="catalog">
      <h2>采集报告</h2>
      <p>数字以本次采集器观察到的记录为准。</p>
      <div className="report-grid">
        <div>
          <strong>
            {events.filter((e) => e.kind.startsWith("interaction.")).length}
          </strong>
          <small>操作记录</small>
        </div>
        <div>
          <strong>
            {events.filter((e) => e.kind === "page.snapshot").length}
          </strong>
          <small>页面快照</small>
        </div>
        <div>
          <strong>{shots.filter((e) => e.payload.assetId).length}</strong>
          <small>截图</small>
        </div>
        <div>
          <strong>
            {events.filter((e) => e.kind === "network.request").length}
          </strong>
          <small>请求</small>
        </div>
      </div>
      <p>
        截图未取得：
        {shots.filter((e) => e.payload.status === "unavailable").length}
        ；响应主体未取得或未保留：{unavailableBodies}
        。开始录制前的请求不可补录；数据库为限量的开始和结束快照，缓存仅记录名称。
      </p>
      {archive.manifest.partial && (
        <div className="notice error">
          <AlertTriangle size={16} />
          录制异常中断，此包只包含已保存的部分。
        </div>
      )}
      <h3 className="report-heading">采集提示 · {warnings.length}</h3>
      {warnings.map((e) => (
        <button
          key={e.id}
          className="catalog-row"
          onClick={() => showEvent(e.id)}
        >
          <span>
            <strong>{title(e)}</strong>
            <small>
              {e.kind === "page.snapshot"
                ? snapshotIssues(e.payload).join("；")
                : e.payload.message ||
                e.payload.reason ||
                e.payload.errorText ||
                (e.kind === "resource.initialSummary"
                  ? `已有页面资源未取得：${e.payload.omitted || "数量未知"}`
                  : null) ||
                (e.kind === "storage.snapshot" ? "站点存储部分内容未取得或超过采集上限" : null) ||
                (e.kind === "storage.unavailable" ? "站点存储无法读取" : null) ||
                (["truncated", "redacted_truncated"].includes(e.payload.valueStatus)
                  ? "输入值超过采集上限，仅记录部分内容"
                  : null) ||
                (["truncated", "redacted_truncated"].includes(e.payload.beforeValueStatus)
                  ? "操作前输入值超过采集上限"
                  : null) ||
                (e.payload.formState?.truncated
                  ? "选项数量超过采集上限"
                  : null) ||
                (e.payload.formState?.optionsTruncated
                  ? "选项数量超过复现控件上限"
                  : null) ||
                bodyStatus[e.payload.body?.status] ||
                e.payload.body?.reason ||
                e.payload.body?.status ||
                e.payload.status ||
                e.payload.database?.status ||
                "记录已截断"}
            </small>
          </span>
          <ChevronRight size={15} />
        </button>
      ))}
      {!warnings.length && <div className="empty">没有采集提示</div>}
    </section>
  );
}
export default function Viewer({ onBack, sessionId }) {
  const [archive, setArchive] = useState(null),
    [selected, setSelected] = useState(null),
    [filter, setFilter] = useState("all"),
    [search, setSearch] = useState(""),
    [error, setError] = useState(""),
    [playing, setPlaying] = useState(false),
    [speed, setSpeed] = useState(1),
    [imageUrl, setImageUrl] = useState(""),
    [view, setView] = useState("timeline");
  const [loading, setLoading] = useState(null);
  const [timelinePage, setTimelinePage] = useState(0);
  const [replayFrom, setReplayFrom] = useState(null);
  const [replayOutcome, setReplayOutcome] = useState(false);
  const onReplayChange = useCallback((step, completed) => {
    setSelected(step);
    setReplayOutcome(completed);
  }, []);
  const [scrollFailed, setScrollFailed] = useState(false);
  const events = useMemo(
    () =>
      (archive?.events || [])
        .filter(
          (e) =>
            (filter === "all" || e.kind.startsWith(filter)) &&
            (!search ||
              JSON.stringify(e).toLowerCase().includes(search.toLowerCase())),
        )
        .sort((a, b) => a.time - b.time || a.seq - b.seq),
    [archive, filter, search],
  );
  const catalog = useMemo(() => buildCatalog(archive?.events || []), [archive]);
  const requestContext = useMemo(() => {
    if (!archive || !selected?.kind?.startsWith("network.") || !selected.payload?.requestId) return null;
    const request = selected.kind === "network.request" ? selected : archive.events.find((event) =>
      event.kind === "network.request" && event.payload?.requestId === selected.payload.requestId);
    if (!request) return null;
    const step = catalog.flows.flatMap((flow) => flow.steps).find((item) =>
      item.candidateRequests.some((candidate) => candidate.eventId === request.id));
    return { request, step };
  }, [archive, selected, catalog]);
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    readLocalSession(sessionId)
      .then((result) => {
        if (!cancelled) {
          setArchive(result);
          setSelected(result.events[0] || null);
        }
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);
  const index = events.findIndex((e) => e.id === selected?.id);
  const totalPages = Math.max(1, Math.ceil(events.length / 100));
  useEffect(() => {
    if (index >= 0) setTimelinePage(Math.floor(index / 100));
    else setTimelinePage(0);
  }, [index]);
  const screenshot = useMemo(() => {
    if (!selected || !archive) return null;
    if (selected.kind === "screenshot") return selected;
    return archive.events.find(
      (e) =>
        e.kind === "screenshot" && e.payload.eventIds?.includes(selected.id),
    );
  }, [selected, archive]);
  const screenshotTiming = useMemo(() => selected?.kind?.startsWith("interaction.")
    ? assessScreenshotTiming(archive?.events || [], selected, screenshot) : null, [archive, selected, screenshot]);
  const snapshotCursor = useMemo(() => {
    if (!selected || !archive) return null;
    if (view === "replay" && replayOutcome) return findReplayOutcome(archive.events, selected);
    return { event: selected };
  }, [selected, archive, view, replayOutcome]);
  const snapshotEvent = useMemo(() => {
    const cursor = snapshotCursor?.event;
    if (!cursor || !archive) return null;
    if (cursor.kind === "page.snapshot") return cursor;
    if (!cursor.tabId) return null;
    if (cursor.frameId == null && ["embedded", "unknown"].includes(requestContext?.request?.payload?.sourceFrame)) return null;
    const inReplay = view === "replay", beforeAction = inReplay && !replayOutcome;
    return (
      archive.events
        .filter(
          (e) =>
            e.kind === "page.snapshot" &&
            e.tabId === cursor.tabId &&
            e.frameId === (cursor.frameId ?? 0) &&
            (!inReplay || e.payload?.url === cursor.payload?.url) &&
            (!cursor.documentId || e.documentId === cursor.documentId ||
              (!inReplay && !e.documentId)) &&
            (e.time < cursor.time ||
              (e.time === cursor.time && (beforeAction ? e.seq < cursor.seq : e.seq <= cursor.seq))) &&
            e.payload?.html,
        )
        .sort((a, b) => b.time - a.time || b.seq - a.seq)[0] || null
    );
  }, [snapshotCursor, archive, requestContext, view, replayOutcome]);
  const snapshot = useMemo(() => {
    const cursor = snapshotCursor?.event;
    if (!snapshotEvent?.payload.html || !archive || !cursor) return null;
    const beforeAction = view === "replay" && !replayOutcome;
    const doc = new DOMParser().parseFromString(
      sanitizeSnapshotHtml(snapshotEvent.payload.html),
      "text/html",
    );
    const related = archive.events
      .filter(
        (event) =>
          event.tabId === snapshotEvent.tabId &&
          event.frameId === snapshotEvent.frameId &&
          (!event.documentId ||
            !snapshotEvent.documentId ||
            event.documentId === snapshotEvent.documentId) &&
          (event.time > snapshotEvent.time ||
            (event.time === snapshotEvent.time &&
              event.seq > snapshotEvent.seq)) &&
          (event.time < cursor.time ||
            (event.time === cursor.time && (beforeAction ? event.seq < cursor.seq : event.seq <= cursor.seq))),
      )
      .sort((a, b) => a.time - b.time || a.seq - b.seq);
    const result = applyRecordedMutations(
      doc,
      related.filter((event) =>
        ["page.mutation", "interaction.input", "interaction.change"].includes(event.kind),
      ),
    );
    const scrollState = recordedScrollState(snapshotEvent.payload, related);
    result.issues.push(...snapshotIssues(snapshotEvent.payload));
    if (scrollState.truncated && !snapshotEvent.payload.scroll?.truncated)
      result.issues.push("部分滚动状态超过采集上限");
    const snapshotRoots = [doc];
    for (let i = 0; i < snapshotRoots.length; i++)
      for (const template of snapshotRoots[i].querySelectorAll("template"))
        snapshotRoots.push(template.content);
    for (const root of snapshotRoots) root
      .querySelectorAll(
        "script, iframe, frame, object, embed, base, meta, link",
      )
      .forEach((node) => node.remove());
    for (const root of snapshotRoots) for (const node of root.querySelectorAll("*")) {
      for (const attr of [...node.attributes])
        if (
          /^on/i.test(attr.name) ||
          /^(src|srcset|href|xlink:href|action|formaction)$/i.test(attr.name)
        )
          node.removeAttribute(attr.name);
      if (node.matches("button,input,select,textarea"))
        node.setAttribute("disabled", "");
      if (view === "replay" && replayOutcome && node.hasAttribute("contenteditable"))
        node.setAttribute("contenteditable", "false");
    }
    const assetIndex = JSON.parse(
      new TextDecoder().decode(
        archive.files["resources/index.json"] || new TextEncoder().encode("[]"),
      ),
    );
    const byId = new Map(assetIndex.map((asset) => [asset.id, asset]));
    const resourceCutoff = beforeAction ? { ...cursor, seq: (cursor.seq || 0) - 1 } : cursor;
    const resourceContext = { frameId: snapshotEvent.frameId, documentId: snapshotEvent.documentId, url: snapshotEvent.payload.url, snapshotEvent };
    const stylesheets = buildStylesheetMap(archive.events, snapshotEvent.tabId, resourceCutoff, byId, archive.files, resourceContext);
    const resources = buildResourceMap(archive.events, snapshotEvent.tabId, resourceCutoff, resourceContext);
    let fontBudget = 10000000;
    const fontUrl = (url) => {
      const id = resources.get(url);
      if (typeof id !== "string" || !/^[a-z0-9_-]{1,128}$/i.test(id)) return null;
      const asset = byId.get(id), bytes = archive.files[`resources/${id}.bin`];
      const mime = fontMime(bytes);
      if (!mime || bytes.length > fontBudget || asset?.type !== "resource" || asset.mime !== mime) return null;
      fontBudget -= bytes.length;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      return `data:${mime};base64,${btoa(binary)}`;
    };
    let missingStyles = 0, missingFonts = 0;
    for (const root of snapshotRoots)
      for (const style of root.querySelectorAll("style[data-logic-stylesheet]")) {
        const stylesheetUrl = style.getAttribute("data-logic-stylesheet");
        const css = stylesheets.get(stylesheetUrl);
        if (typeof css === "string") {
          const fonts = recordedFontFaces(css, stylesheetUrl, fontUrl);
          style.textContent = `${sanitizeCss(css)}\n${fonts.css}`;
          missingFonts += fonts.missing;
        }
        else missingStyles++;
        style.removeAttribute("data-logic-stylesheet");
      }
    for (const root of snapshotRoots)
      for (const style of root.querySelectorAll("style[data-logic-fonts]")) {
        const fonts = recordedFontMetadata(style.getAttribute("data-logic-fonts"), fontUrl);
        style.textContent += `\n${fonts.css}`;
        missingFonts += fonts.missing;
        style.removeAttribute("data-logic-fonts");
      }
    if (missingStyles) result.issues.push(`外部样式未取得：${missingStyles} 个`);
    if (missingFonts) result.issues.push(`样式字体未取得：${missingFonts} 个`);
    const dataUrls = new Map();
    const dataUrl = (id) => {
      if (typeof id !== "string" || !id) return null;
      if (dataUrls.has(id)) return dataUrls.get(id);
      const asset = byId.get(id),
        bytes = archive.files[`resources/${id}.bin`];
      if (
        !bytes ||
        bytes.length > 1500000 ||
        !asset ||
        !/^image\/(png|jpeg|webp|gif)$/.test(asset.mime)
      )
        return null;
      let binary = "";
      for (let i = 0; i < bytes.length; i += 32768)
        binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
      const result = `data:${asset.mime};base64,${btoa(binary)}`;
      dataUrls.set(id, result);
      return result;
    };
    let missingImages = 0, missingBackgrounds = 0;
    for (const root of snapshotRoots) for (const img of root.querySelectorAll("img[data-logic-src]")) {
      const url = dataUrl(resources.get(img.getAttribute("data-logic-src")));
      if (url) img.setAttribute("src", url);
      else missingImages++;
      img.removeAttribute("data-logic-src");
    }
    for (const root of snapshotRoots) for (const node of root.querySelectorAll("[data-logic-background]")) {
      const url = dataUrl(
        resources.get(node.getAttribute("data-logic-background")),
      );
      if (url && node instanceof HTMLElement)
        node.style.setProperty(
          "background-image",
          `url("${url}")`,
          "important",
        );
      else missingBackgrounds++;
      node.removeAttribute("data-logic-background");
    }
    if (missingImages) result.issues.push(`图片资源未取得：${missingImages} 个`);
    if (missingBackgrounds) result.issues.push(`背景图片未取得：${missingBackgrounds} 个`);
    return {
      html: "<!doctype html>" + doc.documentElement.outerHTML,
      scrollState,
      documentId: snapshotEvent.documentId,
      ...result,
    };
  }, [snapshotEvent, snapshotCursor, archive, view, replayOutcome]);
  useEffect(() => {
    const bytes =
      screenshot?.payload?.assetId &&
      archive?.files[`screenshots/${screenshot.payload.assetId}.jpg`];
    if (!bytes) {
      setImageUrl("");
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [screenshot, archive]);
  useEffect(() => {
    if (!playing) return;
    const delta =
      index >= 0 && index < events.length - 1
        ? events[index + 1].time - events[index].time
        : 800;
    const timer = setTimeout(
      () => {
        if (index < events.length - 1) setSelected(events[index + 1]);
        else setPlaying(false);
      },
      Math.max(80, Math.min(3000, Math.max(0, delta) / speed)),
    );
    return () => clearTimeout(timer);
  }, [playing, index, events, speed]);
  async function load(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    setError("");
    setPlaying(false);
    setLoading(0);
    try {
      const result = await readArchive(file, (current, total) =>
        setLoading(Math.round((current / total) * 100)),
      );
      setArchive(result);
      setReplayFrom(null);
      setSelected(result.events[0] || null);
      setFilter("all");
      setSearch("");
      setView("timeline");
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(null);
      event.target.value = "";
    }
  }
  function showEvent(id) {
    const found = archive.events.find((e) => e.id === id);
    if (found) {
      setFilter("all");
      setSearch("");
      setSelected(found);
      setView("timeline");
    }
  }
  async function downloadCatalog() {
    const data = {
      source: archive.manifest.session.id,
      note: "仅包含实际观察到的页面和接口样本，不代表完整站点或完整接口契约。",
      ...catalog,
    };
    try {
      await downloadBlob(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
        "页面与接口清单.json",
      );
    } catch (e) {
      setError(e.message);
    }
  }
  async function downloadOpenApi() {
    try {
      const documents = buildOpenApi(catalog),
        files = {};
      for (let i = 0; i < documents.length; i++)
        files[`api-${String(i + 1).padStart(3, "0")}.openapi.json`] = strToU8(
          JSON.stringify(documents[i].document, null, 2),
        );
      files["index.json"] = strToU8(
        JSON.stringify(
          documents.map((item, index) => ({
            origin: item.origin,
            file: `api-${String(index + 1).padStart(3, "0")}.openapi.json`,
          })),
          null,
          2,
        ),
      );
      await downloadBlob(
        new Blob([zipSync(files)], { type: "application/zip" }),
        "接口规范草稿.zip",
      );
    } catch (e) {
      setError(e.message);
    }
  }
  return (
    <main className="viewer">
      <header className="viewer-top">
        <div className="viewer-title">
          <button className="icon" title="返回录制" onClick={onBack}>
            <ArrowLeft size={18} />
          </button>
          <div>
            <strong>记录查看</strong>
            <small>逻辑记录</small>
          </div>
        </div>
        <label className="open-button">
          <Upload size={16} /> 导入
          <input type="file" accept=".zip,application/zip" onChange={load} />
        </label>
      </header>
      {error && (
        <div className="viewer-error">
          <AlertTriangle size={16} /> {error}
        </div>
      )}
      {loading !== null && (
        <div className="viewer-progress">正在读取记录包 · {loading}%</div>
      )}
      {!archive ? (
        <div className="viewer-empty">
          <div className="empty-symbol">
            <FileJson size={28} />
          </div>
          <h1>打开一份录制记录</h1>
          <p>选择从逻辑记录导出的 ZIP 文件。</p>
          <label className="open-button">
            <Upload size={16} /> 选择记录包
            <input type="file" accept=".zip,application/zip" onChange={load} />
          </label>
        </div>
      ) : (
        <>
          <div className="viewer-summary">
            <div>
              <div className="section-label">录制档案</div>
              <h1>{archive.manifest.session.title}</h1>
              <p>
                {archive.manifest.session.origin} ·{" "}
                {new Date(archive.manifest.session.startedAt).toLocaleString()}
              </p>
            </div>
            <div className="summary-count">
              <strong>{archive.events.length}</strong>
              <span>条记录</span>
            </div>
          </div>
          <div className="view-tabs">
            <button
              className={view === "timeline" ? "active" : ""}
              onClick={() => setView("timeline")}
            >
              时间线
            </button>
            <button
              className={view === "replay" ? "active" : ""}
              onClick={() => {
                setPlaying(false);
                setReplayFrom(null);
                setView("replay");
              }}
            >
              复现
            </button>
            <button
              className={view === "pages" ? "active" : ""}
              onClick={() => setView("pages")}
            >
              页面 <span>{catalog.pages.length}</span>
            </button>
            <button
              className={view === "flows" ? "active" : ""}
              onClick={() => setView("flows")}
            >
              流程 <span>{catalog.flows.length}</span>
            </button>
            <button
              className={view === "apis" ? "active" : ""}
              onClick={() => setView("apis")}
            >
              接口 <span>{catalog.endpoints.length}</span>
            </button>
            <button
              className={view === "report" ? "active" : ""}
              onClick={() => setView("report")}
            >
              报告
            </button>
            <button className="catalog-export" onClick={downloadCatalog}>
              导出
            </button>
          </div>
          {view === "replay" ? (
            <Replay
              key={replayFrom === null ? "all" : `event:${replayFrom}`}
              archive={archive}
              showEvent={showEvent}
              startEventId={replayFrom}
              onStepChange={onReplayChange}
              snapshot={snapshot}
              snapshotForId={selected?.id}
              snapshotIsOutcome={replayOutcome}
              outcomeLabel={snapshotCursor?.label}
            />
          ) : view === "report" ? (
            <Report archive={archive} showEvent={showEvent} />
          ) : view !== "timeline" ? (
            <section className="catalog">
              <h2>
                {view === "pages"
                  ? "已记录的页面"
                  : view === "flows"
                    ? "操作流程"
                    : "已观察到的接口"}
              </h2>
              <p>
                {view === "flows"
                  ? "按标签页、页面实例和时间整理；候选请求不代表已确认的业务因果关系。"
                  : "仅包含本次录制中实际采集到的内容。"}
              </p>
              {view === "apis" && (
                <button
                  className="catalog-download"
                  disabled={!catalog.endpoints.length}
                  onClick={downloadOpenApi}
                >
                  <Download size={15} /> 导出接口规范草稿
                </button>
              )}
              {view === "pages"
                ? catalog.pages.map((page) => (
                    <button
                      className="catalog-row"
                      key={page.id}
                      onClick={() => showEvent(page.snapshots[0])}
                    >
                      <span>
                        <strong>{page.title || page.url}</strong>
                        <small>{page.url}</small>
                      </span>
                      <span>
                        {page.snapshots.length} 个快照{" "}
                        <ChevronRight size={15} />
                      </span>
                    </button>
                  ))
                : view === "flows"
                  ? catalog.flows.map((flow) => (
                      <div key={flow.id} className="flow">
                        <strong>{flow.url}</strong>
                        <small className="flow-context">
                          {flow.tabId != null ? `标签页 ${flow.tabId} · ` : ""}
                          {flow.frameId === 0
                            ? "主页面"
                            : flow.frameId != null
                              ? `嵌入页面 ${flow.frameId}`
                              : "页面未知"}
                          {flow.steps[0]?.time != null
                            ? ` · ${new Date(flow.steps[0].time).toLocaleString()}`
                            : ""}
                        </small>
                        {flow.steps.map((step) => (
                          <div key={step.eventId}>
                          <button
                            className="catalog-row"
                            onClick={() => showEvent(step.eventId)}
                          >
                            <span>
                              <strong>
                                {labels[step.kind] || step.kind}{" "}
                                {step.target?.text ||
                                  step.target?.name ||
                                  step.target?.tag ||
                                  ""}
                              </strong>
                              <small>
                                {new Date(step.time).toLocaleTimeString()}
                                {step.candidateRequests.length
                                  ? ` · ${step.candidateRequests.length} 个可能相关请求`
                                  : ""}
                              </small>
                            </span>
                            <ChevronRight size={15} />
                          </button>
                          {step.candidateRequests.map((request) => (
                            <button key={request.eventId} className="catalog-row flow-request" onClick={() => showEvent(request.eventId)}>
                              <span><strong>{request.method || "请求"} {request.url}</strong><small>{request.source === "main" ? "主页面" : "页面来源未确认"} · {request.delay} ms 后 · 仅按时间推测</small></span>
                              <ChevronRight size={15} />
                            </button>
                          ))}
                          </div>
                        ))}
                      </div>
                    ))
                  : catalog.endpoints.map((api) => (
                      <button
                        className="catalog-row"
                        key={api.method + api.path}
                        onClick={() => showEvent(api.samples[0].requestEventId)}
                      >
                        <span>
                          <strong>
                            <b>{api.method}</b> {api.path}
                          </strong>
                          <small>{api.count} 次请求 · 点击查看原始记录</small>
                        </span>
                        <ChevronRight size={15} />
                      </button>
                    ))}
              {(view === "pages"
                ? !catalog.pages.length
                : view === "flows"
                  ? !catalog.flows.length
                  : !catalog.endpoints.length) && (
                <div className="empty">没有可用记录</div>
              )}
            </section>
          ) : (
            <div className="workspace">
              <aside className="timeline">
                <div className="timeline-head">
                  <div className="section-heading">
                    <h2>时间线</h2>
                    <div className="play-controls">
                      <button
                        className="icon"
                        title="上一条"
                        disabled={index <= 0}
                        onClick={() => {
                          setPlaying(false);
                          setSelected(events[index - 1]);
                        }}
                      >
                        <SkipBack size={16} />
                      </button>
                      <button
                        className="icon"
                        title={playing ? "暂停" : "播放"}
                        onClick={() => {
                          if (index < 0 && events[0]) setSelected(events[0]);
                          setPlaying(!playing);
                        }}
                      >
                        {playing ? <Pause size={17} /> : <Play size={17} />}
                      </button>
                      <button
                        className="icon"
                        title="下一条"
                        disabled={index < 0 || index >= events.length - 1}
                        onClick={() => {
                          setPlaying(false);
                          setSelected(events[index + 1]);
                        }}
                      >
                        <SkipForward size={16} />
                      </button>
                      <select
                        aria-label="播放速度"
                        value={speed}
                        onChange={(e) => setSpeed(Number(e.target.value))}
                      >
                        <option value="0.5">0.5×</option>
                        <option value="1">1×</option>
                        <option value="2">2×</option>
                        <option value="4">4×</option>
                      </select>
                    </div>
                  </div>
                  <label className="search">
                    <Search size={15} />
                    <input
                      placeholder="搜索记录"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setTimelinePage(0);
                      }}
                    />
                  </label>
                  <select
                    value={filter}
                    onChange={(e) => {
                      setFilter(e.target.value);
                      setTimelinePage(0);
                      setPlaying(false);
                    }}
                  >
                    <option value="all">全部记录</option>
                    <option value="interaction.">用户操作</option>
                    <option value="page.">页面状态</option>
                    <option value="network.">网络请求</option>
                    <option value="screenshot">截图</option>
                    <option value="warning">采集提示</option>
                  </select>
                </div>
                <div className="timeline-list">
                  {events
                    .slice(timelinePage * 100, (timelinePage + 1) * 100)
                    .map((e) => (
                      <button
                        key={e.id}
                        className={
                          "timeline-item " +
                          (selected?.id === e.id ? "selected" : "")
                        }
                        onClick={() => {
                          setPlaying(false);
                          setSelected(e);
                        }}
                      >
                        <span className="dot" />
                        <span>
                          <strong>{title(e)}</strong>
                          <small>
                            {new Date(e.time).toLocaleTimeString()} ·{" "}
                            {e.payload?.target?.text ||
                              e.payload?.method ||
                              e.payload?.reason ||
                              ""}
                          </small>
                        </span>
                        <ChevronRight size={14} />
                      </button>
                    ))}
                  {events.length === 0 && (
                    <div className="empty">没有匹配的记录</div>
                  )}
                </div>
                {totalPages > 1 && (
                  <div className="timeline-pager">
                    <button
                      className="icon"
                      title="上一页"
                      disabled={timelinePage === 0}
                      onClick={() => {
                        setPlaying(false);
                        setTimelinePage(timelinePage - 1);
                      }}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <span>
                      {timelinePage + 1} / {totalPages}
                    </span>
                    <button
                      className="icon"
                      title="下一页"
                      disabled={timelinePage >= totalPages - 1}
                      onClick={() => {
                        setPlaying(false);
                        setTimelinePage(timelinePage + 1);
                      }}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                )}
              </aside>
              <section className="detail">
                {selected ? (
                  <>
                    <div className="detail-head">
                      <div>
                        <div className="section-label">
                          事件详情 · #{selected.seq}
                        </div>
                        <h2>{title(selected)}</h2>
                        <p>{new Date(selected.time).toLocaleString()}</p>
                      </div>
                      <span className="event-kind">{selected.kind}</span>
                    </div>
                    <div className="detail-content">
                      {replayableKinds.has(selected.kind) &&
                        selected.payload?.target && (
                          <button
                            className="catalog-download"
                            onClick={() => {
                              setPlaying(false);
                              setReplayFrom(selected.id);
                              setView("replay");
                            }}
                          >
                            <Play size={15} /> 从此操作复现
                          </button>
                        )}
                      {requestContext?.step && (
                        <button className="catalog-download" onClick={() => showEvent(requestContext.step.eventId)}>
                          <ChevronLeft size={15} /> 查看可能相关的操作
                        </button>
                      )}
                      <h3>关联截图</h3>
                      {imageUrl ? (
                        <img
                          className="capture"
                          src={imageUrl}
                          alt="录制截图"
                        />
                      ) : (
                        <div className="capture-empty">
                          <ImageIcon size={19} />{" "}
                          {screenshot?.payload?.reason ||
                            "此事件没有可用的截图"}
                        </div>
                      )}
                      {screenshot?.payload?.capturedAt && (
                        <div className="replay-meta">
                          截图时间 {new Date(screenshot.payload.capturedAt).toLocaleString()}
                          {screenshot.payload.status === "shared" ? " · 多个操作共用" : ""}
                          {screenshot.payload.contextChanged ? " · 操作后页面已变化" : ""}
                          {screenshotTiming?.overlap ? " · 截图期间发生操作" : screenshotTiming?.changed ? " · 截图与操作之间有其他操作或页面变化" : ""}
                          {screenshotTiming?.startUnknown ? " · 截图开始时间未记录" : ""}
                        </div>
                      )}
                      {snapshot && (
                        <>
                          <h3>
                            {snapshotEvent.id === selected.id
                              ? "页面快照"
                              : "页面状态"}
                          </h3>
                          {requestContext && selected.frameId == null && (
                            <div className="notice">请求页面实例未确认，页面状态仅供参考</div>
                          )}
                          {snapshot.issues.length > 0 && (
                            <div className="notice error">
                              <AlertTriangle size={16} />
                              <span>{snapshot.issues.join("；")}</span>
                            </div>
                          )}
                          {scrollFailed && (
                            <div className="notice error">滚动位置无法还原</div>
                          )}
                          <iframe
                            key={selected.id}
                            className="snapshot"
                            title="页面快照"
                            sandbox="allow-same-origin"
                            onLoad={(event) => {
                              try {
                                setScrollFailed(
                                  !restoreScrollState(event.currentTarget, snapshot.scrollState),
                                );
                              } catch {
                                setScrollFailed(true);
                              }
                            }}
                            srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">${snapshot.html}`}
                          />
                        </>
                      )}
                      {!snapshot && requestContext && ["embedded", "unknown"].includes(requestContext.request.payload.sourceFrame) && (
                        <div className="replay-meta">请求所属页面快照无法确认</div>
                      )}
                      <h3>记录数据</h3>
                      <pre>
                        {JSON.stringify(
                          selected.payload,
                          (key, value) =>
                            key === "html"
                              ? `[页面快照，${value?.length || 0} 字符]`
                              : value,
                          2,
                        )}
                      </pre>
                      {selected.payload?.requestId && (
                        <>
                          <h3>同一请求</h3>
                          {archive.events
                            .filter(
                              (e) =>
                                e.id !== selected.id &&
                                e.payload?.requestId ===
                                  selected.payload.requestId,
                            )
                            .map((e) => (
                              <button
                                key={e.id}
                                className="catalog-row"
                                onClick={() => setSelected(e)}
                              >
                                <span>
                                  <strong>{title(e)}</strong>
                                  <small>
                                    {new Date(e.time).toLocaleTimeString()}
                                  </small>
                                </span>
                                <ChevronRight size={15} />
                              </button>
                            ))}
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="empty">选择一条记录查看详情</div>
                )}
              </section>
            </div>
          )}
        </>
      )}
    </main>
  );
}
