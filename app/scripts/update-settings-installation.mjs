import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { unzipSync } from "fflate";

// Updates only the installation explicitly supplied by the owner. Never opens
// Chrome user data, removes the extension, reloads it or restarts Chrome.
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = "C:/Users/carzy/Downloads/logic-recorder-chrome-v0.3.0";
const expectedZipHash = "e0a9a7332208c1a90c974948973a1ba0108503784b4b2f1fa27845d44bc7b594";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const must = (condition, message) => { if (!condition) throw new Error(message); };
const relativeName = (name) => {
  must(typeof name === "string" && /^(?:manifest\.json|background\.js|content\.js|sidepanel\.html|assets\/[A-Za-z0-9_-]+\.(?:js|css)|icons\/icon-(?:16|32|48|128)\.png)$/.test(name), "unexpected_installation_path");
  return name;
};
async function directoryWithoutLinks(directory) {
  const absolute = path.resolve(directory), root = path.parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    must(stat.isDirectory() && !stat.isSymbolicLink(), "installation_directory_contains_link_or_special_node");
  }
  return absolute;
}
async function regular(root, name) {
  relativeName(name);
  const full = path.join(root, ...name.split("/"));
  await directoryWithoutLinks(path.dirname(full));
  const stat = await fs.lstat(full);
  must(stat.isFile() && !stat.isSymbolicLink(), "ordinary_installation_file_required");
  return fs.readFile(full);
}
const original = JSON.parse(await fs.readFile(path.join(app, "release/v0.4.0/release-manifest.json"), "utf8"))
  .artifacts.find((asset) => asset.kind === "chrome-extension");
const next = JSON.parse(await fs.readFile(path.join(app, "release/v0.5.0/release-manifest.json"), "utf8"))
  .artifacts.find((asset) => asset.kind === "chrome-extension");
await directoryWithoutLinks(target);
const oldFiles = new Map();
for (const entry of original.entries) {
  const bytes = await regular(target, entry.path);
  must(bytes.length === entry.size && hash(bytes) === entry.sha256, "installed_v030_modified: " + entry.path);
  oldFiles.set(entry.path, bytes);
}
// Preserve and back up leftover hashed assets from the earlier same-path install too.
const olderManifests = await Promise.all(["0.3.0", "0.3.1"].map(async version => JSON.parse(await fs.readFile(path.join(app, "release/v"+version+"/release-manifest.json"), "utf8")).artifacts.find(a => a.kind === "chrome-extension")));
const olderManifest = { entries: olderManifests.flatMap(m => m.entries) };
for (const entry of olderManifest.entries.filter((e) => e.path.startsWith("assets/") && !oldFiles.has(e.path))) {
  try {
    const bytes = await regular(target, entry.path);
    must(hash(bytes) === entry.sha256, "retained_old_asset_modified");
    oldFiles.set(entry.path, bytes); original.entries.push(entry);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
}
const oldManifest = JSON.parse(oldFiles.get("manifest.json"));
must(oldManifest.name === "逻辑记录" && oldManifest.version === "0.4.0", "wrong_installation_identity");
const zipBytes = await fs.readFile(path.join(app, "release/v0.5.0", next.path));
must(hash(zipBytes) === expectedZipHash && next.sha256 === expectedZipHash, "untrusted_patch_bytes");
const entries = unzipSync(zipBytes), names = Object.keys(entries).sort();
must(JSON.stringify(names) === JSON.stringify(next.entries.map((entry) => entry.path).sort()), "patch_entry_set_mismatch");
for (const entry of next.entries) {
  relativeName(entry.path);
  must(entries[entry.path].length === entry.size && hash(entries[entry.path]) === entry.sha256, "patch_entry_hash_mismatch");
}
const newManifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
must(newManifest.name === oldManifest.name && newManifest.version === "0.5.0", "patch_identity_mismatch");
const changes = next.entries.filter((entry) => !oldFiles.has(entry.path) || hash(oldFiles.get(entry.path)) !== entry.sha256);
const mode = process.argv[2] || "check";
must(["check", "apply"].includes(mode), "usage: update-unpacked-chrome.mjs check|apply");
if (mode === "check") {
  console.log(JSON.stringify({ status: "ready", target: path.resolve(target), installedVersion: oldManifest.version,
    patchVersion: newManifest.version, originalFilesVerified: oldFiles.size, patchFilesVerified: next.entries.length,
    changes: changes.map((entry) => entry.path), policy: "Back up all original program files; preserve old hashed assets and all Chrome user data; no reload" }));
} else {
  const parent = path.join(app, "release/install-backups");
  await fs.mkdir(parent, { recursive: true });
  const backup = await fs.mkdtemp(path.join(parent, "logic-recorder-v0.4.0-before-v0.5.0-"));
  for (const [name, bytes] of oldFiles) {
    const destination = path.join(backup, ...name.split("/"));
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, bytes, { flag: "wx" });
    must(hash(await fs.readFile(destination)) === hash(bytes), "backup_verification_failed");
  }
  const receiptPath = path.join(backup, "UPDATE-RECEIPT.json");
  const receipt = { schemaVersion: 1, status: "backup-verified", target: path.resolve(target), backup,
    originalVersion: "0.4.0", fileVersion: "0.5.0", patchSha256: expectedZipHash,
    startedAt: new Date().toISOString(), originalFiles: original.entries, changedFiles: [],
    chromeReloadPerformed: false, chromeRestartPerformed: false, chromeUserDataAccessed: false,
    retainedOldAssets: original.entries.filter((entry) => !names.includes(entry.path)).map((entry) => entry.path) };
  await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  const written = [];
  async function atomicWrite(name, bytes) {
    const full = path.join(target, ...relativeName(name).split("/"));
    await directoryWithoutLinks(path.dirname(full));
    const temporary = full + ".update-" + randomUUID();
    try { await fs.writeFile(temporary, bytes, { flag: "wx" }); await fs.rename(temporary, full); }
    finally { await fs.rm(temporary, { force: true }); }
  }
  try {
    // Reject concurrent changes before modifying anything in the installation.
    for (const [name, bytes] of oldFiles) must(hash(await regular(target, name)) === hash(bytes), "installation_changed_during_backup");
    // New hashed assets first, common entrypoints next, manifest version last.
    changes.sort((a, b) => (a.path === "manifest.json") - (b.path === "manifest.json") ||
      (a.path.startsWith("assets/") ? 0 : 1) - (b.path.startsWith("assets/") ? 0 : 1));
    for (const entry of changes) {
      if (!oldFiles.has(entry.path)) {
        try { await fs.lstat(path.join(target, ...entry.path.split("/"))); throw new Error("new_patch_path_already_exists"); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
      }
      await atomicWrite(entry.path, entries[entry.path]); written.push(entry.path);
    }
    for (const entry of next.entries) must(hash(await regular(target, entry.path)) === entry.sha256, "installed_patch_hash_mismatch");
    for (const name of receipt.retainedOldAssets) must(hash(await regular(target, name)) === hash(oldFiles.get(name)), "old_live_asset_changed");
    receipt.status = "files-updated-awaiting-chrome-reload";
    receipt.finishedAt = new Date().toISOString(); receipt.changedFiles = written;
    receipt.patchFilesVerified = next.entries.length;
    receipt.oldDatabaseOpened = false; receipt.oldDataMigrated = false;
    await fs.writeFile(path.join(app, "../docs/设置/2026-11-14-v0.5.0/INSTALLATION.json"), JSON.stringify(receipt, null, 2) + "\n");
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const rollback = [];
    for (const name of [...written].reverse()) {
      try {
        must(hash(await regular(target, name)) === hash(entries[name]), "concurrent_installation_change_do_not_overwrite");
        if (oldFiles.has(name)) await atomicWrite(name, oldFiles.get(name));
        else await fs.unlink(path.join(target, ...name.split("/")));
        rollback.push({ name, status: "restored" });
      } catch { rollback.push({ name, status: "needs_manual_check" }); }
    }
    receipt.status = "update-failed"; receipt.rollback = rollback; receipt.finishedAt = new Date().toISOString();
    await fs.writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    console.error(JSON.stringify({ status: receipt.status, backup, rollback, reason: error.message }));
    process.exitCode = 1;
  }
}
