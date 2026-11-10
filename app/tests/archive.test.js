import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { zipSync, strToU8 } from "fflate";
import { createHash } from "node:crypto";
import { readArchive } from "../src/archive.js";

function validZip(version, tamper = false) {
  const event = {
    id: "e1",
    kind: "interaction.click",
    time: 1,
    seq: 1,
    payload: {},
  };
  const eventPath =
    version === 1 ? "timeline/events.jsonl" : "timeline/events-00001.jsonl";
  const manifest = {
    format: "logic-recorder",
    version,
    session: { id: "s1", title: "测试", startedAt: 1 },
    eventCount: 1,
    ...(version === 2 ? { eventChunks: [eventPath] } : {}),
  };
  const files = {
    "manifest.json": strToU8(JSON.stringify(manifest)),
    [eventPath]: strToU8(JSON.stringify(event) + "\n"),
  };
  const integrity = Object.entries(files).map(([path, bytes]) => ({
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }));
  if (tamper) integrity[1].sha256 = "0".repeat(64);
  files["integrity.json"] = strToU8(JSON.stringify(integrity));
  return zipSync(files);
}
describe("记录包导入", () => {
  it("拒绝包含路径穿越的压缩包", async () => {
    const bytes = zipSync({ "../outside.txt": strToU8("unsafe") });
    await assert.rejects(readArchive(bytes.buffer), /不安全/);
  });
  it("拒绝缺少必要清单的压缩包", async () => {
    const bytes = zipSync({ "manifest.json": strToU8("{}") });
    await assert.rejects(readArchive(bytes.buffer), /缺少必要文件/);
  });
  it("兼容旧版和分段记录包", async () => {
    for (const version of [1, 2]) {
      const bytes = validZip(version);
      const result = await readArchive(bytes.buffer);
      assert.equal(result.events[0].id, "e1");
    }
  });
  it("拒绝哈希校验失败的记录", async () => {
    const bytes = validZip(2, true);
    await assert.rejects(readArchive(bytes.buffer), /校验失败/);
  });
});
