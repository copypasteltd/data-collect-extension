import { it } from "node:test";
import assert from "node:assert/strict";
import { observeThemeValues } from "../src/style-observations.js";
import { packComputedEntries } from "../src/computed-style-encoder.js";

it("从计算样式提取原值及来源，不把背景声明推断成单个颜色", () => {
  const event = { id: "e", kind: "page.computedStyle", payload: { snapshotId: "s", entries: [
    { status: "captured", nodeId: "1", observedAt: 10,
      properties: [["color", "rgb(1, 2, 3)"], ["--theme", "dark"], ["background-image", "linear-gradient(red, blue)"], ["width", "10px"]],
      before: [["color", "red"]], after: [], pseudos: { "::marker": [["color", "green"]] } },
  ] } };
  const rows = [...observeThemeValues(event, { path: "timeline/events-00001.jsonl", line: 3 })];
  assert.equal(rows.length, 5);
  assert.equal(rows[2].value, "linear-gradient(red, blue)");
  assert.equal(rows[3].pseudo, "::before");
  assert.equal(rows[4].pseudo, "::marker");
  assert.equal(rows[0].evidence.line, 3);
  assert.equal(rows[0].source, "computed");
});

it("从压缩的计算样式中提取原始颜色", async () => {
  const packed = await packComputedEntries([{ status: "captured", nodeId: "1", properties: [["color", "red"], ["--long", "x".repeat(3000)]] }]);
  const event = { id: "e", kind: "page.computedStyle", payload: { snapshotId: "s", ...packed } };
  assert.ok([...observeThemeValues(event, { path: "timeline/a", line: 1 })].some((row) => row.property === "color" && row.value === "red"));
});

it("交互态颜色保留关联标识和采样时间", () => {
  const event = { id: "e", kind: "page.interactionStyle", payload: { status: "captured", nodeId: "n", observedAt: 42,
    interactionCaptureId: "interaction", properties: [["color", "red"]], before: [], after: [] } };
  const [row] = [...observeThemeValues(event, { path: "timeline/a", line: 2 })];
  assert.equal(row.source, "computed_interaction");
  assert.equal(row.interactionCaptureId, "interaction");
  assert.equal(row.observedAt, 42);
});
