import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {sha256} from "./package-release.mjs";
const app=path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),repo=path.dirname(app),docs=path.join(repo,"docs/releases/v0.4.0-publication");
const run=promisify(execFile),plan=JSON.parse(await fs.readFile(path.join(docs,"publication-plan.json"),"utf8")),verification=JSON.parse(await fs.readFile(path.join(docs,"package-verification.json"),"utf8"));
const mode=process.argv[2]||"check",must=(x,m)=>{if(!x)throw Error(m);};
must(["check","publish","verify"].includes(mode),"Use check|publish|verify");
must(plan.repository==="copypasteltd/data-collect-extension"&&plan.tag==="v0.4.0"&&plan.sourceCommit==="3b5626a5ba88370d521756737a9d35b5340d52a2"&&plan.readerSkillVersion==="0.4.0.1","Publication target differs from user-authorized release");
must(verification.status==="passed"&&verification.sourceCommit===plan.sourceCommit&&verification.assets.length===plan.assets.length,"Exact formal package verification required");
const root=path.join(repo,plan.formalDirectory),assets=[];for(const asset of plan.assets){must(/^[A-Za-z0-9._-]+$/.test(asset.name)&&!asset.name.includes("..")&&asset.path==="app/release/formal-v0.4.0/"+asset.name,"Unsafe publication asset");const filename=path.join(root,asset.name),stat=await fs.lstat(filename);must(stat.isFile()&&!stat.isSymbolicLink(),"Ordinary release file required");const bytes=await fs.readFile(filename);must(bytes.length===asset.size&&sha256(bytes)===asset.sha256,"Prepared asset changed");assets.push({...asset,bytes});}
const description=await fs.readFile(path.join(repo,plan.bodyFile),"utf8");must(sha256(Buffer.from(description))===assets.find(a=>a.name==="RELEASE-NOTES.md")?.sha256,"Release description changed");
let token;
try{
 const filename=path.join(app,".release-token.enc");
 const command="$ErrorActionPreference='Stop';$secure=ConvertTo-SecureString ([IO.File]::ReadAllText('"+filename.replaceAll("'","''")+"').Trim());$ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}";
 try{const result=await run("powershell.exe",["-NoProfile","-NonInteractive","-Command",command],{timeout:15000,maxBuffer:32768,windowsHide:true});token=result.stdout.trim();must(token.length>=20&&!/\s/.test(token),"Invalid release credential");}catch{throw Error("Stored GitHub publication credential is unavailable for this Windows account");}
 const api="https://api.github.com/repos/"+plan.repository;
 async function github(url,{method="GET",data,bytes,contentType,allow404=false}={}){
  const target=new URL(url);must(target.protocol==="https:"&&["api.github.com","uploads.github.com"].includes(target.hostname),"Credential destination rejected");
  const response=await fetch(target,{method,redirect:"error",signal:AbortSignal.timeout(45000),headers:{Authorization:"Bearer "+token,Accept:"application/vnd.github+json","X-GitHub-Api-Version":"2022-11-28","User-Agent":"logic-recorder-owner-release",...(data?{"Content-Type":"application/json"}:{}),...(contentType?{"Content-Type":contentType}:{})},body:data?JSON.stringify(data):bytes});
  if(allow404&&response.status===404)return null;
  const text=await response.text();let body;try{body=JSON.parse(text);}catch{throw Error("GitHub API returned non-JSON response "+response.status);}
  if(!response.ok)throw Error("github_api_"+response.status+": "+String(body.message||"request_failed").slice(0,200));return body;
 }
 async function publicJson(url){const response=await fetch(url,{signal:AbortSignal.timeout(45000),headers:{Accept:"application/vnd.github+json","User-Agent":"logic-recorder-release-verification"}});must(response.ok,"Public GitHub API unavailable: "+response.status);return response.json();}
 const repository=await github(api);must(repository.full_name===plan.repository&&!repository.private&&repository.permissions?.push,"Public repository release write permission required");
 const source=await github(api+"/commits/"+plan.sourceCommit);must(source.sha===plan.sourceCommit,"Verified source commit missing");
 const old=await github(api+"/releases/tags/v0.3.0");
 const oldIdentity={id:old.id,tag:old.tag_name,publishedAt:old.published_at,assets:old.assets.map(a=>({name:a.name,size:a.size,digest:a.digest})).sort((a,b)=>a.name.localeCompare(b.name))};
 const existingRef=await github(api+"/git/ref/tags/"+plan.tag,{allow404:true});
 if(existingRef){let object=existingRef.object;if(object.type==="tag")object=(await github(api+"/git/tags/"+object.sha)).object;must(object.type==="commit"&&object.sha===plan.sourceCommit,"Existing tag points to a different commit");}
 let release=await github(api+"/releases/tags/"+plan.tag,{allow404:true});
 if(!release){const all=await github(api+"/releases?per_page=100");release=all.find(r=>r.tag_name===plan.tag)||null;}
 console.log(JSON.stringify({mode,repository:plan.repository,tag:plan.tag,sourceCommit:plan.sourceCommit,existing:release?{id:release.id,url:release.html_url,draft:release.draft,prerelease:release.prerelease,assetCount:release.assets.length}:null,plannedAssets:assets.map(({name,size,sha256})=>({name,size,sha256}))}));
 if(mode!=="check"){
  if(mode==="publish"){
   if(!release)release=await github(api+"/releases",{method:"POST",data:{tag_name:plan.tag,target_commitish:plan.sourceCommit,name:plan.name,body:description,draft:true,prerelease:false}});
   must(release.tag_name===plan.tag,"Unexpected release target");
   for(const local of assets){
    release=await github(api+"/releases/"+release.id);
    const remote=release.assets.find(a=>a.name===local.name);
    if(remote){must(remote.state==="uploaded"&&remote.size===local.size&&remote.digest==="sha256:"+local.sha256,"Existing release asset differs: "+local.name);continue;}
    must(release.draft,"Refuse changing an already-published release asset set");
    const url=release.upload_url.replace(/\{.*$/,"")+"?name="+encodeURIComponent(local.name);
    const uploaded=await github(url,{method:"POST",bytes:local.bytes,contentType:local.name.endsWith(".zip")?"application/zip":local.name.endsWith(".json")?"application/json":"text/plain; charset=utf-8"});
    must(uploaded.state==="uploaded"&&uploaded.size===local.size&&uploaded.digest==="sha256:"+local.sha256,"Uploaded asset mismatch");console.log(JSON.stringify({uploaded:local.name,size:uploaded.size,sha256:local.sha256}));
   }
   release=await github(api+"/releases/"+release.id);must(release.assets.length===assets.length,"Unexpected formal release asset set");
   if(release.draft)release=await github(api+"/releases/"+release.id,{method:"PATCH",data:{name:plan.name,body:description,draft:false,prerelease:false,make_latest:"true"}});
  }
  must(release&&!release.draft&&!release.prerelease,"Public stable release required");
  release=await github(api+"/releases/"+release.id);must(release.assets.length===assets.length,"Public release assets incomplete");
  const verified=[];
  for(const local of assets){const remote=release.assets.find(a=>a.name===local.name);must(remote?.state==="uploaded"&&remote.size===local.size&&remote.digest==="sha256:"+local.sha256,"Remote asset metadata mismatch");const response=await fetch(remote.browser_download_url,{redirect:"follow",signal:AbortSignal.timeout(45000),headers:{"User-Agent":"logic-recorder-public-download-verification"}});must(response.ok,"Public asset download failed: "+response.status);const bytes=new Uint8Array(await response.arrayBuffer());must(bytes.length===local.size&&sha256(bytes)===local.sha256,"Public download checksum mismatch");verified.push({name:local.name,size:local.size,sha256:local.sha256,url:remote.browser_download_url});console.log(JSON.stringify({publicDownloadVerified:local.name,bytes:bytes.length}));}
  const ref=await github(api+"/git/ref/tags/"+plan.tag);let object=ref.object;if(object.type==="tag")object=(await github(api+"/git/tags/"+object.sha)).object;must(object.type==="commit"&&object.sha===plan.sourceCommit,"Published tag target mismatch");
  const latest=await publicJson(api+"/releases/latest");must(latest.id===release.id&&latest.tag_name===plan.tag&&!latest.draft&&!latest.prerelease,"New stable release is not latest");
  const oldAfter=await github(api+"/releases/tags/v0.3.0");const unchanged={id:oldAfter.id,tag:oldAfter.tag_name,publishedAt:oldAfter.published_at,assets:oldAfter.assets.map(a=>({name:a.name,size:a.size,digest:a.digest})).sort((a,b)=>a.name.localeCompare(b.name))};must(JSON.stringify(unchanged)===JSON.stringify(oldIdentity),"Old release changed during publication");
  const receipt={schemaVersion:1,status:"published-and-public-downloads-verified",repository:plan.repository,tag:plan.tag,commit:plan.sourceCommit,readerSkillVersion:plan.readerSkillVersion,releaseId:release.id,releaseUrl:release.html_url,publishedAt:release.published_at,verifiedAt:new Date().toISOString(),draft:false,prerelease:false,latestStable:true,assets:verified,verifiedComponentZipBytesUnchanged:true,oldV030ReleaseUnchanged:true};
  await fs.writeFile(path.join(docs,"GITHUB-RELEASE.json"),JSON.stringify(receipt,null,2)+"\n");console.log(JSON.stringify(receipt));
 }
}finally{token=undefined;}
