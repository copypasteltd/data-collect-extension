import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {unzipSync} from "fflate";
import {sha256} from "./package-release.mjs";
const run=promisify(execFile),app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app);
const folder=path.join(app,"release/skill-v0.4.0.1"),manifest=JSON.parse(await fs.readFile(path.join(folder,"manifest.json"),"utf8"));
const bytes=await fs.readFile(path.join(folder,manifest.path));if(sha256(bytes)!==manifest.sha256)throw Error("Skill ZIP changed");
const entries=unzipSync(bytes),root=await fs.mkdtemp(path.join(app,"test-reading-skill-package-"));
if(Object.keys(entries).length!==manifest.files.length)throw Error("Skill package inventory mismatch");
for(const file of manifest.files){const relative="extension-logic-clone/"+file.path;if(!/^(?:extension-logic-clone\/)(?:SKILL\.md|agents\/[A-Za-z0-9_-]+\.yaml|references\/[A-Za-z0-9_-]+\.md|scripts\/[A-Za-z0-9_-]+\.py)$/.test(relative)||sha256(entries[relative])!==file.sha256)throw Error("Unexpected skill package entry");const dst=path.join(root,...relative.split("/"));await fs.mkdir(path.dirname(dst),{recursive:true});await fs.writeFile(dst,entries[relative],{flag:"wx"});}
const skill=path.join(root,"extension-logic-clone"),env={...process.env,PYTHONUTF8:"1",PYTHONDONTWRITEBYTECODE:"1"};
const validate=await run("python",["C:/Users/carzy/.codex/skills/.system/skill-creator/scripts/quick_validate.py",skill],{cwd:app,env,timeout:30000});
const verify=await run("python",[path.join(app,"scripts/verify-reading-skill.py"),"--skill",skill,"--report",path.join(repo,"docs/技能更新/2026-11-14-v3/package-verification.json")],{cwd:app,env,timeout:45000});
console.log(JSON.stringify({status:"passed",zipSha256:manifest.sha256,files:manifest.files.length,skillValidation:validate.stdout.trim(),actualExtraction:JSON.parse(verify.stdout)}));
