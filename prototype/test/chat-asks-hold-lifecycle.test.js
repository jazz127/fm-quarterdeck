import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { backlogHoldRecords, normalizeSnapshot } from '../bearings.js';
import { createChatAskScanner, memoryStateFile, extractAsks, taskMarkers, composeCallModel } from '../chat-asks.js';
import { extractAskSections } from '../public/chat-ask-extraction.js';

test('shared ask ranges retain CRLF, multiple asks and unclipped originals without changing the canonical projection', () => {
  const long = 'Sample detail '.repeat(400);
  const text = `Background.\r\n\r\n**DECISION NEEDED:** Choose example-app.\r\n- "staged": sample first\r\n- "wait": later\r\n\r\n\`\`\`text\r\nACTION NEEDED: fenced example\r\n\`\`\`\r\n\r\n> APPROVAL NEEDED: ${long}\r\nReply "allow" or "hold".\r\n\r\nEnd detail.`;
  const sections = extractAskSections(text);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map(({ ask }) => ask), extractAsks(text));
  assert.deepEqual(sections[0].ask.replies, ['staged', 'wait']);
  assert.deepEqual(sections[1].ask.replies, ['allow', 'hold']);
  assert.equal(sections[1].ask.text.length, 4000);
  assert.ok(sections[1].raw.length > 4000);
  let cursor = 0, recovered = '';
  for (const section of sections) {
    assert.equal(section.raw, text.slice(section.start, section.end));
    recovered += text.slice(cursor, section.start) + section.raw;
    cursor = section.end;
  }
  assert.equal(recovered + text.slice(cursor), text);
});
const hold = (id, reason, checked = ' ') => `- [${checked}] ${id} - Choose (hold-kind: captain) (hold: fm-hold-v1:${Buffer.from(reason).toString('base64')})`;
async function scanner(t, text) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'qd-hold-lifecycle-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = path.join(home, 'main.jsonl'), store = memoryStateFile();
  await writeFile(file, JSON.stringify({ type: 'assistant', uuid: 'ask', message: { content: text } }) + '\n');
  const make = () => createChatAskScanner({ home, store, discover: async () => ({ sources: [{ file, source: 'claude-main-session/main', origin: 'claude' }], warnings: [] }) });
  const scan = make();
  await scan.scan(); return { scan, store, make };
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

test('missing, omitted or stale ledger evidence cannot close a vanished linked ask', async t => {
  const { scan, store } = await scanner(t, 'DECISION NEEDED: [task:held] choose');
  await scan.applySnapshot([{ task: 'held', type: 'decision' }], true);
  const key = scan.asks()[0].key;
  const closed = backlogHoldRecords(hold('held', 'choose', 'x'));
  for (const [fresh, rows, omitted] of [
    [true, [], []],
    [true, [], [{ kind: 'decisions-bound' }]],
    [false, closed, []],
  ]) {
    assert.equal(await scan.applySnapshot([], fresh, rows, omitted), false);
    assert.equal(scan.asks()[0].key, key);
    assert.deepEqual((await store.read()).tombstones, {});
    assert.deepEqual(scan.view().resolved, []);
  }
  assert.equal(await scan.applySnapshot([], true, closed, [{ kind: 'decisions-bound' }]), true, 'fresh ledger closure does not require full snapshot coverage');
  assert.deepEqual(scan.asks(), []);
  assert.equal(scan.view().resolved[0].source, 'data/backlog.md');
});

test('every linked sibling requires its own fresh closed-ledger evidence', async t => {
  const { scan, store } = await scanner(t, 'DECISION NEEDED: [task:held-a] [task:held-b] choose');
  const open = backlogHoldRecords(hold('held-a', 'choose') + '\n' + hold('held-b', 'choose'));
  await scan.applySnapshot([], true, open);
  assert.deepEqual(scan.asks()[0].linkedTasks, ['held-a', 'held-b']);
  const a = backlogHoldRecords(hold('held-a', 'choose', 'x'));
  await scan.applySnapshot([], true, a);
  assert.equal(scan.asks().length, 1, 'a vanished sibling is not answered by the other closure');
  assert.deepEqual((await store.read()).tombstones, {});
  const b = backlogHoldRecords(hold('held-b', 'choose', 'x'));
  await scan.applySnapshot([], false, [...a, ...b]);
  assert.equal(scan.asks().length, 1);
  await scan.applySnapshot([], true, [...a, ...b]);
  assert.deepEqual(scan.asks(), []);
  assert.deepEqual(scan.view().resolved[0].tasks, ['held-a', 'held-b']);
});

test('remote ledger rows and same-named local closure cannot answer persisted remote links', async t => {
  for (const task of ['held', 'other/held']) {
    const { store, make } = await scanner(t, 'DECISION NEEDED: choose a sample window');
    // Retain legacy links without changing their ownership or guessing a reassignment.
    await store.update(state => {
      Object.values(state.asks)[0].linkedTasks = [task];
      return { write: true };
    });
    const scan = make();
    await scan.scan();
    assert.deepEqual(scan.asks()[0].linkedTasks, [task]);
    const remote = { task, closed: true, source: 'other/data/backlog.md' };
    const scoped = { task: 'other/held', closed: true, source: 'data/backlog.md' };
    const model = normalizeSnapshot({ schema: 'fm-bearings.v1', decisions_open: [],
      contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [],
      quarterdeck_holds: [remote, scoped] });
    assert.deepEqual(model.holds, [], 'the existing selected-home source and task guards reject remote ledger evidence');
    await scan.applySnapshot(model.cards, true, model.holds, model.omitted);
    assert.equal(scan.asks().length, 1);
    if (task.includes('/')) {
      await scan.applySnapshot([], true, backlogHoldRecords(hold('held', 'local window', 'x')));
      assert.equal(scan.asks().length, 1, 'local bare id is not the remote scoped identity');
    }
    assert.deepEqual((await store.read()).tombstones, {});
  }
});

test('lifecycle parser rejects duplicate ids and unscoped body prose', () => {
  assert.deepEqual(backlogHoldRecords(hold('same', 'x') + '\n- [x] same - duplicate'), []);
  assert.deepEqual(backlogHoldRecords('- [ ] work - Regular\n  Resolution mode: answered\n## Done\n  Resolution recorded by fm-captain-hold.\n  Resolution mode: released'), []);
});
