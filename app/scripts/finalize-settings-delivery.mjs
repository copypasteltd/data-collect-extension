import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createHash} from "node:crypto";
import {zipSync,unzipSync} from "fflate";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app),docs=path.join(repo,"docs/设置/2026-11-14-v0.5.0"),output=path.join(app,"release/v0.5.0");
const sha=b=>createHash("sha256").update(b).digest("hex");
const smoke=JSON.parse(await fs.readFile(path.join(docs,"package-smoke.json"),"utf8")),verification=await fs.readFile(path.join(docs,"VERIFICATION.json")),manifest=JSON.parse(await fs.readFile(path.join(output,"release-manifest.json"),"utf8")),installation=JSON.parse(await fs.readFile(path.join(docs,"INSTALLATION.json"),"utf8"));
if(smoke.status!=="passed"||sha(verification)!==manifest.provenance.verificationReport.sha256||installation.status!=="files-updated-awaiting-chrome-reload"||installation.fileVersion!=="0.5.0")throw Error("flow_final_delivery_gate");
for(const entry of manifest.artifacts.find(a=>a.kind==="chrome-extension").entries){const bytes=await fs.readFile(path.join(installation.target,...entry.path.split("/")));if(sha(bytes)!==entry.sha256)throw Error("installed_flow_file_mismatch");}
const extra=["REPORT.md","package-smoke.json","INSTALLATION.json","CONTRACT.md","settings-acceptance.json","large-export.json","review.json","skill-installation.json"];
for(const name of extra)await fs.copyFile(path.join(docs,name),path.join(output,name));
const names=(await fs.readdir(output)).filter(n=>n!=="SHA256SUMS.txt").sort(),entries=Object.create(null),sums=[];
for(const name of names){if(!/^[A-Za-z0-9._-]+$/.test(name)||name.includes(".."))throw Error("unexpected_release_file");const bytes=await fs.readFile(path.join(output,name));sums.push(sha(bytes)+"  "+name);entries["logic-recorder-v0.5.0/"+name]=[bytes,{mtime:new Date(2000,0,1)}];}
const checksums=Buffer.from(sums.join("\n")+"\n");await fs.writeFile(path.join(output,"SHA256SUMS.txt"),checksums);entries["logic-recorder-v0.5.0/SHA256SUMS.txt"]=[checksums,{mtime:new Date(2000,0,1)}];
const bytes=zipSync(entries,{level:6}),roundtrip=unzipSync(bytes);for(const line of sums){const[digest,name]=line.split("  ");if(sha(roundtrip["logic-recorder-v0.5.0/"+name])!==digest)throw Error("final_bundle_integrity");}
const filename="logic-recorder-release-v0.5.0.zip";await fs.writeFile(path.join(app,"release",filename),bytes,{flag:"wx"});await fs.writeFile(path.join(app,"release",filename+".sha256"),sha(bytes)+"  "+filename+"\n",{flag:"wx"});
console.log(JSON.stringify({file:"app/release/"+filename,bytes:bytes.length,sha256:sha(bytes),entryCount:Object.keys(roundtrip).length,installedFilesVerified:true}));
