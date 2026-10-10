import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { callDom, fakeTimers } from './helpers/call-dom.js';
const sources = await Promise.all(['bearings-view.js', 'bearings-patch.js', 'bearings-dismiss.js'].map(name => readFile(new URL(`../public/${name}`, import.meta.url), 'utf8')));
const chat = { key: 'chat:0000000000000001', rev: 'chat-one', type: 'chat', kind: 'approval', marker: 'APPROVAL NEEDED', summary: 'Publish synthetic notes. Reply "publish".', replies: ['publish'], answer: { options: [] } };
const hold = { key: 'decision:sample-hold', rev: 'hold-one', type: 'decision', summary: 'Choose the sample window' };
const model = cards => ({ cards, rev: cards.map(c => c.rev).join('|'), state: 'ready' });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(fetchImpl) {
  const { document } = callDom(), timers = fakeTimers();
  const window = { document, matchMedia: () => ({ matches: false }) };
  for (const source of sources) vm.runInNewContext(source, { window, URL });
  const section = document.createElement('section'), list = document.createElement('div'), status = document.createElement('p'), outside = document.createElement('button');
  section.append(status, list); document.body.append(section, outside);
  let controller;
  const patcher = window.bearingsPatch.createCallPatcher({ section, list, status, timers, win: window, onRender: node => controller?.render(node), onApply: m => controller?.prune(m.cards.map(c => c.key)) });
  controller = window.bearingsDismiss.createDismissController({ list, fetchImpl, focusTarget: () => outside, doc: document, onDismiss: key => { if (patcher.tracker.state().selected === key) patcher.tracker.deselect(); } });
  patcher.update(model([chat, hold]));
  const node = key => list.children.find(n => n.getAttribute('data-call-key') === key);
  return { document, timers, list, outside, patcher, controller, node, button: name => node(chat.key).querySelector(`[data-call-dismiss${name ? `-${name}` : ''}]`) };
}

test('dismiss review and cancel are local, controls do not select, confirmed dismissal releases focus and preserves unsent text', async () => {
  const calls = [];
  const s = setup(async (url, options) => { calls.push([url, JSON.parse(options.body)]); s.patcher.update(model([hold])); return { ok: true }; });
  const field = s.node(chat.key).querySelector('[data-call-draft="answer"]');
  field.type('Unsent synthetic note');
  s.button('').click();
  assert.equal(s.patcher.tracker.state().selected, null);
  assert.equal(s.button('confirm').hidden, false);
  assert.equal(s.document.activeElement, s.button('send'));
  assert.equal(calls.length, 0);
  s.button('cancel').click();
  assert.equal(s.document.activeElement, s.button(''));
  assert.equal(s.button('confirm').hidden, true);
  s.button('').click(); s.button('send').click(); s.button('send').click();
  await flush();
  assert.deepEqual(calls, [['/api/bearings/dismiss', { key: chat.key, cardRev: chat.rev }]]);
  assert.equal(s.document.activeElement, s.outside);
  s.timers.advance(600);
  assert.equal(s.node(chat.key), undefined);
  assert.match(s.list.querySelector('[data-call-stub]').textContent, /Unsent synthetic note/);
  assert.equal(s.node(hold.key).isConnected, true);
  s.controller.destroy(); s.patcher.destroy();
});

test('dismiss errors return to review; a changed card invalidates its earlier review', async () => {
  const s = setup(async () => ({ ok: false, json: async () => ({ error: 'Synthetic save failed' }) }));
  s.button('').click(); s.button('send').click(); await flush();
  assert.equal(s.button('confirm').hidden, true);
  assert.equal(s.button('error').textContent, 'Synthetic save failed');
  assert.equal(s.document.activeElement, s.button(''));
  s.button('').click();
  s.patcher.update(model([{ ...chat, rev: 'changed-chat', summary: 'A changed synthetic ask' }, hold]));
  s.outside.focus(); s.timers.advance(600);
  assert.equal(s.button('confirm').hidden, true);
  assert.match(s.button('error').textContent, /call changed/);
  s.controller.destroy(); s.patcher.destroy();
});

test('a card that changes after Cancel shows no stale-review error', async () => {
  const s = setup(async () => ({ ok: true }));
  s.button('').click(); s.button('cancel').click();
  s.patcher.update(model([{ ...chat, rev: 'changed-chat', summary: 'A changed synthetic ask' }, hold]));
  s.outside.focus(); s.timers.advance(600);
  assert.equal(s.button('confirm').hidden, true);
  assert.equal(s.button('error').hidden, true);
  s.controller.destroy(); s.patcher.destroy();
});

test('chat cards arrive and resolve immediately while another card is engaged, without stealing focus', async () => {
  let finish;
  const s = setup(() => new Promise(resolve => { finish = resolve; }));
  s.patcher.update(model([hold])); s.timers.advance(320);
  const held = s.node(hold.key);
  held.querySelector('textarea').type('Protected hold draft');
  assert.equal(s.patcher.update(model([chat, hold])), 'applied');
  assert.ok(s.node(chat.key));
  s.outside.focus(); s.timers.advance(600);
  assert.equal(s.node(hold.key), held);
  assert.match(s.node(chat.key).textContent, /Approval · Chat ask/);
  assert.match(s.node(chat.key).textContent, /Publish synthetic notes/);
  s.button('').click(); s.button('send').click();
  held.querySelector('textarea').focus();
  s.timers.advance(600); // Finish the dismissed chat's own focus-release grace.
  s.patcher.update(model([hold])); finish({ ok: true }); await flush();
  assert.equal(s.document.activeElement, held.querySelector('textarea'));
  assert.equal(s.patcher.held, false);
  const leaving = s.node(chat.key);
  s.outside.focus(); s.timers.advance(600);
  assert.equal(leaving.classList.contains('call-card-leaving'), true);
  s.timers.advance(320);
  assert.equal(leaving.isConnected, false);
  assert.equal(held.querySelector('textarea').value, 'Protected hold draft');
  s.controller.destroy(); s.patcher.destroy();
});
