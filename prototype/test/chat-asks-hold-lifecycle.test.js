import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { backlogHoldRecords, normalizeSnapshot } from '../bearings.js';
import { createChatAskScanner, memoryStateFile, extractAsks, taskMarkers, composeCallModel, createCallSource } from '../chat-asks.js';
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

test('release/closure resolves linked local holds only with fresh ledger evidence', async t => {
  const { scan, store } = await scanner(t, 'DECISION NEEDED: [task:held] choose');
  const open = backlogHoldRecords(hold('held', 'choose') + '\n  Resolution recorded by fm-captain-hold.\n  Resolution mode: released');
  assert.equal(open[0].closed, false, 'historical block cannot close a reopened hold');
  await scan.applySnapshot([], true, open);
  await scan.applySnapshot([], true);
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

const decisionModel = (rows) => normalizeSnapshot({ schema: 'fm-bearings.v1', decisions_open: rows.map(row => ({ ...row, key: row.id.split("/").at(-1) })),
  contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] });

test('local chat asks stay actionable across every read-only decision matching field', async t => {
  const cases = ['summary', 'title', 'reason', 'backlogTitle', 'backlogReason'].map(field => ({
    text: 'DECISION NEEDED: Choose the local plan. Reply "yes".',
    row: { id: 'remote/held', owner: 'remote', summary: 'Remote pending', [field]: 'Reply "yes".' },
  }));
  cases.push(...['DECISION NEEDED: [task:held] choose', 'DECISION NEEDED: Choose held.'].map(text => ({
    text, row: { id: 'held', owner: 'remote', summary: 'Remote pending' },
  })));
  for (const { text, row } of cases) {
    const { scan, store } = await scanner(t, text);
    const base = decisionModel([row]);
    const key = scan.asks()[0].key;
    assert.equal(await scan.applySnapshot(base.cards, true), false);
    assert.deepEqual(scan.asks()[0].linkedTasks, []);
    const model = composeCallModel(base, scan.asks(), scan.view());
    assert.deepEqual(model.cards.map(card => card.key), [base.cards[0].key, key]);
    assert.equal(model.cards[0].chatAsks, undefined);
    assert.equal(model.cards[1].answer.question, `chat.${key.slice(5)}`);
    assert.equal(model.chat.linked, 0);
    assert.equal(Object.values((await store.read()).asks)[0].status, 'open');
    const local = { ...base.cards[0], readOnly: false, owner: '(main)' };
    await scan.applySnapshot([local], true);
    assert.deepEqual(scan.asks()[0].linkedTasks, [local.task]);
    assert.equal(composeCallModel({ ...base, cards: [local] }, scan.asks(), scan.view()).chat.linked, 1);
    await scan.applySnapshot([], true);
    assert.equal(scan.asks()[0].key, key);
  }
});

test('saved remote-only links are excluded before composition and disappearance closure', async t => {
  for (const fresh of [false, true]) {
    const { scan, store } = await scanner(t, 'APPROVAL NEEDED: Choose the local plan. Reply "yes".');
    const base = decisionModel([{ id: 'remote/held', owner: 'remote', summary: 'Reply "yes".' }]);
    const saved = await store.read();
    const ask = Object.values(saved.asks)[0];
    ask.linkedTasks = [base.cards[0].task];
    const restoredStore = memoryStateFile(saved);
    const restored = createChatAskScanner({ home: '/synthetic/home', store: restoredStore,
      discover: async () => ({ sources: [], warnings: [] }) });
    await restored.scan();
    const model = composeCallModel(base, restored.asks(), restored.view());
    assert.equal(model.chat.open, 1);
    assert.equal(model.chat.linked, 0);
    assert.equal(model.cards[0].chatAsks, undefined);
    assert.ok(model.cards[1].answer);
    assert.equal(await restored.applySnapshot(base.cards, fresh), true);
    assert.deepEqual(restored.asks()[0].linkedTasks, []);
    assert.deepEqual((await restoredStore.read()).asks[ask.key].linkedTasks, []);
    assert.equal(await restored.applySnapshot(base.cards, fresh), false);
    await restored.applySnapshot([], true);
    assert.equal(restored.asks()[0].key, ask.key);
    assert.equal(restored.view().resolved.length, 0);
  }
});

test('a shared task attaches local asks only to its actionable card', async t => {
  const { scan } = await scanner(t, 'DECISION NEEDED: [task:held] choose');
  const remote = decisionModel([{ id: 'held', owner: 'remote', summary: 'Remote pending' }]).cards[0];
  const local = { ...remote, key: 'decision:local-held', owner: '(main)', readOnly: false };
  const base = { cards: [remote, local], coverage: null, omitted: [] };
  await scan.applySnapshot(base.cards, true);
  assert.deepEqual(scan.asks()[0].linkedTasks, ['held']);
  assert.equal(await scan.applySnapshot(base.cards, true), false);
  const model = composeCallModel(base, scan.asks(), scan.view());
  assert.equal(model.cards[0].chatAsks, undefined);
  assert.deepEqual(model.cards[1].chatAsks.map(ask => ask.key), [scan.asks()[0].key]);
  assert.equal(model.chat.linked, 1);
});

test('legacy bare and qualified remote links stay open when scoped or missing on the first fresh read', async t => {
  for (const linkedTask of ['gamma-credential', 'delta-mate/gamma-credential']) {
    for (const present of [true, false]) {
      const { store } = await scanner(t, 'APPROVAL NEEDED: Choose the local plan. Reply "yes".');
      const saved = await store.read();
      const ask = Object.values(saved.asks)[0];
      ask.linkedTasks = [linkedTask];
      const persisted = memoryStateFile(saved);
      const restored = () => createChatAskScanner({ home: '/synthetic/home', store: persisted,
        discover: async () => ({ sources: [], warnings: [] }) });
      const base = { state: 'ready', ...decisionModel(present
        ? [{ id: 'delta-mate/gamma-credential', owner: 'delta-mate', summary: 'Remote credential pending' }]
        : []) };
      const scan = restored();
      const source = createCallSource({ hub: { current: () => base }, chat: scan });
      await source.refresh();
      assert.equal(scan.asks()[0].key, ask.key);
      assert.equal(scan.view().resolved.length, 0);
      const state = await persisted.read();
      assert.equal(state.asks[ask.key].status, 'open');
      assert.equal(state.tombstones[ask.key], undefined);
      const model = source.current();
      const standalone = model.cards.find(card => card.key === ask.key);
      assert.equal(standalone.type, 'chat');
      assert.ok(standalone.answer);
      assert.equal(model.chat.linked, 0);
      if (present) {
        assert.equal(model.cards[0].readOnly, true);
        assert.equal(model.cards[0].chatAsks, undefined);
      }
      const restarted = restored();
      await restarted.scan();
      await restarted.applySnapshot([], true);
      assert.equal(restarted.asks()[0].key, ask.key);
      assert.equal((await persisted.read()).tombstones[ask.key], undefined);
      await restarted.resolve(ask.key, present ? 'answered' : 'dismissed');
      assert.deepEqual(restarted.asks(), []);
      assert.ok((await persisted.read()).tombstones[ask.key]);
    }
  }
});

test('legacy links require local proof before closure and reconcile remote owners in either arrival order', async t => {
  for (const remoteFirst of [true, false]) {
    const { store, make } = await scanner(t, 'APPROVAL NEEDED: Choose the remote plan. Reply "remote choice".');
    await store.update(state => { Object.values(state.asks)[0].linkedTasks = ['shared']; return { write: true }; });
    const scan = make();
    await scan.scan();
    const remote = decisionModel([{ id: 'mate/shared', owner: 'mate', summary: 'Reply "remote choice".' }]);
    const closed = backlogHoldRecords(hold('shared', 'unrelated local choice', 'x'));
    await scan.applySnapshot(remoteFirst ? remote.cards : [], true, closed);
    assert.equal(scan.asks().length, 1, 'unproven bare link must not close against local ledger');
    await scan.applySnapshot(remote.cards, true, closed);
    assert.deepEqual(scan.asks()[0].taskLinks, [{ task: 'mate/shared', localTask: 'shared', owner: 'mate' }]);
    const restored = make();
    await restored.scan();
    await restored.applySnapshot([], true, closed);
    assert.equal(restored.asks().length, 1);
    assert.equal(remote.cards[0].localTask, 'shared');
  }
});
