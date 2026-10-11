import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSnapshot } from '../bearings.js';
import { ThreadRefused, createThreadRelay, noteForCard, taggedEnvelope } from '../bearings-thread.js';
import { activeUntil, emptyProcrastination, nextUntil, procrastinationKey } from '../call-procrastination.js';

const uuid = (n = 1) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const refusal = code => error => error instanceof ThreadRefused && error.code === code;
const decision = { type: 'decision', rev: 'r1' };
const model = cards => ({ cards });
const empty = async () => ({ pending: [], handled: [], replies: [] });
const noTranscript = async () => ({ turns: [], omitted: false });

test('canonical child-home decisions retain their scoped identity without local keyed answers', () => {
  const child = owner => ({ id: `${owner}/example-app-release`, key: 'example-app-release', owner,
    verb: 'captain-hold', summary: 'Choose the example-app activation window' });
  const raw = { schema: 'fm-bearings.v1', generated: '2026-01-02T12:00:00Z',
    decisions_open: [{ id: 'example-app-release', owner: '(main)', summary: 'Choose the main release window' }, child('home-alpha'), child('home-beta')],
    contributions: { captain: [{ task: 'example-app-sibling', owner: '(main)', kind: 'pr',
      url: 'https://example.invalid/acme/example-app/pull/2', reason: 'checks green' }], known: 2, checked: 1, proven_clear: false },
    omitted: [{ surface: 'decisions_open showing 3 of 4' }] };
  const model = normalizeSnapshot(raw);
  assert.deepEqual(model.cards.map(card => card.key), ['decision:example-app-release',
    'decision:home-alpha/example-app-release', 'decision:home-beta/example-app-release', 'merge:example-app-sibling']);
  assert.equal(model.cards[0].answer.question, 'example-app-release');
  for (const card of model.cards.slice(1, 3)) {
    assert.equal(card.task, `${card.owner}/example-app-release`);
    assert.equal(card.summary, 'Choose the example-app activation window');
    assert.equal(card.answer, null, 'a child hold must not be answered as a selected-home keyed decision');
  }
  assert.deepEqual(model.omitted, [{ kind: 'decisions-bound', shown: 3, total: 4 }]);
  const removed = normalizeSnapshot({ ...raw, decisions_open: raw.decisions_open.filter(row => row.owner !== 'home-alpha') });
  assert(!removed.cards.some(card => card.owner === 'home-alpha'));
  assert(removed.cards.some(card => card.owner === 'home-beta'));
  assert(removed.cards.some(card => card.key === 'merge:example-app-sibling'));
});

test('a qualified decision requires the canonical owner and local key to agree', () => {
  const child = { id: 'home-alpha/example-app-release', key: 'example-app-release', owner: 'home-alpha', summary: 'Choose a window' };
  const malformed = [{ ...child, owner: '(main)' }, { ...child, owner: 'home-beta' },
    { ...child, key: 'another-task' }, { ...child, key: undefined },
    { ...child, id: 'home-alpha/../example-app-release' }];
  const raw = { schema: 'fm-bearings.v1', decisions_open: [child, ...malformed],
    contributions: { captain: [], known: 0, checked: 0, proven_clear: true }, omitted: [] };
  const model = normalizeSnapshot(raw);
  assert.deepEqual(model.cards.map(card => card.key), ['decision:home-alpha/example-app-release']);
  assert.deepEqual(model.omitted, [{ kind: 'invalid-rows', count: malformed.length }]);
});

test('child-decision thread notes retain home ownership and use the existing hashed inbox identity', async () => {
  const card = { ...decision, key: 'decision:home-alpha/example-app-release', task: 'home-alpha/example-app-release', owner: 'home-alpha', answer: null };
  const sibling = { ...card, key: 'decision:home-beta/example-app-release', task: 'home-beta/example-app-release', owner: 'home-beta' };
  const calls = [];
  const relay = createThreadRelay({ home: '/synthetic/home-alpha', note: async (_home, id, text) => {
    calls.push({ id, text }); return { id: 'note-1', outcome: 'created' };
  }, receipts: empty, transcript: noTranscript });
  const accepted = await relay.submit({ requestId: uuid(), key: card.key, text: 'What remains before activation?' }, model([card, sibling]));
  assert.equal(accepted.state, 'accepted');
  assert.match(calls[0].id, /^quarterdeck-thread:h-[0-9a-f]{16}:/);
  const envelope = taggedEnvelope(calls[0].text, 'fm-quarterdeck-thread');
  assert.equal(envelope.task, card.task);
  assert.equal(envelope.key, card.key);
  assert.match(calls[0].text, /nothing was decided/);
  const note = { id: 'note-1', request_id: calls[0].id, body: calls[0].text };
  assert.equal(noteForCard(note, sibling.key, sibling), null);
  for (const key of ['decision:home-alpha/../example-app-release', 'merge:home-alpha/example-app-release', 'decision:/example-app-release']) {
    await assert.rejects(relay.submit({ requestId: uuid(2), key, text: 'Context?' }, model([card])), refusal('invalid'));
  }
});

test('child decisions park independently without accepting qualified merge or path keys', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  const keys = ['decision:home-alpha/example-app-release', 'decision:home-beta/example-app-release'];
  const state = emptyProcrastination();
  for (const key of keys) {
    assert(procrastinationKey(key));
    state.until[key] = nextUntil(state, key, '3h', now);
  }
  assert.equal(state.until[keys[0]], '2026-01-02T15:00:00.000Z');
  assert.deepEqual(Object.keys(activeUntil(state, now, new Set([keys[1]]))), [keys[1]]);
  for (const key of ['merge:home-alpha/example-app-release', 'decision:home-alpha/../example-app-release', 'decision:/example-app-release']) {
    assert.equal(procrastinationKey(key), false);
  }
});
