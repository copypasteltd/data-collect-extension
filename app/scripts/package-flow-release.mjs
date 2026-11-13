import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectReleaseInputs, createReleaseArtifacts, sha256 } from "./package-release.mjs";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app),docsRelative="docs/精简/2026-11-14-v0.4.0",docs=path.join(repo,docsRelative);
const reportBytes=await fs.readFile(path.join(docs,"VERIFICATION.json")),report=JSON.parse(reportBytes);
if(report.version!=="0.4.0"||report.status!=="lightweight-native-validation-passed"||!report.gates.business60Seconds.passed||!report.gates.twentyRoundPerformance.passed||!report.gates.packageOnlyReconstruction.passed)throw Error("flow_release_verification_gate");
const inputs=collectReleaseInputs({appRoot:app});if(inputs.version!=="0.4.0")throw Error("flow_release_version_mismatch");
const documentation=[];
for(const name of ["INSTALL.md","RELEASE-NOTES.md"]){const bytes=await fs.readFile(path.join(docs,name));documentation.push({path:name,bytes});inputs.sourceFiles.push({path:docsRelative+"/"+name,bytes});}
const artifacts=createReleaseArtifacts({...inputs,documentation,verificationReport:{size:reportBytes.length,sha256:sha256(reportBytes)}});
const output=path.join(app,"release/v0.4.0");await fs.mkdir(output);
for(const file of artifacts.files)await fs.writeFile(path.join(output,file.path),file.bytes,{flag:"wx"});
for(const name of ["VERIFICATION.json","REPORT.md"])await fs.copyFile(path.join(docs,name),path.join(output,name),fs.constants.COPYFILE_EXCL);
const names=(await fs.readdir(output)).filter(n=>n!=="SHA256SUMS.txt").sort(),sums=[];
for(const name of names)sums.push(sha256(await fs.readFile(path.join(output,name)))+"  "+name);
await fs.writeFile(path.join(output,"SHA256SUMS.txt"),sums.join("\n")+"\n");
console.log(JSON.stringify({version:artifacts.version,output:"app/release/v0.4.0",artifacts:artifacts.manifest.artifacts.map(({path,size,sha256})=>({path,size,sha256}))}));
