import { createHash } from "node:crypto";
import path from "node:path";

// Read-only identity, not a build attestation or a signature. Import performs no I/O.
export const VALIDATION_IDENTITY_SCHEMA_VERSION = 1;
export const VALIDATION_IDENTITY_POLICY_VERSION = 1;

const sourceTrees = Object.freeze([
  "src",
  "public",
  "skills/extension-logic-clone/scripts",
  "skills/extension-logic-clone/references",
]);
const sourceFiles = Object.freeze([
  "sidepanel.html",
  "package.json",
  "package-lock.json",
  "vite.config.js",
  "skills/extension-logic-clone/SKILL.md",
  "scripts/capture-readme.mjs",
  "scripts/generate-icons.ps1",
]);
const testFixtures = Object.freeze(["tests/fixtures/fragment-conformance.json"]);
const requiredSourceFiles = Object.freeze([
  ...sourceFiles,
  ...testFixtures,
  "src/background.js",
  "src/content.js",
  "src/sidepanel.jsx",
  "public/manifest.json",
  "skills/extension-logic-clone/scripts/index_archive.py",
  "skills/extension-logic-clone/scripts/reconstruct_payload.py",
  "skills/extension-logic-clone/scripts/decode_computed_style.py",
  "skills/extension-logic-clone/references/archive-format.md",
  "skills/extension-logic-clone/references/reconstruction.md",
  "tests/capture-matrix.mjs",
  "tests/chrome-harness.mjs",
  "tests/chrome-errors.e2e.mjs",
  "tests/capture-scenarios.mjs",
  "tests/scenario-runner.mjs",
  "tests/owned-chrome-cleanup.mjs",
  "tests/profile-cleanup-guard.mjs",
  "tests/capture-matrix-run.mjs",
  "tests/matrix-options.mjs",
  "tests/e2e.mjs",
  "tests/skill_archive_test.py",
  "tests/validation-identity.mjs",
  "tests/validation-identity.test.js",
]);
const requiredDistFiles = Object.freeze([
  "dist/manifest.json", "dist/background.js", "dist/content.js", "dist/sidepanel.html",
]);

// Public data only: callers cannot widen these roots or supply extra candidate paths.
export const VALIDATION_IDENTITY_POLICY = Object.freeze({
  sourceTrees,
  sourceFiles,
  testFixtures,
  requiredSourceFiles,
  requiredDistFiles,
  tests: "root executable .js/.mjs/.cjs/.jsx/.ts/.tsx/.py files plus listed fixtures",
  dist: "all ordinary files recursively under dist, subject to protected-path rejection",
});

const codeExtensions = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py"]);
const srcExtensions = new Set([...codeExtensions, ".css", ".json", ".html", ".svg"]);
const publicExtensions = new Set([
  ".json", ".html", ".css", ".js", ".svg", ".png", ".jpg", ".jpeg", ".webp", ".gif",
  ".ico", ".woff", ".woff2", ".ttf", ".otf",
]);
const protectedSegments = new Set([
  "node_modules", "profiles", "profile", "release", "releases", "recordings", "records",
  "credentials", "secrets", "reports", "report", "runs", "run", "test-results",
  "playwright-report", "__pycache__",
]);
const protectedExtensions = new Set([".zip", ".7z", ".db", ".sqlite", ".sqlite3", ".pem", ".key", ".p12", ".pfx", ".pyc"]);
const comparePaths = (left, right) => left < right ? -1 : left > right ? 1 : 0;

export class ValidationIdentityError extends Error {
  constructor(code, relativePath = null, operation = null, causeCode = null) {
    super("Validation identity unavailable (" + code + ")" + (relativePath ? ": " + relativePath : ""));
    this.name = "ValidationIdentityError";
    this.code = code;
    this.path = relativePath;
    this.operation = operation;
    this.causeCode = typeof causeCode === "string" && /^[A-Z0-9_]+$/.test(causeCode) ? causeCode : null;
    this.complete = false;
  }
}

function canonicalPath(value) {
  if (typeof value !== "string" || !value || /[\\:\u0000-\u001f\u007f]/.test(value))
    throw new ValidationIdentityError("PATH_NOT_ALLOWED");
  const parts = value.split("/");
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (!part || part === "." || part === ".." || /[. ]$/.test(part) || part.startsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[.]|$)/i.test(part) ||
        protectedSegments.has(lower) || /^(?:credentials|secrets)(?:[.-]|$)/i.test(part) ||
        protectedExtensions.has(path.posix.extname(lower)))
      throw new ValidationIdentityError("PATH_NOT_ALLOWED", value);
  }
  return value;
}

function isAllowedSourceFile(relativePath) {
  if (sourceFiles.includes(relativePath) || testFixtures.includes(relativePath)) return true;
  const extension = path.posix.extname(relativePath);
  if (relativePath.startsWith("src/")) return srcExtensions.has(extension);
  if (relativePath.startsWith("public/")) return publicExtensions.has(extension);
  if (relativePath.startsWith("skills/extension-logic-clone/scripts/")) return extension === ".py";
  if (relativePath.startsWith("skills/extension-logic-clone/references/")) return extension === ".md";
  return relativePath.startsWith("tests/") && relativePath.split("/").length === 2 && codeExtensions.has(extension);
}

function allowedFile(kind, value) {
  const relativePath = canonicalPath(value);
  if ((kind === "source" && isAllowedSourceFile(relativePath)) ||
      (kind === "dist" && relativePath.startsWith("dist/"))) return relativePath;
  throw new ValidationIdentityError("PATH_NOT_ALLOWED", relativePath);
}

// Pure manifest canonicalization + hashing. This alone does NOT establish completeness.
export function digestValidationManifest(kind, entries) {
  if ((kind !== "source" && kind !== "dist") || !Array.isArray(entries))
    throw new ValidationIdentityError("INVALID_MANIFEST");
  const seen = new Set();
  const inputs = Array.from(entries, (entry) => {
    if (!entry || typeof entry !== "object") throw new ValidationIdentityError("INVALID_MANIFEST");
    const relativePath = allowedFile(kind, entry.path);
    if (seen.has(relativePath) || !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256))
      throw new ValidationIdentityError("INVALID_MANIFEST", relativePath);
    seen.add(relativePath);
    return { path: relativePath, size: entry.size, sha256: entry.sha256 };
  }).sort((left, right) => comparePaths(left.path, right.path));
  const digest = createHash("sha256").update(JSON.stringify({
    schemaVersion: VALIDATION_IDENTITY_SCHEMA_VERSION,
    policyVersion: VALIDATION_IDENTITY_POLICY_VERSION,
    kind,
    inputs,
  }), "utf8").digest("hex");
  return { digest, inputs };
}

function hostMetadata(host = {}) {
  if (!host || typeof host !== "object" || Array.isArray(host))
    throw new ValidationIdentityError("INVALID_HOST_METADATA");
  const result = {};
  for (const key of ["nodeVersion", "platform", "arch", "chromeBinaryPath", "chromeVersion", "chromeBinarySha256"]) {
    const value = host[key];
    if (value !== undefined && value !== null && (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)))
      throw new ValidationIdentityError("INVALID_HOST_METADATA");
    result[key] = value ?? null;
  }
  if (result.chromeBinarySha256 !== null && !/^[a-f0-9]{64}$/.test(result.chromeBinarySha256))
    throw new ValidationIdentityError("INVALID_HOST_METADATA");
  return result;
}

async function defaultIO() {
  const fs = await import("node:fs/promises");
  return { read: (name) => fs.readFile(name), stat: (name) => fs.lstat(name), readdir: (name) => fs.readdir(name) };
}

/**
 * Capture a fixed-policy, non-atomic read-only snapshot. No target imports, writes,
 * subprocesses, environment enumeration, Git calls or Chrome/version execution.
 * io.stat MUST use lstat semantics (do not follow links); read returns Uint8Array;
 * readdir returns basename strings. A supplied io must implement all three methods.
 * Node lstat cannot attest the absence of every Windows reparse point or ancestor
 * redirection, and neither the injected adapter nor this helper is an OS sandbox.
 */
export async function captureValidationIdentity({ appRoot, io, host } = {}) {
  if (typeof appRoot !== "string" || !appRoot || appRoot.includes("\0") || !path.isAbsolute(appRoot))
    throw new ValidationIdentityError("INVALID_APP_ROOT");
  const metadata = hostMetadata(host);
  const adapter = io === undefined ? await defaultIO() : io;
  if (!adapter || ["read", "stat", "readdir"].some((key) => typeof adapter[key] !== "function"))
    throw new ValidationIdentityError("INVALID_IO");
  const root = path.resolve(appRoot);
  const directories = new Set();
  const sourceInputs = [], distInputs = [];
  const absolutePath = (relativePath) => relativePath ? path.join(root, ...canonicalPath(relativePath).split("/")) : root;

  async function callIO(operation, relativePath) {
    try { return await adapter[operation](absolutePath(relativePath)); }
    catch (error) {
      if (error instanceof ValidationIdentityError) throw error;
      throw new ValidationIdentityError(error?.code === "ENOENT" ? "MISSING_REQUIRED_INPUT" : "INPUT_IO_FAILED", relativePath || ".", operation, error?.code);
    }
  }

  async function inspect(relativePath) {
    const info = await callIO("stat", relativePath);
    if (!info || ["isSymbolicLink", "isDirectory", "isFile"].some((key) => typeof info[key] !== "function"))
      throw new ValidationIdentityError("INVALID_STAT", relativePath || ".", "stat");
    if (info.isSymbolicLink() || info.reparsePoint === true ||
        (typeof info.isReparsePoint === "function" && info.isReparsePoint()))
      throw new ValidationIdentityError("LINK_NOT_ALLOWED", relativePath || ".", "stat");
    if (!info.isFile() && !info.isDirectory())
      throw new ValidationIdentityError("UNSUPPORTED_FILE_TYPE", relativePath || ".", "stat");
    return info;
  }

  async function directory(relativePath) {
    if (directories.has(relativePath)) return;
    if (relativePath) {
      canonicalPath(relativePath);
      const slash = relativePath.lastIndexOf("/");
      await directory(slash < 0 ? "" : relativePath.slice(0, slash));
    }
    const info = await inspect(relativePath);
    if (!info.isDirectory()) throw new ValidationIdentityError("EXPECTED_DIRECTORY", relativePath || ".", "stat");
    directories.add(relativePath);
  }

  async function file(kind, relativePath) {
    allowedFile(kind, relativePath); // Reject non-allowlisted paths BEFORE any I/O.
    const slash = relativePath.lastIndexOf("/");
    await directory(slash < 0 ? "" : relativePath.slice(0, slash));
    const before = await inspect(relativePath);
    if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0)
      throw new ValidationIdentityError("EXPECTED_REGULAR_FILE", relativePath, "stat");
    const bytes = await callIO("read", relativePath);
    if (!(bytes instanceof Uint8Array)) throw new ValidationIdentityError("INVALID_READ_RESULT", relativePath, "read");
    const after = await inspect(relativePath);
    if (!after.isFile() || bytes.byteLength !== before.size || after.size !== before.size ||
        ["mtimeMs", "ctimeMs", "ino", "dev"].some((key) => before[key] !== undefined && before[key] !== after[key]))
      throw new ValidationIdentityError("SNAPSHOT_CHANGED", relativePath, "stat");
    const row = { path: relativePath, size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    (kind === "source" ? sourceInputs : distInputs).push(row);
  }

  async function names(relativePath) {
    await directory(relativePath);
    const entries = await callIO("readdir", relativePath);
    if (!Array.isArray(entries)) throw new ValidationIdentityError("INVALID_DIRECTORY_LIST", relativePath, "readdir");
    const seen = new Set();
    for (const name of entries) {
      if (typeof name !== "string" || !name || /[\/\\]/.test(name) || name === "." || name === ".." || seen.has(name))
        throw new ValidationIdentityError("INVALID_DIRECTORY_ENTRY", relativePath, "readdir");
      seen.add(name);
    }
    return entries.slice().sort(comparePaths);
  }

  async function tree(kind, relativePath) {
    for (const name of await names(relativePath)) {
      if (kind === "source" && relativePath.startsWith("skills/extension-logic-clone/scripts") && name === "__pycache__") continue; // Generated Python cache is not source; no I/O inside it.
      const child = canonicalPath(relativePath + "/" + name);
      const info = await inspect(child);
      if (info.isDirectory()) await tree(kind, child);
      else await file(kind, child);
    }
  }

  // Never enumerate appRoot, scripts' siblings, the skill's siblings, or test outputs.
  await directory("");
  for (const relativePath of sourceFiles) await file("source", relativePath);
  for (const relativePath of sourceTrees) await tree("source", relativePath);
  for (const name of await names("tests")) {
    if (name === "__pycache__") continue; // Sole excluded tests entry: explicit generated Python cache; no I/O inside it.
    // Output-looking names are not evidence of generated data: unknown entries fail before stat/read/readdir.
    const child = canonicalPath("tests/" + name);
    if (name === "fixtures") {
      for (const fixtureName of await names(child)) {
        const fixture = canonicalPath(child + "/" + fixtureName);
        if (!testFixtures.includes(fixture)) throw new ValidationIdentityError("PATH_NOT_ALLOWED", fixture);
        await file("source", fixture);
      }
    } else {
      if (!isAllowedSourceFile(child)) throw new ValidationIdentityError("PATH_NOT_ALLOWED", child);
      await file("source", child);
    }
  }
  for (const required of requiredSourceFiles)
    if (!sourceInputs.some((entry) => entry.path === required)) throw new ValidationIdentityError("MISSING_REQUIRED_INPUT", required);
  await tree("dist", "dist");
  for (const required of requiredDistFiles)
    if (!distInputs.some((entry) => entry.path === required)) throw new ValidationIdentityError("MISSING_REQUIRED_INPUT", required);
  const source = digestValidationManifest("source", sourceInputs);
  const dist = digestValidationManifest("dist", distInputs);
  return {
    schemaVersion: VALIDATION_IDENTITY_SCHEMA_VERSION,
    policyVersion: VALIDATION_IDENTITY_POLICY_VERSION,
    status: "complete",
    sourceDigest: source.digest,
    distDigest: dist.digest,
    inputs: { source: source.inputs, dist: dist.inputs },
    host: metadata,
    limitations: {
      snapshot: "read-only-non-atomic",
      linkDetection: "Node lstat isSymbolicLink plus optional adapter reparse flag; not all Windows reparse points or appRoot ancestors",
      sourceToDist: "not-attested",
      signature: "none",
      hostMetadata: "caller-supplied-not-probed",
    },
  };
}
