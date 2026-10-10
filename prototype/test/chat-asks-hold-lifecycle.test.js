import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { backlogHoldRecords } from '../bearings.js';
import { createChatAskScanner, memoryStateFile, extractAsks, taskMarkers, composeCallModel } from '../chat-asks.js';
const hold = (id, reason, checked = ' ') => `- [${checked}] ${id} - Choose (hold-kind: captain) (hold: fm-hold-v1:${Buffer.from(reason).toString('base64')})`;
async function scanner(t, text) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'qd-hold-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'main.jsonl'), store = memoryStateFile();
  await writeFile(file, JSON.stringify({ type: 'assistant', uuid: 'ask', message: { content: text } }) + '\n');
  const scan = createChatAskScanner({ home, store, discover: async () => ({ sources: [{ file, source: 'claude-main-session/main', origin: 'claude' }], warnings: [] }) });
  await scan.scan(); return { scan, store };
}

test('structured marker grammar and whole-token id linking are mechanical', async t => {
  assert.deepEqual(taskMarkers('x [task:hold.a-1] [task:hold.a-1] [task:bad/id] [task:]'), ['hold.a-1']);
  const asks = extractAsks('**DECISION NEEDED:** [task:hold.a-1] pick\n\nACTION NEEDED: no\n[task:continuation]');
  assert.deepEqual(asks.map(a => a.taskMarkers), [['hold.a-1'], []]);
  for (const text of ['DECISION NEEDED: [task:hold-a] Pick', 'DECISION NEEDED: Pick hold-a.']) {
    const { scan } = await scanner(t, text);
    await scan.applySnapshot([{ task: 'hold-aa', type: 'decision' }], true);
    assert.deepEqual(scan.asks()[0].linkedTasks, []);
    await scan.applySnapshot([], true, backlogHoldRecords(hold('hold-a', 'Choose')));
    assert.deepEqual(scan.asks()[0].linkedTasks, ['hold-a']);
  }
});

test('normalised replies link by reason including already-answered holds on first scan', async t => {
  for (const reason of ['`Ship Preview`', '“SHIP PREVIEW”', "Reply 'ship preview'.", 'ship preview']) {
    const { scan, store } = await scanner(t, 'APPROVAL NEEDED: Pick. Reply "ship preview".');
    const rows = backlogHoldRecords(hold('held', reason, 'x') + '\n  Resolution recorded by fm-captain-hold.\n  Resolution mode: answered');
    await scan.applySnapshot([], true, rows);
    assert.deepEqual(scan.asks(), []);
    const state = await store.read(), ask = Object.values(state.asks)[0];
    assert.equal(ask.resolvedBy, 'answered');
    assert.equal(ask.resolutionSource, 'data/backlog.md');
    assert.ok(state.tombstones[ask.key]);
    const base = { cards: [], coverage: null, omitted: [] };
    assert.equal(composeCallModel(base, [], scan.view()).chat.resolved[0].source, 'data/backlog.md');
    await scan.scan(); assert.deepEqual(scan.asks(), []);
  }
});

test('release/closure resolves linked holds but stale or omitted evidence never implies closure', async t => {
  const { scan, store } = await scanner(t, 'DECISION NEEDED: [task:held] choose');
  const open = backlogHoldRecords(hold('held', 'choose') + '\n  Resolution recorded by fm-captain-hold.\n  Resolution mode: released');
  assert.equal(open[0].closed, false, 'historical block cannot close a reopened hold');
  await scan.applySnapshot([], true, open, [{ kind: 'deferred-holds', count: 1 }]);
  await scan.applySnapshot([], true, [], [{ kind: 'decisions-bound' }]);
  assert.equal(scan.asks().length, 1);
  const released = backlogHoldRecords('- [ ] held - Work (hold-kind: parked)\n  Resolution recorded by fm-captain-hold.\n  Resolution mode: released\n\n  Captain decision:\n  free form accepted');
  await scan.applySnapshot([], false, released);
  assert.equal(scan.asks().length, 1);
  await scan.applySnapshot([], true, released);
  assert.equal(scan.asks().length, 0);
  assert.equal(Object.values((await store.read()).asks)[0].holdResolutions[0].resolution, 'released');
});

test('lifecycle parser rejects duplicate ids and unscoped body prose', () => {
  assert.deepEqual(backlogHoldRecords(hold('same', 'x') + '\n- [x] same - duplicate'), []);
  assert.deepEqual(backlogHoldRecords('- [ ] work - Regular\n  Resolution mode: answered\n## Done\n  Resolution recorded by fm-captain-hold.\n  Resolution mode: released'), []);
});
