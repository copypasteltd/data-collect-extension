import { it } from "node:test";
import assert from "node:assert/strict";
import { planFullPageTiles } from "../src/full-page-tiles.js";

it("按设备像素比划分页面并覆盖全部区域", () => {
  const plan = planFullPageTiles(5000, 4500, 2);
  assert.deepEqual([plan.columns, plan.rows, plan.total], [3, 3, 9]);
  assert.deepEqual(plan.tile(0), { x: 0, y: 0, width: 2048, height: 2048 });
  assert.deepEqual(plan.tile(8), { x: 4096, y: 4096, width: 904, height: 404 });
  const area = Array.from({ length: plan.total }, (_, index) => plan.tile(index))
    .reduce((sum, tile) => sum + tile.width * tile.height, 0);
  assert.equal(area, 5000 * 4500);
  assert.throws(() => plan.tile(9));
  assert.throws(() => planFullPageTiles(0, 1, 1));
});
