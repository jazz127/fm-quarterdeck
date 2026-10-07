// Exact-head local Chromium review keyboard acceptance (desktop and 390px).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
const app=createServer({ FM_DEPLOYMENT_TIER:'uat' });
await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${app.address().port}`;
const version=(await (await fetch(`${base}/api/review`)).json()).version;
const profile=await mkdtemp(path.join(process.cwd(),'.review-keyboard-chrome-'));
const chrome=spawn(process.env.CHROMIUM || "chromium",['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:'ignore'});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws;
try {
  let port;
  for(let i=0;i<100;i++){try{port=Number((await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).split('\n')[0]);break;}catch{await sleep(100);}}
  assert.ok(port,'Chromium ready');
  const pages=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws=new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let seq=0;const pending=new Map();
  ws.addEventListener('message',({data})=>{const r=JSON.parse(data);if(!pending.has(r.id))return;const [resolve,reject]=pending.get(r.id);pending.delete(r.id);r.error?reject(Error(JSON.stringify(r.error))):resolve(r.result);});
  const cmd=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,[resolve,reject]);ws.send(JSON.stringify({id,method,params}));});
  const evaluate=async expression=>{const r=await cmd('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.text);return r.result.value;};
  await cmd('Page.enable');
  for(const width of [1280,390]){
    await cmd('Emulation.setDeviceMetricsOverride',{width,height:844,deviceScaleFactor:1,mobile:width===390});
    await cmd('Page.navigate',{url:`${base}/?keyboard=${width}#work`});
    if(width===390){await sleep(400);await evaluate('sessionStorage.clear();location.reload()');}
    for(let i=0;i<100;i++){if(await evaluate(`document.querySelector('#review-context')?.textContent.includes(${JSON.stringify(version.slice(0,12))})`))break;await sleep(100);}
    const start=await evaluate(`(() => {const q=s=>document.querySelector(s);q('#review-panel-toggle').click();return {version:q('#review-context').textContent,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    assert.match(start.version,new RegExp(version.slice(0,12)));
    assert.equal(start.overflow,false);
    await evaluate(`(() => {const q=s=>document.querySelector(s),e=q('#review-message');e.value='Synthetic keyboard ${width}';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    for(let i=0;i<100;i++){if(await evaluate(`JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.length===1`))break;await sleep(100);}
    const accepted=await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return {sent:d.sent.length,retry:d.retryBatches.length,receipt:d.sent[0]?.receiptId};})()`);
    console.log(`${width}px initial result: ${JSON.stringify({...accepted, ...(await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return {retryId:d.retryBatches[0]?.id,status:document.querySelector('#review-state').textContent,thread:document.querySelector('#review-thread').textContent.slice(-160)}})()`))})}`);
    assert.equal(accepted.sent,1);assert.equal(accepted.retry,0);assert.match(accepted.receipt,/^local:/);
    // Captain's sequence on Work split: second Send Batch, then Send & End.
    await evaluate(`(() => {const e=document.querySelector('#review-message');e.value='Second ordinary Send ${width}';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#review-send').click();})()`);
    for(let i=0;i<100;i++){if(await evaluate(`JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.length===2`))break;await sleep(100);}
    const ordinary=await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return {sent:d.sent.length,retry:d.retryBatches.length,text:d.sent.at(-1)?.entries[0]?.text};})()`);
    assert.deepEqual(ordinary,{sent:2,retry:0,text:`Second ordinary Send ${width}`});
    await evaluate(`(() => {const e=document.querySelector('#review-message');e.value='Third Send & End ${width}';e.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#review-end').click();})()`);
    for(let i=0;i<100;i++){if(await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return !d.sent.length&&!d.retryBatches.length&&!d.queue.length;})()`))break;await sleep(100);}
    const ended=await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return {sent:d.sent.length,retry:d.retryBatches.length,queue:d.queue.length,overflow:document.documentElement.scrollWidth>innerWidth};})()`);
    assert.deepEqual(ended,{sent:0,retry:0,queue:0,overflow:false});
    // A genuine unconfirmed transport still retains the same ID and remains retryable.
    await evaluate(`(() => {const original=window.fetch;let fail=true;window.fetch=(url,options)=>{if(fail&&options?.method==='POST'&&url==='/api/review'){fail=false;return Promise.resolve(new Response(JSON.stringify({error:'synthetic transport failure'}),{status:502,headers:{'content-type':'application/json'}}));}return original(url,options);};const q=s=>document.querySelector(s);q('#review-panel-toggle').click();const e=q('#review-message');e.value='Retry scenario ${width}';e.dispatchEvent(new Event('input',{bubbles:true}));e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,bubbles:true,cancelable:true}));})()`);
    for(let i=0;i<100;i++){if(await evaluate(`JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).retryBatches.length===1`))break;await sleep(100);}
    const failed=await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return {sent:d.sent.length,id:d.retryBatches[0]?.id,enabled:!document.querySelector('#review-send').disabled};})()`);
    assert.equal(failed.sent,0);assert.ok(failed.id);assert.equal(failed.enabled,true);
    await evaluate(`document.querySelector('#review-message').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',metaKey:true,bubbles:true,cancelable:true}))`);
    for(let i=0;i<100;i++){if(await evaluate(`JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.length===1`))break;await sleep(100);}
    const retried=await evaluate(`(() => {const d=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));return {sent:d.sent.length,retry:d.retryBatches.length,id:d.sent.at(-1)?.id};})()`);
    assert.equal(retried.id,failed.id);assert.equal(retried.retry,0);
    console.log(`${width}px exact-head ${version}: Work split Ctrl Send, ordinary Send, durable Send & End, and same-ID failed-transport retry`);
  }
} finally {ws?.close();chrome.kill();app.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100}).catch(()=>{});}
