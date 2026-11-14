import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {sha256} from "./package-release.mjs";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app),docs=path.join(repo,"docs/releases/v0.4.0-publication"),run=promisify(execFile);
const plan=JSON.parse(await fs.readFile(path.join(docs,"publication-plan.json"),"utf8")),root=await fs.mkdtemp(path.join(app,"test-public-release-downloads-"));
const metadataResponse=await fetch("https://api.github.com/repos/copypasteltd/data-collect-extension/releases/tags/v0.4.0",{headers:{"User-Agent":"logic-recorder-public-verification"},signal:AbortSignal.timeout(20000)});if(!metadataResponse.ok)throw Error("Public release metadata unavailable");const release=await metadataResponse.json();
const results=[];
for(const asset of plan.assets){
 if(!/^[A-Za-z0-9._-]+$/.test(asset.name)||asset.name.includes(".."))throw Error("Unsafe planned download name");
 const url="https://github.com/copypasteltd/data-collect-extension/releases/download/v0.4.0/"+asset.name;
 const destination=path.join(root,asset.name),remote=release.assets.find(a=>a.name===asset.name);if(!remote||remote.size!==asset.size||remote.digest!=="sha256:"+asset.sha256)throw Error("Public asset metadata mismatch");
 const publicApiUrl=remote.url+"?verification="+Date.now();
 try{await run("curl",["--fail","--location","--silent","--show-error","--proto","=https","--proto-redir","=https","--connect-timeout","15","--max-time","45","--retry","1","--header","Accept: application/octet-stream","--header","User-Agent: logic-recorder-public-verification","--output",destination,publicApiUrl],{cwd:app,timeout:100000,maxBuffer:16000,windowsHide:true});}
 catch(error){console.error(JSON.stringify({downloadFailed:asset.name,code:error.code,stderr:String(error.stderr||"").slice(0,700)}));throw Error("Public release download unavailable: "+asset.name);}
 const bytes=await fs.readFile(destination);if(bytes.length!==asset.size||sha256(bytes)!==asset.sha256)throw Error("Public asset checksum mismatch: "+asset.name);
 const item={name:asset.name,size:bytes.length,sha256:sha256(bytes),url,downloadVerificationApiUrl:remote.url};results.push(item);console.log(JSON.stringify({publicDownloadVerified:asset.name,bytes:bytes.length,sha256:item.sha256}));
}
const receipt={schemaVersion:1,status:"all-public-downloads-byte-verified",tag:"v0.4.0",sourceCommit:plan.sourceCommit,downloadMethod:"curl HTTPS public asset API with Accept:application/octet-stream, no Authorization header; redirected to release-assets.githubusercontent.com",browserDownloadUrlHostCheck:"Node and curl browser_download_url connections reset from this host; all bytes verified using the public API redirect route",verifiedAt:new Date().toISOString(),assets:results};
await fs.writeFile(path.join(docs,"PUBLIC-DOWNLOADS.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify({status:receipt.status,assets:results.length}));
