import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createQuotaReader} from '../quota.js';
import {attachPanelResize, quotaAvailableHeight} from '../public/panel-resize.js';
const window = {};
vm.runInNewContext(await readFile(new URL('../public/quota-view-model.js', import.meta.url),'utf8'), {window});
const {project} = window.quotaViewModel;
const now = Date.parse('2030-01-01T00:00:00Z');
const provider = (name, percent, reserve, extra={}) => ({provider:name, refreshedAt:new Date(now).toISOString(), scopes:[],windows:[{id:'session',percentRemaining:percent,pace: reserve === null ? {status:'unknown'} : {status:'behind',reservePercentPoints:reserve}}],...extra});

test('sidebar sorts captured remaining both ways, source pace runway differs, stale/unknown last',()=>{
 const providers=[provider('codex',50,49),provider('claude',80,-19),provider('cursor',100,60,{stale:true}),provider('grok',20,null)];
 const order=sort=>Array.from(project({providers},{now,sidebarSort:sort}).sidebar,f=>f.provider);
 assert.deepEqual(order('highest'),['claude','codex','grok','cursor']);
 assert.deepEqual(order('lowest'),['grok','codex','claude','cursor']);
 assert.deepEqual(order('runway'),['codex','claude','cursor','grok']);
 assert.deepEqual(order('runway-lowest'),['claude','codex','cursor','grok']);
 const result=project({providers},{now,sidebarSort:'runway'}).sidebar;
 assert.equal(result[0].sortRunway.value,49);
 assert.equal(result[0].sortRunway.basis,'source pace');
 assert.equal(result[2].sortRunway,null);
 assert.equal(result[3].sortRunway,null);
 assert.equal(providers[2].windows[0].percentRemaining,100);
 assert.deepEqual(order('source'),['codex','claude','cursor','grok']);
 assert.deepEqual(order('az'),['claude','codex','cursor','grok']);
 assert.deepEqual(order('za'),['grok','cursor','codex','claude']);
});

test('runway fallback needs source runway and unambiguous future reset bounds; no estimates from percentages',()=>{
 const make=(status,seconds,resetsAt)=>provider('codex',50,null,{scopes:[{scope:'all_models',boundedBy:['session'],runway:{status,seconds}}],windows:[{id:'session',percentRemaining:50,resetsAt}]});
 const reset=new Date(now+600000).toISOString();
 const score=p=>project({providers:[p]},{now,sidebarSort:'runway'}).sidebar[0].sortRunway;
 assert.equal(score(make('through_reset',null,reset)).value,0);
 assert.equal(score(make('projected_exhaustion',300,reset)).value,-50);
 assert.equal(score(make('exhausted_now',0,reset)).value,-100);
 assert.equal(score(make('unknown',300,reset)),null);
 assert.equal(score(make('projected_exhaustion',300,null)),null);
 assert.equal(score(make('projected_exhaustion',300,new Date(now-1).toISOString())),null);
 assert.equal(score({...make('through_reset',null,reset),stale:true}),null);
});

test('auto size tracks content, clamps to available control space, manual size persists until reset',()=>{
 const previousWindow=globalThis.window, previousStyle=globalThis.getComputedStyle;
 globalThis.window={addEventListener(){}};
 globalThis.getComputedStyle=el=>el.style;
 const listeners={}, props=new Map(), values=new Map();
 const panel={style:{setProperty:(k,v)=>props.set(k,v),getPropertyValue:k=>props.get(k)||'',removeProperty:k=>props.delete(k)}};
 const handle={setAttribute(){},addEventListener:(name,fn)=>listeners[name]=fn};
 const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
 let content=90, max=400;
 try {
  const refresh=attachPanelResize({panel,handle,property:'height',key:'quota',direction:'vertical',initial:220,min:()=>Math.min(64,max),maximum:()=>max,automatic:()=>content,storage,desktop:{matches:true}});
  assert.equal(props.get('height'),'90px');
  content=700; refresh(); assert.equal(props.get('height'),'400px');
  listeners.keydown({key:'ArrowDown',preventDefault(){}}); assert.equal(values.get('quota'),'380');
  content=90; refresh(); assert.equal(props.get('height'),'380px');
  max=200; refresh(); assert.equal(props.get('height'),'200px'); assert.equal(values.get('quota'),'380');
  listeners.keydown({key:'Home',preventDefault(){}}); assert.equal(props.get('height'),'90px'); assert.equal(values.has('quota'),false);
  assert.equal(quotaAvailableHeight(900,32,[60,330,80]),398);
  assert.equal(quotaAvailableHeight(300,32,[60,330,80]),0);
 } finally {globalThis.window=previousWindow;globalThis.getComputedStyle=previousStyle;}
});

test('quota cold start has bounded longer timeout, failed reads retry after five seconds and coalesce',async()=>{
 let clock=0, calls=[], release;
 const reader=createQuotaReader({now:()=>clock,execute:async(...args)=>{calls.push(args);if(calls.length===1)throw new Error('cold start');return new Promise(r=>release=()=>r({stdout:JSON.stringify({schemaVersion:5,providers:[]})}));}});
 assert.match((await reader()).error,/unavailable/);
 assert.equal(calls[0][2].timeout,15000);
 assert.equal(calls[0][2].maxBuffer,1024*1024);
 clock=4999; await reader(); assert.equal(calls.length,1);
 clock=5000; const a=reader(),b=reader(); await new Promise(r=>setImmediate(r)); assert.equal(calls.length,2);
 assert.equal(calls[1][2].timeout,6000);release();assert.deepEqual(await a,await b);
 clock+=59999;await reader();assert.equal(calls.length,2);
});

test('failed refresh retains last good evidence stale while retrying on short backoff',async()=>{
 let clock=100000,calls=0;
 const reader=createQuotaReader({now:()=>clock,run:async()=>{calls++; if(calls===2)throw new Error('failed');return {stdout:JSON.stringify({schemaVersion:5,providers:[{provider:'codex',state:{status:'fresh'},windows:[{id:'session',label:'Session',kind:'session',percentRemaining:42}],quotaSemantics:{effectiveAvailability:[]}}]})};}});
 const good=await reader();clock+=60000;
 const stale=await reader();assert.equal(stale.stale,true);assert.deepEqual(stale.providers,good.providers);
 clock+=4999;assert.equal((await reader()).stale,true);assert.equal(calls,2);
 clock++;assert.equal((await reader()).stale,false);assert.equal(calls,3);
});
