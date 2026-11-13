import { it } from "node:test";
import assert from "node:assert/strict";
import { createArchiveProvenance, normalizeExtensionVersion, readArchiveExporterVersion } from "../src/archive-provenance.js";

// not-run / 未运行：只编写和静态复核；全 OS 隔离门尚未满足，未导入或执行目标模块。
it("provenance keeps producer/exporter roles distinct and projects metadata without reading raw values", () => {
  const raw = Object.freeze({ content: "synthetic-original-content", cookie: "synthetic-cookie" });
  const session = Object.freeze({ id: "synthetic-session", producerVersion: "0.1.2", raw,
    get content() { throw new Error("raw content must not be read"); } });
  const result = createArchiveProvenance(session, "0.2.0");
  assert.deepEqual(result, { schemaVersion: 1, producerVersion: "0.1.2", exporterVersion: "0.2.0",
    derivations: { browserObservations: 2, browserFieldSummary: 2, fragmentValidation: 1, fragmentTerminals: 1 } });
  assert.equal(session.producerVersion, "0.1.2");
  assert.equal(session.raw, raw);
  assert.deepEqual(raw, { content: "synthetic-original-content", cookie: "synthetic-cookie" });
  assert.doesNotMatch(JSON.stringify(result), /synthetic-original-content|synthetic-cookie|capabilities|sourceCommit|verified/);
});

it("provenance is stable for fixed metadata and each result owns its derivation labels", () => {
  const session = Object.freeze({ producerVersion: "1.2.3" });
  const first = createArchiveProvenance(session, "2.0"), second = createArchiveProvenance(session, "2.0");
  assert.deepEqual(first, second);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.notEqual(first, second);
  assert.notEqual(first.derivations, second.derivations);
  first.derivations.browserObservations = 99;
  assert.equal(second.derivations.browserObservations, 2);
  assert.deepEqual(createArchiveProvenance(session, "2.0"), second);
  assert.equal(createArchiveProvenance(session, "3.0").producerVersion, "1.2.3");
});

it("only bounded manifest.version strings are accepted, unchanged, without coercion", () => {
  for (const version of ["1", "0.1", "1.2.3", "65535.65535.65535.65535"]) {
    assert.equal(normalizeExtensionVersion(version), version);
    assert.equal(createArchiveProvenance({ producerVersion: version }, version).producerVersion, version);
  }
  const invalid = [undefined, null, false, 2, {}, [], new String("1.2.3"), "", "0", "0.0.0.0", "01.2", "1.02",
    "1.2.3.4.5", "65536", "1..2", "1.2.", " 1.2", "1.2 ", "1.2\n", "1.2-beta", "1.2+meta",
    "synthetic-original-content", "1".repeat(24), { toString() { throw new Error("must not coerce content"); } }];
  for (const value of invalid) {
    assert.equal(normalizeExtensionVersion(value), null);
    const projected = createArchiveProvenance({ producerVersion: value }, value);
    assert.equal(projected.producerVersion, null);
    assert.equal(projected.exporterVersion, null);
  }
});

it("unknown legacy/invalid producers stay null even when the current exporter version is known", () => {
  for (const session of [undefined, null, {}, { version: "1.0", exporterVersion: "2.0" }, { producerVersion: "bad-content" }])
    assert.equal(createArchiveProvenance(session, "2.0").producerVersion, null);
  assert.deepEqual(createArchiveProvenance({}, "2.0"), { schemaVersion: 1, producerVersion: null, exporterVersion: "2.0",
    derivations: { browserObservations: 2, browserFieldSummary: 2, fragmentValidation: 1, fragmentTerminals: 1 } });
  assert.equal(createArchiveProvenance({ producerVersion: "1.0" }).exporterVersion, null);
});

it("exporter reads the current runtime method with its receiver; missing, malformed or throwing APIs are unknown", () => {
  let version = "2.0";
  const runtime = { getManifest() { assert.equal(this, runtime); return { version, version_name: "not-the-version" }; } };
  assert.equal(readArchiveExporterVersion({ chrome: { runtime } }), "2.0");
  version = "3.0";
  assert.equal(readArchiveExporterVersion({ chrome: { runtime } }), "3.0");
  for (const environment of [null, {}, { chrome: null }, { chrome: {} }, { chrome: { runtime: null } },
    { chrome: { runtime: {} } }, { chrome: { runtime: { getManifest: "not-callable" } } },
    { get chrome() { throw new Error("unavailable chrome"); } },
    { chrome: { get runtime() { throw new Error("unavailable runtime"); } } },
    { chrome: { runtime: { get getManifest() { throw new Error("unavailable method"); } } } },
    { chrome: { runtime: { getManifest() { throw new Error("synthetic-runtime-error"); } } } },
  ]) assert.equal(readArchiveExporterVersion(environment), null);
  for (const manifest of [undefined, null, {}, { version: null }, { version: 2 }, { version: "bad-content" },
    { version_name: "2.0" }, { get version() { throw new Error("unavailable version"); } }]) {
    const unknown = readArchiveExporterVersion({ chrome: { runtime: { getManifest: () => manifest } } });
    assert.equal(unknown, null);
    assert.equal(createArchiveProvenance({ producerVersion: "1.0" }, unknown).exporterVersion, null);
  }
});
