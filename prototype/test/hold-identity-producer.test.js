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

test('generated new cycle stays Active while cached thread and local sent state still belong to the old cycle', () => {
  const old = card(), current = card({ hold_set_at: later });
  const entry = { kind: 'ask', from: 'captain', state: 'waiting', holdVersion: old.holdVersion, at: sent };
  const answer = { phase: 'sent', holdVersion: old.holdVersion, cardRev: old.rev, sentAt: sent, receipt: { state: 'received' } };
  const thread = { captainAsked: true, holdVersion: old.holdVersion, entries: [entry] };
  assert.equal(win.callLifecycle.cardState({ card: old, thread, answer }), 'sent');
  assert.equal(win.callLifecycle.cardState({ card: current, thread, answer }), 'active');
  assert.equal(win.callLifecycle.cardState({ card: card({ repo: 'example-app' }), thread, answer }), 'sent');
});
