import { indexEvent } from "./archive-index.js";

export function createPageInstances() {
  const pages = new Map();
  let unassociated = 0;
  return {
    add(event, path, line) {
      if (!Number.isInteger(event.tabId) || !Number.isInteger(event.frameId) || typeof event.documentId !== "string" || !event.documentId) {
        unassociated++;
        return;
      }
      const id = JSON.stringify([event.tabId, event.frameId, event.documentId]);
      let page = pages.get(id);
      if (!page) {
        page = { id, tabId: event.tabId, frameId: event.frameId, documentId: event.documentId,
          firstSeq: event.seq, lastSeq: event.seq, firstTime: event.time, lastTime: event.time,
          eventCount: 0, categories: Object.create(null), urls: new Set(), evidence: [] };
        pages.set(id, page);
      }
      const row = indexEvent(event, path, line);
      page.eventCount++;
      page.categories[row.category] = (page.categories[row.category] || 0) + 1;
      if (Number.isSafeInteger(event.seq)) {
        page.firstSeq = Math.min(page.firstSeq, event.seq);
        page.lastSeq = Math.max(page.lastSeq, event.seq);
      }
      if (Number.isFinite(event.time)) {
        page.firstTime = Math.min(page.firstTime, event.time);
        page.lastTime = Math.max(page.lastTime, event.time);
      }
      if (row.url) page.urls.add(row.url);
      if (page.evidence.length < 3) page.evidence.push({ eventId: event.id, path, line });
    },
    *results() {
      for (const page of pages.values()) yield { ...page, urls: [...page.urls], association: "recorded_document_id" };
    },
    get unassociatedCount() { return unassociated; },
  };
}
