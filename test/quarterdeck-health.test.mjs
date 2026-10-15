import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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
test('a reading stale only by the server age ceiling defers to the check age limit', async t => {
  const generatedAt = new Date(Date.now() - 6 * 60_000).toISOString();
  assert.deepEqual(await check(await fixture(t, { state: 'stale', stale: true, error: null, generatedAt })), { code: 0, stdout: '', stderr: '' });
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
  ['failed-run stale', { state: 'stale', stale: true, error: 'synthetic failure' }, /snapshot stale/],
  ['age-only stale past the check limit', { state: 'stale', stale: true, error: null, generatedAt: '2000-01-01T00:00:00Z' }, /snapshot stale/],
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
for (const mode of ['override', 'windows-fallback', 'native-first']) {
  test(`Serve discovery uses ${mode} and accepts CRLF JSON`, async t => {
    const f = await fixture(t);
    const bin = join(f.state, 'discovery-bin');
    await mkdir(bin);
    // Isolate PATH from any installed Tailscale while retaining checker tools.
    for (const command of ['bash', 'dirname', 'python3', 'timeout', 'flock']) {
      await symlink(execFileSync('which', [command], { encoding: 'utf8' }).trim(), join(bin, command));
    }
    const routes = JSON.stringify({ Web: { '127.0.0.1:443': { Handlers: { '/': { Proxy: `http://127.0.0.1:${f.port}` } } } } }, null, 2);
    const cli = '#!/usr/bin/env bash\n[[ "$*" == "serve status --json" ]] || exit 1\nprintf \'%s\\r\\n\' \'' + routes.replaceAll('\n', '\r\n') + '\'\n';
    await writeFile(join(bin, 'tailscale.exe'), mode === 'native-first' ? '#!/usr/bin/env bash\nexit 1\n' : cli, { mode: 0o700 });
    if (mode !== 'windows-fallback') {
      await writeFile(join(bin, mode === 'override' ? 'custom-cli' : 'tailscale'), cli, { mode: 0o700 });
    }
    const result = await check(f, {
      PATH: bin, TAILSCALE_BIN: mode === 'override' ? join(bin, 'custom-cli') : '',
      FM_QUARTERDECK_HEALTH_PORT: '',
    });
    // Both local probes succeeded on the discovered port. The synthetic Serve
    // origin has no HTTPS listener; this failure is after successful discovery.
    failure(result, /endpoint unavailable/);
    assert.doesNotMatch(result.stdout, /discovery unavailable/);
    assert.equal(f.calls(), 2);
    if (mode === 'windows-fallback') {
      failure(await check(f, { PATH: bin, FM_QUARTERDECK_HEALTH_PORT: '',
        FM_QUARTERDECK_HEALTH_FORCE: '1', TAILSCALE_BIN: join(bin, 'absent-explicit'),
      }), /discovery unavailable/);
    }
  });
}
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
test('new notes report once at any age; overdue notes retain reply plus ack reminders', async t => {
  const f = await fixture(t);
  const old = noteId(1000), fresh = noteId(30), future = noteId(-120);
  await notes(f, [{ id: old, body: 'DO NOT PRINT THIS' }, { id: fresh }, { id: future }]);
  const result = await check(f);
  failure(result, /inbox notes overdue/);
  assert.ok(result.stdout.includes(old));
  assert.ok(result.stdout.includes(fresh));
  assert.ok(result.stdout.includes(future));
  assert.ok(!result.stdout.includes('DO NOT PRINT THIS'));
  assert.match(result.stdout, /reply <id> <text>.*drain --ack <id> required/);
  assert.equal((await check(f)).stdout, '');
  assert.match(result.stdout, /new pending inbox notes/);
  // A reply alone does not close pending intake; removal after ack stops wakes.
  const reminder = await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' });
  failure(reminder, /inbox notes overdue/);
  assert.doesNotMatch(reminder.stdout, /new pending/);
  await notes(f, []);
  assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
});
test('handled and reply omissions do not hide pending coverage', async t => {
  const f = await fixture(t);
  const handled = { surface: 'handled notes omitted by bound: 118' };
  await notes(f, [], { omitted: [handled] });
  assert.deepEqual(await check(f), { code: 0, stdout: '', stderr: '' });
  await notes(f, [{ id: noteId(30) }], { omitted: [handled,
    { surface: 'replies omitted by bound: 42', reveal: 'pass --all-replies' },
    { surface: 'malformed replies without a valid sequence: 1 (synthetic.json)' },
  ] });
  failure(await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' }), /new pending inbox notes/);
  await notes(f, [{ id: noteId(1000) }], { omitted: [handled] });
  failure(await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' }), /inbox notes overdue/);
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
  assert.ok(result.stdout.length < 6000);
  const marker = join(f.state, 'fm-quarterdeck-health.notes.json');
  assert.equal(JSON.parse(await readFile(marker, 'utf8')).reported.length, 25);
  assert.equal((await lstat(marker)).mode & 0o777, 0o600);
  assert.equal((await check(f)).stdout, '');
});
for (const [name, pending, extra] of [
  ['unsafe id', [{ id: '123-unsafe\nline' }], {}],
  ['missing id', [{}], {}],
  ['wrong schema', [], { schema: 'unknown.v1' }],
  ['omitted receipts', [], { omitted: ['synthetic'] }],
  ['pending omissions', [], { omitted: [{ surface: 'pending notes omitted by bound: 1' }] }],
  ['mixed pending omissions', [], { omitted: [{ surface: 'handled notes omitted by bound: 118' }, { surface: 'pending notes omitted by bound: 1' }] }],
  ['invalid omission list', [], { omitted: {} }],
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
    await writeFile(join(f.state, 'fm-quarterdeck-health.stamp'), String(Date.now() / 1000 - 120));
    failure(await check(f), /new pending inbox notes/); assert.equal(f.calls(), 0);
    assert.equal((await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' })).stdout, '');
  });
}
test('saved away interval changes apply even while previously throttled', async t => {
  const f = await fixture(t);
  await writeFile(join(f.state, 'fm-quarterdeck-health.stamp'), String(Date.now() / 1000 - 120));
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

const markerName = 'fm-quarterdeck-health.notes.json';
test('multiple new notes bypass a recent health stamp; repeats, replies and handled notes do not become new', async t => {
  const f = await fixture(t);
  await check(f);
  const first = noteId(0, 'example-app-a'), second = noteId(0, 'example-app-b');
  const handled = noteId(0, 'handled');
  await notes(f, [{ id: second }, { id: first }, { id: first }], {
    handled: [{ id: handled }], replies: [{ id: first, body: 'Synthetic reply' }],
  });
  const receiptBytes = await readFile(join(f.state, 'receipts.json'), 'utf8');
  const stamp = await readFile(join(f.state, 'fm-quarterdeck-health.stamp'), 'utf8');
  const result = await check(f);
  failure(result, /new pending inbox notes/);
  assert.ok(result.stdout.includes(first) && result.stdout.includes(second));
  assert.ok(!result.stdout.includes(handled));
  assert.equal((result.stdout.match(new RegExp(first, 'g')) || []).length, 1);
  assert.equal(f.calls(), 2, 'dashboard remains throttled');
  assert.equal(await readFile(join(f.state, 'fm-quarterdeck-health.stamp'), 'utf8'), stamp);
  assert.equal(await readFile(join(f.state, 'receipts.json'), 'utf8'), receiptBytes);
  assert.equal((await check(f)).stdout, '');
  await notes(f, []);
  assert.equal((await check(f)).stdout, '');
  await notes(f, [{ id: first }]);
  assert.equal((await check(f)).stdout, '', 'reported identity survives removal');
});
test('a previously reported fresh note later becomes overdue and continues periodic reminders', async t => {
  const f = await fixture(t);
  const id = noteId(100);
  await notes(f, [{ id }]);
  failure(await check(f), /new pending inbox notes/);
  await writeFile(join(f.state, 'quarterdeck-preferences.json'), JSON.stringify({ openNoteAlarmMinutes: 1 }));
  assert.equal((await check(f)).stdout, '', 'overdue reminders remain throttled');
  for (let i = 0; i < 2; i++) {
    await writeFile(join(f.state, 'fm-quarterdeck-health.stamp'), String(Date.now() / 1000 - 601));
    const reminder = await check(f);
    failure(reminder, /inbox notes overdue/);
    assert.doesNotMatch(reminder.stdout, /new pending/);
  }
});
test('unavailable receipts never advance the marker and recovered source reports new notes', async t => {
  const f = await fixture(t);
  const first = noteId(0, 'first'), second = noteId(0, 'second');
  await notes(f, [{ id: first }]);
  await check(f);
  const marker = await readFile(join(f.state, markerName), 'utf8');
  await notes(f, [{ id: first }, { id: second }], { omitted: [{ surface: 'pending notes omitted by bound: 1' }] });
  failure(await check(f, { FM_QUARTERDECK_HEALTH_FORCE: '1' }), /inbox unavailable/);
  assert.equal(await readFile(join(f.state, markerName), 'utf8'), marker);
  await notes(f, [{ id: first }, { id: second }]);
  const result = await check(f);
  failure(result, /new pending inbox notes/);
  assert.ok(result.stdout.includes(second));
  assert.ok(!result.stdout.includes(first));
});
test('unsafe marker is refused without touching its target or printing paths', async t => {
  const f = await fixture(t);
  await notes(f, [{ id: noteId(0) }]);
  const target = join(f.state, 'receipts.json'), original = await readFile(target, 'utf8');
  await symlink(target, join(f.state, markerName));
  const result = await check(f);
  failure(result, /new inbox note marker unavailable or invalid/);
  assert.ok(!result.stdout.includes(f.state));
  assert.equal(await readFile(target, 'utf8'), original);
  await rm(join(f.state, markerName));
  const invalid = JSON.stringify({ schema: 'unknown.v1', reported: ['do-not-print-marker'] });
  await writeFile(join(f.state, markerName), invalid);
  const rejected = await check(f);
  failure(rejected, /new inbox note marker unavailable or invalid/);
  assert.doesNotMatch(rejected.stdout, /do-not-print-marker/);
  assert.equal(await readFile(join(f.state, markerName), 'utf8'), invalid);
});
test('marker write failure is meaningful and retries notification after recovery', { skip: process.getuid?.() === 0 }, async t => {
  const f = await fixture(t);
  await check(f); // Create writable lock and stamp before removing directory write access.
  const id = noteId(0);
  await notes(f, [{ id }]);
  await chmod(f.state, 0o500);
  let result;
  try { result = await check(f); } finally { await chmod(f.state, 0o700); }
  failure(result, /new pending inbox notes.*marker write failed/);
  assert.ok(!result.stdout.includes(f.state));
  failure(await check(f), /new pending inbox notes/);
  assert.equal((await check(f)).stdout, '');
});

// Opt-in real-process contract: no download, shared endpoint or patched watcher.
// See docs/FIRSTMATE-INTEGRATIONS.md for the exact upstream pin and invocation.
const stockRoot = process.env.FM_QUARTERDECK_TEST_STOCK_ROOT;
test('stock follow-on watcher delivers a new note through the registered custom health check', {
  skip: !stockRoot && 'set FM_QUARTERDECK_TEST_STOCK_ROOT to the pinned upstream export',
  timeout: 30000,
}, async t => {
  const hash = createHash('sha256');
  async function sourceFiles(dir, prefix = '') {
    const files = [];
    for (const name of await readdir(dir)) {
      const relative = prefix + name, file = join(dir, name), info = await lstat(file);
      assert.ok(!info.isSymbolicLink(), 'stock export must contain regular source');
      if (info.isDirectory()) files.push(...await sourceFiles(file, relative + '/'));
      else { assert.ok(info.isFile()); files.push(relative); }
    }
    return files;
  }
  const files = (await sourceFiles(join(stockRoot, 'bin'))).sort();
  for (const file of files) hash.update(file + '\0').update(await readFile(join(stockRoot, 'bin', file))).update('\0');
  assert.equal(hash.digest('hex'), '5767c03d05550e1c51b253ba5349f58f6de6410f4b1a15ade1f5bd5f00697597',
    'requires unmodified bin/ from upstream 4735ddc6d9667dffa775cd0009f56775e56ba326');
  let watcher, done, closed = false;
  t.after(async () => {
    if (watcher && !closed) watcher.kill('SIGTERM');
    if (done) await done;
  });
  const f = await fixture(t), home = f.state;
  f.state = join(home, 'state');
  await mkdir(f.state, { mode: 0o700 });
  await mkdir(join(home, 'config'));
  await mkdir(join(home, 'data'));
  await cp(join(stockRoot, 'bin'), join(home, 'bin'), { recursive: true });
  const fakebin = join(home, 'fakebin');
  await mkdir(fakebin);
  // Same empty tmux surface as stock wake-helpers.sh; no real terminal backend.
  await writeFile(join(fakebin, 'tmux'), '#!/bin/sh\n[ "$1" = list-windows ] && exit 0\nexit 1\n', { mode: 0o700 });
  const env = {
    HOME: process.env.HOME, PATH: `${fakebin}:/usr/bin:/bin`, FM_HOME: home, FM_ROOT_OVERRIDE: home,
    FM_STATE_OVERRIDE: f.state, FM_CONFIG_OVERRIDE: join(home, 'config'),
    FM_BACKEND: 'tmux', FM_WATCH_HANDLING_SUCCESSOR: '1', FM_POLL: '0.2',
    FM_SIGNAL_GRACE: '1', FM_CHECK_INTERVAL: '300', FM_HEARTBEAT: '999999',
    FM_SECONDMATE_LIVENESS_SECS: '99999999', FM_WEDGE_ALARM_EXEC: 'discard',
    FM_QUARTERDECK_HEALTH_STATE_DIR: f.state, FM_QUARTERDECK_HEALTH_PORT: String(f.port),
    FM_QUARTERDECK_STATE_PATH: join(home, 'agent-state.json'),
    TAILSCALE_BIN: join(home, 'absent-tailscale'),
  };
  const run = (file, args = []) => execFileSync(join(home, 'bin', file), args, { env, encoding: 'utf8', timeout: 10000 });
  await writeFile(join(f.state, 'fm-quarterdeck-health.check.sh'),
    `#!/usr/bin/env bash\n# fm-quarterdeck\nexec bash '${script.replaceAll("'", "'\\''")}'\n`, { mode: 0o700 });
  assert.match(run('fm-check-register.sh', ['fm-quarterdeck-health']), /registered:/);
  assert.equal((await check(f, { FM_HOME: home, FM_STATE_OVERRIDE: f.state })).stdout, '');
  assert.equal(f.calls(), 2, 'prime a fresh dashboard stamp');
  await writeFile(join(f.state, '.last-check'), '');
  watcher = spawn(join(home, 'bin/fm-watch.sh'), [], { env });
  let stdout = '', stderr = '';
  watcher.stdout.on('data', data => { stdout += data; });
  watcher.stderr.on('data', data => { stderr += data; });
  done = new Promise((resolve, reject) => {
    watcher.on('error', reject);
    watcher.on('close', code => { closed = true; resolve(code); });
  });
  async function until(predicate, message) {
    const deadline = Date.now() + 10000;
    while (!await predicate()) {
      assert.ok(!closed, `watcher exited early: ${stdout} ${stderr}`);
      assert.ok(Date.now() < deadline, message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  let beat;
  await until(async () => {
    try { beat = (await lstat(join(f.state, '.last-watcher-beat'))).mtimeMs; return true; } catch { return false; }
  }, 'follow-on watcher did not start');
  await until(async () => (await lstat(join(f.state, '.last-watcher-beat'))).mtimeMs > beat,
    'follow-on watcher did not complete an empty poll cycle');
  const id = JSON.parse(run('fm-inbox.sh', ['note', '--json', '--request-id', 'example-app-note', 'Synthetic note for example-app'])).id;
  assert.match(id, /^[0-9]+-[A-Za-z0-9]+$/);
  const receipts = run('fm-inbox.sh', ['receipts', '--all-pending']);
  assert.equal(JSON.parse(receipts).pending[0].id, id, 'stock reader sees intake');
  beat = (await lstat(join(f.state, '.last-watcher-beat'))).mtimeMs;
  await until(async () => (await lstat(join(f.state, '.last-watcher-beat'))).mtimeMs > beat,
    'watcher did not poll after intake');
  assert.equal(stdout, '', 'stock successor skips downtime resurfacing before a check is due');
  // Advance only the synthetic check clock; keep the stock 300-second interval.
  const past = new Date(Date.now() - 301000);
  await utimes(join(f.state, '.last-check'), past, past);
  const wakeDeadline = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error('custom-health-check sweep missed new pending note')), 10000);
    done.finally(() => clearTimeout(timer));
  });
  assert.equal(await Promise.race([done, wakeDeadline]), 0);
  assert.equal(stderr, '');
  assert.match(stdout, /^check: .*fm-quarterdeck-health\.check\.sh: Quarterdeck health: new pending inbox notes:/);
  assert.ok(stdout.includes(id));
  assert.doesNotMatch(stdout, /rearm-resurface|overdue|Synthetic note for example-app/);
  assert.equal(f.calls(), 2, 'new-note wake bypasses the fresh dashboard throttle');
  const queue = await readFile(join(f.state, '.wake-queue'), 'utf8');
  assert.ok(queue.includes(`inbox:${id}`), 'ordinary inbox queue row remains available to main');
  assert.ok(queue.includes('new pending inbox notes'), 'stock authenticated custom check published its wake');
  assert.deepEqual({ ...JSON.parse(run('fm-inbox.sh', ['receipts', '--all-pending'])), generated: undefined },
    { ...JSON.parse(receipts), generated: undefined }, 'health wake does not consume or reply to the note');
  assert.equal((await check(f, { FM_HOME: home, FM_STATE_OVERRIDE: f.state })).stdout, '', 'same pending note is not new again');
});
