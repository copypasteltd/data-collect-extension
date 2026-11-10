import { it } from "node:test";
import assert from "node:assert/strict";
import { encodeDatabaseValue } from "../src/database-value.js";

const clean = (value) => value.length > 10000 ? "[超过大小限制]" : value;

it("保留复杂数据库值的类型和原始字段", () => {
  const value = {
    big: 42n,
    unknown: undefined,
    nonfinite: [NaN, Infinity, -Infinity],
    map: new Map([["token", "secret"], ["name", "customer"]]),
    set: new Set(["a", "b"]),
    pattern: /customer/gi,
  };
  const encoded = encodeDatabaseValue(value, clean);
  assert.deepEqual(encoded.issues, []);
  assert.deepEqual(encoded.value.big, { $type: "bigint", value: "42" });
  assert.deepEqual(encoded.value.unknown, { $type: "undefined" });
  assert.deepEqual(encoded.value.nonfinite, [
    { $type: "number", value: "NaN" },
    { $type: "number", value: "Infinity" },
    { $type: "number", value: "-Infinity" },
  ]);
  assert.deepEqual(encoded.value.map.entries, [["token", "secret"], ["name", "customer"]]);
  assert.deepEqual(encoded.value.set, { $type: "set", values: ["a", "b"] });
  assert.deepEqual(encoded.value.pattern, { $type: "regexp", source: "customer", flags: "gi" });
  assert.doesNotThrow(() => JSON.stringify(encoded.value));
});

it("对二进制、循环引用及内容限制标记缺口", () => {
  const cycle = {};
  cycle.self = cycle;
  const result = encodeDatabaseValue({
    binary: new Uint8Array([1, 2, 3]),
    cycle,
    long: "x".repeat(10001),
    array: Array.from({ length: 201 }, (_, i) => i),
    nodes: Array.from({ length: 20 }, () => Array.from({ length: 200 }, () => 1)),
  }, clean);
  for (const issue of ["binary_omitted", "circular_reference", "string_limit", "entry_limit", "node_limit"])
    assert.ok(result.issues.includes(issue), issue);
  assert.equal(result.value.cycle.self, "[循环引用未采集]");
  assert.equal(result.value.array.length, 200);
  assert.deepEqual(result.value.binary, { $type: "binary", kind: "Uint8Array", size: 3 });
});
