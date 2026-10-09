import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/quarterdeck-health-check.sh', import.meta.url));
async function fixture(t, bearings = {}) {
  const state = await mkdtemp(join(tmpdir(), 'quarterdeck-health-'));
  await mkdir(join(state, 'bin'));
  await writeFile(join(state, 'receipts.json'), JSON.stringify({
    schema: 'fm-inbox-receipts.v1', pending: [], omitted: [],
  }));
  await writeFile(join(state, 'bin', 'fm-inbox.sh'), '#!/usr/bin/env bash\n[[ "$*" == "receipts --all-pending" ]] || exit 1\nexec python3 -c \'import os; from pathlib import Path; print((Path(os.environ["FM_HOME"]) / "receipts.json").read_text())\'\n', { mode: 0o700 });
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/api/health' ? { ok: true } : {
      schema: 'fm-quarterdeck-call.v1', state: 'ready', generatedAt: new Date().toISOString(), ...bearings,
    }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(state, { recursive: true, force: true });
  });
  return { state, server, port: server.address().port, calls: () => calls };
}
function check(f, extra = {}) {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      !key.startsWith('FM_QUARTERDECK_HEALTH_') && key !== 'FM_HOME'));
    const child = spawn('bash', [script], { env: {
      ...env, FM_HOME: f.state, FM_QUARTERDECK_HEALTH_STATE_DIR: f.state,
      FM_QUARTERDECK_HEALTH_PORT: String(f.port),
      FM_QUARTERDECK_STATE_PATH: join(f.state, 'agent-state.json'), FM_AGENTOS_STATE_PATH: '',
      TAILSCALE_BIN: join(f.state, 'absent-tailscale'), ...extra,
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}
function failure(result, match) {
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^Quarterdeck health: [^\n]+\n$/);
  if (match) assert.match(result.stdout, match);
}

test('healthy is silent; attempts throttle; force bypasses stamp', async t => {
  const f = await fixture(t);
  assert.deepEqual(await check(f), { code: 0, stdout: '', stderr: '' });
  assert.equal(f.calls(), 2);
  assert.equal((await check(f)).stdout, '');
  assert.equal(f.calls(), 2);
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
  assert.equal(f.calls(), 4);
});
test('down server produces exactly one private-data-free line', async t => {
  const f = await fixture(t);
  await new Promise(resolve => f.server.close(resolve));
  failure(await check(f), /endpoint unavailable/);
  assert.equal((await check(f)).stdout, '');
});
for (const [name, snapshot, match] of [
  ['stale timestamp', { generatedAt: '2000-01-01T00:00:00Z' }, /snapshot stale/],
  ['explicit stale', { stale: true }, /snapshot stale/],
  ['loading with stale flag', { state: 'loading', stale: true }, /snapshot stale/],
  ['loading with error', { state: 'loading', error: 'synthetic failure' }, /snapshot error/],
  ['error state', { state: 'error' }, /not ready/],
  ['unavailable', { state: 'unavailable' }, /not ready/],
  ['unknown schema', { schema: 'unknown.v1' }, /not ready/],
  ['missing timestamp', { generatedAt: null }, /timestamp missing/],
  ['future timestamp', { generatedAt: '2100-01-01T00:00:00Z' }, /snapshot stale/],
]) {
  test(name, async t => failure(await check(await fixture(t, snapshot)), match));
}
test('persistent private config supplies port without inherited environment', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'quarterdeck-health.json'), JSON.stringify({
    FM_HOME: f.state,
    FM_QUARTERDECK_HEALTH_PORT: String(f.port),
  }));
  // An absent environment key allows private JSON config to supply it.
  const result = await new Promise((resolve, reject) => {
    const child = spawn('bash', [script], { env: {
      PATH: process.env.PATH, FM_QUARTERDECK_HEALTH_STATE_DIR: f.state,
      TAILSCALE_BIN: join(f.state, 'absent-tailscale'),
    } });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' });
});
test('configured remote failure is not hidden by healthy loopback', async t => {
  const f = await fixture(t);
  failure(await check(f, { FM_QUARTERDECK_HEALTH_URL: `https://127.0.0.1:${f.port}` }), /endpoint unavailable/);
});
test('missing port and unavailable discovery fail closed', async t => {
  const f = await fixture(t);
  failure(await check(f, { FM_QUARTERDECK_HEALTH_PORT: '' }), /discovery unavailable/);
});
test('idle loading without a snapshot clock is healthy', async t => {
  const f = await fixture(t, { state: 'loading', generatedAt: null });
  assert.deepEqual(await check(f), { code: 0, stdout: '', stderr: '' });
});
async function notes(f, pending, extra = {}) {
  await writeFile(join(f.state, 'receipts.json'), JSON.stringify({
    schema: 'fm-inbox-receipts.v1', pending, omitted: [], ...extra,
  }));
}
const noteId = (age, suffix = 'synthetic') => `${Math.floor(Date.now() / 1000) - age}-${suffix}`;
test('overdue notes wake once, name ids and demand reply plus ack; fresh notes stay silent', async t => {
  const f = await fixture(t);
  const old = noteId(1000), fresh = noteId(30), future = noteId(-120);
  await notes(f, [{ id: old, body: 'DO NOT PRINT THIS' }, { id: fresh }, { id: future }]);
  const result = await check(f);
  failure(result, /inbox notes overdue/);
  assert.ok(result.stdout.includes(old));
  assert.ok(!result.stdout.includes(fresh));
  assert.ok(!result.stdout.includes(future));
  assert.ok(!result.stdout.includes('DO NOT PRINT THIS'));
  assert.match(result.stdout, /reply <id> <text>.*drain --ack <id> required/);
  assert.equal((await check(f)).stdout, '');
  // A reply alone does not close pending intake; removal after ack stops wakes.
  failure(await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' }), /inbox notes overdue/);
  await notes(f, []);
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
});
test('saved note alarm is reread on every forced run', async t => {
  const f = await fixture(t);
  await notes(f, [{ id: noteId(100) }]);
  await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ awayCheckInMinutes: 10, openNoteAlarmMinutes: 1 }));
  failure(await check(f), /inbox notes overdue/);
  await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ awayCheckInMinutes: 10, openNoteAlarmMinutes: 3 }));
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
});
test('preference reads never modify saved contents; malformed/symlink records default', async t => {
  const f = await fixture(t);
  const file = join(f.state, 'quarterdeck-preferences.json');
  const bytes = JSON.stringify({ awayCheckInMinutes: 10, openNoteAlarmMinutes: 15 });
  await writeFile(file, bytes);
  assert.equal((await check(f)).stdout, '');
  assert.equal(await readFile(file, 'utf8'), bytes);
  await writeFile(file, '{invalid');
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
  await rm(file); await symlink(join(f.state, 'receipts.json'), file);
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
});
test('legacy storage owner and environment override resolve the server preference directory', async t => {
  const f = await fixture(t);
  await notes(f, [{ id: noteId(100) }]);
  await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ awayCheckInMinutes: 10, openNoteAlarmMinutes: 1 }));
  await writeFile(join(f.state, 'quarterdeck-health.json'), JSON.stringify({ FM_AGENTOS_STATE_PATH: join(f.state, 'agent-state.json') }));
  failure(await check(f, { FM_QUARTERDECK_STATE_PATH: '', FM_AGENTOS_STATE_PATH: undefined }), /inbox notes overdue/);
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1', FM_QUARTERDECK_STATE_PATH: join(f.state, 'other', 'agent-state.json') })).stdout, '');
});
test('overdue inbox and dashboard failure share a single wake line', async t => {
  const f = await fixture(t, { state: 'unavailable' });
  await notes(f, [{ id: noteId(1000) }]);
  failure(await check(f), /inbox notes overdue.*snapshot not ready/);
});
test('many overdue ids are bounded with a remaining count', async t => {
  const f = await fixture(t);
  await notes(f, Array.from({ length: 25 }, (_, i) => ({ id: noteId(1000, `synthetic-${i}`) })));
  const result = await check(f);
  failure(result, /\(\+5 more; list inbox\)/);
  assert.ok(result.stdout.length < 3000);
});
for (const [name, pending, extra] of [
  ['unsafe id', [{ id: '123-unsafe\nline' }], {}],
  ['missing id', [{}], {}],
  ['wrong schema', [], { schema: 'unknown.v1' }],
  ['omitted receipts', [], { omitted: ['synthetic'] }],
]) {
  test(`inbox ${name} fails closed without printing data`, async t => {
    const f = await fixture(t);
    await notes(f, pending, extra);
    failure(await check(f), /inbox unavailable or invalid receipts/);
  });
}
for (const value of [0, -1, 1441, 1.5, '1', true, null]) {
  test(`invalid saved minutes ${value} fall back to defaults`, async t => {
    const f = await fixture(t);
    await notes(f, [{ id: noteId(100) }]);
    await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ awayCheckInMinutes: value, openNoteAlarmMinutes: value }));
    await writeFile(join(f.state, 'quarterdeck-health.stamp'), String(Date.now() / 1000 - 120));
    assert.equal((await check(f)).stdout, ''); assert.equal(f.calls(), 0);
    assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
  });
}
test('saved away interval changes apply even while previously throttled', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'quarterdeck-health.stamp'), String(Date.now() / 1000 - 120));
  await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ awayCheckInMinutes: 3, openNoteAlarmMinutes: 15 }));
  assert.equal((await check(f)).stdout, ''); assert.equal(f.calls(), 0);
  await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ awayCheckInMinutes: 1, openNoteAlarmMinutes: 15 }));
  assert.equal((await check(f)).stdout, ''); assert.equal(f.calls(), 2);
});
test('inbox requires an explicit home and never silently skips a missing interface', async t => {
  const f = await fixture(t);
  failure(await check(f, { FM_HOME: '' }), /explicit FM_HOME required/);
  await rm(join(f.state, 'bin', 'fm-inbox.sh'));
  failure(await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' }), /inbox unavailable/);
});
test('oversized and failed inbox reads are sanitized failures', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'receipts.json'), 'x'.repeat(1024 * 1024 + 1));
  failure(await check(f), /inbox unavailable/);
  await writeFile(join(f.state, 'bin', 'fm-inbox.sh'), '#!/usr/bin/env bash\necho private-diagnostic >&2\nexit 1\n');
  failure(await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' }), /inbox unavailable/);
});
test('hung inbox reads have a bounded deadline', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'bin', 'fm-inbox.sh'), '#!/usr/bin/env bash\nexec sleep 30\n');
  const start = Date.now();
  failure(await check(f), /inbox unavailable/);
  assert.ok(Date.now() - start < 6000);
});
