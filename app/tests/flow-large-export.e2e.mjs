// Native synthetic test: a20x batch exceeding the old64MiB admission/export cap.
import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import {build} from "esbuild";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {launchExtension,removeTestProfile} from "./chrome-harness.mjs";
const run=promisify(execFile),app=path.resolve("."),root=await fs.mkdtemp(path.join(app,"test-flow-large-export-")),profile=path.join(root,"profile"),extension=path.join(root,"extension");
const bundle=await build({stdin:{contents:"import * as S from './src/flow-store.js';import {createArchive} from './src/flow-archive.js';import {downloadBlob} from './src/downloads.js';globalThis.__LIMIT_TEST={S,createArchive,downloadBlob};",resolveDir:app},bundle:true,platform:"browser",format:"iife",write:false});
let browser;const report={schemaVersion:1,status:"running",test:"native20x72MiBstored-and-exported",profile:"fresh-owned-synthetic",root,maximum1point25GiBFullyStressTested:false};
try{
 await fs.cp(path.join(app,"dist"),extension,{recursive:true});browser=await launchExtension(profile,extension);const panel=await browser.context.newPage();await panel.goto("chrome-extension://"+browser.id+"/sidepanel.html");
 const ready=await panel.evaluate(()=>chrome.runtime.sendMessage({type:"GET_STATE"}));assert.equal(ready.ok,true);await panel.evaluate(bundle.outputFiles[0].text);
 report.preparation=await panel.evaluate(async()=>{
  const S=globalThis.__LIMIT_TEST.S,MiB=1048576,settings={schemaVersion:1,budgetMultiplier:20,queueMultiplier:20,samplingMultiplier:20};
  const session=await S.createSession({id:"native-large20",ownerToken:"synthetic-owner",settings,producerVersion:"0.5.0"});
  const require=(ok,m)=>{if(!ok)throw Error(m);};require(session.budget.limitBytes===1280*MiB,"20x admission cap");
  let saved=0;for(let i=0;i<4;i++){const bytes=new Uint8Array(18*MiB);bytes.fill(i+1);bytes[bytes.length-1]=127-i;
   const result=await S.appendCapture(session.id,"synthetic-owner",{kind:"page.resource",captureKey:"large-"+i,payload:{source:"synthetic-validation"}},[{field:"body",category:"resource",mime:"application/octet-stream",bytes}]);require(result.accepted===1&&!result.failed&&!result.policyStopped,"large content must persist under20x");saved+=bytes.length;}
  await S.closeSessionWrites(session.id,"synthetic-owner");await S.appendCapture(session.id,"synthetic-owner",{kind:"session.stop",captureKey:"final-stop",payload:{}},[],{final:true});
  const sealed=await S.sealSession(session.id,"synthetic-owner",{status:"ready",stopOutcome:{reason:"synthetic_validation"},coverage:{}});require(saved===72*MiB&&sealed.budget.usedBytes>64*MiB,"exceeds original64MiB without old cap rejection");
  globalThis.__LARGE_SESSION=sealed.id;return{sessionId:sealed.id,usedBytes:sealed.budget.usedBytes,contentBytes:saved,limitBytes:sealed.budget.limitBytes,eventCount:sealed.eventCount,contentCount:sealed.contentCount,settings:sealed.capturePolicy.settings};
 });
 const downloadPromise=panel.waitForEvent("download",{timeout:120000});
 const exportPromise=panel.evaluate(async()=>{const h=globalThis.__LIMIT_TEST,started=Date.now();const result=await h.createArchive(globalThis.__LARGE_SESSION);try{await h.downloadBlob(result.blob,"native-large20.zip");return{...result.metrics,elapsedMs:Date.now()-started,fileBacked:result.blob instanceof File};}finally{await result.cleanup?.();}});
 const download=await downloadPromise;const filename=path.join(root,"native-large20.zip");await download.saveAs(filename);report.export=await exportPromise;report.zipBytes=(await fs.stat(filename)).size;assert.ok(report.zipBytes>64*1048576);
 const index=path.join(root,"verified.sqlite3"),consumer=await run("python",[path.join(app,"skills/extension-logic-clone/scripts/index_archive.py"),filename,"--output",index],{env:{...process.env,PYTHONUTF8:"1"},timeout:120000,maxBuffer:100000});report.reader=JSON.parse(consumer.stdout);assert.equal(report.reader.verification,"passed");assert.equal(report.reader.events,5);assert.equal(report.reader.contentCount,4);
 report.status="passed";console.log(JSON.stringify({status:report.status,storedBytes:report.preparation.usedBytes,zipBytes:report.zipBytes,export:report.export,reader:report.reader.verification}));
}catch(error){report.status="failed";report.failure={message:error.message,stack:error.stack};process.exitCode=1;console.error(error.stack);}
finally{if(browser){await browser.close();report.browserCleanup="confirmed";}const cleanup=await removeTestProfile(profile,()=>fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}));report.profileCleanup=cleanup.status;if(cleanup.status==="removed")await fs.rm(extension,{recursive:true,force:true});const reportFile=path.resolve("../docs/设置/2026-11-14-v0.5.0/large-export.json");await fs.mkdir(path.dirname(reportFile),{recursive:true});await fs.writeFile(reportFile,JSON.stringify(report,null,2)+"\n");}
