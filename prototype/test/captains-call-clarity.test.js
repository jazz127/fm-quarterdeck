import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { classifyAnsweredCalls } from '../answered-calls.js';
import { createThreadRelay, formatThreadNote, threadRequestId } from '../bearings-thread.js';
import { createAnswerRelay } from '../bearings-answer.js';
import { currentCardNote } from '../receipt-provenance.js';

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const card = (task='sample-a',extra={}) => ({key:`decision:${task}`,type:'decision',task,rev:'presentation-a',summary:'Choose the sample window',answer:{question:task,options:[]},...extra});
const note = (c,n,id='note-shared',extra={}) => ({id,at:'2026-01-01T12:01:00Z',request_id:threadRequestId(c.key,uuid(n)),body:formatThreadNote({card:c,key:c.key,text:'Explain this call.',requestId:uuid(n)}),...extra});
const history = (c,data,turns=[]) => createThreadRelay({home:'/synthetic',receipts:async()=>data,transcript:async()=>({turns,omitted:true})}).history(c.key,{cards:[c]});
const data = (handled,replies) => ({pending:[],handled,replies});

test('optional cycle guard honors version, clock and legacy revision precedence without producing identities',()=>{
  const c=card('sample-a',{holdVersion:'current',clock:{at:'2026-01-01T12:00:00Z'}});
  for(const [envelope,at,expected] of [
    [{holdVersion:'old'},'2026-01-01T12:01:00Z',false],
    [{holdVersion:'current',cardRev:'different'},'2026-01-01T12:01:00Z',true],
    [{holdVersion:'current'},'2026-01-01T11:00:00Z',false],
    [{cardRev:c.rev},'2026-01-01T12:01:00Z',true],
    [{cardRev:'different'},'2026-01-01T12:01:00Z',false],
    [{},'2026-01-01T12:01:00Z',true],[{},null,false],
  ]) assert.equal(currentCardNote(c,envelope,at),expected);
  assert.equal(currentCardNote({...c,clock:{at:null}},{},'2026-01-01T12:01:00Z'),false);
  assert.equal(currentCardNote({...c,holdVersion:null},{},null),true,'unversioned source retains its existing behavior');
});

test('combined reply is provenance, not either card-specific reply; prose never chooses ownership', async () => {
  const a=card(), b=card('sample-b');
  for(const body of ['Item 1: Window A.\n\nItem 2: Board B.', 'Item 2: Board B.\n\nItem 1: Window A.', 'Same text.\n\nSame text.', 'No headings: Window A and Board B.']) {
    const receipts=data([note(a,1),note(b,2)],[{id:'note-shared',at:'2026-01-01T12:02:00Z',body}]);
    for(const c of [a,b]) {
      const classified=classifyAnsweredCalls([c],receipts)[0];
      assert.equal(classified.sentReceipt,'replied');
      assert.equal(classified.sentReply,undefined);
      assert.equal(classified.sentReplyScope,'combined');
      const h=await history(c,receipts);
      assert.deepEqual(h.entries.map(e=>e.kind),['ask']);
      assert.equal(h.entries[0].state,'replied');
      assert.equal(h.entries[0].replyScope,'combined');
      assert.ok(h.provenance.some(e=>e.kind==='combined-reply'&&e.text===body));
    }
    assert.equal(receipts.replies[0].body,body,'original receipt bytes unchanged');
  }
});

test('individual reply stays exact; task-only mixed and older turns are separate contextual provenance', async()=>{
  const a=card();const receipts=data([note(a,1,'note-a')],[{id:'note-a',body:'Only the sample window.'}]);
  const h=await history(a,receipts,[{at:'2025-01-01T00:00:00Z',text:'sample-a: old scope. sample-b: unrelated choice.',source:'primary',offset:42,part:0}]);
  assert.deepEqual(h.entries.map(e=>e.kind),['ask','reply']);assert.equal(h.entries[1].text,'Only the sample window.');
  assert.equal(h.provenance[0].kind,'context');assert.match(h.provenance[0].text,/unrelated choice/);
  assert.equal(classifyAnsweredCalls([a],receipts)[0].sentReply,'Only the sample window.');
});

test('optional current-cycle identity excludes old history without resetting versioned accepted answers on presentation changes', async()=>{
  const a=card('sample-a',{holdVersion:'current',clock:{at:'2026-01-01T12:00:00Z'}});
  const old=note({...a,holdVersion:'old'},1,'old-note');
  const receipts=data([old],[{id:'old-note',body:'Previous choice.'}]);
  assert.equal(classifyAnsweredCalls([a],receipts)[0].sentReceipt,undefined);
  const h=await history(a,receipts);assert.equal(h.entries.length,0);assert.equal(h.provenance.length,2);
  const answer={id:'answer-note',at:'2026-01-01T12:01:00Z',request_id:`quarterdeck-call:${uuid(3)}`,body:'\n```json fm-bearings-answer\n'+JSON.stringify({schema:'fm-bearings-answer.v1',channel:'quarterdeck',type:'decision',task:a.task,question:a.task,holdVersion:'current',cardRev:'old-presentation'})+'\n```'};
  assert.equal(classifyAnsweredCalls([{...a,rev:'new-presentation'}],data([answer],[]))[0].answered,true);
  const olderClock={...answer,at:'2026-01-01T11:00:00Z'};
  assert.equal(classifyAnsweredCalls([a],data([olderClock],[]))[0].answered,undefined);
  const other=card('other-home/sample-a',{holdVersion:'current',clock:a.clock});assert.equal((await history(other,data([answer],[]))).entries.length,0);
});

test('answer status preserves shared reply posture without leaking shared content to local answer echo',async()=>{
  const a=card();const b=card('sample-b');
  const make=(c,n)=>note(c,n,'shared-answer',{request_id:`quarterdeck-call:${uuid(n)}`,body:'\n```json fm-bearings-answer\n'+JSON.stringify({schema:'fm-bearings-answer.v1',channel:'quarterdeck',type:'decision',task:c.task,question:c.task})+'\n```'});
  const receipts=data([make(a,1),make(b,2)],[{id:'shared-answer',body:'Two separate topics.'}]);
  const status=await createAnswerRelay({home:'/synthetic',receipts:async()=>receipts}).status([uuid(1)]);
  assert.equal(status.answers[uuid(1)].state,'replied');assert.equal(status.answers[uuid(1)].replyScope,'combined');assert.equal(status.answers[uuid(1)].reply,'');
});

test('recap presents literal source request/context/response guidance without thread disclosure; incomplete child source is honest',async()=>{
  const window={};vm.runInNewContext(await readFile(new URL('../public/bearings-view.js',import.meta.url),'utf8'),{window,URL});
  const c=card('sample-url',{boardTitle:'Sample Delivery',boardDecide:'Create a private board, then send its URL.',boardDetail:'Privacy must be explicit at creation. No board exists.',boardFreeformHint:'Send the exact URL.',reason:'Only the existing approved scope is allowed.'});
  const html=window.bearingsView.cardHtml(c);
  assert.match(html,/Source question \/ action/);assert.ok(html.includes(c.boardDecide));assert.ok(html.includes(c.boardDetail));assert.ok(html.includes(c.boardFreeformHint));
  assert.doesNotMatch(html,/More details|data-call-detail-full/);
  const child=window.bearingsView.cardHtml(card('sample-home/qualification',{answer:null,summary:'Qualification before a future release: Deferred…'}));
  assert.match(child,/complete question or response context/);assert.match(child,/does not establish whether action is needed now/);assert.doesNotMatch(child,/No action needed|Approve now|type="radio"/);
  assert.doesNotMatch(child,/Window A|Board B/,'historical replies do not create recaps');
});
