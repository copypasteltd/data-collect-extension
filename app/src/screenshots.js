export function screenshotAssetPath(id, mime) {
  return `screenshots/${id}.${mime === "image/png" ? "png" : "jpg"}`;
}

export function findScreenshotAsset(files, id) {
  if (!files || !id) return null;
  for (const mime of ["image/png", "image/jpeg"]) {
    const bytes = files[screenshotAssetPath(id, mime)];
    if (bytes) return { bytes, mime };
  }
  return null;
}

export function findStepScreenshots(events, step) {
  if (!step) return { before: null, after: null };
  const after = events.find(
    (event) =>
      event.kind === "screenshot" &&
      event.tabId === step.tabId &&
      Array.isArray(event.payload?.eventIds) &&
      event.payload.eventIds.includes(step.id),
  );
  const before =
    step.frameId === 0
      ? events
          .filter((event) => {
            const p = event.payload || {};
            return (
              event.kind === "screenshot" &&
              event.tabId === step.tabId &&
              p.assetId &&
              !p.contextChanged &&
              p.url === step.payload?.url &&
              (!step.documentId ||
                !p.documentId ||
                p.documentId === step.documentId) &&
              Number.isFinite(p.capturedAt) &&
              p.capturedAt < step.time
            );
          })
          .sort((a, b) => b.payload.capturedAt - a.payload.capturedAt)[0]
      : null;
  return { before: before || null, after: after || null };
}

export function assessScreenshotTiming(events, step, shot) {
  const payload = shot?.payload;
  if (
    !payload?.assetId ||
    !Number.isFinite(payload.capturedAt) ||
    !Number.isFinite(step?.time)
  )
    return null;
  const end = payload.capturedAt;
  const start =
    Number.isFinite(payload.captureStartedAt) && payload.captureStartedAt <= end
      ? payload.captureStartedAt
      : null;
  const before = end < step.time;
  const overlap = start != null && start <= step.time && end >= step.time;
  const uncertain = start == null && end >= step.time;
  const from = before ? (start ?? end) : step.time;
  const to = before ? step.time : end;
  const changed =
    step.tabId != null &&
    events.some((event) => {
      if (
        event.id === step.id ||
        event.tabId !== step.tabId ||
        !Number.isFinite(event.time)
      )
        return false;
      if (
        !/^(page\.(mutation|popover|dialog)|interaction\.(click|dblclick|contextmenu|input|change|submit|scroll|pointerdown|keydown)|navigation(?:\..*)?)$/.test(
          event.kind || "",
        )
      )
        return false;
      return (
        (event.time > from && event.time <= to) ||
        (!before && event.time === from && Number(event.seq) > Number(step.seq))
      );
    });
  return { before, overlap, uncertain, changed, startUnknown: start == null };
}

export function canPlaceScreenshotTarget(step, shot, timing) {
  if (
    !step ||
    !shot?.payload?.assetId ||
    step.frameId !== 0 ||
    shot.payload.contextChanged
  )
    return false;
  if (
    step.tabId == null ||
    shot.tabId !== step.tabId ||
    !step.documentId ||
    !shot.payload.documentId ||
    step.documentId !== shot.payload.documentId ||
    !step.payload?.url ||
    step.payload.url !== shot.payload.url
  )
    return false;
  if (
    !timing ||
    timing.overlap ||
    timing.uncertain ||
    timing.changed ||
    (timing.startUnknown && !timing.before)
  )
    return false;
  const eventViewport = step.payload?.viewport;
  const imageViewport = shot.payload.viewport;
  if (
    !eventViewport ||
    !imageViewport ||
    !Number.isFinite(step.time) ||
    !Number.isFinite(shot.payload.capturedAt)
  )
    return false;
  if (Math.abs(shot.payload.capturedAt - step.time) > 2000) return false;
  return ["width", "height", "scrollX", "scrollY"].every(
    (key) =>
      Number.isFinite(eventViewport[key]) &&
      Number.isFinite(imageViewport[key]) &&
      Math.abs(eventViewport[key] - imageViewport[key]) < 1,
  );
}
