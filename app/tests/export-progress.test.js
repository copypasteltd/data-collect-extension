import { it } from "node:test";
import assert from "node:assert/strict";
import { exportProgressDetail, exportProgressPhase } from "../src/export-progress.js";
it("each real archive stage has a distinct operational label", () => {
  assert.equal(exportProgressPhase({ phase: "核对分段终态" }), "fragments");
  assert.equal(exportProgressPhase({ phase: "整理字段与关系索引" }), "indexes");
  assert.equal(exportProgressPhase({ phase: "生成清单与完整性校验" }), "verifying");
});
it("progress reports actual work without recorded content or a fabricated percent", () => {
  const label = exportProgressDetail({ current: 20, total: 100, bytesDone: 1500000,
    url: "https://secret.test/token", path: "private-event", title: "private" }, 12500);
  assert.match(label, /20 \/ 100/); assert.match(label, /1.5 MB/); assert.match(label, /12 秒/);
  assert.doesNotMatch(label, /secret|private|https|%/);
  assert.doesNotMatch(exportProgressDetail({ current: NaN, total: -1, bytesDone: Infinity }), /NaN|Infinity|undefined/);
});
