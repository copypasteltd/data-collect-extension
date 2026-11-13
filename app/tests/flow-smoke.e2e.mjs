import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { unzipSync } from "fflate";
import { launchExtension, removeTestProfile } from "./chrome-harness.mjs";
const server=http.createServer((req,res)=>{if(req.url.startsWith("/api")){res.setHeader("Content-Type","application/json");res.end(JSON.stringify({ok:true,value:req.url}));}else{res.setHeader("Content-Type","text/html;charset=utf-8");res.end('<!doctype html><html><head><style>body{color:#123;background:#eee}input{width:150px}</style></head><body><h1>业务测试</h1><input id="value" value="old"><button id="send" onclick="fetch(\'/api?value=\'+document.querySelector(\'#value\').value).then(r=>r.json()).then(v=>document.querySelector(\'#out\').textContent=JSON.stringify(v))">保存</button><output id="out"></output></body></html>');}});
await new Promise(r=>server.listen(0,"127.0.0.1",r));
const root=await fs.mkdtemp(path.resolve("test-flow-smoke-")),profile=path.join(root,"profile"),extension=path.join(root,"extension");let browser,panel;
try{await fs.cp(path.resolve("dist"),extension,{recursive:true});const m=JSON.parse(await fs.readFile(path.join(extension,"manifest.json"),"utf8"));m.host_permissions=["http://*/*","https://*/*"];await fs.writeFile(path.join(extension,"manifest.json"),JSON.stringify(m));
 browser=await launchExtension(profile,extension);const page=await browser.context.newPage();await page.goto("http://127.0.0.1:"+server.address().port+"/");
 panel=await browser.context.newPage();panel.on("pageerror",e=>console.log("PANEL_ERROR "+e.message));await panel.goto("chrome-extension://"+browser.id+"/sidepanel.html");await page.bringToFront();
 await panel.getByRole("button",{name:"开始录制"}).click();await panel.getByText("录制中",{exact:true}).waitFor({timeout:15000});await page.waitForTimeout(1000);
 console.log("STATUS "+JSON.stringify(await panel.evaluate(()=>chrome.runtime.sendMessage({type:"GET_STATUS"}))));
 await page.locator("#value").fill("newvalue💆");await page.locator("#send").click();await page.locator("#out").filter({hasText:"newvalue"}).waitFor();await page.waitForTimeout(900);
 await panel.getByRole("button",{name:"停止录制"}).click();await panel.getByRole("button",{name:"开始录制"}).waitFor({timeout:15000});
 const state=await panel.evaluate(()=>chrome.runtime.sendMessage({type:"GET_STATE"}));console.log("STOPSTATE "+JSON.stringify(state));assert.equal(state.ok,true);assert.equal(state.value.sessions[0].status,"ready");
 const download=panel.waitForEvent("download",{timeout:15000});await panel.getByRole("button",{name:"导出记录包"}).click();const d=await download;await d.saveAs(path.join(root,"flow.zip"));
 const files=unzipSync(await fs.readFile(path.join(root,"flow.zip"))),manifest=JSON.parse(Buffer.from(files["manifest.json"]));const events=manifest.eventChunks.flatMap(p=>Buffer.from(files[p]).toString().trim().split("\n").map(JSON.parse));
 assert.equal(manifest.version,3);const input=events.find(e=>["ui.input","ui.change"].includes(e.kind)&&e.payload.target?.selector==="#value");assert.ok(input);assert.equal(input.payload.value,"newvalue💆");assert.equal(input.payload.beforeValue,"old");assert.ok(events.some(e=>e.kind==="network.response"&&e.payload.url.includes("/api")));
 console.log(JSON.stringify({passed:true,profile:manifest.profile,events:events.length,contents:manifest.contentCount,bytes:(await fs.stat(path.join(root,"flow.zip"))).size,kinds:[...new Set(events.map(e=>e.kind))]}));
}catch(e){if(panel)console.error("PANEL_STATE "+await panel.locator("body").innerText().catch(()=>"unreadable"));throw e;}
finally{if(browser)await browser.close();await new Promise(r=>server.close(r));const gone=await removeTestProfile(profile,()=>fs.rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}));if(gone.status==="removed")await fs.rm(extension,{recursive:true,force:true});}
