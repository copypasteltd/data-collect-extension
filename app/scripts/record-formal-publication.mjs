import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app),docs=path.join(repo,"docs/releases/v0.4.0-publication"),run=promisify(execFile),must=(x,m)=>{if(!x)throw Error(m);};
const plan=JSON.parse(await fs.readFile(path.join(docs,"publication-plan.json"),"utf8")),downloads=JSON.parse(await fs.readFile(path.join(docs,"PUBLIC-DOWNLOADS.json"),"utf8")),oldReceipt=JSON.parse(await fs.readFile(path.join(repo,"docs/交付/2026-11-13/native-release/GITHUB-RELEASE.json"),"utf8"));
async function get(url){const r=await fetch(url,{headers:{"User-Agent":"logic-recorder-public-release-receipt",Accept:"application/vnd.github+json"},signal:AbortSignal.timeout(30000)});must(r.ok,"Public metadata unavailable");return r.json();}
const api="https://api.github.com/repos/"+plan.repository;
const[release,latest,ref,old]=await Promise.all([get(api+"/releases/tags/"+plan.tag),get(api+"/releases/latest"),get(api+"/git/ref/tags/"+plan.tag),get(api+"/releases/tags/v0.3.0")]);
must(downloads.status==="all-public-downloads-byte-verified"&&downloads.assets.length===10&&release.assets.length===10&&!release.draft&&!release.prerelease&&release.id===latest.id,"Public release/download gates incomplete");
let target=ref.object;if(target.type==="tag")target=(await get(api+"/git/tags/"+target.sha)).object;must(target.type==="commit"&&target.sha===plan.sourceCommit,"Formal release tag mismatch");
for(const local of plan.assets){const remote=release.assets.find(a=>a.name===local.name),downloaded=downloads.assets.find(a=>a.name===local.name);must(remote?.state==="uploaded"&&remote.size===local.size&&remote.digest==="sha256:"+local.sha256&&downloaded?.size===local.size&&downloaded.sha256===local.sha256,"Published asset differs");}
must(old.id===oldReceipt.releaseId&&old.published_at===oldReceipt.publishedAt&&old.assets.length===oldReceipt.assets.length,"Previous release identity changed");for(const asset of oldReceipt.assets){const current=old.assets.find(a=>a.name===asset.name);must(current?.size===asset.size&&current.digest==="sha256:"+asset.sha256,"Previous release bytes changed");}
const oldTag=(await run("git",["ls-remote","origin","refs/tags/v0.3.0"],{cwd:repo})).stdout.trim().split(/\s/)[0];must(oldTag===oldReceipt.commit,"Previous release tag changed");
const receipt={schemaVersion:1,status:"published-and-public-downloads-verified",repository:plan.repository,tag:plan.tag,commit:plan.sourceCommit,readerSkillVersion:plan.readerSkillVersion,releaseId:release.id,releaseUrl:release.html_url,publishedAt:release.published_at,verifiedAt:new Date().toISOString(),draft:false,prerelease:false,latestStable:true,assets:downloads.assets,downloadVerification:{method:downloads.downloadMethod,hostLimitation:downloads.browserDownloadUrlHostCheck},verifiedComponentZipBytesUnchanged:true,oldV030ReleaseUnchanged:true,codeArtifactsRebuilt:false};
await fs.writeFile(path.join(docs,"GITHUB-RELEASE.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({status:receipt.status,tag:receipt.tag,url:receipt.releaseUrl,publishedAt:receipt.publishedAt,verifiedAssets:receipt.assets.length,latestStable:true,oldReleaseUnchanged:true}));
