export function* directRelationships(event, evidence) {
  const payload = event.payload || {}, source = { eventId: event.id, ...evidence };
  const edge = (relation, targetType, targetId) => ({ source, relation, targetType, targetId, confidence: "recorded" });
  if (event.kind === "screenshot" && Array.isArray(payload.eventIds))
    for (const id of payload.eventIds) if (typeof id === "string") yield edge("screenshot_of", "event", id);
  if (event.kind === "screenshot.fullPage" && typeof payload.snapshotEventId === "string")
    yield edge("screenshot_of", "event", payload.snapshotEventId);
  if (event.kind === "network.request" && typeof payload.redirectFrom === "string")
    yield edge("redirected_from", "request", payload.redirectFrom);
  if (typeof payload.requestId === "string") yield edge("request", "request", payload.requestId);
  if (typeof payload.protocolRequestKey === "string") yield edge("protocol_request", "protocol-request", payload.protocolRequestKey);
  if (typeof payload.interactionCaptureId === "string") yield edge("interaction_capture", "interaction-capture", payload.interactionCaptureId);
  if (typeof payload.catalogId === "string") {
    if (event.kind.startsWith("cache.") && event.kind !== "cache.catalog")
      yield edge("cache_catalog", "cache-catalog", payload.catalogId);
    if (event.kind.startsWith("database.") && event.kind !== "database.catalog")
      yield edge("database_catalog", "database-catalog", payload.catalogId);
  }
  if (typeof payload.assetId === "string") yield edge("asset", "asset", payload.assetId);
  if (typeof payload.body?.assetId === "string" && payload.body.assetId !== payload.assetId)
    yield edge("body_asset", "asset", payload.body.assetId);
  if (event.kind === "network.requestDataEntries" && Array.isArray(payload.entries))
    for (const entry of payload.entries) if (typeof entry.assetId === "string") yield edge("request_entry_asset", "asset", entry.assetId);
  if (typeof payload.snapshotId === "string" && event.kind !== "page.snapshot")
    yield edge("snapshot", "snapshot", payload.snapshotId);
  if (typeof payload.graphCaptureId === "string" && event.kind === "database.record")
    yield edge("database_capture", "database-capture", payload.graphCaptureId);
  if (event.kind === "frame.tree" && Array.isArray(payload.frames)) {
    for (const frame of payload.frames) {
      if (!Number.isInteger(frame.frameId) || !Number.isInteger(frame.parentFrameId) || frame.parentFrameId < 0) continue;
      yield { source, relation: "frame_parent", targetType: "frame", confidence: "recorded",
        tabId: event.tabId, frameId: frame.frameId, documentId: frame.documentId,
        parentFrameId: frame.parentFrameId, parentDocumentId: frame.parentDocumentId };
    }
  }
}
