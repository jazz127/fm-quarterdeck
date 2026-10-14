import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, lstat, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { autocleanReport } from '../scripts/quarterdeck-autoclean.mjs';

const now = 1800000000000;
const old = now / 1000 - 90000;
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-autoclean-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'home');
  for (const name of ['state', 'data']) await mkdir(path.join(home, name), { recursive: true });
  await writeFile(path.join(home, 'data/backlog.md'), '## Done\n- [x] alpha - Neutral completed task (repo: /srv/synthetic/repo)\n');
  await writeFile(path.join(home, 'state/alpha.meta'), 'endpoint_task_id=alpha\nworktree=/srv/synthetic/copy\nbackend=herdr\nherdr_session=neutral-lab\nherdr_pane_id=p1\nterminal=neutral-terminal\nkind=scout\n');
  await writeFile(path.join(home, 'state/alpha.status'), `done [at=${old}]: Report ready\n`);
  return { dir, home };
}
async function snapshot(root) {
  const result = {};
  for (const name of (await readdir(root)).sort()) {
    const file = path.join(root, name), stat = await lstat(file);
    result[name] = stat.isDirectory() ? await snapshot(file) : { size: stat.size, mtime: stat.mtimeMs, symlink: stat.isSymbolicLink(), bytes: stat.isFile() ? (await readFile(file)).toString('base64') : null };
  }
  return result;
}

test('default disabled does not discover or validate any home; CLI rejects acting flags', async () => {
  assert.equal((await autocleanReport('/absent/home')).enabled, false);
  assert.equal((await autocleanReport(undefined, { tracking: true })).tracking.state, 'disabled');
  const script = fileURLToPath(new URL('../scripts/quarterdeck-autoclean.mjs', import.meta.url));
  const disabled = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(disabled.status, 0);
  assert.equal(JSON.parse(disabled.stdout).enabled, false);
  for (const args of [['--clear'], ['--enabled-report', '/absent', '--act'], ['--enabled-report', '/absent', '--tracking-findings', '--reset']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
  }
});

test('recorded old completion inventories agent/copy/pane/terminal, all protected and unchanged', async t => {
  const { home } = await fixture(t), before = await snapshot(home);
  const report = await autocleanReport(home, { enabled: true, now });
  assert.deepEqual(report.inventory.map(item => item.kind), ['agent', 'copy', 'pane', 'terminal']);
  assert.ok(report.inventory.every(item => item.staleCandidate && item.disposition === 'protected-report-only' && item.landing === 'unverified'));
  assert.deepEqual(report.effects, []);
  assert.equal(report.tracking.state, 'disabled');
  assert.deepEqual(await snapshot(home), before);
  assert.match(report.limitations.join(' '), /Unrecorded resources are not covered/);
});

for (const [name, meta, status, backlog, reason] of [
  ['foreign', 'remote_host=neutral-host\n', null, null, 'foreign-endpoint-not-inspected'],
  ['secondmate', 'kind=secondmate\nhome=/srv/synthetic/other\n', null, null, 'foreign-endpoint-not-inspected'],
  ['bound elsewhere', 'endpoint_task_id=other\n', null, null, 'endpoint-binding-mismatch'],
  ['duplicate metadata', 'window=one\nwindow=two\n', null, null, 'metadata-unverified'],
  ['unlanded', null, null, '## Active\n- [ ] alpha - Neutral pending task\n', 'unlanded-or-completion-unverified'],
  ['in flight', null, null, '## In flight\n- [x] alpha - Neutral retained task\n', 'in-flight'],
  ['hold', null, `blocked [key=review] [at=${old}]: Pending\ndone [at=${old}]: Report ready\n`, null, 'open-hold-or-blocker'],
  ['captain hold', null, null, '## Active\n- [ ] alpha - Neutral question (hold-kind: captain)\n', 'open-hold-or-blocker'],
  ['ambiguous backlog', null, null, '## Done\n- [x] alpha - Neutral task\n- [x] alpha - Duplicate task\n', 'ambiguous-backlog']
]) test(`${name} stays protected, not a stale candidate`, async t => {
  const { home } = await fixture(t);
  if (meta) await writeFile(path.join(home, 'state/alpha.meta'), meta);
  if (status) await writeFile(path.join(home, 'state/alpha.status'), status);
  if (backlog) await writeFile(path.join(home, 'data/backlog.md'), backlog);
  const before = await snapshot(home);
  const report = await autocleanReport(home, { enabled: true, now });
  assert.ok(report.inventory.every(item => !item.staleCandidate && item.reasons.includes(reason)));
  assert.deepEqual(await snapshot(home), before);
});

test('unknown/future/recent timestamps do not claim staleness', async t => {
  const { home } = await fixture(t);
  for (const stamp of ['', '[at=unknown]', `[at=${now / 1000 + 1}]`, `[at=${now / 1000 - 1}]`]) {
    await writeFile(path.join(home, 'state/alpha.status'), `done ${stamp}: Report ready\n`);
    const report = await autocleanReport(home, { enabled: true, now });
    assert.ok(report.inventory.every(item => !item.staleCandidate));
  }
});

test('missing/unsafe owners are explicit, never replaced with empty authoritative records', async t => {
  const { dir, home } = await fixture(t);
  const foreign = path.join(dir, 'foreign');
  await mkdir(foreign);
  await writeFile(path.join(foreign, 'alpha.meta'), 'terminal=foreign-secret\n');
  await rm(path.join(home, 'state/alpha.meta'));
  await symlink(path.join(foreign, 'alpha.meta'), path.join(home, 'state/alpha.meta'));
  await writeFile(path.join(home, 'state/alpha.status'), 'x'.repeat(65537));
  await rm(path.join(home, 'data/backlog.md'));
  const before = await snapshot(dir);
  const report = await autocleanReport(home, { enabled: true, tracking: true, now });
  assert.equal(report.tracking.state, 'unverified');
  assert.equal(report.inventory.length, 1);
  assert.ok(report.inventory[0].reasons.includes('metadata-unverified'));
  assert.ok(report.inventory[0].reasons.includes('status-unverified'));
  assert.ok(!JSON.stringify(report).includes('foreign-secret'));
  assert.deepEqual(await snapshot(dir), before);
  await rm(path.join(home, 'state'), { recursive: true });
  await symlink(foreign, path.join(home, 'state'));
  await assert.rejects(autocleanReport(home, { enabled: true, now }), /Unverified directory/);
});

test('established tracking yields local findings only; absent means not-applicable', async t => {
  const { home } = await fixture(t);
  assert.equal((await autocleanReport(home, { enabled: true, tracking: true, now })).tracking.state, 'not-applicable');
  await writeFile(path.join(home, 'data/backlog.md'), '## Done\n- [x] alpha - Neutral completed task (repo: /srv/synthetic/repo)\n  Issue: https://github.com/neutral-demo/sample/issues/1\n  Project: https://github.com/users/neutral-demo/projects/2\n');
  const before = await snapshot(home);
  const report = await autocleanReport(home, { enabled: true, tracking: true, now });
  assert.equal(report.tracking.state, 'review-needed');
  assert.equal(report.tracking.findings[0].repository, '/srv/synthetic/repo');
  assert.equal(report.tracking.findings[0].links.length, 2);
  assert.equal(report.tracking.findings[0].state, 'unverified');
  assert.deepEqual(report.effects, []);
  assert.deepEqual(await snapshot(home), before);
});

test('bounded task coverage reports omissions, traversal names never become readers', async t => {
  const { home } = await fixture(t);
  for (let i = 0; i < 513; i++) await writeFile(path.join(home, 'state', `task-${String(i).padStart(3, '0')}.meta`), 'kind=scout\n');
  await writeFile(path.join(home, 'state', '..unowned.meta'), 'terminal=outside\n');
  const report = await autocleanReport(home, { enabled: true, now });
  assert.equal(report.coverage[1].state, 'partial');
  assert.equal(report.coverage[1].omittedTasks, 2);
  assert.ok(!report.inventory.some(item => item.task === '..unowned'));
});

test('report entrypoint contains no effect path or endpoint probe call', async () => {
  const source = await readFile(new URL('../scripts/quarterdeck-autoclean.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:child_process|\b(?:execFile|spawn|writeFile|unlink|rename|mkdir|fetch|endpointIsLive)\s*\(/);
});
