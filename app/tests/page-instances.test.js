import { it } from "node:test";
import assert from "node:assert/strict";
import { createPageInstances } from "../src/page-instances.js";

it("同网址的不同文档、框架和标签不混合，无文档身份的事件不猜测归属", () => {
  const pages = createPageInstances();
  const base = { kind: "page.snapshot", time: 100, payload: { url: "https://example.test/" }, tabId: 1, frameId: 0, documentId: "a" };
  pages.add({ ...base, id: "one", seq: 1 }, "timeline/a", 1);
  pages.add({ ...base, id: "click", kind: "interaction.click", seq: 2 }, "timeline/a", 2);
  pages.add({ ...base, id: "reload", documentId: "b", seq: 3 }, "timeline/a", 3);
  pages.add({ ...base, id: "frame", frameId: 2, documentId: "c", seq: 4 }, "timeline/a", 4);
  pages.add({ ...base, id: "other-tab", tabId: 2, documentId: "d", seq: 5 }, "timeline/a", 5);
  pages.add({ ...base, id: "unknown", documentId: null, seq: 6 }, "timeline/a", 6);
  const rows = [...pages.results()];
  assert.equal(rows.length, 4);
  assert.equal(pages.unassociatedCount, 1);
  assert.equal(rows[0].eventCount, 2);
  assert.equal(rows[0].categories.interaction, 1);
  assert.deepEqual(rows[0].urls, ["https://example.test/"]);
  assert.equal(rows[0].evidence[1].line, 2);
  assert.equal(rows[0].association, "recorded_document_id");
});
