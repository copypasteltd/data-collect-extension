import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync } from "fflate";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.dirname(app), output = path.join(app, "release/v0.3.0");
const docs = path.join(repo, "docs/交付/2026-11-13/native-release");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const verification = await fs.readFile(path.join(docs, "VERIFICATION.json"));
const manifest = JSON.parse(await fs.readFile(path.join(output, "release-manifest.json"), "utf8"));
const smoke = JSON.parse(await fs.readFile(path.join(docs, "package-smoke.json"), "utf8"));
if (smoke.status !== "passed" || hash(verification) !== manifest.provenance.verificationReport.sha256) throw new Error("release_evidence_gate");
const extra = ["VERIFICATION.json", "RELEASE-REPORT.md", "DELIVERY.json", "package-smoke.json", "REQUIREMENTS-v0.3.0.md", "ACCEPTANCE-01-26.md", "FIX-CLOSURE.md", "START-HERE.md"];
// This finalizer only updates the already verified local v0.3.0 documents/bundle,
// never either immutable nested code ZIP or another release directory.
for (const name of extra) await fs.copyFile(path.join(docs, name), path.join(output, name));
const names = ["logic-recorder-chrome-v0.3.0.zip", "extension-logic-clone-v0.3.0.zip", "INSTALL.md", "RELEASE-NOTES.md", "release-manifest.json", ...extra].sort();
const entries = Object.create(null), sums = [];
for (const name of names) {
  const file = path.join(output, name), stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("ordinary_release_file_required");
  const bytes = await fs.readFile(file);
  sums.push(hash(bytes) + "  " + name);
  entries["logic-recorder-v0.3.0/" + name] = [bytes, { mtime: new Date(2000, 0, 1) }];
}
const sumBytes = Buffer.from(sums.join("\n") + "\n");
await fs.writeFile(path.join(output, "SHA256SUMS.txt"), sumBytes);
entries["logic-recorder-v0.3.0/SHA256SUMS.txt"] = [sumBytes, { mtime: new Date(2000, 0, 1) }];
const bytes = zipSync(entries, { level: 6 }), bundleName = "logic-recorder-release-v0.3.0.zip";
await fs.writeFile(path.join(app, "release", bundleName), bytes);
console.log(JSON.stringify({ bundle: "app/release/" + bundleName, bytes: bytes.length, sha256: hash(bytes), files: Object.keys(entries).length }));
