import { it } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { archiveSeal, sameArchiveSeal } from "../src/archive.js";

// 验证状态：仅编写和静态复核，未运行（完整 OS 隔离尚未确认）。
const sealedSession = () => ({ id: "synthetic-session", status: "ready", revision: 7,
  seal: { revision: 7, lastSeq: 12, eventCount: 10, assetCount: 2, sealedAt: 1700000000000 } });

it("只投影既有有效 seal，历史终态不会被补造 seal", () => {
  const legacy = { id: "legacy", status: "ready", eventCount: 3 };
  const before = JSON.stringify(legacy);
  assert.equal(archiveSeal(legacy), null);
  assert.equal(sameArchiveSeal(legacy, null), true);
  assert.equal(JSON.stringify(legacy), before);
  const session = sealedSession(), snapshot = archiveSeal(session);
  assert.deepEqual(snapshot, session.seal);
  assert.notEqual(snapshot, session.seal);
  session.seal.eventCount++;
  assert.equal(snapshot.eventCount, 10);
});

it("拒绝 revision 不匹配、缺字段及非 safe integer seal", () => {
  const session = sealedSession();
  for (const invalid of [
    { ...session, revision: 8 },
    { ...session, seal: {} },
    { ...session, seal: { ...session.seal, revision: 0 }, revision: 0 },
    { ...session, seal: { ...session.seal, eventCount: -1 } },
    { ...session, seal: { ...session.seal, lastSeq: 0.5 } },
    { ...session, seal: { ...session.seal, assetCount: "2" } },
    { ...session, seal: { ...session.seal, sealedAt: Number.MAX_SAFE_INTEGER + 1 } },
  ]) assert.throws(() => archiveSeal(invalid), /封存信息无效/);
});

it("同计数但 revision、lastSeq 或封存时点变化仍不匹配最初 seal", () => {
  const session = sealedSession(), snapshot = archiveSeal(session);
  assert.equal(sameArchiveSeal(session, snapshot), true);
  for (const key of ["revision", "lastSeq", "eventCount", "assetCount", "sealedAt"]) {
    const changed = { ...session, seal: { ...session.seal, [key]: session.seal[key] + 1 } };
    if (key === "revision") changed.revision = changed.seal.revision;
    assert.equal(sameArchiveSeal(changed, snapshot), false);
  }
  assert.equal(sameArchiveSeal({ ...session, seal: null }, snapshot), false);
});

it("archive 初始、预扫后及最终核对 seal，主流核对预扫计数/水位（静态连线检查）", async () => {
  const code = await readFile(new URL("../src/archive.js", import.meta.url), "utf8");
  assert.match(code, /const sealed = archiveSeal\(session\)/);
  assert.match(code, /sealed\.eventCount !== count \|\| sealed\.assetCount !== assets\.length/);
  assert.match(code, /terminalAfter !== sealed\.lastSeq/);
  assert.match(code, /sameArchiveSeal\(afterPrepass, sealed\)/);
  assert.match(code, /after !== sealed\.lastSeq/);
  assert.match(code, /sameArchiveSeal\(latest, sealed\)/);
});
