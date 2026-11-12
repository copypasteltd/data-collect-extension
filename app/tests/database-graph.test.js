import { it } from "node:test";
import assert from "node:assert/strict";
import { encodeDatabaseGraph } from "../src/database-graph.js";

it("保留循环、共享缓冲、稀疏数组和二进制原始字节", async () => {
  const buffer = Uint8Array.from([0, 255, 10, 20]).buffer;
  const value = { bytes: new Uint8Array(buffer, 1, 2), buffer, blob: new Blob([buffer], { type: "application/octet-stream" }),
    big: 9007199254740993n, date: new Date("2020-01-01T00:00:00Z"), map: new Map([["a", 1]]), sparse: [] };
  value.sparse.length = 3;
  value.sparse[2] = "end";
  value.self = value;
  const graph = await encodeDatabaseGraph(value);
  assert.deepEqual(graph.issues, []);
  const root = graph.nodes[graph.root.id];
  const fields = Object.fromEntries(root.entries);
  assert.equal(fields.self.id, graph.root.id);
  assert.equal(fields.big.value, "9007199254740993");
  const view = graph.nodes[fields.bytes.id];
  assert.equal(view.buffer.id, fields.buffer.id);
  assert.deepEqual(Buffer.from(graph.nodes[fields.buffer.id].data, "base64"), Buffer.from([0, 255, 10, 20]));
  assert.deepEqual(Buffer.from(graph.nodes[fields.blob.id].data, "base64"), Buffer.from([0, 255, 10, 20]));
  const sparse = graph.nodes[fields.sparse.id];
  assert.equal(sparse.length, 3);
  assert.deepEqual(sparse.entries.map(([key]) => key), ["2"]);
  assert.equal(graph.nodes[fields.date.id].type, "date");
  assert.equal(graph.nodes[fields.map.id].type, "map");
});
