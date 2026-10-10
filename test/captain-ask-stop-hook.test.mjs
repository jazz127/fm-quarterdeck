import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkStop } from '../scripts/captain-ask-stop-hook.mjs';
import { configure, hookEntry } from '../scripts/captain-ask-hook-install.mjs';
import { claudeProjectDirectory } from '../prototype/claude-transcript.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qd-stop-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), configDir = path.join(root, 'config');
  for (const dir of ['state', 'data']) await mkdir(path.join(home, dir), { recursive: true });
  await mkdir(claudeProjectDirectory(configDir, home), { recursive: true });
  await writeFile(path.join(home, 'state/.lock-session'), 'primary');
  const transcript = path.join(claudeProjectDirectory(configDir, home), 'primary.jsonl');
  const backlog = path.join(home, 'data/backlog.md');
  await writeFile(backlog, '- [ ] hold-a - Choose (hold-kind: captain)\n- [x] closed - Done (hold-kind: captain)\n- [ ] ordinary - Work\n');
  const input = { hook_event_name: 'Stop', session_id: 'primary', cwd: home, transcript_path: transcript, stop_hook_active: false };
  const message = async text => writeFile(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } }) + '\n');
  return { root, home, configDir, transcript, backlog, input, message, check: () => checkStop(input, { home, configDir }) };
}

test('guard passes only asks naming open selected-home captain holds on each marker line', async t => {
  const f = await fixture(t);
  for (const lead of ['', '**', '> - **', '## ', '1. ', '⚠️ ']) {
    await f.message(`${lead}DECISION NEEDED:** prose [task:hold-a]`);
    assert.deepEqual(await f.check(), {});
    await f.message(`${lead}DECISION NEEDED:** prose hold-a`);
    assert.equal((await f.check()).decision, 'block');
  }
  for (const id of ['missing', 'closed', 'ordinary', 'hold-aa', '../hold-a']) {
    await f.message(`APPROVAL NEEDED: proceed [task:${id}]`);
    assert.equal((await f.check()).decision, 'block');
  }
  await f.message('DECISION NEEDED: [task:hold-a]\nACTION NEEDED: unfiled\n[task:hold-a]');
  assert.equal((await f.check()).decision, 'block', 'continuation marker cannot rescue ask line');
  await f.message('```\nDECISION NEEDED: example\n```\nProse ACTION NEEDED: ignored');
  assert.deepEqual(await f.check(), {});
});

test('guard checks only final assistant text and ignores other sessions / corrective stops', async t => {
  const f = await fixture(t);
  const records = [
    { type: 'assistant', message: { content: 'DECISION NEEDED: stale bad ask' } },
    { type: 'assistant', message: { content: 'All done.' } },
    { type: 'user', message: { content: 'DECISION NEEDED: user quoted ask' } },
    { type: 'assistant', isSidechain: true, message: { content: 'DECISION NEEDED: worker' } },
  ];
  await writeFile(f.transcript, records.map(r => JSON.stringify(r)).join('\n') + '\n');
  assert.deepEqual(await f.check(), {});
  await f.message('ACTION NEEDED: missing');
  f.input.session_id = 'worker';
  assert.deepEqual(await f.check(), {});
  f.input.session_id = 'primary'; f.input.stop_hook_active = true;
  assert.match((await f.check()).diagnostic, /already active/);
});

test('unreadable/malformed/oversized inputs and backlog fail open with diagnostic; duplicates do not validate', async t => {
  const f = await fixture(t);
  await f.message('ACTION NEEDED: [task:hold-a]');
  await writeFile(f.backlog, '- [ ] hold-a - First (hold-kind: captain)\n- [x] hold-a - Duplicate');
  assert.equal((await f.check()).decision, 'block');
  await writeFile(f.backlog, 'x'.repeat(2 * 1024 * 1024 + 1));
  assert.match((await f.check()).diagnostic, /fail-open/);
  await rm(f.backlog);
  assert.match((await f.check()).diagnostic, /fail-open/);
  await rm(f.transcript);
  assert.match((await f.check()).diagnostic, /fail-open/);
  await writeFile(f.transcript, '{bad json');
  assert.match((await f.check()).diagnostic, /fail-open/);
  f.input.transcript_path = '/unselected/home/transcript.jsonl';
  assert.match((await f.check()).diagnostic, /fail-open/);
  const run = spawnSync(process.execPath, ['scripts/captain-ask-stop-hook.mjs'], { input: '{bad', encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /fail-open/);
});

test('CLI emits Claude Stop block/pass JSON and groups final assistant message parts', async t => {
  const f = await fixture(t);
  const run = () => spawnSync(process.execPath, ['scripts/captain-ask-stop-hook.mjs'], { input: JSON.stringify(f.input), env: { ...process.env, FM_HOME: f.home, CLAUDE_CONFIG_DIR: f.configDir }, encoding: 'utf8', timeout: 10000 });
  await f.message('DECISION NEEDED: missing');
  let result = run();
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
  await f.message('DECISION NEEDED: [task:hold-a] choose');
  result = run(); assert.equal(result.status, 0); assert.equal(result.stdout, '');
  await writeFile(f.transcript, [
    { type: 'assistant', message: { id: 'final', content: 'DECISION NEEDED: missing' } },
    { type: 'assistant', message: { id: 'final', content: [{ type: 'text', text: 'closing explanation' }] } },
  ].map(r => JSON.stringify(r)).join('\n'));
  assert.equal((await f.check()).decision, 'block');
});

test('explicit installer preserves unrelated settings and uninstalls only exact pinned entry', async t => {
  const f = await fixture(t), file = path.join(f.root, 'settings.json');
  const existing = { permissions: { allow: ['Read'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'other' }] }] } };
  await writeFile(file, JSON.stringify(existing));
  const entry = hookEntry(f.home, '/pinned/quarterdeck');
  await configure(file, entry, true); await configure(file, entry, true);
  const installed = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(installed.hooks.Stop.length, 2);
  assert.deepEqual(installed.permissions, existing.permissions);
  await assert.rejects(configure(file, hookEntry(f.home, '/different/pin'), false), /Different ask hook/);
  await configure(file, entry, false);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), existing);
});
