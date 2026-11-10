import React, { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  MousePointer2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { assessScreenshotTiming, canPlaceScreenshotTarget, findStepScreenshots } from "./screenshots.js";
import { attachPageReplay } from "./page-replay.js";
import { restoreScrollState } from "./scroll-state.js";
import { restoreDialogState, restorePopoverState } from "./popover-state.js";
import { MAX_INPUT_LENGTH } from "./capture-limits.js";
import { normalizeNumericConstraint } from "./numeric-constraints.js";

const names = {
  "interaction.click": "点击",
  "interaction.input": "输入",
  "interaction.change": "更改",
  "interaction.submit": "提交",
};
export const replayableKinds = new Set(Object.keys(names));
function sameTarget(previous, current) {
  const target = current.payload?.target;
  const selector = target?.selector;
  const path = target?.shadowPath;
  const sameElement =
    typeof selector === "string" && selector.length > 0
      ? previous.payload?.target?.selector === selector
      : Array.isArray(path) && path.length > 0 &&
        JSON.stringify(previous.payload?.target?.shadowPath) === JSON.stringify(path);
  return (
    sameElement &&
    previous.tabId === current.tabId &&
    previous.frameId === current.frameId &&
    (!target?.nodeId || !previous.payload?.target?.nodeId ||
      target.nodeId === previous.payload.target.nodeId) &&
    (!previous.documentId ||
      !current.documentId ||
      previous.documentId === current.documentId) &&
    previous.payload?.url === current.payload?.url
  );
}
function replayControl(step) {
  if (step?.kind !== "interaction.change" || step.payload?.target?.sensitive)
    return null;
  const target = step.payload.target,
    state = step.payload.formState;
  const type = String(target?.type || "").toLowerCase();
  if (
    target?.tag === "input" &&
    typeof state?.checked === "boolean" &&
    (type === "checkbox" || (type === "radio" && state.checked))
  )
    return { kind: type, checked: state.checked };
  if (
    target?.tag === "select" &&
    !state?.truncated &&
    !state?.optionsTruncated &&
    Array.isArray(state?.options) &&
    state.options.length <= 200 &&
    state.options.every((item) => typeof item?.label === "string") &&
    Array.isArray(state.selectedIndices) &&
    state.selectedIndices.every(
      (index) =>
        Number.isInteger(index) && index >= 0 && index < state.options.length,
    )
  )
    return {
      kind: "select",
      multiple: !!state.multiple,
      options: state.options,
      selected: state.selectedIndices,
    };
  return null;
}
function sameOptions(first, second) {
  return Array.isArray(first) && Array.isArray(second) && first.length === second.length &&
    first.every((item, index) => !item?.uncertain && !second[index]?.uncertain &&
      item?.id === second[index]?.id && item?.label === second[index]?.label &&
      !!item?.disabled === !!second[index]?.disabled && item?.value === second[index]?.value);
}
export default function Replay({ archive, showEvent, startEventId, onStepChange, snapshot, snapshotForId, snapshotIsOutcome, outcomeLabel }) {
  const steps = useMemo(
    () =>
      archive.events
        .filter((event) => names[event.kind] && event.payload?.target)
        .sort((a, b) => a.time - b.time || a.seq - b.seq),
    [archive],
  );
  const [index, setIndex] = useState(() =>
      Math.max(
        0,
        steps.findIndex((event) => event.id === startEventId),
      ),
    ),
    [image, setImage] = useState(null),
    [shotChoice, setShotChoice] = useState("before"),
    [zoom, setZoom] = useState(1),
    [inputValue, setInputValue] = useState(""),
    [checked, setChecked] = useState(false),
    [selection, setSelection] = useState([]),
    [display, setDisplay] = useState("screenshot"),
    [pageProblem, setPageProblem] = useState(null),
    [completed, setCompleted] = useState(false);
  const step = steps[index];
  useEffect(() => { if (step) onStepChange(step, completed); }, [step, completed, onStepChange]);
  useLayoutEffect(() => setPageProblem(null), [step, snapshot?.html]);
  useLayoutEffect(() => setCompleted(false), [step]);
  const control = replayControl(step);
  useLayoutEffect(() => setShotChoice("before"), [step]);
  const choiceInitial = useMemo(() => {
    const current = replayControl(step);
    if (!current) return { checked: false, selected: [], status: null };
    const before = step.payload.beforeFormState;
    if (current.kind !== "select" && typeof before?.checked === "boolean")
      return { checked: before.checked, selected: [], status: null };
    if (current.kind === "select" && before && !before.truncated && !before.optionsTruncated &&
        !!before.multiple === current.multiple && Array.isArray(before.options) &&
        before.options.every((item) => typeof item?.id === "string" && item.id.length <= 128) &&
        sameOptions(before.options, current.options) &&
        Array.isArray(before.selectedIndices) && before.selectedIndices.length <= 200 &&
        before.selectedIndices.every((item) => Number.isInteger(item) && item >= 0 && item < current.options.length))
      return { checked: false, selected: before.selectedIndices, status: null };
    const previous = steps
      .slice(0, index)
      .reverse()
      .find(
        (item) =>
          item.kind === "interaction.change" &&
          sameTarget(item, step),
      );
    const previousControl = replayControl(previous);
    if (current.kind === "select" && previousControl?.kind === "select" &&
        previousControl.multiple === current.multiple && sameOptions(previousControl.options, current.options))
      return { checked: false, selected: previousControl.selected, status: "显示最近一次记录的选择，操作前状态未确认" };
    if (current.kind !== "select" && previousControl?.kind === current.kind)
      return { checked: previousControl.checked, selected: [], status: "显示最近一次记录的选择，操作前状态未确认" };
    return { checked: current.kind === "select" ? false : !current.checked, selected: [], status: "操作前选择状态未取得" };
  }, [step, index, steps]);
  useLayoutEffect(() => {
    setSelection(choiceInitial.selected);
    setChecked(choiceInitial.checked);
  }, [choiceInitial]);
  const inputBefore = useMemo(() => {
    if (!step || step.kind !== "interaction.input") return { value: "", status: null };
    if (typeof step.payload.beforeValue === "string" && step.payload.beforeValue.length <= MAX_INPUT_LENGTH && step.payload.beforeValue !== "[已隐藏]") {
      const statuses = new Map([
        ["redacted", "操作前输入值已脱敏"],
        ["truncated", "操作前输入值过长，已截断"],
        ["redacted_truncated", "操作前输入值已脱敏且截断"],
      ]);
      const status = statuses.get(step.payload.beforeValueStatus) || null;
      return { value: step.payload.beforeValue, status };
    }
    const previous = steps
      .slice(0, index)
      .reverse()
      .find(
        (item) =>
          item.kind === "interaction.input" &&
          sameTarget(item, step),
      );
    const value = previous?.payload.value;
    return typeof value === "string" && value.length <= MAX_INPUT_LENGTH && value !== "[已隐藏]"
      ? { value, status: "显示最近一次记录值，操作前状态未确认" }
      : { value: "", status: "操作前输入值未取得" };
  }, [step, index, steps]);
  useLayoutEffect(() => setInputValue(inputBefore.value), [inputBefore]);
  const shots = useMemo(
    () => findStepScreenshots(archive.events, step),
    [archive, step],
  );
  useEffect(() => { if (completed && shots.after?.payload?.assetId) setShotChoice("after"); }, [completed, shots.after]);
  const selectedChoice = shotChoice === "after" && shots.after
    ? "after"
    : shots.before
      ? "before"
      : shots.after
        ? "after"
        : null;
  const shot = selectedChoice ? shots[selectedChoice] : null;
  const timing = useMemo(() => assessScreenshotTiming(archive.events, step, shot), [archive, step, shot]);
  useEffect(() => {
    const bytes =
      shot?.payload?.assetId &&
      archive.files[`screenshots/${shot.payload.assetId}.jpg`];
    if (!bytes) {
      setImage(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
    setImage({ assetId: shot.payload.assetId, url });
    return () => URL.revokeObjectURL(url);
  }, [archive, shot]);
  if (!step)
    return (
      <section className="catalog">
        <h2>逐步复现</h2>
        <div className="empty">没有可复现的操作</div>
      </section>
    );
  const target = step.payload.target,
    rect = target.rect,
    viewport = shot?.payload.viewport,
    imageUrl = image && image.assetId === shot?.payload?.assetId ? image.url : "";
  const recordedValue =
    control?.kind === "select"
      ? control.selected
          .map(
            (optionIndex) =>
              control.options[optionIndex]?.label || `选项 ${optionIndex + 1}`,
          )
          .join("、") || "未选择"
      : control
        ? control.checked
          ? "已选中"
          : "未选中"
        : step.payload.value;
  const canHighlight =
    !completed &&
    imageUrl &&
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    viewport?.width &&
    viewport?.height &&
    canPlaceScreenshotTarget(step, shot, timing);
  const targetType = typeof target.type === "string" ? target.type.toLowerCase() : "";
  const canType =
    step.kind === "interaction.input" &&
    typeof step.payload.value === "string" &&
    step.payload.value !== "[已隐藏]" &&
    !target.sensitive &&
    (target.type == null || typeof target.type === "string") &&
    (["input", "textarea"].includes(target.tag) || target.editable) &&
    ![
      "file",
      "password",
      "checkbox",
      "radio",
      "button",
      "submit",
      "reset",
      "image",
      "hidden",
    ].includes(targetType);
  const InputControl = target.tag === "textarea" || target.editable ? "textarea" : "input";
  const numeric = target.numericConstraints;
  const numericType = ["range", "number"].includes(targetType) && numeric && typeof numeric === "object" && !Array.isArray(numeric);
  const inputType = numericType ? targetType : targetType === "color" && typeof step.payload.value === "string" && /^#[0-9a-f]{6}$/i.test(step.payload.value) ? "color" : "text";
  const numericProp = (name) => normalizeNumericConstraint(name, numeric?.[name]) ?? undefined;
  const inputProps = InputControl === "input" ? {
    type: inputType,
    ...(numericType ? { min: numericProp("min"), max: numericProp("max"), step: numericProp("step") } : {}),
  } : {};
  const displayedInput = inputType === "color" && !/^#[0-9a-f]{6}$/i.test(inputValue) ? "#000000" : inputValue;
  const next = () => {
    if (index >= steps.length - 1) setCompleted(true);
    else setIndex((value) => Math.min(steps.length - 1, value + 1));
  };
  const updateInputValue = (value) => {
    setInputValue(value);
    if (value === step.payload.value) next();
  };
  const updateChoiceValue = (value) => {
    setChecked(value);
    if (value === control.checked) next();
  };
  const updateSelectionValues = (values) => {
    setSelection(values);
    if (
      values.length === control.selected.length &&
      values.every((value) => control.selected.includes(value))
    )
      next();
  };
  const pageReady = snapshotForId === step.id && snapshotIsOutcome === completed && !!snapshot?.html;
  const fallbackControls = !completed && (display !== "page" || !pageReady || !!pageProblem);
  const position = canHighlight
    ? {
        left: `${(rect.x / viewport.width) * 100}%`,
        top: `${(rect.y / viewport.height) * 100}%`,
        width: `${(rect.width / viewport.width) * 100}%`,
        height: `${(rect.height / viewport.height) * 100}%`,
      }
    : undefined;
  return (
    <section className="replay">
      <div className="replay-header">
        <div>
          <div className="section-label">
            步骤 {index + 1} / {steps.length}
          </div>
          <h2>
            {names[step.kind]}{" "}
            {target.text || target.name || target.tag || "页面"}
          </h2>
          <p>
            {new Date(step.time).toLocaleTimeString()} · {step.payload.url}
          </p>
        </div>
      </div>
      {completed && <div className="notice" role="status">已到达记录末尾</div>}
      <div className="replay-shot-choice" role="group" aria-label="复现视图">
        <button type="button" aria-pressed={display === "screenshot"} onClick={() => setDisplay("screenshot")}>截图</button>
        <button type="button" aria-pressed={display === "page"} onClick={() => setDisplay("page")}>页面</button>
      </div>
      {display === "page" ? (
        pageReady ? (
          <>
            {completed && <div className="replay-meta">{outcomeLabel || "后续记录的页面状态"}</div>}
            {(!step.documentId || !snapshot.documentId) && <div className="notice error">页面实例未确认，快照可能不是本次操作的页面</div>}
            {snapshot.issues?.length > 0 && <div className="notice error">{snapshot.issues.join("；")}</div>}
            {pageProblem && <div className="notice error">{pageProblem}</div>}
            <iframe
              key={`${step.id}:${completed ? "outcome" : "before"}`}
              className="snapshot replay-page"
              title="逐步复现页面"
              sandbox="allow-same-origin"
              srcDoc={`<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; font-src data:; style-src 'unsafe-inline'">${snapshot.html}`}
              onLoad={(event) => {
                const frame = event.currentTarget;
                try {
                  const popoverReady = restorePopoverState(frame);
                  const dialogReady = restoreDialogState(frame);
                  restoreScrollState(frame, snapshot.scrollState);
                  const overlayProblem = !popoverReady ? "部分弹出层状态无法还原" : !dialogReady ? "部分模态对话框状态无法还原" : null;
                  if (completed) { setPageProblem(overlayProblem); return; }
                  const result = attachPageReplay(frame, step, {
                    control, canType, inputBefore, choiceInitial,
                    onInput: updateInputValue, onChoice: updateChoiceValue,
                    onSelection: updateSelectionValues, onNext: next,
                  });
                  setPageProblem(result.ok ? overlayProblem : result.reason);
                } catch { setPageProblem("页面快照无法交互"); }
              }}
            />
          </>
        ) : <div className="capture-empty">{completed ? "未取得最后操作后的页面状态" : "此操作之前没有可用的页面快照"}</div>
      ) : <>
      <div className="replay-shot-choice" role="group" aria-label="截图时间">
        <button type="button" disabled={!shots.before} aria-pressed={selectedChoice === "before"} onClick={() => setShotChoice("before")}>操作前</button>
        <button type="button" disabled={!shots.after} aria-pressed={selectedChoice === "after"} onClick={() => setShotChoice("after")}>操作后</button>
      </div>
      {imageUrl ? (
        <>
          <div className="zoom-controls">
            <button
              className="icon"
              title="缩小截图"
              disabled={zoom <= 1}
              onClick={() => setZoom(Math.max(1, zoom - 0.5))}
            >
              <ZoomOut size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              className="icon"
              title="放大截图"
              disabled={zoom >= 3}
              onClick={() => setZoom(Math.min(3, zoom + 0.5))}
            >
              <ZoomIn size={16} />
            </button>
          </div>
          <div className="replay-scroll">
            <div className="replay-stage" style={{ width: `${zoom * 100}%` }}>
              <img src={imageUrl} alt="该步骤关联的页面截图" />
              {canHighlight &&
                (control ? (
                  <div
                    className="replay-hotspot"
                    aria-hidden="true"
                    style={position}
                  />
                ) : canType ? (
                  <InputControl
                    className="replay-input"
                    aria-label="输入记录值"
                    style={position}
                    {...inputProps}
                    value={displayedInput}
                    onChange={(event) => updateInputValue(event.target.value)}
                  />
                ) : (
                  <button
                    className="replay-hotspot"
                    title="继续到下一步"
                    aria-label="继续到下一步"
                    onClick={next}
                    style={position}
                  />
                ))}
            </div>
          </div>
        </>
      ) : (
        <div className="capture-empty">
          <MousePointer2 size={18} />{" "}
          {shot?.payload?.reason || "此步骤没有可用截图"}
        </div>
      )}
      <div className="replay-meta">
        {shot?.payload?.capturedAt
          ? `截图时间 ${new Date(shot.payload.capturedAt).toLocaleTimeString()} · ${timing?.overlap || timing?.uncertain ? "时间不确定" : timing?.before ? "操作前" : "操作后"}`
          : "截图不可用"}
        {shot?.payload?.status === "shared" ? " · 多个操作共用" : ""}
        {shot?.payload?.contextChanged ? " · 操作后页面已变化" : ""}
        {shot?.payload?.assetId && step.frameId === 0 && (!step.documentId || !shot.payload.documentId) ? " · 截图页面实例未确认" : ""}
        {shot?.payload?.assetId && step.frameId === 0 && step.documentId && shot.payload.documentId && step.documentId !== shot.payload.documentId ? " · 截图与操作的页面实例不一致" : ""}
        {shot?.payload?.assetId && step.frameId === 0 && step.payload?.url && shot.payload.url && step.payload.url !== shot.payload.url ? " · 截图与操作的网址不一致" : ""}
        {timing?.overlap ? " · 截图期间发生操作" : timing?.changed ? " · 截图与操作之间有其他操作或页面变化" : ""}
        {timing?.startUnknown ? " · 截图开始时间未记录" : ""}
        {canHighlight ? " · 操作位置为近似位置" : ""}
      </div>
      {selectedChoice === "before" && !shots.after?.payload?.assetId && (
        <div className="replay-meta">
          {shots.after?.payload?.reason || "操作后截图未取得"}
        </div>
      )}
      </>}
      {recordedValue != null && (
        <div className="replay-value">
          <span>记录值</span>
          <strong>{String(recordedValue)}</strong>
        </div>
      )}
      {["truncated", "redacted_truncated"].includes(step.payload.valueStatus) && (
        <div className="notice error">输入值超过采集上限，仅显示已记录内容</div>
      )}
      {!completed && canType && inputBefore.status && (
        <div className="replay-meta">{inputBefore.status}</div>
      )}
      {!completed && control && choiceInitial.status && (
        <div className="replay-meta">{choiceInitial.status}</div>
      )}
      {canType && !completed && (display === "page" ? fallbackControls : !canHighlight) && (
        <InputControl
          className="replay-fallback-input"
          aria-label="输入记录值"
          {...inputProps}
          value={displayedInput}
          onChange={(event) => updateInputValue(event.target.value)}
        />
      )}
      {control && fallbackControls && control.kind !== "select" && (
        <label className="replay-choice">
          <input
            type={control.kind}
            aria-label="复现勾选"
            checked={checked}
            onChange={(event) => updateChoiceValue(event.target.checked)}
          />
          <span>{target.name || target.text || "选项"}</span>
        </label>
      )}
      {control?.kind === "select" && fallbackControls && (
        <select
          className="replay-select"
          aria-label="复现选择"
          multiple={control.multiple}
          value={
            control.multiple
              ? selection.map(String)
              : selection.length
                ? String(selection[0])
                : ""
          }
          onChange={(event) => updateSelectionValues([...event.target.selectedOptions].map((option) => Number(option.value)))}
        >
          {!control.multiple && (
            <option value="" disabled>
              选择选项
            </option>
          )}
          {control.options.map((option, optionIndex) => (
            <option
              key={optionIndex}
              value={String(optionIndex)}
              disabled={!!option.disabled}
            >
              {option.label || `选项 ${optionIndex + 1}`}
            </option>
          ))}
        </select>
      )}
      <div className="replay-actions">
        <button
          className="replay-step"
          disabled={index === 0}
          onClick={() => { setCompleted(false); setIndex(index - 1); }}
        >
          <ChevronLeft size={16} /> 上一步
        </button>
        <button className="replay-step" onClick={() => showEvent(step.id)}>
          查看证据
        </button>
        <button
          className="replay-step"
          disabled={completed}
          onClick={next}
        >
          {index === steps.length - 1 ? "完成" : "下一步"} <ChevronRight size={16} />
        </button>
      </div>
    </section>
  );
}
