import { compareEvents } from "./event-order.js";

function sameFrame(event, step) {
  if (event.tabId !== step.tabId) return false;
  if (event.frameId === step.frameId) return true;
  return step.frameId === 0 && event.frameId == null &&
    ["navigation", "navigation.spa"].includes(event.kind);
}

export function findReplayOutcome(events, step) {
  if (!step || step.tabId == null || step.frameId == null) return null;
  const afterStep = events.filter((event) => compareEvents(event, step) > 0).sort(compareEvents);
  const lastActivation = afterStep.filter((event) => event.kind === "tab.activated" && event.payload?.tabId != null).at(-1);
  const otherTabId = lastActivation?.payload.tabId !== step.tabId ? lastActivation?.payload.tabId : null;
  const childTab = otherTabId != null && afterStep.find((event) => event.kind === "tab.created" &&
    event.payload?.openerTabId === step.tabId && event.payload?.tabId === otherTabId &&
    event.time >= step.time && event.time - step.time <= 1000 && compareEvents(event, lastActivation) <= 0);
  const isNavigation = (event) => /^(navigation|navigation\.spa|navigation\.committed|navigation\.hash|navigation\.popstate|navigation\.out_of_scope)$/.test(event.kind || "");
  const outcomeTabId = otherTabId ?? step.tabId;
  const tabClosed = afterStep.some((event) => event.kind === "tab.closed" &&
    event.payload?.tabId === outcomeTabId &&
    (!lastActivation || compareEvents(event, lastActivation) > 0));
  if (tabClosed) return null;
  const topEvents = afterStep.filter((event) => event.tabId === outcomeTabId &&
    (event.frameId === 0 || event.frameId == null));
  const scopeBoundaries = afterStep.filter((event) =>
    (event.tabId === outcomeTabId && (event.frameId === 0 || event.frameId == null) &&
      ["navigation", "navigation.spa", "navigation.committed", "navigation.out_of_scope"].includes(event.kind)) ||
    (event.kind === "warning" && event.payload?.tabId === outcomeTabId &&
      ["已离开授权范围，页面操作不会被采集", "页面已离开授权范围"].includes(event.payload?.message)));
  const lastBoundary = scopeBoundaries.at(-1);
  if (lastBoundary?.kind === "navigation.out_of_scope" || lastBoundary?.kind === "warning") return null;
  const lastOutside = scopeBoundaries.filter((event) => event.kind === "navigation.out_of_scope" || event.kind === "warning").at(-1);
  const matchesMainDocument = (snapshot) => {
    const committed = topEvents.filter((event) => event.kind === "navigation.committed" &&
      compareEvents(event, snapshot) <= 0 && (!lastOutside || compareEvents(event, lastOutside) > 0)).at(-1);
    if (lastOutside && (!committed?.payload?.documentId || !snapshot.documentId)) return false;
    return !committed?.payload?.documentId || committed.payload.documentId === snapshot.documentId;
  };
  if (otherTabId != null) {
    const tabEvents = afterStep.filter((event) => sameFrame(event, { tabId: otherTabId, frameId: 0 }) && compareEvents(event, lastActivation) > 0);
    const tabSnapshot = tabEvents.filter((event) => event.kind === "page.snapshot" && event.payload?.html).at(-1);
    if (!tabSnapshot || !matchesMainDocument(tabSnapshot) || tabEvents.some((event) => isNavigation(event) && compareEvents(event, tabSnapshot) > 0)) return null;
    return { event: tabSnapshot, label: childTab ? "后续激活的新标签页状态（按时间关联）" : "后续激活的标签页状态" };
  }
  if (step.frameId !== 0) {
    const topNavigation = topEvents.filter((event) =>
      ["navigation", "navigation.committed"].includes(event.kind)).at(-1);
    if (topNavigation) {
      const mainSnapshot = topEvents.filter((event) => event.kind === "page.snapshot" && event.frameId === 0 &&
        event.payload?.html && compareEvents(event, topNavigation) > 0).at(-1);
      return mainSnapshot && matchesMainDocument(mainSnapshot) ? { event: mainSnapshot, label: "主页面跳转后的页面状态" } : null;
    }
  }
  const later = events.filter((event) => sameFrame(event, step) && compareEvents(event, step) > 0).sort(compareEvents);
  const snapshot = later.filter((event) => event.kind === "page.snapshot" && event.payload?.html).at(-1);
  if (snapshot) {
    if (step.frameId === 0 && !matchesMainDocument(snapshot)) return null;
    if (later.some((event) => isNavigation(event) && compareEvents(event, snapshot) > 0)) return null;
    return { event: snapshot, label: snapshot.payload.reason === "stop" ? "录制停止时的页面状态" : "后续记录的页面状态" };
  }
  if (later.some(isNavigation)) return null;
  const changes = later.filter((event) =>
    ["page.mutation", "page.popover", "page.dialog", "interaction.input", "interaction.change"].includes(event.kind) &&
    (!step.documentId || event.documentId === step.documentId) && event.payload?.url === step.payload?.url);
  if (changes.length) return { event: changes.at(-1), label: "后续记录的页面变化" };
  if (["interaction.input", "interaction.change"].includes(step.kind))
    return { event: step, label: "最后记录的输入或选择状态" };
  return null;
}
