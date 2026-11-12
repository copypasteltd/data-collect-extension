import { it } from "node:test";
import assert from "node:assert/strict";
import { countInteractionStyleGaps, countInteractionDescendantGaps } from "../src/interaction-style-coverage.js";

it("交互态样式必须与同一操作、节点和时间一一对应", () => {
  const action = { kind: "interaction.pointerover", seq: 1, time: 10, payload: { interactionCaptureId: "i", target: { nodeId: "n" } } };
  const sample = { kind: "page.interactionStyle", seq: 2, payload: { interactionCaptureId: "i", interactionTime: 10,
    nodeId: "n", status: "captured", properties: [], before: [], after: [] } };
  assert.equal(countInteractionStyleGaps([action, sample]), 0);
  assert.equal(countInteractionStyleGaps([action]), 1);
  assert.equal(countInteractionStyleGaps([sample]), 1);
  assert.equal(countInteractionStyleGaps([action, sample, sample]), 1);
  assert.equal(countInteractionStyleGaps([action, { ...sample, payload: { ...sample.payload, nodeId: "other" } }]), 1);
});

it("交互子元素采样缺失、截断、重复或错误关联时标记缺口", () => {
  const action = { kind: "interaction.pointerover", seq: 1, time: 10, payload: { interactionCaptureId: "i", target: { nodeId: "root" } } };
  const child = { kind: "page.interactionDescendantStyle", seq: 2, payload: { interactionCaptureId: "i", interactionTime: 10,
    rootNodeId: "root", nodeId: "child", status: "captured", properties: [], before: [], after: [] } };
  const end = { kind: "page.interactionDescendantStyleEnd", seq: 3, payload: { interactionCaptureId: "i", interactionTime: 10,
    nodeId: "root", scope: "light_dom_descendants_only", processed: 1, failed: 0, status: "captured" } };
  assert.equal(countInteractionDescendantGaps([action, child, end]), 0);
  assert.equal(countInteractionDescendantGaps([action, child]), 1);
  assert.equal(countInteractionDescendantGaps([child, end]), 1);
  assert.equal(countInteractionDescendantGaps([action, end]), 1);
  assert.equal(countInteractionDescendantGaps([action, child, child, end]), 1);
  assert.equal(countInteractionDescendantGaps([action, child, { ...end, payload: { ...end.payload, status: "partial" } }]), 1);
  assert.equal(countInteractionDescendantGaps([action, { ...child, payload: { ...child.payload, rootNodeId: "wrong" } }, end]), 1);
});
