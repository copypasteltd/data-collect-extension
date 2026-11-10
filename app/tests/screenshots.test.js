import { it } from "node:test";
import assert from "node:assert/strict";
import {
  assessScreenshotTiming,
  canPlaceScreenshotTarget,
  findStepScreenshots,
} from "../src/screenshots.js";

it("分别关联同一页面的操作前截图和当前操作的截图结果", () => {
  const step = {
    id: "action",
    time: 5000,
    tabId: 1,
    frameId: 0,
    documentId: "doc",
    payload: { url: "https://example.test/" },
  };
  const shot = (id, capturedAt, doc, tabId = 1) => ({
    id,
    kind: "screenshot",
    tabId,
    payload: {
      assetId: id,
      capturedAt,
      documentId: doc,
      url: step.payload.url,
    },
  });
  const old = shot("old", 4000, "doc");
  const otherDocument = shot("other-doc", 4900, "other");
  const otherTab = shot("other-tab", 4950, "doc", 2);
  const unavailable = {
    kind: "screenshot",
    tabId: 1,
    payload: {
      eventIds: ["action"],
      status: "unavailable",
      reason: "页面已关闭",
    },
  };
  const result = findStepScreenshots(
    [old, otherDocument, otherTab, unavailable],
    step,
  );
  assert.equal(result.before.id, "old");
  assert.equal(result.after.payload.reason, "页面已关闭");
  assert.equal(
    findStepScreenshots([old], { ...step, frameId: 3 }).before,
    null,
  );
  const sameMillisecond = {
    ...shot("same-time", step.time, "doc"),
    payload: {
      ...shot("same-time", step.time, "doc").payload,
      eventIds: ["action"],
    },
  };
  const simultaneous = findStepScreenshots([sameMillisecond], step);
  assert.equal(simultaneous.before, null);
  assert.equal(simultaneous.after.id, "same-time");
});

it("截图与操作之间发生变化时不标示近似位置", () => {
  const viewport = { width: 1000, height: 700, scrollX: 0, scrollY: 0 };
  const step = {
    id: "step",
    seq: 10,
    time: 5000,
    tabId: 1,
    frameId: 0,
    documentId: "doc",
    payload: { viewport, url: "https://example.test/" },
  };
  const shot = {
    tabId: 1,
    payload: {
      assetId: "image",
      documentId: "doc",
      url: "https://example.test/",
      captureStartedAt: 5100,
      capturedAt: 5150,
      viewport,
    },
  };
  const otherTab = {
    id: "other-tab",
    kind: "interaction.click",
    tabId: 2,
    time: 5050,
    seq: 11,
  };
  const sameTab = {
    id: "other-click",
    kind: "interaction.click",
    tabId: 1,
    time: 5050,
    seq: 12,
  };
  const mutation = {
    id: "mutation",
    kind: "page.mutation",
    tabId: 1,
    time: 5050,
    seq: 13,
  };
  const stable = assessScreenshotTiming([otherTab], step, shot);
  assert.equal(stable.changed, false);
  assert.equal(canPlaceScreenshotTarget(step, shot, stable), true);
  for (const event of [sameTab, mutation, { ...mutation, kind: "page.popover" }, { ...mutation, kind: "page.dialog" }]) {
    const timing = assessScreenshotTiming([event], step, shot);
    assert.equal(timing.changed, true);
    assert.equal(canPlaceScreenshotTarget(step, shot, timing), false);
  }
  const overlapShot = {
    payload: { ...shot.payload, captureStartedAt: 4990, capturedAt: 5010 },
  };
  const overlap = assessScreenshotTiming([], step, overlapShot);
  assert.equal(overlap.overlap, true);
  assert.equal(canPlaceScreenshotTarget(step, overlapShot, overlap), false);
  const beforeShot = {
    payload: { ...shot.payload, captureStartedAt: 4800, capturedAt: 4850 },
  };
  assert.equal(
    assessScreenshotTiming([{ ...sameTab, time: 4900 }], step, beforeShot)
      .changed,
    true,
  );
  assert.equal(
    assessScreenshotTiming([{ ...sameTab, time: 5125 }], step, shot).changed,
    true,
  );
  assert.equal(
    assessScreenshotTiming([{ ...sameTab, time: 4825 }], step, beforeShot)
      .changed,
    true,
  );
  assert.equal(
    assessScreenshotTiming([], step, {
      payload: { ...shot.payload, captureStartedAt: undefined },
    }).startUnknown,
    true,
  );
  assert.equal(
    assessScreenshotTiming([], step, {
      payload: { ...shot.payload, captureStartedAt: undefined },
    }).uncertain,
    true,
  );
  const sameTime = assessScreenshotTiming([], step, {
    payload: { ...shot.payload, captureStartedAt: undefined, capturedAt: 5000 },
  });
  assert.equal(sameTime.uncertain, true);
  assert.equal(sameTime.before, false);
});

it("只在视口一致、时间接近且页面未变化时标示操作位置", () => {
  const viewport = { width: 1000, height: 700, scrollX: 0, scrollY: 50 };
  const step = {
    id: "step",
    time: 5000,
    tabId: 1,
    frameId: 0,
    documentId: "doc",
    payload: { viewport, url: "https://example.test/" },
  };
  const shot = {
    tabId: 1,
    payload: {
      assetId: "image",
      documentId: "doc",
      url: "https://example.test/",
      captureStartedAt: 5050,
      capturedAt: 5100,
      viewport,
    },
  };
  const timing = assessScreenshotTiming([], step, shot);
  assert.equal(canPlaceScreenshotTarget(step, shot, timing), true);
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      {
        ...shot,
        payload: { ...shot.payload, viewport: { ...viewport, scrollY: 100 } },
      },
      timing,
    ),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      { ...shot, payload: { ...shot.payload, capturedAt: 8000 } },
      timing,
    ),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      { ...shot, payload: { ...shot.payload, contextChanged: true } },
      timing,
    ),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget({ ...step, payload: {} }, shot, timing),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget({ ...step, frameId: 2 }, shot, timing),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget({ ...step, documentId: undefined }, shot, timing),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      { ...shot, payload: { ...shot.payload, documentId: undefined } },
      timing,
    ),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      { ...shot, payload: { ...shot.payload, documentId: "other" } },
      timing,
    ),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      {
        ...shot,
        payload: { ...shot.payload, url: "https://example.test/other" },
      },
      timing,
    ),
    false,
  );
  assert.equal(
    canPlaceScreenshotTarget(step, { ...shot, tabId: 2 }, timing),
    false,
  );
  const unknownStart = {
    ...shot,
    payload: { ...shot.payload, captureStartedAt: undefined },
  };
  assert.equal(
    canPlaceScreenshotTarget(
      step,
      unknownStart,
      assessScreenshotTiming([], step, unknownStart),
    ),
    false,
  );
});
