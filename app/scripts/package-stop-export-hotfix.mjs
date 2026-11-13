import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReleaseInputs, createReleaseArtifacts, sha256 } from "./package-release.mjs";
const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), repo = path.dirname(app);
const docsRelative = "docs/修复/2026-11-13-stop-export", docs = path.join(repo, docsRelative);
const bytes = await fs.readFile(path.join(docs, "VERIFICATION.json"));
const verification = JSON.parse(bytes);
if (verification.version !== "0.3.1" || verification.status !== "patch-native-validation-passed" ||
    !verification.gates.captureMatrix.passed || !verification.gates.normalStopAndExport.passed || !verification.gates.readFaultAndRetry.passed)
  throw new Error("hotfix_verification_gate");
const inputs = collectReleaseInputs({ appRoot: app });
if (inputs.version !== "0.3.1") throw new Error("hotfix_version_mismatch");
const documents = [];
for (const [source, destination] of [["UPDATE-RECOVERY.md", "INSTALL.md"], ["RELEASE-NOTES.md", "RELEASE-NOTES.md"]]) {
  const content = await fs.readFile(path.join(docs, source));
  documents.push({ path: destination, bytes: content });
  inputs.sourceFiles.push({ path: docsRelative + "/" + source, bytes: content });
}
const result = createReleaseArtifacts({ ...inputs, documentation: documents,
  verificationReport: { size: bytes.length, sha256: sha256(bytes) } });
const output = path.join(app, "release/v0.3.1");
await fs.mkdir(output);
for (const file of result.files) await fs.writeFile(path.join(output, file.path), file.bytes, { flag: "wx" });
for (const name of ["VERIFICATION.json", "REPORT.md", "UPDATE-RECOVERY.md"])
  await fs.copyFile(path.join(docs, name), path.join(output, name), fs.constants.COPYFILE_EXCL);
const names = (await fs.readdir(output)).filter((name) => name !== "SHA256SUMS.txt").sort(), sums = [];
for (const name of names) sums.push(sha256(await fs.readFile(path.join(output, name))) + "  " + name);
await fs.writeFile(path.join(output, "SHA256SUMS.txt"), sums.join("\n") + "\n");
console.log(JSON.stringify({ version: result.version, output: "app/release/v0.3.1",
  artifacts: result.manifest.artifacts.map(({ path, size, sha256 }) => ({ path, size, sha256 })) }));
