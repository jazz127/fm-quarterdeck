import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { checkLaneEnvelopes } from '../scripts/check-lane-envelopes.mjs';
import { replyAndAckNote } from '../prototype/inbox.js';
import { LandingWatch } from '../scripts/quarterdeck-watch.mjs';

const codes = (text) => checkLaneEnvelopes(text).map((error) => error.code);
test('lane check accepts flat multiline/multi-lane replies and fenced examples', () => {
  assert.deepEqual(codes('[fm-lane Example-UI]\r\nDone.\r\n[end Example-UI]\r\n\r\n[fm-lane General]\r\nNext.\r\n[end General]'), []);
  assert.deepEqual(codes('[fm-lane General]\nExample:\n```text\n[fm-lane Other]\n[end Other]\n```\n[end General]'), []);
});
for (const [text, expected] of [
  ['hello', 'unwrapped-text'], ['', 'no-blocks'],
  ['[fm-lane General]\n[end General]', 'empty-block'],
  ['[fm-lane General]\nhi', 'unclosed-block'],
  ['[fm-lane General]\nhi\n[end Other]', 'mismatched-end'],
  ['[end General]', 'orphan-end'],
  ['[fm-lane General]\n[fm-lane Other]\nhi\n[end General]', 'nested-block'],
  ['[fm-lane Two Words]\nhi\n[end Two Words]', 'malformed-marker'],
  ['[fm-lane General] trailing\nhi\n[end General]', 'malformed-marker'],
  ['[fm-lane General]\nhi\n[end General]\norphan', 'unwrapped-text'],
]) test(`lane check rejects ${expected}: ${JSON.stringify(text)}`, () => assert.ok(codes(text).includes(expected)));

test('lane CLI exits nonzero without leaking prose; accepts valid stdin', () => {
  const run = (input) => spawnSync(process.execPath, ['scripts/check-lane-envelopes.mjs'], { input, encoding: 'utf8', timeout: 5000 });
  assert.equal(run('[fm-lane General]\nhello\n[end General]').status, 0);
  const invalid = run('private prose');
  assert.equal(invalid.status, 1);
  assert.ok(!invalid.stderr.includes('private prose'));
  assert.equal(run('x'.repeat(1024 * 1024 + 1)).status, 2);
});

function inbox({ pending = true, reply = null, fail = '', omitted = [], ambiguous = false } = {}) {
  const calls = [];
  const invoke = async (home, args) => {
    assert.equal(home, '/synthetic/home');
    calls.push(args);
    if (args[0] === 'receipts') return { code: 0, stdout: JSON.stringify({
      schema: 'fm-inbox-receipts.v1', pending: pending ? [{ id: '123-test' }] : [],
      handled: !pending || ambiguous ? [{ id: '123-test' }] : [],
      replies: reply === null ? [] : [{ in_reply_to: '123-test', body: reply }], omitted,
    }) };
    if (args[0] === 'reply') {
      if (fail === 'reply') return { code: 1 };
      if (fail !== 'unrecorded') reply = args[2];
      return { code: 0 };
    }
    assert.deepEqual(args, ['drain', '--ack', '123-test']);
    if (fail === 'ack') return { code: 1 };
    if (fail !== 'unclosed') pending = false;
    return { code: 0 };
  };
  return { calls, invoke, repair: () => { fail = ''; } };
}
const close = (f) => replyAndAckNote('/synthetic/home', '123-test', 'Done and verified', { invoke: f.invoke });
test('note closure replies, proves reply, acknowledges, proves closure, and retry is read-only', async () => {
  const f = inbox();
  assert.deepEqual(await close(f), { state: 'replied-and-acked', id: '123-test' });
  assert.deepEqual(f.calls.map((args) => args[0]), ['receipts', 'reply', 'receipts', 'drain', 'receipts']);
  f.calls.length = 0;
  await close(f);
  assert.deepEqual(f.calls.map((args) => args[0]), ['receipts']);
});
test('ack failure retry never repeats reply or captain action', async () => {
  const f = inbox({ fail: 'ack' });
  await assert.rejects(close(f), /Acknowledgement failed/);
  f.repair(); f.calls.length = 0;
  await close(f);
  assert.deepEqual(f.calls.map((args) => args[0]), ['receipts', 'drain', 'receipts']);
});
for (const options of [{ fail: 'reply' }, { fail: 'unrecorded' }, { reply: 'different' }, { pending: false }, { omitted: ['lost'] }, { ambiguous: true }]) {
  test(`unsafe note state cannot acknowledge: ${JSON.stringify(options)}`, async () => {
    const f = inbox(options);
    await assert.rejects(close(f));
    assert.ok(!f.calls.some((args) => args[0] === 'drain'));
  });
}
test('successful ack command without receipt closure is not reported done', async () => {
  await assert.rejects(close(inbox({ fail: 'unclosed' })), /not confirmed/);
});
test('invalid note input refuses before invoking any home command', async () => {
  for (const [home, id, text] of [['relative', '123-test', 'ok'], ['/synthetic/home', '--all', 'ok'], ['/synthetic/home', '123-test', ''], ['/synthetic/home', '123-test', 'x'.repeat(32769)]]) {
    await assert.rejects(replyAndAckNote(home, id, text, { invoke: () => assert.fail('must not invoke') }));
  }
});

function watcher() {
  let current = { branch: 'main', commit: 'a' }, ancestor = true, failStop = false;
  const events = [];
  const watch = new LandingWatch({ branch: 'main', commit: 'a', prove: async () => ({ ...current }),
    isAncestor: async () => ancestor,
    launch: async (commit) => { events.push(`launch:${commit}`); return commit; },
    stop: async (child) => { events.push(`stop:${child}`); if (failStop) throw new Error('stop failed'); },
  });
  return { watch, events, set: (value) => { current = value; }, diverge: () => { ancestor = false; }, failStop: () => { failStop = true; } };
}
test('landing watch restarts only clean fast-forwards and stops old child before launch', async () => {
  const f = watcher(); await f.watch.start();
  assert.equal(await f.watch.tick(), false);
  f.set({ branch: 'main', commit: null }); // A checkout mid-update is not launchable.
  assert.equal(await f.watch.tick(), false);
  f.set({ branch: 'main', commit: 'b' });
  assert.equal(await f.watch.tick(), true);
  assert.deepEqual(f.events, ['launch:a', 'stop:a', 'launch:b']);
  await f.watch.close();
  assert.deepEqual(f.events, ['launch:a', 'stop:a', 'launch:b', 'stop:b']);
});
test('landing watch refuses dirty startup, branch switches and divergence', async () => {
  const dirty = watcher(); dirty.set({ branch: 'main', commit: null });
  await assert.rejects(dirty.watch.start()); assert.deepEqual(dirty.events, []);
  for (const branch of ['other', 'main']) {
    const f = watcher(); await f.watch.start();
    f.set({ branch, commit: 'b' }); f.diverge();
    await assert.rejects(f.watch.tick());
    assert.deepEqual(f.events, ['launch:a']); await f.watch.close();
  }
});
test('failed stop cannot launch a replacement', async () => {
  const f = watcher(); await f.watch.start(); f.set({ branch: 'main', commit: 'b' }); f.failStop();
  await assert.rejects(f.watch.tick()); assert.deepEqual(f.events, ['launch:a', 'stop:a']);
});
test('concurrent checkout change during stop refuses replacement', async () => {
  const f = watcher(); await f.watch.start(); f.set({ branch: 'main', commit: 'b' });
  f.watch.stop = async () => { f.set({ branch: 'main', commit: 'c' }); };
  await assert.rejects(f.watch.tick(), /changed during restart/);
  assert.deepEqual(f.events, ['launch:a']);
});
