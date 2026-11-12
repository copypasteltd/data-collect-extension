import { it } from "node:test";
import assert from "node:assert/strict";
import { countInteractionStyleGaps } from "../src/interaction-style-coverage.js";

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
