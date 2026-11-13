import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { validateArchivePath } from "./package-release.mjs";
import { launchExtension, removeTestProfile } from "../tests/chrome-harness.mjs";

// Checks this project's own local release, not arbitrary untrusted ZIPs or a user's browser.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(app);
const release = path.join(app, "release/v0.3.0");
const reports = path.join(repo, "docs/交付/2026-11-13/native-release");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (bytes) => JSON.parse(Buffer.from(bytes).toString("utf8"));
const runFile = promisify(execFile);
function assert(ok, code) { if (!ok) throw new Error(code); }
async function regular(file) {
  const stat = await fs.lstat(file);
  assert(stat.isFile() && !stat.isSymbolicLink(), "ordinary_file_required");
  return fs.readFile(file);
}
async function extract(entries, destination) {
  await fs.mkdir(destination);
  for (const [name, bytes] of Object.entries(entries)) {
    validateArchivePath(name);
    const file = path.join(destination, ...name.split("/"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes, { flag: "wx" });
  }
}
const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === "--recording"), "usage: verify-release.mjs [--recording app/test-native-erp-evidence-.../erp-workflow.zip]");
const report = { schemaVersion: 1, version: "0.3.0", startedAt: new Date().toISOString(), status: "running",
  environment: { platform: process.platform, arch: process.arch, node: process.version, mode: "native-host; no OS isolation environment" },
  scope: "Exact packaged extension loaded without modifying its manifest; optional packaged Python CLI reads only a local synthetic recording",
  checks: [], artifacts: [], limitations: ["No native permission-dialog acceptance/denial test", "No macOS or minimum Chrome125 execution", "Hashes are consistency evidence, not publisher signatures"] };
let temporary, profile, browser, failed;
try {
  const manifestBytes = await regular(path.join(release, "release-manifest.json"));
  const manifest = json(manifestBytes);
  assert(manifest.version === "0.3.0" && manifest.artifacts?.length === 2, "release_manifest_shape");
  const sums = (await regular(path.join(release, "SHA256SUMS.txt"))).toString("utf8");
  for (const line of sums.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert(match && !match[2].includes(".."), "checksum_line_invalid");
    assert(sha(await regular(path.join(release, match[2]))) === match[1], "release_checksum_mismatch");
  }
  const packages = new Map();
  for (const artifact of manifest.artifacts) {
    assert(["logic-recorder-chrome-v0.3.0.zip", "extension-logic-clone-v0.3.0.zip"].includes(artifact.path), "unexpected_artifact");
    const bytes = await regular(path.join(release, artifact.path));
    assert(bytes.length === artifact.size && sha(bytes) === artifact.sha256, "artifact_hash_mismatch");
    const files = unzipSync(bytes), names = Object.keys(files).sort();
    assert(JSON.stringify(names) === JSON.stringify(artifact.entries.map((entry) => entry.path).sort()), "entry_set_mismatch");
    for (const entry of artifact.entries) {
      validateArchivePath(entry.path);
      assert(files[entry.path].length === entry.size && sha(files[entry.path]) === entry.sha256, "entry_hash_mismatch");
      const current = artifact.kind === "chrome-extension" ? path.join(app, "dist", entry.path)
        : path.join(app, "skills", ...entry.path.split("/"));
      assert(sha(await regular(current)) === entry.sha256, "package_not_current_candidate");
    }
    packages.set(artifact.kind, files);
    report.artifacts.push({ path: artifact.path, size: artifact.size, sha256: artifact.sha256, entriesVerified: names.length });
  }
  report.checks.push("release files/checksums/entry sizes and hashes match current dist and skill source");
  const extensionFiles = packages.get("chrome-extension"), skillFiles = packages.get("standalone-skill");
  const extensionManifest = json(extensionFiles["manifest.json"]);
  assert(extensionManifest.version === "0.3.0" && extensionManifest.manifest_version === 3, "extension_manifest_version");
  assert(!extensionManifest.host_permissions?.length && extensionManifest.optional_host_permissions?.includes("https://*/*"), "untouched_optional_permissions");
  temporary = await fs.mkdtemp(path.join(app, "test-release-smoke-"));
  profile = path.join(temporary, "profile");
  const extension = path.join(temporary, "extension"), skillRoot = path.join(temporary, "skill");
  await extract(extensionFiles, extension); await extract(skillFiles, skillRoot);
  browser = await launchExtension(profile, extension);
  const panel = await browser.context.newPage(), errors = [];
  panel.on("pageerror", (error) => errors.push(error.message));
  await panel.goto("chrome-extension://" + browser.id + "/sidepanel.html");
  await panel.getByRole("button", { name: "开始录制" }).waitFor();
  const labels = await panel.locator("button").allTextContents();
  assert(JSON.stringify(labels) === JSON.stringify(["开始录制", "导出记录包"]), "unexpected_packaged_controls");
  const state = await panel.evaluate(() => ({ version: chrome.runtime.getManifest().version,
    imageLoaded: [...document.images].every((image) => image.complete && image.naturalWidth > 0),
    cssLoaded: document.styleSheets.length > 0, csp: chrome.runtime.getManifest().content_security_policy ?? null }));
  assert(state.version === "0.3.0" && state.imageLoaded && state.cssLoaded && errors.length === 0, "packaged_runtime_assets");
  report.checks.push("exact unmodified extension ZIP extracts and loads in actual Chrome with JS/CSS/icons and expected idle controls");
  report.browser = { extensionVersion: state.version, userAgent: await panel.evaluate(() => navigator.userAgent), pageErrors: errors.length };
  if (args.length) {
    const recording = path.resolve(repo, args[1]);
    const relative = path.relative(app, recording).split(path.sep).join("/");
    assert(/^test-native-erp-evidence-[A-Za-z0-9_-]+\/erp-workflow\.zip$/.test(relative), "synthetic_recording_only");
    const recordingBytes = await regular(recording), raw = unzipSync(recordingBytes), recordingManifest = json(raw["manifest.json"]);
    const output = path.join(temporary, "verified-index.sqlite3");
    const result = await runFile("python", [path.join(skillRoot, "extension-logic-clone/scripts/index_archive.py"), recording, "--output", output],
      { timeout: 120000, maxBuffer: 1000000, env: { ...process.env, PYTHONUTF8: "1" } });
    const consumer = JSON.parse(result.stdout);
    assert(consumer.verification === "passed" && consumer.events === recordingManifest.eventCount, "packaged_consumer_failed");
    report.consumer = { ...consumer, recordingSha256: sha(recordingBytes), indexCreated: (await fs.stat(output)).size > 0 };
    report.checks.push("extracted packaged Python indexer verifies synthetic ERP recording integrity and event count");
  }
  report.status = "passed";
} catch (error) { failed = error; report.status = "failed"; report.failure = String(error.message); process.exitCode = 1; }
finally {
  try {
    if (browser) { const closed = await browser.close(); report.chromeCleanup = closed.status; }
    if (profile) {
      const removed = await removeTestProfile(profile, () => fs.rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
      report.profileCleanup = removed.status;
      if (removed.status === "removed") await fs.rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      else { report.status = "failed"; process.exitCode = 1; }
    }
  } catch { report.status = "failed"; report.cleanupFailure = true; process.exitCode = 1; }
  report.finishedAt = new Date().toISOString();
  await fs.mkdir(reports, { recursive: true });
  await fs.writeFile(path.join(reports, "package-smoke.json"), JSON.stringify(report, null, 2) + "\n");
  await fs.writeFile(path.join(reports, "package-smoke.md"), "# Exact release package smoke verification\n\nResult: **" + report.status + "**.\n\n" + report.checks.map((check) => "- " + check).join("\n") + "\n\nSee package-smoke.json for hashes, browser/consumer and cleanup results. Native permission dialog, macOS and Chrome125 are not tested.\n");
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, packageArtifacts: report.artifacts, failure: report.failure ?? null }));
}
