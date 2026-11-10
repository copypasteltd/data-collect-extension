import { it } from "node:test";
import assert from "node:assert/strict";
import { recordedScrollState } from "../src/scroll-state.js";

it("滚动还原使用快照初始状态和之后的最后一次有效位置", () => {
  const state = recordedScrollState(
    {
      viewport: { scrollX: 5, scrollY: 20 },
      scroll: { positions: [{ nodeId: "1", left: 0, top: 30 }] },
    },
    [
      { kind: "interaction.scroll", payload: { targetScope: "element", targetNodeId: "1", scrollLeft: -10, scrollTop: 50 } },
      { kind: "interaction.scroll", payload: { targetScope: "document", x: 8, y: 60 } },
      { kind: "interaction.scroll", payload: { targetScope: "element", targetNodeId: "1", scrollLeft: 0, scrollTop: Infinity } },
    ],
  );
  assert.equal(state.elements.get("id:1").left, -10);
  assert.equal(state.elements.get("id:1").top, 50);
  assert.equal(state.x, 8);
  assert.equal(state.y, 60);
});

it("旧滚动记录可恢复整页位置，超出上限的快照会标记截断", () => {
  const positions = Array.from({ length: 201 }, (_, index) => ({
    nodeId: String(index + 1), left: 0, top: 1,
  }));
  const state = recordedScrollState(
    { scroll: { positions } },
    [{ kind: "interaction.scroll", payload: { x: 0, y: 42 } }],
  );
  assert.equal(state.y, 42);
  assert.equal(state.elements.size, 200);
  assert.equal(state.truncated, true);
});
