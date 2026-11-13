import { it } from "node:test";
import assert from "node:assert/strict";
import { canStartRecording, canStopRecording, canExportRecording, recordingNotice, batchStatusLabel, exportPhaseLabel } from "../src/panel-state.js";

it("活动录制不新开历史导出，独立导出状态不拥有停止入口", () => {
  const active = { id: "new", status: "recording" };
  assert.equal(canExportRecording(active, "old", null, null), false);
  assert.equal(canStopRecording(active, null), true);
  // Another panel may start while this panel already has an export in flight.
  // The Stop projection deliberately has no export-operation dependency.
  const exportOperation = { id: "old" };
  assert.equal(canStopRecording(active, null), true);
  assert.equal(canStartRecording(null, null, exportOperation), false);
  assert.equal(canExportRecording(null, "old", null, exportOperation), false);
  assert.equal(canExportRecording(null, "old", null, null), true);
});

it("准备期间可停止，控制收尾期间不重复停止", () => {
  for (const status of ["preparing", "recording"]) {
    assert.equal(canStopRecording({ status }, { type: "starting" }), true);
    assert.equal(canStopRecording({ status }, { type: "stopping" }), false);
  }
  assert.equal(canStopRecording({ status: "stopping" }, null), false);
  assert.equal(canStopRecording(null, null), false);
  assert.equal(canStartRecording(null, null, null), true);
  assert.equal(canStartRecording(null, { type: "starting" }, null), false);
  assert.equal(canExportRecording(null, "", null, null), false);
});

it("状态与说明不暴露录制内容，不将unknown写成确定丢失", () => {
  const sensitive = { status: "recording", title: "private-title", notice: "https://secret.test/?token=private-token", hasNotice: true };
  const notice = recordingNotice(sensitive);
  assert.match(notice, /限制或异常/);
  assert.doesNotMatch(notice, /private|secret|token|https:/);
  assert.equal(recordingNotice(null), "");
  assert.match(recordingNotice({ communicationUnknown: true }), /未确认不等于确定丢失/);
  assert.match(recordingNotice({ storageError: true }), /本地保存出现异常/);
  // A sticky producer fact is meaningful on its own, even after late ACKs
  // reconcile the transport counters and without a synthesized incomplete flag.
  for (const key of ["captureIncomplete", "needsVerification"]) {
    const activeState = { [key]: true, failedEvents: 0, unknownEvents: 0 };
    assert.match(recordingNotice(activeState), /核验/);
    assert.equal(batchStatusLabel({ status: "ready", ...activeState }), "已停止，需核验");
  }
  assert.equal(batchStatusLabel({ status: "ready", coverage: { responseGaps: 1 } }), "已停止，需核验");
  assert.equal(batchStatusLabel({ status: "ready", coverage: { version: 1, responseGaps: 0, eventCount: 10, lastSeq: 20 } }), "已停止，可导出");
  assert.equal(batchStatusLabel({ status: "ready", coverage: { status: "unavailable" } }), "已停止，需核验");
  assert.equal(batchStatusLabel({ status: "interrupted" }), "录制中断");
});

it("导出阶段只显示操作状态而不显示采集计数或内容", () => {
  for (const phase of ["checking", "events", "assets", "download", "unknown"]) {
    assert.equal(typeof exportPhaseLabel(phase), "string");
    assert.doesNotMatch(exportPhaseLabel(phase), /[0-9]|https:/);
  }
  assert.match(exportPhaseLabel("download"), /下载确认/);
});
