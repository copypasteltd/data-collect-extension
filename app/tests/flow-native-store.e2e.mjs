import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
const app=path.resolve("."),root=await fs.mkdtemp(path.join(app,"test-flow-native-store-"));
const profile=path.join(root,"profile"),extension=path.join(root,"extension");
await fs.cp(path.join(app,"dist"),extension,{recursive:true});
const bundle=await build({stdin:{contents:"import * as S from './src/flow-store.js';globalThis.__FLOW_STORE_TEST=S;",resolveDir:app},bundle:true,platform:"browser",format:"iife",write:false});
let browser;
try{
 browser=await launchExtension(profile,extension);
 const panel=await browser.context.newPage();await panel.goto("chrome-extension://"+browser.id+"/sidepanel.html");
 const controllerReady=await panel.evaluate(()=>chrome.runtime.sendMessage({type:"GET_STATE"}));assert.equal(controllerReady.ok,true);
 // Wait for the real background recovery scan before creating intentionally open
 // test sessions; otherwise that recovery can legitimately seal our fixture.
 await panel.evaluate(bundle.outputFiles[0].text);
 const result=await panel.evaluate(async()=>{
  const S=globalThis.__FLOW_STORE_TEST,MB=1048576,yes=(x,m)=>{if(!x)throw Error(m);};
  const session=await S.createSession({id:"native-cas",ownerToken:"owner",profile:"business-flow-v1"});
  const repeated="same 中文💆",desc={field:"body",category:"body",mime:"text/plain",bytes:repeated};
  const first=await S.appendCapture(session.id,"owner",{kind:"network.request",captureKey:"a",payload:{requestId:"one"}},[desc]);
  yes(first.accepted===1,"first accepted");
  const retried=await S.appendCapture(session.id,"owner",{kind:"network.request",captureKey:"a",payload:{requestId:"one"}},[desc]);
  yes(retried.accepted===1&&retried.event.id===first.event.id,"durable dedup ack");
  const second=await S.appendCapture(session.id,"owner",{kind:"network.request",captureKey:"b",payload:{requestId:"two"}},[desc]);
  let events=await S.readEvents(session.id),contents=await S.readContents(session.id),saved=await S.getSession(session.id);
  yes(events.length===2&&contents.length===1,"content once and observations twice");
  yes(first.event.payload.body.contentId===second.event.payload.body.contentId,"same rawcontentref");
  let failed=false;try{await S.appendCapture(session.id,"wrong",{kind:"ui.click",payload:{}});}catch{failed=true;}yes(failed,"wrongowner reject");
  const before=JSON.stringify(await S.getSession(session.id));
  const invalid=await S.appendCapture(session.id,"owner",{kind:"page.computedStyle",payload:{}}).then(()=>false,()=>true);
  yes(invalid&&JSON.stringify(await S.getSession(session.id))===before,"unknown kind cannot persist");
  await S.closeSessionWrites(session.id,"owner");
  const stop=await S.appendCapture(session.id,"owner",{kind:"session.stop",captureKey:"fixed-stop",payload:{reason:"test"}},[],{final:true});yes(stop.accepted===1,"final accepted");
  await S.sealSession(session.id,"owner",{status:"ready",stopOutcome:{reason:"user_stop"},coverage:{},expectedSeq:3});
  saved=await S.getSession(session.id);events=await S.readEvents(session.id);contents=await S.readContents(session.id);
  yes(saved.seal.eventCount===3&&saved.seal.contentCount===1&&saved.lastSeq===3,"same tx seal counts");
  const bytes=events.reduce((n,e)=>n+new TextEncoder().encode(JSON.stringify(e)+"\n").length,0)+contents.reduce((n,c)=>n+c.size,0);
  yes(bytes===saved.budget.usedBytes,"native exact byte ledger");
  const frozen=JSON.stringify(saved);
  const late=await S.appendCapture(session.id,"owner",{kind:"ui.click",captureKey:"late",payload:{}});
  yes(!late.accepted&&JSON.stringify(await S.getSession(session.id))===frozen,"late write cannot change seal");
  const body=await S.createSession({id:"body-limit",ownerToken:"owner"});
  const oversize=await S.appendCapture(body.id,"owner",{kind:"network.response",payload:{}},[{field:"body",category:"body",mime:"application/json",bytes:new Blob([new Uint8Array(2*MB+1)])}]);
  yes(!oversize.accepted&&oversize.policyStopped,"singlebody2MiB policy");
  yes((await S.readEvents(body.id)).length===0&&(await S.readContents(body.id)).length===0,"rejection no partial raw writes");
  await S.closeSessionWrites(body.id,"owner");await S.appendCapture(body.id,"owner",{kind:"session.stop",captureKey:"stop",payload:{reason:oversize.reason}},[],{final:true});
  await S.sealSession(body.id,"owner",{status:"ready",stopOutcome:{reason:oversize.reason},coverage:{}});
  const limit=await S.createSession({id:"aggregate-limit",ownerToken:"owner"});
  let accepted=0;
  for(let i=0;i<13;i++){
   const data=new Uint8Array(2*MB);data[0]=i;data[1]=127-i;
   const r=await S.appendCapture(limit.id,"owner",{kind:"network.response",captureKey:"body-"+i,payload:{}},[{field:"body",category:"body",mime:"application/octet-stream",bytes:data}]);
   if(r.accepted)accepted++;else{yes(r.policyStopped,"category budget policy");break;}
  }
  const bounded=await S.getSession(limit.id);yes(accepted===12&&bounded.budget.byCategory.body===24*MB,"24MiB body exact");
  yes(bounded.budget.usedBytes<63*MB&&bounded.budget.policyStopped,"under total but category blocked");
  await S.closeSessionWrites(limit.id,"owner");await S.appendCapture(limit.id,"owner",{kind:"session.stop",captureKey:"stop",payload:{}},[],{final:true});
  await S.sealSession(limit.id,"owner",{status:"ready",stopOutcome:{reason:"budget"},coverage:{}});
  const totalSession=await S.createSession({id:"total-capacity",ownerToken:"owner"});
  let counter=0;
  for(const [category,totalMiB,kind] of [["body",24,"network.response"],["dom",16,"page.snapshot"],["resource",8,"page.resource"],["screenshot",12,"screenshot"]]){
    for(let n=0;n<totalMiB;n+=2){
      const data=new Uint8Array(2*MB);data[0]=++counter;data[data.length-1]=counter;
      const result=await S.appendCapture(totalSession.id,"owner",{kind,captureKey:"unique-content-"+counter,payload:{}},[{field:"content",category,mime:"application/octet-stream",bytes:data}]);
      yes(result.accepted===1&&!result.policyStopped,"below total and exact category content accepted");
    }
  }
  let current=await S.getSession(totalSession.id);
  yes(current.budget.warning===true&&current.budget.usedBytes>=60*MB,"48MiB warning persisted");
  const metadata="x".repeat(31000);let metadataAccepted=0;
  while(metadataAccepted<120){
    const result=await S.appendCapture(totalSession.id,"owner",{kind:"session.notice",captureKey:"metadata-"+metadataAccepted,payload:{note:metadata}});
    if(!result.accepted){yes(result.policyStopped,"normal capacity policy stop");break;}
    metadataAccepted++;
  }
  current=await S.getSession(totalSession.id);
  yes(current.budget.policyStopped&&current.budget.usedBytes<=63*MB,"normal intake never consumes reserved MiB");
  const atStop=current.budget.usedBytes;await S.closeSessionWrites(totalSession.id,"owner");
  const final=await S.appendCapture(totalSession.id,"owner",{kind:"session.stop",captureKey:"stop",payload:{reason:current.budget.reason}},[],{final:true});
  yes(final.accepted===1,"capacity stop retains final event reserve");
  const totalSealed=await S.sealSession(totalSession.id,"owner",{status:"ready",stopOutcome:{reason:"policy_capacity"},coverage:{}});
  yes(totalSealed.budget.usedBytes<=64*MB&&totalSealed.seal.eventCount===totalSealed.eventCount,"total64MiB sealed without truncation");
  return {passed:true,cas:{events:saved.eventCount,contents:saved.contentCount,usedBytes:saved.budget.usedBytes},singleBodyLimit:oversize.reason,
   category:{acceptedBodies:accepted,bytes:bounded.budget.byCategory.body,reason:bounded.budget.reason},
   total:{beforeStopBytes:atStop,afterStopBytes:totalSealed.budget.usedBytes,metadataAccepted,warning:true,reason:current.budget.reason},oldDatabaseOpened:false};
 });
 assert.equal(result.passed,true);console.log(JSON.stringify(result));
 await fs.writeFile(path.join(root,"result.json"),JSON.stringify(result,null,2));
}finally{
 if(browser)await browser.close();
 const gone=await removeTestProfile(profile,()=>fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
 if(gone.status==="removed")await fs.rm(extension,{recursive:true,force:true});
}
