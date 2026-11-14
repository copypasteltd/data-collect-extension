import {it} from "node:test";
import assert from "node:assert/strict";
import {DEFAULT_FLOW_SETTINGS,LEGACY_FLOW_SETTINGS,MAX_MULTIPLIER,deriveFlowLimits,validateFlowSettings,settingsForSession,formatFlowBytes,loadFlowSettings,saveFlowSettings,FLOW_SETTINGS_KEY} from "../src/flow-config.js";
it("latest user contract is20 not200 and derives exact original values times20",()=>{
 assert.equal(MAX_MULTIPLIER,20);assert.deepEqual(DEFAULT_FLOW_SETTINGS,{schemaVersion:1,budgetMultiplier:20,queueMultiplier:20,samplingMultiplier:20});
 const one=deriveFlowLimits(LEGACY_FLOW_SETTINGS),max=deriveFlowLimits();
 assert.equal(max.budget.totalBytes,1280*1048576);assert.equal(max.budget.warningBytes,960*1048576);assert.equal(max.budget.singleBodyBytes,40*1048576);
 for(const [key,value]of Object.entries(one.budget)){if(key==="categoryBytes"){for(const k of Object.keys(value))assert.equal(max.budget.categoryBytes[k],value[k]*20);}else assert.equal(max.budget[key],value*20);}
 for(const key of ["body","resource","screenshot","metadata","batchBytes","queuedBytes","queue","requests","frames","batch","streams","resourceObservations"])assert.equal(max.background[key],one.background[key]*20);
 for(const key of ["screenshotInterval","flushMs","stopMs","detachMs","commandMs"])assert.equal(max.background[key],one.background[key]);
 assert.equal(max.content.domDepth,one.content.domDepth);assert.equal(max.content.domNodes,240000);assert.equal(max.content.queueEvents,640);
});
it("mixed settings derive independently and immutable snapshots retain legacy behavior",()=>{
 const x={schemaVersion:1,budgetMultiplier:7,queueMultiplier:3,samplingMultiplier:11},v=deriveFlowLimits(x);x.budgetMultiplier=8;
 assert.equal(v.budget.totalBytes,64*1048576*7);assert.equal(v.background.queue,64*3);assert.equal(v.content.domNodes,12000*11);assert.ok(Object.isFrozen(v.budget.categoryBytes));
 assert.deepEqual(settingsForSession({capturePolicy:{limits:{totalBytes:64*1048576}}}),LEGACY_FLOW_SETTINGS);
 assert.deepEqual(settingsForSession({capturePolicy:{settings:v.settings}}),v.settings);
});
it("invalid numbers extra keys malformed schemas never normalize silently",()=>{
 for(const value of [0,-1,21,200,1.1,NaN,Infinity,"20",true,null])assert.throws(()=>validateFlowSettings({...DEFAULT_FLOW_SETTINGS,budgetMultiplier:value}));
 for(const value of [null,[],{}, {...DEFAULT_FLOW_SETTINGS,schemaVersion:2},{...DEFAULT_FLOW_SETTINGS,other:1}])assert.throws(()=>validateFlowSettings(value));
});
it("all combinations preserve safeinteger capacity and independence by BigInt oracle",()=>{
 for(let b=1;b<=20;b++)for(let q=1;q<=20;q++)for(let s=1;s<=20;s++){
  const v=deriveFlowLimits({schemaVersion:1,budgetMultiplier:b,queueMultiplier:q,samplingMultiplier:s});
  assert.equal(BigInt(v.budget.totalBytes),64n*1048576n*BigInt(b));assert.equal(BigInt(v.background.queuedBytes),8n*1048576n*BigInt(q));
  assert.equal(v.content.domNodes,12000*s);assert.ok(Number.isSafeInteger(v.budget.normalBytes));assert.ok(v.budget.reserveBytes>0&&v.budget.warningBytes<v.budget.normalBytes);
 }
});
it("settings roundtrip persists once rejects bad values and surfaces real storage errors",async()=>{
 let data={},writes=0;const storage={async get(){return structuredClone(data)},async set(value){writes++;data=structuredClone(value)}};
 assert.deepEqual(await loadFlowSettings(storage),DEFAULT_FLOW_SETTINGS);
 const config={schemaVersion:1,budgetMultiplier:5,queueMultiplier:4,samplingMultiplier:3};assert.deepEqual(await saveFlowSettings(config,storage),config);assert.equal(writes,1);assert.deepEqual(await loadFlowSettings(storage),config);
 await assert.rejects(saveFlowSettings({...config,queueMultiplier:21},storage));assert.equal(writes,1);
 await assert.rejects(loadFlowSettings({get:async()=>{throw Error("read-failed")}}),/read-failed/);
 await assert.rejects(saveFlowSettings(config,{set:async()=>{throw Error("write-failed")}}),/write-failed/);
 data={[FLOW_SETTINGS_KEY]:{...config,samplingMultiplier:200}};await assert.rejects(loadFlowSettings(storage));
 assert.equal(formatFlowBytes(1280*1048576),"1.25 GiB");
});
