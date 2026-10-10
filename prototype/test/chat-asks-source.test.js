import assert from 'node:assert/strict';
import test from 'node:test';
import { createCallSource } from '../chat-asks.js';
import { fakeTimers } from './helpers/call-dom.js';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const ask = { key: 'chat:0000000000000001', kind: 'approval', marker: 'APPROVAL NEEDED', text: 'Approve sample-task. Reply "approve".', replies: ['approve'], at: '2030-01-02T10:00:00Z', source: 'claude-main-session/synthetic', offset: 0, part: 0, linkedTasks: [] };
function fixture(options = {}) {
  const timers = fakeTimers(), hubListeners = new Set(), links = [];
  let base = { rev: 'base', cards: [], state: 'ready', coverage: {}, omitted: [] }, asks = [], scans = 0, closes = 0;
  const hub = {
    current: () => base,
    subscribe(listener) { hubListeners.add(listener); return () => hubListeners.delete(listener); },
    close() { closes++; },
  };
  const chat = {
    asks: () => asks,
    view: () => ({ state: 'ready', sources: [], checkedAt: String(scans) }),
    async scan() { scans++; },
    async applySnapshot(cards, fresh) {
      const tasks = cards.map(card => card.task).filter(Boolean);
      links.push([cards, fresh]);
      asks = asks.map(entry => ({ ...entry, linkedTasks: tasks.includes('sample-task') ? ['sample-task'] : entry.linkedTasks }));
    },
    async resolve(key) { const before = asks.length; asks = asks.filter(entry => entry.key !== key); return asks.length !== before; },
  };
  const source = createCallSource({ hub, chat, timers, ...options });
  return { source, timers, links, hubListeners, scans: () => scans, closes: () => closes, setAsks: value => { asks = value; }, async publish(model, type = 'model') { base = model; for (const listener of hubListeners) await listener({ type }); }, base: () => base };
}

test('durable answers hydrate a fresh viewer and disappear with the snapshot call', async () => {
  const card = { key: 'decision:sample', task: 'sample', type: 'decision', rev: 'hold-rev', summary: 'Synthetic call', answer: { question: 'sample' } };
  const body = '\n```json fm-bearings-answer\n' + JSON.stringify({ schema: 'fm-bearings-answer.v1', channel: 'quarterdeck', type: 'decision', question: 'sample', cardRev: 'hold-rev' }) + '\n```';
  let reads = 0;
  const f = fixture({ home: '/synthetic', receipts: async () => { reads++; return { pending: [{ request_id: 'quarterdeck-call:sample', body }], handled: [], replies: [] }; } });
  await f.publish({ ...f.base(), cards: [card] });
  const before = f.source.current().rev;
  await f.source.refresh();
  assert.equal(f.source.current().cards[0].answered, true);
  assert.notEqual(f.source.current().rev, before);
  await f.source.refresh();
  assert.equal(reads, 1, 'receipt reads are bounded to one per 15 seconds');
  const stop = f.source.subscribe(() => {}); await flush();
  await f.publish({ ...f.base(), cards: [] });
  assert.deepEqual(f.source.current().cards, []);
  stop(); f.source.close();
});

test('scans emit model only for changed content and stay silent otherwise; hub evidence is forwarded', async () => {
  const f = fixture(), events = [];
  const stop = f.source.subscribe(event => events.push(event)); await flush();
  assert.deepEqual(events, []);
  f.setAsks([ask]); f.timers.advance(3000); await flush();
  assert.deepEqual(events.map(event => event.type), ['model']);
  const rev = events.at(-1).model.rev;
  f.timers.advance(9000); await flush();
  assert.equal(events.length, 1);
  assert.equal(f.source.current().rev, rev);
  await f.publish({ ...f.base(), checkedAt: '2030-01-02T10:01:00Z' }, 'observed');
  assert.equal(events.at(-1).type, 'observed');
  assert.equal(events.at(-1).checkedAt, '2030-01-02T10:01:00Z');
  stop(); f.source.close();
});

test('source owns one interval while subscribed, stops at last unsubscribe, and close closes the hub', async () => {
  const f = fixture();
  const stopA = f.source.subscribe(() => {}), stopB = f.source.subscribe(() => {}); await flush();
  assert.equal(f.timers.pending(), 1);
  assert.equal(f.hubListeners.size, 1);
  stopA(); f.timers.advance(3000); await flush();
  const scans = f.scans(); assert.ok(scans > 1);
  stopB(); assert.equal(f.timers.pending(), 0); assert.equal(f.hubListeners.size, 0);
  f.timers.advance(9000); await flush(); assert.equal(f.scans(), scans);
  f.source.subscribe(() => {}); await flush();
  f.source.close(); assert.equal(f.closes(), 1); assert.equal(f.timers.pending(), 0); assert.equal(f.hubListeners.size, 0);
});

test('hub model events re-apply linking before publishing; own resolutions push immediately', async () => {
  const f = fixture(), events = [];
  f.setAsks([ask]); const stop = f.source.subscribe(event => events.push(event)); await flush();
  assert.equal(f.source.current().cards[0].type, 'chat');
  await f.publish({ ...f.base(), cards: [{ key: 'decision:sample-task', rev: 'hold-rev', task: 'sample-task', type: 'decision', summary: 'Approve sample rollout' }] });
  assert.deepEqual(f.links.at(-1), [f.base().cards, true]);
  assert.equal(events.at(-1).type, 'model');
  assert.equal(events.at(-1).model.cards.length, 1);
  assert.equal(events.at(-1).model.cards[0].chatAsks[0].key, ask.key);
  assert.equal(await f.source.resolveChat(ask.key, 'dismissed'), true);
  assert.equal(events.at(-1).type, 'model');
  assert.equal(events.at(-1).model.cards[0].chatAsks, undefined);
  stop(); f.source.close();
});
