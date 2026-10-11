import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// Independently authored synthetic selected-source regression; no live data or account APIs.
const root = path.resolve(import.meta.dirname, '../..');
const moduleAt = name => import(pathToFileURL(path.join(root, 'prototype', name)));
const { createServer } = await moduleAt('server.js');
const { claudeProjectDirectory } = await moduleAt('claude-transcript.js');
const { acquireFixturePage, waitForBrowserPort, cleanupBrowserProfile } = await moduleAt('scripts/browser-harness.mjs');
const head = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
assert.equal(execFileSync('git', ['status','--porcelain'], {encoding:'utf8'}).trim(), '');
const temp = await mkdtemp(path.join(os.tmpdir(), 'qd-terminal-diagnosis-'));
const home = path.join(temp,'home'), config = path.join(temp,'claude');
for (const dir of ['data','state']) await mkdir(path.join(home,dir), {recursive:true});
await writeFile(path.join(home,'data/projects.md'), '- Demo - Synthetic lane\n');
await writeFile(path.join(home,'state/.lock-session'), 'selected-primary\n');
const directory = claudeProjectDirectory(config,home);
await mkdir(directory,{recursive:true});
const transcript = path.join(directory,'selected-primary.jsonl');
const record = (type,text,extra={}) => ({type,timestamp:'2030-05-06T10:00:00Z',sessionId:'different-record-session',session_id:'different-legacy-session',sessionKind:'bg',isSidechain:false,origin:{kind:'human'},message:{role:type,content:text},...extra});
const records = [
  record('user','Synthetic terminal input'),
  record('assistant','Synthetic visible reply',{origin:undefined,message:{role:'assistant',content:[{type:'text',text:'Synthetic visible reply'}],stop_reason:'end_turn'}}),
  {type:'attachment',timestamp:'2030-05-06T10:01:00Z',attachment:{type:'queued_command',origin:{kind:'human'},prompt:'Synthetic queued input'}},
  record('user','Synthetic relayed instruction'),
  record('user','FIRSTMATE_OP: Synthetic control'),
  record('user','MAIN DIALOG MIRROR Synthetic control'),
  record('user','<task-notification>Synthetic human-marked notice</task-notification>'),
  record('user','Synthetic unmarked input',{origin:undefined}),
  record('user','Synthetic meta input',{isMeta:true}),
  record('user','Synthetic sidechain input',{isSidechain:true}),
  record('user','Synthetic background notice',{origin:{kind:'task-notification'}}),
  {type:'attachment',timestamp:'2030-05-06T10:02:00Z',attachment:{type:'queued_command',origin:{kind:'task-notification'},prompt:'Synthetic queued machine prompt'}},
];
const save = () => writeFile(transcript,records.map(JSON.stringify).join('\n')+'\n');
await save();
await writeFile(path.join(directory,'unselected.jsonl'), JSON.stringify(record('user','Synthetic unselected session'))+'\n');
const other = claudeProjectDirectory(config,path.join(temp,'other-home'));
await mkdir(other,{recursive:true});
await writeFile(path.join(other,'selected-primary.jsonl'), JSON.stringify(record('user','Synthetic other home'))+'\n');
const server = createServer({FM_HOME:home,CLAUDE_CONFIG_DIR:config,FM_QUARTERDECK_STATE_PATH:path.join(temp,'presentation.json')},{quotaReader:async()=>({providers:[],stale:false,error:'Offline fixture'}),costReader:async()=>({azure:{state:'unavailable'},github:{state:'unavailable'}})});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const env={...process.env,HOME:temp,CHROME_DEVTOOLS_AXI_SESSION:`qd-terminal-${process.pid}`,CHROME_DEVTOOLS_AXI_HEADED:'0',CHROME_DEVTOOLS_AXI_USER_DATA_DIR:path.join(temp,'profile'),CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS:'60000'};
for(const k of ['CHROME_DEVTOOLS_AXI_AUTO_CONNECT','CHROME_DEVTOOLS_AXI_BROWSER_URL','CHROME_DEVTOOLS_AXI_MCP_SERVER_URL'])delete env[k];
const profile=path.join(temp,'profile');await mkdir(profile,{recursive:true});
const chrome=spawn(process.env.CHROMIUM||'chromium',['--headless=new','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-first-run','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'],{stdio:['ignore','ignore','pipe']});
let spawnError,diagnostics='';chrome.on('error',e=>{spawnError=e});chrome.stderr.on('data',c=>{diagnostics=(diagnostics+c).slice(-2000)});
const exec=promisify(execFile);
const browser=async(...args)=>(await exec('chrome-devtools-axi',args,{env,timeout:45000,maxBuffer:1024*1024})).stdout;
const evaluate=async js=>{
 const output=await browser('eval',js);
 if(/isError":\s*true|Error:|Exception:|^error:/m.test(output)) throw Error(output);
 return output;
};
const until=condition=>evaluate(`async()=>{for(let i=0;i<100;i++){if(${condition})return 'ready';await new Promise(r=>setTimeout(r,100));}throw Error('bounded readiness timeout');}`);
const shown=`[...document.querySelectorAll('article.message')].map(n=>({text:n.querySelector('.message-content')?.innerText.trim(),author:n.querySelector('header strong')?.textContent,kind:n.querySelector('.message-origin')?.textContent,captain:n.classList.contains('captain')}))`;
const assertInPage=expression=>evaluate(`()=>{if(!(${expression}))throw Error('counterfactual failed');return 'PASS';}`);
try {
 const port=await waitForBrowserPort(chrome,profile,{spawnError:()=>spawnError,diagnostics:()=>diagnostics});env.CHROME_DEVTOOLS_AXI_BROWSER_URL=`http://127.0.0.1:${port}`;
 await acquireFixturePage(browser,base+'/#lanes',head);
 await until(`document.querySelectorAll('article.message').length===4`);
 const api=await (await fetch(base+'/api/lanes?format=refs.v1&windowBytes=1048576')).json();
 const input=api.messages.find(m=>m.text==='Synthetic terminal input');assert.deepEqual([input.role,input.kind,input.author],['input','input','Claude session input']);assert.equal(input.primaryHumanInput,true);
 assert.ok(api.lanes.some(l=>l.messages.includes(api.messages.indexOf(input))));
 for(const m of api.messages.filter(m=>m.text.includes('Synthetic') && !['Synthetic terminal input','Synthetic relayed instruction','Synthetic queued input'].includes(m.text))) assert.equal(m.primaryHumanInput,undefined,'nonconversation/unmarked records are outside the new display subset');
 for(const text of ['Synthetic meta input','Synthetic sidechain input','Synthetic queued machine prompt','Synthetic unselected session','Synthetic other home','FIRSTMATE_OP: Synthetic control'])assert.ok(!api.messages.some(m=>m.text===text),text);
 const primary = `${shown}.filter(n=>n.kind==='primary session input (unverified)')`;
 await assertInPage(`${primary}.length===3 && ${primary}.every(n=>n.author==='Claude session input'&&!n.captain)`);
 await assertInPage(`${shown}.every(n=>['Synthetic terminal input','Synthetic relayed instruction','Synthetic queued input','Synthetic visible reply'].includes(n.text))`);
 console.log('PASS actual reader/API/refs/render: selected human-marked input and queued input default-visible and explicitly unverified; record-session/bg metadata grants no authority; isolation/exclusion controls absent');
 if(process.env.SCREENSHOT_DIR) await browser('screenshot',path.join(process.env.SCREENSHOT_DIR,'primary-input-default.png'));
 // An explicit opt-out stays an opt-out and explains how to show this subset again.
 await evaluate(`()=>document.querySelector('#message-type-filters input[value="primary-input"]').click()`);
 await until(`${shown}.length===1 && !document.querySelector('#primary-input-filter-status').hidden`);
 await acquireFixturePage(browser,base+'/#lanes',head);
 await until(`${shown}.length===1 && !document.querySelector('#primary-input-filter-status').hidden`);
 await assertInPage(`!document.querySelector('#message-type-filters input[value="primary-input"]').checked`);
 if(process.env.SCREENSHOT_DIR) await browser('screenshot',path.join(process.env.SCREENSHOT_DIR,'primary-input-hidden.png'));
 await evaluate(`()=>document.querySelector('#show-primary-input').click()`);
 await until(`${primary}.length===3 && document.querySelector('#primary-input-filter-status').hidden`);
 console.log('PASS explicit opt-out survives fresh load; notice action restores only primary input without Captain promotion or general input exposure');
 // Old saved omissions are not mistaken for an untouched default.
 await evaluate(`()=>{localStorage.removeItem('fm-agentos-message-types-v3');localStorage.setItem('fm-agentos-message-types-v2',JSON.stringify(['captain','conversation','supervision']));}`);
 await acquireFixturePage(browser,base+'/#lanes',head);
 await until(`${shown}.length===1 && !document.querySelector('#primary-input-filter-status').hidden`);
 await evaluate(`()=>document.querySelector('#show-primary-input').click()`);
 await until(`${primary}.length===3`);
 console.log('PASS legacy saved set is respected; primary input remains explicitly discoverable');
 // Actual source/search intersections still apply to this display kind.
 await evaluate(`()=>{const search=document.querySelector('#transcript-search');search.value='unmatched';search.dispatchEvent(new Event('input',{bubbles:true}));}`);
 await until(`document.querySelectorAll('article.message').length===0 && document.querySelector('#primary-input-filter-status').hidden`);
 await evaluate(`()=>{const search=document.querySelector('#transcript-search');search.value='';search.dispatchEvent(new Event('input',{bubbles:true}));}`);
 await until(`${primary}.length===3`);
 console.log('PASS actual rendered search intersection remains in force');
 // Disconfirm filename/sessionKind hypotheses one field at a time.
 for(const [field,value] of [['sessionId','selected-primary'],['sessionKind','foreground']]) {
  records[0][field]=value;await save();
  const next=await (await fetch(base+'/api/lanes?format=refs.v1&windowBytes=1048576')).json();
  const target=next.messages.find(m=>m.text==='Synthetic terminal input');assert.deepEqual([target.role,target.kind,target.author],['input','input','Claude session input']);assert.equal(target.primaryHumanInput,true);
  console.log(`PASS disconfirmer: changing ${field} alone does not change unverified API identity or selected-source display provenance`);
 }
 console.log('EXACT SYNTHETIC REVISION '+head+'; headless browser via chrome-devtools-axi, not live/phone acceptance');
} finally {
 try{await browser('stop')}catch(e){console.error('own axi cleanup: '+e.message)}
 await cleanupBrowserProfile(chrome,profile);
 await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});
}
