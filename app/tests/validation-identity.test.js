import { it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  captureValidationIdentity,
  digestValidationManifest,
  ValidationIdentityError,
  VALIDATION_IDENTITY_POLICY,
} from "./validation-identity.mjs";

// not-run / 未运行：仅编写和静态自审，未 import/执行本测试或 helper。
// Every capture injects synthetic bytes and lstat/readdir/read. No real dist or fs.
const syntheticRoot = path.resolve("__validation_identity_synthetic_only__", "app");
const bytes = (value) => new TextEncoder().encode(value);
const abcSha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
const manifestRow = (name) => ({ path: name, size: 3, sha256: abcSha256 });

function syntheticFiles() {
  const files = new Map();
  for (const name of [...VALIDATION_IDENTITY_POLICY.requiredSourceFiles, ...VALIDATION_IDENTITY_POLICY.requiredDistFiles])
    files.set(name, bytes("synthetic:" + name));
  files.set("src/zeta.js", bytes("abc"));
  files.set("src/nested/alpha.js", bytes("synthetic alpha"));
  files.set("src/style.css", bytes("body{color:red}"));
  files.set("public/icons/synthetic.png", new Uint8Array([0, 1, 255]));
  files.set("tests/capture-scenarios.mjs", bytes("synthetic scenarios"));
  files.set("tests/matrix-options.mjs", bytes("synthetic options"));
  files.set("tests/profile-cleanup.mjs", bytes("synthetic cleanup source, not a profile"));
  files.set("tests/runner.test.js", bytes("synthetic regression"));
  files.set("dist/assets/synthetic.js", bytes("synthetic dist bytes"));
  return files;
}

function syntheticIO({
  files = syntheticFiles(), extraDirectories = [], order = "forward", listing = {},
  fail = null, statOverride = null, readOverride = null, banned = [],
} = {}) {
  const directories = new Set(["", ...extraDirectories]);
  for (const name of [...files.keys(), ...extraDirectories]) {
    let parent = name;
    while (parent.includes("/")) {
      parent = parent.slice(0, parent.lastIndexOf("/"));
      directories.add(parent);
    }
  }
  const calls = [];
  const counts = new Map();
  function touch(operation, absolute) {
    const relative = path.relative(syntheticRoot, absolute);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep), "I/O escaped synthetic root");
    const name = relative.split(path.sep).join("/");
    calls.push({ operation, path: name });
    assert.ok(!banned.some((prefix) => name === prefix || name.startsWith(prefix + "/")), "touched non-allowlist: " + name);
    if (fail && fail.operation === operation && fail.path === name)
      throw Object.assign(new Error("synthetic private cause must not leak"), { code: fail.code });
    return name;
  }
  const io = {
    async stat(absolute) {
      const name = touch("stat", absolute);
      const count = (counts.get(name) || 0) + 1;
      counts.set(name, count);
      const kind = files.has(name) ? "file" : directories.has(name) ? "directory" : null;
      if (!kind) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      const base = {
        size: files.get(name)?.byteLength ?? 0,
        mtimeMs: 1, ctimeMs: 1, ino: 1, dev: 1,
        isSymbolicLink: () => false,
        isDirectory: () => kind === "directory",
        isFile: () => kind === "file",
      };
      return statOverride ? statOverride(name, base, count) : base;
    },
    async read(absolute) {
      const name = touch("read", absolute);
      if (!files.has(name)) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      return readOverride ? readOverride(name, files.get(name)) : files.get(name).slice();
    },
    async readdir(absolute) {
      const name = touch("readdir", absolute);
      if (!directories.has(name)) throw Object.assign(new Error("synthetic missing"), { code: "ENOENT" });
      const prefix = name ? name + "/" : "";
      let names = listing[name] ?? [...new Set([...directories, ...files.keys()]
        .filter((entry) => entry.startsWith(prefix) && entry !== name)
        .map((entry) => entry.slice(prefix.length).split("/")[0]))];
      names = names.slice();
      if (order === "reverse") names.reverse();
      if (order === "rotate" && names.length) names.push(names.shift());
      return names;
    },
  };
  return { io, calls };
}

async function capture(options = {}, host) {
  const memory = syntheticIO(options);
  return { identity: await captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io, host }), calls: memory.calls };
}

function identityFailure(code, relativePath) {
  return (error) => {
    assert.ok(error instanceof ValidationIdentityError);
    assert.equal(error.code, code);
    if (relativePath !== undefined) assert.equal(error.path, relativePath);
    assert.equal(error.complete, false);
    assert.equal(Object.hasOwn(error, "sourceDigest"), false);
    assert.equal(Object.hasOwn(error, "distDigest"), false);
    assert.doesNotMatch(String(error), /synthetic private cause/);
    return true;
  };
}

it("canonical manifest digest is invariant under every permutation of three rows without mutating input", () => {
  const rows = Object.freeze(["src/z.js", "src/a.js", "src/nested/m.js"].map((name) => Object.freeze(manifestRow(name))));
  const expected = digestValidationManifest("source", rows);
  for (const indexes of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) {
    const actual = digestValidationManifest("source", indexes.map((index) => rows[index]));
    assert.equal(actual.digest, expected.digest);
    assert.deepEqual(actual.inputs.map((row) => row.path), ["src/a.js", "src/nested/m.js", "src/z.js"]);
  }
  assert.deepEqual(rows.map((row) => row.path), ["src/z.js", "src/a.js", "src/nested/m.js"]);
  assert.notEqual(digestValidationManifest("source", []).digest, digestValidationManifest("dist", []).digest);
});

it("capture is stable across directory order, hashes bytes with SHA256, and emits relative sorted paths only", async () => {
  const first = (await capture()).identity;
  for (const order of ["reverse", "rotate"]) {
    const actual = (await capture({ order })).identity;
    assert.equal(actual.sourceDigest, first.sourceDigest);
    assert.equal(actual.distDigest, first.distDigest);
    assert.deepEqual(actual.inputs, first.inputs);
  }
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.policyVersion, 1);
  assert.equal(first.status, "complete");
  assert.deepEqual(first.inputs.source.find((row) => row.path === "src/zeta.js"), manifestRow("src/zeta.js"));
  for (const list of Object.values(first.inputs)) {
    assert.deepEqual(list.map((row) => row.path), list.map((row) => row.path).sort());
    for (const row of list) {
      assert.equal(path.isAbsolute(row.path), false);
      assert.equal(row.path.includes("\\"), false);
      assert.match(row.sha256, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(row.size) && row.size >= 0);
    }
  }
  assert.equal(first.limitations.snapshot, "read-only-non-atomic");
  assert.equal(first.limitations.sourceToDist, "not-attested");
  assert.equal(first.limitations.signature, "none");
  assert.equal(Object.hasOwn(first, "verified"), false);
});

it("same-size source and dist content changes affect only the corresponding identity", async () => {
  const baseline = (await capture()).identity;
  for (const [name, kind] of [["src/zeta.js", "source"], ["dist/content.js", "dist"]]) {
    const files = syntheticFiles();
    const changed = files.get(name).slice();
    changed[0] ^= 1;
    files.set(name, changed);
    const next = (await capture({ files })).identity;
    assert.notEqual(next[kind + "Digest"], baseline[kind + "Digest"]);
    assert.equal(next[kind === "source" ? "distDigest" : "sourceDigest"], baseline[kind === "source" ? "distDigest" : "sourceDigest"]);
  }
});

it("file addition, optional deletion and rename change identity, including all new runner and scenario sources", async () => {
  const baseline = (await capture()).identity;
  for (const name of ["src/new.js", "tests/new-scenario.mjs", "tests/new-regression.test.js", "dist/assets/new.bin"]) {
    const files = syntheticFiles();
    files.set(name, bytes("new synthetic file"));
    const next = (await capture({ files })).identity;
    assert.notEqual(next[name.startsWith("dist/") ? "distDigest" : "sourceDigest"], baseline[name.startsWith("dist/") ? "distDigest" : "sourceDigest"]);
  }
  const files = syntheticFiles();
  files.delete("src/zeta.js");
  assert.notEqual((await capture({ files })).identity.sourceDigest, baseline.sourceDigest);
  files.set("src/renamed.js", bytes("abc"));
  assert.notEqual((await capture({ files })).identity.sourceDigest, baseline.sourceDigest);
  for (const name of ["tests/capture-scenarios.mjs", "tests/matrix-options.mjs", "tests/profile-cleanup.mjs", "tests/runner.test.js"])
    assert.ok(baseline.inputs.source.some((row) => row.path === name), name + " must be bound");
});

it("pure manifest boundary rejects escapes, protected paths, extra roots and malformed or duplicate rows", () => {
  for (const name of [
    "../outside.js", "/src/a.js", "C:/src/a.js", "src\\a.js", "src//a.js", "src/./a.js", "src/../a.js",
    "src/a.js\0", "src/CON.js", "src/a.js.", "src/a.js ", "src/.env", "src/secrets.json",
    "node_modules/x.js", "profiles/x.js", "release/x.js", "src/profiles/x.js", "src/a.pem",
    "tests/fixtures/unapproved.json", "tests/helpers/unapproved.js", "scripts/not-allowed.mjs", "dist/content.js",
  ]) assert.throws(() => digestValidationManifest("source", [manifestRow(name)]), identityFailure("PATH_NOT_ALLOWED"));
  for (const name of ["src/a.js", "dist/../a.js", "dist/profile/Preferences", "dist/node_modules/x.js", "dist/a.zip"])
    assert.throws(() => digestValidationManifest("dist", [manifestRow(name)]), identityFailure("PATH_NOT_ALLOWED"));
  assert.throws(() => digestValidationManifest("source", [manifestRow("src/a.js"), manifestRow("src/a.js")]), identityFailure("INVALID_MANIFEST"));
  assert.throws(() => digestValidationManifest("source", new Array(1)), identityFailure("INVALID_MANIFEST"));
  for (const row of [{ ...manifestRow("src/a.js"), size: -1 }, { ...manifestRow("src/a.js"), size: 1.5 },
    { ...manifestRow("src/a.js"), sha256: "not-a-hash" }])
    assert.throws(() => digestValidationManifest("source", [row]), identityFailure("INVALID_MANIFEST"));
});

it("malformed directory entries and non-allowlisted descendants fail before they are read", async () => {
  for (const value of ["../outside.js", "/absolute.js", "a/b.js", "a\\b.js", ".", "..", "evil.js:stream", ".env", "secrets.json"])
    await assert.rejects(capture({ listing: { tests: [value] } }), (error) => {
      assert.ok(error instanceof ValidationIdentityError);
      assert.ok(["INVALID_DIRECTORY_ENTRY", "PATH_NOT_ALLOWED"].includes(error.code));
      return true;
    });
  const files = syntheticFiles();
  files.set("tests/helpers/unapproved.mjs", bytes("must not read"));
  const memory = syntheticIO({ files, banned: ["tests/helpers"] });
  await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("PATH_NOT_ALLOWED", "tests/helpers"));
  assert.equal(memory.calls.some((call) => call.path.startsWith("tests/helpers")), false);
  const protectedFiles = syntheticFiles();
  protectedFiles.set("src/profiles/private.json", bytes("must not read"));
  const protectedMemory = syntheticIO({ files: protectedFiles, banned: ["src/profiles"] });
  await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: protectedMemory.io }), identityFailure("PATH_NOT_ALLOWED", "src/profiles"));
  assert.equal(protectedMemory.calls.some((call) => call.path.startsWith("src/profiles")), false);
});

it("symbolic links at root, ancestor, source file, tree and dist are rejected without reading link targets", async () => {
  for (const target of ["", "skills", "scripts", "src", "src/nested", "src/zeta.js", "dist", "dist/content.js"]) {
    const memory = syntheticIO({ statOverride: (name, info) => name === target ? { ...info, isSymbolicLink: () => true } : info });
    await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("LINK_NOT_ALLOWED", target || "."));
    assert.equal(memory.calls.some((call) => call.operation !== "stat" && (call.path === target || (target && call.path.startsWith(target + "/")))), false);
  }
});

it("adapter-reported reparse points and non-regular files are fail-closed without claiming full Windows coverage", async () => {
  for (const patch of [{ reparsePoint: true }, { isReparsePoint: () => true }]) {
    const memory = syntheticIO({ statOverride: (name, info) => name === "src/zeta.js" ? { ...info, ...patch } : info });
    await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("LINK_NOT_ALLOWED", "src/zeta.js"));
    assert.equal(memory.calls.some((call) => call.operation === "read" && call.path === "src/zeta.js"), false);
  }
  const memory = syntheticIO({ statOverride: (name, info) => name === "dist/content.js" ? { ...info, isFile: () => false } : info });
  await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("UNSUPPORTED_FILE_TYPE", "dist/content.js"));
});

it("missing required source, build inputs, required dist entries and entire dist never return complete identity", async () => {
  const runtimeRequired = ["tests/scenario-runner.mjs", "tests/owned-chrome-cleanup.mjs", "tests/profile-cleanup-guard.mjs", "tests/capture-scenarios.mjs", "tests/capture-matrix-run.mjs", "tests/matrix-options.mjs"];
  for (const name of runtimeRequired) assert.ok(VALIDATION_IDENTITY_POLICY.requiredSourceFiles.includes(name), name + " must be mandatory");
  for (const missing of ["package-lock.json", "src/content.js", "tests/capture-matrix.mjs", "dist/content.js", ...runtimeRequired]) {
    const files = syntheticFiles();
    files.delete(missing);
    await assert.rejects(capture({ files }), identityFailure("MISSING_REQUIRED_INPUT", missing));
  }
  const files = syntheticFiles();
  for (const name of [...files.keys()]) if (name.startsWith("dist/")) files.delete(name);
  await assert.rejects(capture({ files }), identityFailure("MISSING_REQUIRED_INPUT", "dist"));
  await assert.rejects(capture({ files, extraDirectories: ["dist"] }), identityFailure("MISSING_REQUIRED_INPUT", "dist/manifest.json"));
});

it("partial read, stat and directory failures retain typed incomplete evidence, not partial digests or raw errors", async () => {
  for (const fail of [{ operation: "read", path: "src/zeta.js", code: "EACCES" },
    { operation: "stat", path: "dist/content.js", code: "EIO" },
    { operation: "readdir", path: "public", code: "EACCES" }]) {
    const memory = syntheticIO({ fail });
    await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), (error) => {
      identityFailure("INPUT_IO_FAILED", fail.path)(error);
      assert.equal(error.operation, fail.operation);
      assert.equal(error.causeCode, fail.code);
      return true;
    });
    assert.ok(memory.calls.some((call) => call.operation === "read"));
  }
  const memory = syntheticIO({ readOverride: (name, value) => name === "src/zeta.js" ? value.slice(1) : value.slice() });
  await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("SNAPSHOT_CHANGED", "src/zeta.js"));
});

it("observed file metadata mutation fails snapshot capture instead of blessing a racing read", async () => {
  const memory = syntheticIO({ statOverride: (name, info, count) => name === "src/zeta.js" && count >= 3 ? { ...info, mtimeMs: 2 } : info });
  await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("SNAPSHOT_CHANGED", "src/zeta.js"));
});

it("no app-wide enumeration or access to unrelated roots and explicit Python caches is needed", async () => {
  const files = syntheticFiles();
  const banned = ["profiles", "credentials", "node_modules", "release", "records", "tests/__pycache__", "scripts/validation-probes.mjs", "skills/other", "skills/extension-logic-clone/scripts/__pycache__"];
  for (const prefix of banned) files.set(prefix.endsWith(".mjs") ? prefix : prefix + "/private.json", bytes("synthetic data never read"));
  const { identity, calls } = await capture({ files, banned });
  assert.equal(identity.status, "complete");
  assert.equal(calls.some((call) => call.operation === "readdir" && ["", "scripts", "skills", "skills/extension-logic-clone"].includes(call.path)), false);
  assert.equal(calls.some((call) => banned.some((prefix) => call.path === prefix || call.path.startsWith(prefix + "/"))), false);
  assert.equal(identity.inputs.source.some((row) => row.path.includes("private")), false);
  const withoutOutputs = (await capture()).identity;
  assert.equal(identity.sourceDigest, withoutOutputs.sourceDigest);
  assert.equal(identity.distDigest, withoutOutputs.distDigest);
});

it("unknown tests entries fail closed even when named like profiles, reports or run output, without target I/O", async () => {
  for (const name of ["profiles", "profile", "reports", "report", "runs", "run", "run-shared", "chrome-helper", ".chrome-run", "tmp-output", "test-results", "playwright-report", "report.json"]) {
    const files = syntheticFiles();
    const target = "tests/" + name;
    files.set(name.endsWith(".json") ? target : target + "/helper.mjs", bytes("synthetic unapproved source or output"));
    const memory = syntheticIO({ files, banned: [target] });
    await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("PATH_NOT_ALLOWED", target));
    assert.equal(memory.calls.some((call) => call.path === target || call.path.startsWith(target + "/")), false);
  }
});

it("a root test importing an output-named source subtree is rejected instead of receiving an incomplete digest", async () => {
  for (const directory of ["run-shared", "chrome-helper"]) {
    const files = syntheticFiles();
    const importer = "tests/aaa-importer.mjs";
    const target = "tests/" + directory;
    files.set(importer, bytes('import "./' + directory + '/helper.mjs";'));
    files.set(target + "/helper.mjs", bytes("export const synthetic = 1;"));
    const memory = syntheticIO({ files, banned: [target] });
    await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: memory.io }), identityFailure("PATH_NOT_ALLOWED", target));
    assert.ok(memory.calls.some((call) => call.operation === "read" && call.path === importer));
    assert.equal(memory.calls.some((call) => call.path === target || call.path.startsWith(target + "/")), false);
  }
});

it("host metadata is caller-supplied, bounded and projected; unknown versions stay null and no HEAD is invented", async () => {
  const host = { nodeVersion: "v0.synthetic", platform: "synthetic-platform", arch: "synthetic-arch", chromeBinaryPath: "X:/synthetic/chrome.exe" };
  Object.defineProperty(host, "secret", { get() { throw new Error("must not enumerate unrelated host data"); }, enumerable: true });
  const first = (await capture({}, host)).identity;
  assert.deepEqual(first.host, { nodeVersion: "v0.synthetic", platform: "synthetic-platform", arch: "synthetic-arch", chromeBinaryPath: "X:/synthetic/chrome.exe", chromeVersion: null, chromeBinarySha256: null });
  const other = (await capture({}, { chromeVersion: "caller-version-only" })).identity;
  assert.equal(other.sourceDigest, first.sourceDigest);
  assert.equal(other.distDigest, first.distDigest);
  assert.equal(Object.values((await capture()).identity.host).every((value) => value === null), true);
  assert.doesNotMatch(JSON.stringify(first), /sourceCommit|HEAD|secret|verified/);
  await assert.rejects(capture({}, { chromeBinarySha256: "bad" }), identityFailure("INVALID_HOST_METADATA"));
});

it("invalid root or incomplete injected I/O is rejected without falling back to real filesystem", async () => {
  for (const appRoot of [undefined, "", ".", "relative/app", "synthetic\0root"]) {
    let calls = 0;
    const io = { read() { calls++; }, stat() { calls++; }, readdir() { calls++; } };
    await assert.rejects(captureValidationIdentity({ appRoot, io }), identityFailure("INVALID_APP_ROOT"));
    assert.equal(calls, 0);
  }
  await assert.rejects(captureValidationIdentity({ appRoot: syntheticRoot, io: {} }), identityFailure("INVALID_IO"));
});
