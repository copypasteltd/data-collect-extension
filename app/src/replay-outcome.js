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
  const isNavigation = (event) => /^(navigation|navigation\.spa|navigation\.committed|navigation\.hash|navigation\.popstate)$/.test(event.kind || "");
  const outcomeTabId = otherTabId ?? step.tabId;
  const tabClosed = afterStep.some((event) => event.kind === "tab.closed" &&
    event.payload?.tabId === outcomeTabId &&
    (!lastActivation || compareEvents(event, lastActivation) > 0));
  if (tabClosed) return null;
  if (otherTabId != null) {
    const tabEvents = afterStep.filter((event) => sameFrame(event, { tabId: otherTabId, frameId: 0 }) && compareEvents(event, lastActivation) > 0);
    const tabSnapshot = tabEvents.filter((event) => event.kind === "page.snapshot" && event.payload?.html).at(-1);
    if (!tabSnapshot || tabEvents.some((event) => isNavigation(event) && compareEvents(event, tabSnapshot) > 0)) return null;
    return { event: tabSnapshot, label: childTab ? "后续激活的新标签页状态（按时间关联）" : "后续激活的标签页状态" };
  }
  const later = events.filter((event) => sameFrame(event, step) && compareEvents(event, step) > 0).sort(compareEvents);
  const snapshot = later.filter((event) => event.kind === "page.snapshot" && event.payload?.html).at(-1);
  if (snapshot) {
    if (later.some((event) => isNavigation(event) && compareEvents(event, snapshot) > 0)) return null;
    return { event: snapshot, label: snapshot.payload.reason === "stop" ? "录制停止时的页面状态" : "后续记录的页面状态" };
  }
  if (later.some(isNavigation)) return null;
  const changes = later.filter((event) =>
    ["page.mutation", "interaction.input", "interaction.change"].includes(event.kind) &&
    (!step.documentId || event.documentId === step.documentId) && event.payload?.url === step.payload?.url);
  if (changes.length) return { event: changes.at(-1), label: "后续记录的页面变化" };
  if (["interaction.input", "interaction.change"].includes(step.kind))
    return { event: step, label: "最后记录的输入或选择状态" };
  return null;
}
