import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { zipSync, unzipSync } from "fflate";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), repo = path.dirname(app);
const output = path.join(app, "release/v0.3.1"), docs = path.join(repo, "docs/修复/2026-11-13-stop-export");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const smoke = JSON.parse(await fs.readFile(path.join(docs, "package-smoke.json"), "utf8"));
const verification = await fs.readFile(path.join(docs, "VERIFICATION.json"));
const manifest = JSON.parse(await fs.readFile(path.join(output, "release-manifest.json"), "utf8"));
if (smoke.status !== "passed" || sha(verification) !== manifest.provenance.verificationReport.sha256) throw new Error("hotfix_delivery_gate");
for (const name of ["REPORT.md", "package-smoke.json", "UPDATE-RECOVERY.md", "RELEASE-NOTES.md"])
  await fs.copyFile(path.join(docs, name), path.join(output, name));
const files = (await fs.readdir(output)).filter((name) => name !== "SHA256SUMS.txt").sort(), entries = Object.create(null), checksums = [];
for (const name of files) {
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes("..")) throw new Error("unexpected_hotfix_artifact");
  const bytes = await fs.readFile(path.join(output, name));
  entries["logic-recorder-hotfix-v0.3.1/" + name] = [bytes, { mtime: new Date(2000, 0, 1) }];
  checksums.push(sha(bytes) + "  " + name);
}
const sums = Buffer.from(checksums.join("\n") + "\n");
await fs.writeFile(path.join(output, "SHA256SUMS.txt"), sums);
entries["logic-recorder-hotfix-v0.3.1/SHA256SUMS.txt"] = [sums, { mtime: new Date(2000, 0, 1) }];
const bytes = zipSync(entries, { level: 6 }), filename = "logic-recorder-hotfix-v0.3.1.zip";
const verify = unzipSync(bytes);
for (const line of checksums) { const [digest, name] = line.split("  "); if (sha(verify["logic-recorder-hotfix-v0.3.1/" + name]) !== digest) throw new Error("hotfix_bundle_verification"); }
await fs.writeFile(path.join(app, "release", filename), bytes, { flag: "wx" });
await fs.writeFile(path.join(app, "release", filename + ".sha256"), sha(bytes) + "  " + filename + "\n", { flag: "wx" });
console.log(JSON.stringify({ file: "app/release/" + filename, bytes: bytes.length, sha256: sha(bytes), checksumEntriesVerified: checksums.length }));
