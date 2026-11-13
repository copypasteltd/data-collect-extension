import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {createArchive,collectReleaseInputs,sha256} from "./package-release.mjs";
import {unzipSync} from "fflate";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app),version="0.4.0.1",docs=path.join(repo,"docs/技能更新/2026-11-14-v3");
const receipt=JSON.parse(await fs.readFile(path.join(docs,"installation.json"),"utf8"));
if(receipt.status!=="installed-and-byte-verified"||receipt.version!==version)throw Error("Skill installation not verified");
for(const name of ["source","dsh","codex"]){const report=JSON.parse(await fs.readFile(path.join(docs,name+"-verification.json"),"utf8"));if(report.status!=="passed"||report.indexSummary?.version!==3||report.indexSummary?.byteAccountingVerification!=="performed")throw Error("Actual skill execution not verified");}
const {skillFiles}=collectReleaseInputs({appRoot:app});if(skillFiles.length!==10||!skillFiles.some(f=>f.path==="scripts/read_content.py"))throw Error("Skill input inventory changed");
for(const f of skillFiles){if(receipt.sourceFiles.find(x=>x.path===f.path)?.sha256!==sha256(f.bytes))throw Error("Verified skill changed");for(const target of receipt.installations)if(sha256(await fs.readFile(path.join(target.path,...f.path.split("/"))))!==sha256(f.bytes))throw Error("Installed skill differs from package");}
const bytes=createArchive(skillFiles.map(f=>({...f,path:"extension-logic-clone/"+f.path}))),contents=unzipSync(bytes);
for(const file of skillFiles)if(sha256(contents["extension-logic-clone/"+file.path])!==sha256(file.bytes))throw Error("ZIP round-trip mismatch");
const output=path.join(app,"release/skill-v"+version);await fs.mkdir(output);
const name="extension-logic-clone-v"+version+".zip";
await fs.writeFile(path.join(output,name),bytes,{flag:"wx"});
const manifest={schemaVersion:1,skill:"extension-logic-clone",version,recordingFormats:[1,2,3],currentProfile:"business-flow-v1",compatiblePluginVersion:"0.4.0",path:name,size:bytes.length,sha256:sha256(bytes),files:skillFiles.map(f=>({path:f.path,size:f.bytes.length,sha256:sha256(f.bytes)})),rawRecordingsIncluded:false,originalExtensionReleaseChanged:false};
const metadata=Buffer.from(JSON.stringify(manifest,null,2)+"\n");await fs.writeFile(path.join(output,"manifest.json"),metadata,{flag:"wx"});await fs.writeFile(path.join(output,"SHA256SUMS.txt"),sha256(bytes)+"  "+name+"\n"+sha256(metadata)+"  manifest.json\n",{flag:"wx"});
await fs.writeFile(path.join(docs,"package.json"),metadata,{flag:"wx"});console.log(JSON.stringify({path:"app/release/skill-v"+version+"/"+name,version,size:bytes.length,sha256:sha256(bytes),verifiedFiles:skillFiles.length}));
