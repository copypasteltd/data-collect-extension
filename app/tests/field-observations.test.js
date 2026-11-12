import { it } from "node:test";
import assert from "node:assert/strict";
import { observeNetworkBody } from "../src/field-observations.js";

it("保留重复字段、数组位置、精确原文位置和类型", () => {
  const raw = '{"标签":"😀","amount":9007199254740993,"amount":null,"items":[true,{"x":"a"}]}';
  const event = { id: "e1", kind: "network.finished", payload: { requestId: "r1", body: { status: "captured", value: raw } } };
  const rows = [...observeNetworkBody(event, { path: "timeline/events-00001.jsonl", line: 3 })];
  assert.equal(rows[0].status, "parsed_json");
  const amount = rows.filter((row) => row.kind === "field" && row.location[0]?.key === "amount");
  assert.deepEqual(amount.map((row) => row.location[0].occurrence), [0, 1]);
  assert.deepEqual(amount.map((row) => row.type), ["number", "null"]);
  assert.deepEqual(amount.map((row) => raw.slice(row.offset, row.offset + row.length)), ["9007199254740993", "null"]);
  assert.ok(rows.some((row) => row.location?.[0]?.key === "items" && row.location?.[1]?.index === 1 && row.location?.[2]?.key === "x"));
  assert.equal(amount[0].source.line, 3);
  assert.equal(amount[0].source.eventId, "e1");
});

it("对无效 JSON 和未取得的正文标记状态，不生成虚构字段", () => {
  const event = { id: "e", kind: "network.finished", payload: { body: { status: "captured", value: '{"x":}' } } };
  const rows = [...observeNetworkBody(event, { path: "t", line: 1 })];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "not_parsed_as_json");
  event.payload.body = { value: null, status: "omitted_size" };
  assert.equal([...observeNetworkBody(event, { path: "t", line: 1 })][0].status, "omitted_size");
});

it("附件字段保留解码方式和原始附件路径", () => {
  const event = { id: "e", kind: "network.finished", payload: { requestId: "r", body: {
    status: "captured_asset", value: null, representation: "browser-provided-bytes" } } };
  const rows = [...observeNetworkBody(event, { path: "timeline/events-00001.jsonl", line: 1 },
    { path: "resources/a.bin", text: '{"id":9007199254740993}' })];
  const field = rows.find((row) => row.location?.[0]?.key === "id");
  assert.equal(field.source.assetPath, "resources/a.bin");
  assert.equal(field.source.decodedAs, "utf-8");
  assert.equal(field.source.representation, "browser-provided-bytes");
});

it("表单编码保留重复键顺序和原始证据，不推断字符串类型", () => {
  const event = { id: "form", kind: "network.requestBody", payload: { requestId: "r", body: {
    status: "captured", value: "tag=first&tag=%E4%B8%AD&empty=&flag&value=42" } } };
  const rows = [...observeNetworkBody(event, { path: "timeline/events-00001.jsonl", line: 7,
    contentType: "application/x-www-form-urlencoded; charset=UTF-8" })];
  assert.equal(rows[0].status, "parsed_form_urlencoded");
  assert.deepEqual(rows.slice(1).map((row) => [row.location[0].key, row.location[0].occurrence, row.formIndex, row.type]), [
    ["tag", 0, 0, "string"], ["tag", 1, 1, "string"], ["empty", 0, 2, "string"],
    ["flag", 0, 3, "string"], ["value", 0, 4, "string"],
  ]);
  assert.ok(rows.slice(1).every((row) => row.source.eventId === "form" && row.source.line === 7));
});

it("表单字符集不支持或编码无效时保留原始证据并拒绝推断字段", () => {
  const event = { id: "form", kind: "network.request", payload: { headers: {
    "Content-Type": "application/x-www-form-urlencoded; charset=iso-8859-1" }, postData: { value: "name=%E9" } } };
  let rows = [...observeNetworkBody(event, { path: "t", line: 1 })];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "unsupported_form_charset");
  event.payload.headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  rows = [...observeNetworkBody(event, { path: "t", line: 1 })];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "invalid_form_encoding");
  assert.equal(event.payload.postData.value, "name=%E9");
});
