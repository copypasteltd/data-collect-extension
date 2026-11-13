import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const DEFAULT_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const NATIVE_DOCS = "docs/交付/2026-11-13/native-release";
const INSTALL_DOC = "docs/插件安装与使用说明.md";
const RELEASE_NOTES = NATIVE_DOCS + "/RELEASE-NOTES.md";
const FIXED_DIST = Object.freeze([
  "manifest.json", "background.js", "content.js", "sidepanel.html",
  "icons/icon-16.png", "icons/icon-32.png", "icons/icon-48.png", "icons/icon-128.png",
]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 512;
const ZIP_TIME = new Date(2000, 0, 1, 0, 0, 0);
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;
const FORBIDDEN = /^(?:tests?|test[-_].*|.*[-_]profile(?:[-_].*)?|profiles?|node_modules|__pycache__|recordings?|exports?|user[-_]?data|credentials?|secrets?|tokens?|passwords?|cookies?|login data|local state|history|web data)(?:\..*)?$/i;

function fail(message) { throw new Error(message); }
export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

/** Archive names are portable relative paths, never normalized from unsafe input. */
export function validateArchivePath(name) {
  if (typeof name !== "string" || !name || name.length > 240 ||
      /[\\:\x00-\x1f\x7f<>"|?*%]/.test(name) || name.startsWith("/")) {
    fail("Unsafe relative archive path");
  }
  for (const part of name.split("/")) {
    if (!part || part === "." || part === ".." || part.startsWith(".") ||
        /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) ||
        FORBIDDEN.test(part) || /\.(?:pem|key|p12|pfx|sqlite3?|db|zip|crx|pyc|map)$/i.test(part)) {
      fail("Unsafe or excluded archive path");
    }
  }
  return name;
}

function safeEntries(entries) {
  if (!Array.isArray(entries) || !entries.length || entries.length > MAX_FILES) fail("Invalid package file count");
  const seen = new Set();
  let total = 0;
  return entries.map((entry) => {
    const name = validateArchivePath(entry.path);
    const folded = name.toLowerCase();
    if (seen.has(folded)) fail("Duplicate or case-colliding archive path");
    seen.add(folded);
    if (!(entry.bytes instanceof Uint8Array) || !entry.bytes.byteLength || entry.bytes.byteLength > MAX_FILE_BYTES) {
      fail("Invalid package file bytes or size");
    }
    total += entry.bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) fail("Package exceeds small-code archive budget");
    return { path: name, bytes: entry.bytes };
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

/** Pure deterministic in-memory ZIP helper; small, prevalidated code packages only. */
export function createArchive(entries) {
  const files = Object.create(null);
  for (const entry of safeEntries(entries)) files[entry.path] = [entry.bytes, { mtime: ZIP_TIME }];
  return zipSync(files, { level: 6 });
}

function json(bytes, label) {
  try { return JSON.parse(Buffer.from(bytes).toString("utf8")); }
  catch { fail("Invalid JSON in " + label); }
}
function metadata(entries) {
  return safeEntries(entries).map(({ path: name, bytes }) => ({ path: name, size: bytes.byteLength, sha256: sha256(bytes) }));
}
function metadataOrEmpty(entries) { return entries.length ? metadata(entries) : []; }
function jsonBytes(value) { return Buffer.from(JSON.stringify(value, null, 2) + "\n", "utf8"); }
function isDistFile(name) {
  return FIXED_DIST.includes(name) || /^assets\/[A-Za-z0-9_-]+\.(?:js|css)$/.test(name);
}
function isSkillFile(name) {
  return name === "SKILL.md" || /^agents\/[A-Za-z0-9_-]+\.ya?ml$/.test(name) ||
    /^references\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(name) ||
    /^scripts\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.py$/.test(name);
}

function validateExtension(entries, version) {
  const files = safeEntries(entries);
  const byName = new Map(files.map((entry) => [entry.path, entry.bytes]));
  if (files.some((entry) => !isDistFile(entry.path))) fail("Unexpected extension input file");
  for (const name of FIXED_DIST) if (!byName.has(name)) fail("Missing required dist file: " + name);
  if (!files.some((entry) => /^assets\/.+\.js$/.test(entry.path))) fail("Missing built sidepanel JavaScript");
  const manifest = json(byName.get("manifest.json"), "dist manifest");
  if (manifest.version !== version) fail("dist manifest version must equal package version");
  if (manifest.manifest_version !== 3 || manifest.background?.service_worker !== "background.js" ||
      manifest.side_panel?.default_path !== "sidepanel.html") fail("Unexpected extension entry configuration");
  for (const size of [16, 32, 48, 128]) {
    if (manifest.icons?.[size] !== "icons/icon-" + size + ".png") fail("Missing required manifest icon mapping");
  }
  for (const icon of Object.values(manifest.action?.default_icon || {})) {
    if (typeof icon !== "string" || !byName.has(validateArchivePath(icon))) fail("Missing action icon");
  }
  return files;
}

/** Pure release assembly. No filesystem, environment, network, or clock reads. */
export function createReleaseArtifacts({ version, extensionFiles, skillFiles, sourceFiles, documentation = [], verificationReport } = {}) {
  if (typeof version !== "string" || !VERSION.test(version)) fail("Invalid Chrome release version");
  const extension = validateExtension(extensionFiles, version);
  const skill = safeEntries(skillFiles);
  if (!skill.some((entry) => entry.path === "SKILL.md") || skill.some((entry) => !isSkillFile(entry.path))) {
    fail("Unexpected or incomplete standalone skill inputs");
  }
  const docs = documentation.length ? safeEntries(documentation) : [];
  if (docs.some((entry) => !["INSTALL.md", "RELEASE-NOTES.md"].includes(entry.path))) fail("Documentation is not explicitly allowed");
  const sources = metadata(sourceFiles);
  for (const entry of [...extension, ...skill, ...docs]) {
    if (!sources.some((source) => source.size === entry.bytes.byteLength && source.sha256 === sha256(entry.bytes))) {
      fail("Package input missing from source provenance");
    }
  }
  if (verificationReport && (!/^[a-f0-9]{64}$/.test(verificationReport.sha256) ||
      !Number.isSafeInteger(verificationReport.size) || verificationReport.size <= 0)) fail("Invalid verification report digest");
  const skillEntries = skill.map((entry) => ({ ...entry, path: "extension-logic-clone/" + entry.path }));
  const zipFiles = [
    { path: "logic-recorder-chrome-v" + version + ".zip", bytes: createArchive(extension), kind: "chrome-extension", entries: metadata(extension) },
    { path: "extension-logic-clone-v" + version + ".zip", bytes: createArchive(skillEntries), kind: "standalone-skill", entries: metadata(skillEntries) },
  ];
  const manifest = {
    schemaVersion: 1,
    version,
    format: "local-code-release",
    artifacts: zipFiles.map(({ path: name, bytes, kind, entries }) => ({ path: name, kind, size: bytes.byteLength, sha256: sha256(bytes), entries })),
    provenance: {
      algorithm: "sha256",
      sourceInputHash: sha256(jsonBytes(sources)),
      sourceInputs: sources,
      ...(verificationReport ? { verificationReport: { size: verificationReport.size, sha256: verificationReport.sha256 } } : {}),
    },
    notes: ["Only extension runtime files and the independent skill are archived.", "Hashes bind bytes; they do not certify test acceptance or publisher identity."],
  };
  const manifestFile = { path: "release-manifest.json", bytes: jsonBytes(manifest) };
  manifest.documents = metadataOrEmpty(docs);
  manifestFile.bytes = jsonBytes(manifest);
  const checksumFiles = [...zipFiles, ...docs, manifestFile].sort((a, b) => a.path < b.path ? -1 : 1);
  const sums = Buffer.from(checksumFiles.map(({ path: name, bytes }) => sha256(bytes) + "  " + name + "\n").join(""), "utf8");
  return { version, manifest, files: [...zipFiles.map(({ path: name, bytes }) => ({ path: name, bytes })), ...docs, { path: "SHA256SUMS.txt", bytes: sums }, manifestFile] };
}

function regularRoot(root) {
  const absolute = path.resolve(root);
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail("Project directory must not contain links or special nodes");
  }
  return absolute;
}
function resolveRegular(root, relative, directory = false) {
  validateArchivePath(relative);
  let cursor = root;
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index++) {
    cursor = path.join(cursor, parts[index]);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) fail("Symlink rejected: " + relative);
    const needsDirectory = index < parts.length - 1 || directory;
    if (needsDirectory ? !stat.isDirectory() : !stat.isFile()) fail("Expected ordinary " + (needsDirectory ? "directory" : "file") + ": " + relative);
  }
  return cursor;
}
function readRegular(root, relative) {
  const file = resolveRegular(root, relative);
  const stat = fs.lstatSync(file);
  if (!stat.size || stat.size > MAX_FILE_BYTES) fail("Input exceeds small-code file budget: " + relative);
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) fail("Input changed before reading");
    const bytes = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor);
    if (bytes.byteLength !== stat.size || after.size !== stat.size || after.mtimeMs !== opened.mtimeMs) fail("Input changed during reading");
    return { path: relative, bytes };
  } finally { fs.closeSync(descriptor); }
}
function walkAllowed(root, relative, allowed, skipCaches = false) {
  const folder = resolveRegular(root, relative, true);
  const selected = [];
  function visit(directory, prefix) {
    for (const child of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const name = prefix ? prefix + "/" + child.name : child.name;
      const disk = path.join(directory, child.name);
      const stat = fs.lstatSync(disk);
      // Even excluded names may not be symbolic links.
      if (stat.isSymbolicLink()) fail("Symlink rejected in " + relative);
      if (skipCaches && (child.name === "__pycache__" || child.name.endsWith(".pyc"))) continue;
      let safe = true;
      try { validateArchivePath(name); } catch { safe = false; }
      // Denied names are omitted, never traversed; unknown ordinary files fail closed.
      if (!safe) continue;
      if (stat.isDirectory()) visit(disk, name);
      else if (!stat.isFile()) fail("Special file rejected in " + relative);
      else if (!allowed(name)) fail("Unexpected file in " + relative + ": " + name);
      else selected.push({ ...readRegular(root, relative + "/" + name), path: name });
      if (selected.length > MAX_FILES) fail("Too many package inputs");
    }
  }
  visit(folder, "");
  return selected;
}

/** Read fixed app inputs only. Extra docs are opt-in; reports are hashed, never copied. */
export function collectReleaseInputs({ appRoot = DEFAULT_APP_ROOT, includeInstallDoc = false, releaseNotes = false, verificationReport } = {}) {
  const app = regularRoot(appRoot);
  const repository = regularRoot(path.dirname(app));
  const packageFile = readRegular(app, "package.json");
  const lock = readRegular(app, "package-lock.json");
  const publicManifest = readRegular(app, "public/manifest.json");
  const version = json(packageFile.bytes, "package.json").version;
  if (typeof version !== "string" || !VERSION.test(version)) fail("Invalid package version");
  if (json(publicManifest.bytes, "public manifest").version !== version) fail("public manifest version must equal package version");
  const extensionFiles = walkAllowed(app, "dist", isDistFile);
  const skillFiles = walkAllowed(app, "skills/extension-logic-clone", isSkillFile, true);
  const documentation = [];
  const extraSources = [];
  if (includeInstallDoc) {
    const entry = readRegular(repository, INSTALL_DOC);
    extraSources.push(entry);
    documentation.push({ ...entry, path: "INSTALL.md" });
  }
  if (releaseNotes) {
    const entry = readRegular(repository, RELEASE_NOTES);
    extraSources.push(entry);
    documentation.push({ ...entry, path: "RELEASE-NOTES.md" });
  }
  let report;
  if (verificationReport !== undefined) {
    validateArchivePath(verificationReport);
    if (!verificationReport.startsWith(NATIVE_DOCS + "/") || !/\.(?:json|md|txt)$/.test(verificationReport)) fail("Verification report must be a current native-release document");
    const entry = readRegular(repository, verificationReport);
    report = { size: entry.bytes.byteLength, sha256: sha256(entry.bytes) };
  }
  return {
    version, extensionFiles, skillFiles, documentation, verificationReport: report,
    sourceFiles: [
      { ...packageFile, path: "app/package.json" },
      { ...lock, path: "app/package-lock.json" },
      { ...publicManifest, path: "app/public/manifest.json" },
      ...extensionFiles.map((entry) => ({ ...entry, path: "app/dist/" + entry.path })),
      ...skillFiles.map((entry) => ({ ...entry, path: "app/skills/extension-logic-clone/" + entry.path })),
      ...extraSources,
    ],
  };
}

/** Explicit writer; never rebuilds, installs, uploads, or replaces an existing release. */
export function packageRelease(options = {}) {
  const appRoot = regularRoot(options.appRoot || DEFAULT_APP_ROOT);
  const release = createReleaseArtifacts(collectReleaseInputs({ ...options, appRoot }));
  const releaseRoot = path.join(appRoot, "release");
  if (!fs.existsSync(releaseRoot)) fs.mkdirSync(releaseRoot);
  resolveRegular(appRoot, "release", true);
  const output = path.join(releaseRoot, "v" + release.version);
  // mkdir is intentionally exclusive; no force flag and no deletion of pre-existing data.
  fs.mkdirSync(output);
  try {
    for (const file of release.files) {
      // ZIP filenames are generated, never supplied by the caller.
      fs.writeFileSync(path.join(output, file.path), file.bytes, { flag: "wx" });
    }
  } catch (error) {
    // Remove only the directory this call created, never another release.
    fs.rmSync(output, { recursive: true, force: true });
    throw error;
  }
  return { ...release, outputPath: "app/release/v" + release.version };
}

export function runCli(argv = process.argv.slice(2)) {
  if (argv.includes("--help")) {
    console.log("Usage: node scripts/package-release.mjs [--include-install-doc] [--release-notes] [--verification-report <repo-relative-current-native-report>]");
    return;
  }
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--include-install-doc") options.includeInstallDoc = true;
    else if (arg === "--release-notes") options.releaseNotes = true;
    else if (arg === "--verification-report" && argv[index + 1] && !argv[index + 1].startsWith("--")) options.verificationReport = argv[++index];
    else fail("Unknown or incomplete packaging option; use --help");
  }
  const result = packageRelease(options);
  console.log(JSON.stringify({ version: result.version, output: result.outputPath, files: result.files.map(({ path: name, bytes }) => ({ path: name, size: bytes.byteLength, sha256: sha256(bytes) })) }, null, 2));
}

// Importing helpers never reads project files or writes a release.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { runCli(); }
  catch (error) {
    // Avoid disclosing host paths from filesystem errors in release/CLI output.
    console.error("Release packaging failed: " + (error.code || error.message));
    process.exitCode = 1;
  }
}
