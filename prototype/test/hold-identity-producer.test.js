import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { normalizeSnapshot, shortHash, contentRevision, createSnapshotRunner } from '../bearings.js';
import { classifyAnsweredCalls } from '../answered-calls.js';
import { answerEnvelope, formatAnswerNote, answerRequestId } from '../bearings-answer.js';
import { createThreadRelay, formatThreadNote, threadRequestId } from '../bearings-thread.js';

const hold = '2026-01-02T10:00:00Z';
const sent = '2026-01-02T11:00:00Z';
const later = '2026-01-02T12:00:00Z';
const uuid = '00000000-0000-4000-8000-000000000001';
const row = { id: 'sample', owner: '(main)', summary: 'Choose a window', reason: 'Choose staged or immediate', hold_set_at: hold };
const snapshot = (decisions = [row]) => ({ schema: 'fm-bearings.v1', decisions_open: decisions, contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] });
const card = (extra = {}) => normalizeSnapshot(snapshot([{ ...row, ...extra }])).cards[0];
const answer = (c, extra = {}) => ({ id: 'answer', request_id: answerRequestId(uuid), at: sent,
  body: formatAnswerNote({ ...answerEnvelope({ card: c, selection: '', note: 'Use staged' }, 'm1'), ...extra }) });
const win = {};
vm.runInNewContext(await readFile(new URL('../public/call-lifecycle.js', import.meta.url), 'utf8'), { window: win });

test('generated decision identity prefers full durable reason and keeps pre-addition presentation revisions', () => {
  const full = 'Full authored context. '.repeat(40) + 'Choose staged or immediate';
  const c = card({ backlogReason: full });
  assert.equal(c.holdVersion, shortHash([full, '2026-01-02T10:00:00.000Z']));
  const { rev, holdVersion, ...presentation } = c;
  assert.equal(rev, shortHash(presentation), 'adding cycle identity preserves the prior cardRev algorithm');
  assert.match(holdVersion, /^[0-9a-f]{16}$/);
  assert.equal(card().holdVersion, shortHash([row.reason, '2026-01-02T10:00:00.000Z']));
  assert.equal(card({ reason: undefined }).holdVersion, shortHash([row.summary, '2026-01-02T10:00:00.000Z']));
  assert.equal(card({ hold_set_at: undefined }).clock.at, null, 'unknown clock stays unknown');
  assert.equal(card({ hold_set_at: undefined }).holdVersion, shortHash([row.reason, null]));
});

test('cosmetic title/repo/options affect presentation, not hold identity; full reason and a same-reason new clock do', () => {
  const c = card();
  for (const extra of [{ title: 'A fuller title' }, { repo: 'example-app' }, { summary: 'A shortened recap' }, { board_detail: 'Presentation details' }, { options: [{ value: 'later', label: 'Later' }] }]) {
    const changed = card(extra);
    assert.equal(changed.holdVersion, c.holdVersion);
    assert.notEqual(changed.rev, c.rev);
  }
  assert.notEqual(card({ reason: row.reason + ' Keep full context.' }).holdVersion, c.holdVersion);
  assert.notEqual(card({ hold_set_at: later }).holdVersion, c.holdVersion);
  // Raw reasons that render identically still invalidate a receipt, not silently disappear in redaction.
  const a = normalizeSnapshot(snapshot([{ ...row, reason: 'See /synthetic/one/report.md' }]));
  const b = normalizeSnapshot(snapshot([{ ...row, reason: 'See /synthetic/two/report.md' }]));
  assert.equal(a.cards[0].rev, b.cards[0].rev);
  assert.notEqual(a.cards[0].holdVersion, b.cards[0].holdVersion);
  assert.notEqual(contentRevision(a), contentRevision(b), 'model updates include additive cycle metadata');
});

test('selected-home runner takes the newer valid durable hold stamp without broadening owner reads or mutating sources', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'hold-producer-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'data')); await mkdir(path.join(home, 'bin'));
  const full = 'Use the original full reason, not the snapshot recap';
  const ledger = `- [ ] sample - Choose a window (hold: fm-hold-v1:${Buffer.from(full).toString('base64')}) (hold-kind: captain)\n  Captain hold set: ${later}\n`;
  await writeFile(path.join(home, 'data/backlog.md'), ledger);
  const script = path.join(home, 'bin/fm-bearings-snapshot.sh');
  const run = createSnapshotRunner(home);
  for (const stamp of [hold, undefined, 'invalid', later, '2026-01-02T13:00:00Z']) {
    const raw = snapshot([{ ...row, hold_set_at: stamp }, { ...row, id: 'other/sample', key: 'sample', owner: 'other', hold_set_at: hold }]);
    const bytes = `#!/bin/sh\nprintf '%s' '${JSON.stringify(raw)}'\n`;
    await writeFile(script, bytes, { mode: 0o755 });
    const parsed = JSON.parse(await run());
    const c = normalizeSnapshot(parsed).cards[0];
    const expected = stamp === '2026-01-02T13:00:00Z' ? stamp : later;
    assert.equal(c.clock.at, new Date(expected).toISOString());
    assert.equal(c.reason, row.reason, 'upstream source reason stays intact');
    assert.equal(c.backlogReason, full, 'full authoritative reason controls cycle identity');
    assert.equal(c.holdVersion, shortHash([full, new Date(expected).toISOString()]));
    assert.equal(parsed.decisions_open[1].hold_set_at, hold, 'another owner is never supplemented');
    assert.equal(parsed.decisions_open[1].backlogReason, undefined);
    assert.equal(await readFile(script, 'utf8'), bytes);
    assert.equal(await readFile(path.join(home, 'data/backlog.md'), 'utf8'), ledger);
  }
});

test('real generated cycle excludes old pending/handled answers, respects version before legacy rev and preserves closed-call absence', () => {
  const old = card(), current = card({ hold_set_at: later });
  for (const collection of ['pending', 'handled']) {
    const note = answer(old);
    assert.equal(classifyAnsweredCalls([old], { [collection]: [note] })[0].answered, true);
    assert.equal(classifyAnsweredCalls([current], { [collection]: [note] })[0].answered, undefined);
    assert.deepEqual(classifyAnsweredCalls([], { [collection]: [note] }), []);
    const cosmetic = card({ repo: 'example-app' });
    assert.equal(classifyAnsweredCalls([cosmetic], { [collection]: [note] })[0].answered, true);
    const legacy = answer(old, { holdVersion: undefined, cardRev: old.rev });
    assert.equal(classifyAnsweredCalls([old], { [collection]: [legacy] })[0].answered, true);
    assert.equal(classifyAnsweredCalls([cosmetic], { [collection]: [legacy] })[0].answered, undefined);
    const versionWins = answer(old, { holdVersion: 'wrong', cardRev: old.rev });
    assert.equal(classifyAnsweredCalls([old], { [collection]: [versionWins] })[0].answered, undefined);
    const preHold = { ...answer(current), at: sent };
    assert.equal(classifyAnsweredCalls([current], { [collection]: [preHold] })[0].answered, undefined, 'a matching version cannot overrule a later hold clock');
  }
});

test('generated re-hold keeps exact old note/reply as contextual provenance, current notes as entries and original receipt bytes intact', async () => {
  const old = card(), current = card({ hold_set_at: later });
  const oldNote = { id: 'old-note', at: sent, request_id: threadRequestId(old.key, uuid), body: formatThreadNote({ key: old.key, card: old, text: 'Original question', requestId: uuid }) };
  const currentNote = { id: 'current-note', at: '2026-01-02T13:00:00Z', request_id: threadRequestId(current.key, uuid.replace(/1$/, '2')), body: formatThreadNote({ key: current.key, card: current, text: 'Current question', requestId: uuid.replace(/1$/, '2') }) };
  const receipts = { handled: [oldNote], pending: [currentNote], replies: [{ id: oldNote.id, at: '2026-01-02T11:30:00Z', body: 'Original reply' }] };
  const original = JSON.stringify(receipts);
  const relay = createThreadRelay({ home: '/synthetic/home', receipts: async () => receipts, transcript: async () => ({ turns: [], omitted: false }) });
  const history = await relay.history(current.key, { cards: [current] });
  assert.deepEqual(history.entries.map(e => e.text), ['Current question']);
  assert.deepEqual(history.provenance.map(e => e.text), ['Original question', 'Original reply']);
  assert.equal(history.entries[0].holdVersion, current.holdVersion);
  assert.equal(JSON.stringify(receipts), original);
});

test('a real current-cycle thread submission isolates the held-card count without importing earlier Sent', async () => {
  const original = card({ reason: undefined, summary: 'Original rollout question' });
  const current = card({ reason: undefined, summary: 'Changed rollout question', hold_set_at: later });
  const oldNote = { id: 'earlier', at: sent, request_id: threadRequestId(original.key, uuid),
    body: formatThreadNote({ key: original.key, card: original, text: 'Earlier pending question', requestId: uuid }) };
  const oldBytes = JSON.stringify(oldNote);
  const receipts = { pending: [oldNote], handled: [], replies: [] };
  const otherCards = [{ key: 'decision:credential' }, { key: 'decision:extra' }, { key: 'merge:example', sentReceipt: 'pending' }];
  const activeCount = (c) => [c, ...otherCards].filter(card => win.callLifecycle.cardState({ card }) === 'active').length;
  assert.equal(activeCount(classifyAnsweredCalls([current], receipts)[0]), 3, 'an earlier pending note cannot establish current Sent');
  const relay = createThreadRelay({ home: '/synthetic/home', now: () => Date.parse('2026-01-02T13:00:00Z'),
    transcript: async () => ({ turns: [], omitted: false }), receipts: async () => receipts,
    note: async (_home, requestId, body, { record }) => {
      receipts.pending.push({ id: 'current', request_id: requestId, body, at: record.at });
      return { id: 'current', outcome: 'created' };
    } });
  const question = 'Clarify the current rollout question before proceeding';
  const requestId = uuid.replace(/1$/, '2');
  const submitted = await relay.submit({ key: current.key, requestId, text: question }, { cards: [current] });
  assert.equal(submitted.state, 'accepted');
  assert.equal(submitted.replay, false);
  assert.doesNotMatch(receipts.pending[1].body, /fm-bearings-answer/, 'this path records a real question, not an invented answer');
  const sentCurrent = classifyAnsweredCalls([current], receipts)[0];
  assert.equal(sentCurrent.sentReceipt, 'pending');
  assert.equal(activeCount(sentCurrent), 2, 'the unchanged two-count precondition now has current-cycle evidence');
  const history = await relay.history(current.key, { cards: [current] });
  assert.deepEqual(history.entries.map(e => e.text), [question]);
  assert.equal(history.entries[0].holdVersion, current.holdVersion);
  assert.deepEqual(history.provenance.map(e => e.text), ['Earlier pending question']);
  const next = card({ reason: undefined, summary: 'Latest question after typing', hold_set_at: later });
  assert.notEqual(next.holdVersion, current.holdVersion);
  assert.equal(activeCount(classifyAnsweredCalls([next], receipts)[0]), 3, 'the next real reason change remains Active');
  assert.equal(win.callLifecycle.cardState({ card: sentCurrent, thread: history }), 'sent', 'an engaged view retaining the applied cycle still shows its authentic Sent');
  assert.equal(win.callLifecycle.cardState({ card: next, thread: history }), 'active', 'cached history cannot make the next cycle Sent');
  assert.equal(JSON.stringify(oldNote), oldBytes);
});

test('generated new cycle stays Active while cached thread and local sent state still belong to the old cycle', () => {
  const old = card(), current = card({ hold_set_at: later });
  const entry = { kind: 'ask', from: 'captain', state: 'waiting', holdVersion: old.holdVersion, at: sent };
  const answer = { phase: 'sent', holdVersion: old.holdVersion, cardRev: old.rev, sentAt: sent, receipt: { state: 'received' } };
  const thread = { captainAsked: true, holdVersion: old.holdVersion, entries: [entry] };
  assert.equal(win.callLifecycle.cardState({ card: old, thread, answer }), 'sent');
  assert.equal(win.callLifecycle.cardState({ card: current, thread, answer }), 'active');
  assert.equal(win.callLifecycle.cardState({ card: card({ repo: 'example-app' }), thread, answer }), 'sent');
});

test('a date-only creation clock on the next UTC day cannot reject same-cycle notes sent after the precise hold', async () => {
  // A host east of UTC records its local creation date; the precise hold stamp is still the previous UTC day.
  const east = { created: '2026-10-16', hold_set_at: '2026-10-15T20:00:00Z' };
  const a = card({ ...east, id: 'sample-a' }), b = card({ ...east, id: 'sample-b' });
  assert.equal(a.clock.label, 'Created', 'the display clock still shows the newest durable date');
  assert.equal(a.holdAt, '2026-10-15T20:00:00.000Z');
  const { rev, holdVersion, holdAt, ...presentation } = a;
  assert.equal(rev, shortHash(presentation), 'hold-cycle metadata leaves the presentation revision unchanged');
  const asked = (c, n) => ({ id: 'shared-note', at: '2026-10-15T21:00:00Z', request_id: threadRequestId(c.key, uuid.replace(/1$/, String(n))),
    body: formatThreadNote({ key: c.key, card: c, text: `Clarify ${c.task}`, requestId: uuid.replace(/1$/, String(n)) }) });
  const receipts = { pending: [], handled: [asked(a, 1), asked(b, 2)], replies: [{ id: 'shared-note', at: '2026-10-15T22:00:00Z', body: 'One reply for both calls.' }] };
  const relay = createThreadRelay({ home: '/synthetic/home', receipts: async () => receipts, transcript: async () => ({ turns: [], omitted: false }) });
  for (const c of [a, b]) {
    const classified = classifyAnsweredCalls([c], receipts)[0];
    assert.equal(classified.sentReceipt, 'replied');
    assert.equal(classified.sentReplyScope, 'combined');
    const history = await relay.history(c.key, { cards: [c] });
    assert.deepEqual(history.entries.map(e => [e.kind, e.state, e.replyScope]), [['ask', 'replied', 'combined']]);
    assert.equal(win.callLifecycle.delivery({ card: c, thread: history }).posture, 'replied');
  }
  const preHold = { ...asked(a, 3), at: '2026-10-15T19:00:00Z' };
  assert.equal(classifyAnsweredCalls([a], { handled: [preHold] })[0].sentReceipt, undefined, 'a note sent before the hold cycle stays stale');
  assert.equal(win.callLifecycle.delivery({ card: a, thread: { entries: [{ kind: 'ask', from: 'captain', state: 'waiting', holdVersion: a.holdVersion, at: preHold.at }] } }).posture, null);
});
