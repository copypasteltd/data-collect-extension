// Synthetic-only, no build, no existing profile. Run: node tests/archive-scale.probe.mjs --browser
import { performance } from 'node:perf_hooks';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { observeBrowserData } from '../src/browser-observations.js';
import { createBrowserFieldSummary } from '../src/browser-field-summary.js';
import { reconstructFragments } from '../src/fragments.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const rnd = x => Math.round(x * 100) / 100;
function chain(depth) {
  const event = { id: 'synthetic', sessionId: 'probe', kind: 'database.record', payload: {
    url: 'https://synthetic.invalid/', database: 'probe', store: 'items', index: 0, status: 'captured',
    graph: { root: { type: 'ref', id: 0 }, nodes: Array.from({length:depth+1}, (_,id) => ({
      id, type:'object', entries:id===depth?[]:[['next',{type:'ref',id:id+1}]]
    })) }
  }};
  const summary = createBrowserFieldSummary();
  let rows=0, bytes=0, cells=0;
  const start=performance.now();
  for(const row of observeBrowserData(event,{path:'synthetic/events.jsonl',line:1})) {
    rows++; cells+=row.location?.length||0; summary.add(row);
    bytes+=Buffer.byteLength(JSON.stringify(row)+'\n');
  }
  const observationMs=rnd(performance.now()-start), summaryStart=performance.now();
  let summaryBytes=0; for(const row of summary.results())summaryBytes+=Buffer.byteLength(JSON.stringify(row)+'\n');
  return {depth,rows,locationCells:cells,observationBytes:bytes,summaryBytes,observationMs,summaryMs:rnd(performance.now()-summaryStart)};
}
function fragments(parts) {
  const text='a'.repeat(parts*100000), ref={captureId:'probe',field:'graph',length:text.length,parts};
  const events=Array.from({length:parts},(_,index)=>({kind:'capture.fragment',payload:{...ref,index,data:text.slice(index*100000,(index+1)*100000)}}));
  events.push({kind:'capture.fragmentEnd',payload:{...ref,status:'confirmed'}});
  const start=performance.now(); if(reconstructFragments(ref,events)!==text)throw new Error('fragment mismatch');
  return {parts,utf16Units:text.length,reconstructionMs:rnd(performance.now()-start)};
}
async function nativeBrowser() {
  const { chromium }=await import('playwright');
  const workerText = [
    'import {deflateSync} from "/fflate.js";',
    'self.onmessage=({data})=>{const bytes=deflateSync(data,{level:6});self.postMessage(bytes,[bytes.buffer]);};'
  ].join('\n');
  const clientText = [
    'export const run=bytes=>new Promise((resolve,reject)=>{',
    'const w=new Worker(new URL("./probe-worker.js",import.meta.url),{type:"module"});',
    'const timer=setTimeout(()=>{w.terminate();reject(new Error("worker timeout"));},10000);',
    'w.onmessage=({data})=>{clearTimeout(timer);w.terminate();resolve(data);};w.onerror=e=>{clearTimeout(timer);w.terminate();reject(new Error(e.message));};',
    'w.postMessage(bytes,[bytes.buffer]);});'
  ].join('\n');
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',"script-src 'self'; object-src 'self';");
    res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');
    if(req.url==='/'){res.end('<title>Synthetic archive probe</title>');return;}
    if(req.url==='/probe-worker.js'){res.end(workerText);return;}
    if(req.url==='/probe-client.js'){res.end(clientText);return;}
    const files={'/fflate.js':'node_modules/fflate/esm/browser.js','/db.js':'src/db.js','/session-lifecycle.js':'src/session-lifecycle.js','/storage-diagnostics.js':'src/storage-diagnostics.js'};
    if(!files[req.url]){res.writeHead(404);res.end();return;}
    try{res.end(await fs.readFile(path.join(root,files[req.url]),'utf8'));}catch(e){res.writeHead(500);res.end(String(e));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const bundled=path.join(root,'.playwright-browsers/chromium-1254/chrome-win64/chrome.exe');
    const executablePath=process.env.CHROME_BIN||await fs.access(bundled).then(()=>bundled,()=>chromium.executablePath());
    browser=await chromium.launch({headless:true,executablePath});
    const context=await browser.newContext(), page=await context.newPage();
    await page.goto('http://127.0.0.1:'+server.address().port);
    return await page.evaluate(async()=>{
      const f=await import('/fflate.js'),db=await import('/db.js'),out={userAgent:navigator.userAgent};
      const rnd=x=>Math.round(x*100)/100;
      out.cspViolations=[];addEventListener('securitypolicyviolation',e=>out.cspViolations.push({directive:e.effectiveDirective,blocked:e.blockedURI}));
      try{
        out.asyncZipDeflate=await new Promise((resolve,reject)=>{
          let item;const timer=setTimeout(()=>{item?.terminate?.();reject(new Error('timeout'));},1500);
          try{item=new f.AsyncZipDeflate('probe.bin',{level:6});item.ondata=(e,b,last)=>{if(e||last){clearTimeout(timer);item.terminate?.();e?reject(e):resolve({success:true});}};item.push(new Uint8Array(100000),true);}
          catch(e){clearTimeout(timer);item?.terminate?.();reject(e);}
        });
      }catch(e){out.asyncZipDeflate={success:false,error:String(e)};}
      const bytes=new Uint8Array(2000000);let seed=17;
      for(let i=0;i<bytes.length;i++){seed=Math.imul(seed,1664525)+1013904223|0;bytes[i]=32+((seed>>>16)%90);}
      let timerFired=false;const t0=performance.now(),timer=new Promise(r=>setTimeout(()=>{timerFired=true;r(performance.now()-t0);},0));
      const start=performance.now();const zip=new f.Zip(e=>{if(e)throw e;});const item=new f.ZipDeflate('probe.bin',{level:6});zip.add(item);item.push(bytes,true);zip.end();
      out.syncZip={inputBytes:bytes.length,pushAndEndMs:rnd(performance.now()-start),timerFiredBeforeReturn:timerFired,timerDelayMs:rnd(await timer)};
      const ds=performance.now();await crypto.subtle.digest('SHA-256',bytes);out.digest2MBMs=rnd(performance.now()-ds);
      const worker=await import('/probe-client.js');let ticks=0;const interval=setInterval(()=>ticks++,1),ws=performance.now();
      try{const zipped=await worker.run(bytes.slice());const actual=f.inflateSync(zipped);out.selfModuleWorker={success:actual.length===bytes.length&&actual.every((v,i)=>v===bytes[i]),elapsedMs:rnd(performance.now()-ws),intervalTicks:ticks};}
      finally{clearInterval(interval);}
      try{
        const stream=new CompressionStream('deflate-raw'),writer=stream.writable.getWriter();let total=0;
        const csStart=performance.now(),reading=(async()=>{for await(const chunk of stream.readable)total+=chunk.length;})();
        for(let offset=0;offset<bytes.length;offset+=65536)await writer.write(bytes.subarray(offset,offset+65536));
        await writer.close();await reading;out.compressionStream={success:true,elapsedMs:rnd(performance.now()-csStart),compressedBytes:total};
      }catch(e){out.compressionStream={success:false,error:String(e)};}
      const nativeDb=await db.openDB(),sessionId='synthetic-probe',count=600,text='x'.repeat(20000);
      await new Promise((resolve,reject)=>{const tx=nativeDb.transaction(['sessions','events'],'readwrite');
        tx.objectStore('sessions').put({id:sessionId,status:'ready',startedAt:1});
        for(let seq=1;seq<=count;seq++)tx.objectStore('events').put({id:'probe-'+seq,sessionId,seq,time:seq,kind:'synthetic.bulk',payload:{text}});
        tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error);
      });
      out.idb=[];
      for(const limit of [20,200]){let after=0,pages=0,n=0;const start=performance.now();
        while(true){const batch=await db.eventPage(sessionId,after,limit);pages++;if(!batch.length)break;n+=batch.length;after=batch.at(-1).seq;}
        out.idb.push({limit,events:n,pages,payloadUtf16Units:text.length*count,elapsedMs:rnd(performance.now()-start)});
      }
      return out;
    });
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
}
chain(64);
const result={sampledAt:new Date().toISOString(),syntheticOnly:true,chains:[256,512,1024,2048].map(chain),fragments:[16,64,128].map(fragments)};
if(process.argv.includes('--browser'))result.browser=await nativeBrowser();
console.log(JSON.stringify(result,null,2));
