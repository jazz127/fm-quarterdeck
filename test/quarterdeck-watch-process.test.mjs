import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, copyFile, writeFile, rm } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, ms = 15000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await delay(100); }
  throw new Error('synthetic process evidence deadline');
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-watch-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts')); await mkdir(path.join(root, 'prototype'));
  await copyFile('scripts/quarterdeck-watch.mjs', path.join(root, 'scripts/quarterdeck-watch.mjs'));
  await copyFile('prototype/git-identity.js', path.join(root, 'prototype/git-identity.js'));
  await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
  await writeFile(path.join(root, 'prototype/server.js'), `import http from 'node:http';
export function createServer() { return http.createServer((req,res) => res.end(JSON.stringify({pid:process.pid,value:'first'}))); }\n`);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000,
    env: { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Synthetic Fixture'); git('config', 'user.email', 'fixture@example.invalid');
  git('add', '.'); git('commit', '--quiet', '-m', 'synthetic first');
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port;
  await new Promise((resolve) => reserve.close(resolve));
  const start = (extra = {}) => {
    const child = spawn(process.execPath, [path.join(root, 'scripts/quarterdeck-watch.mjs'), 'main', git('rev-parse', 'HEAD')], {
      cwd: root, env: { PATH: process.env.PATH, FM_HOME: root, PORT: String(port), ...extra }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', (chunk) => { output += chunk; }); child.stderr.on('data', (chunk) => { output += chunk; });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await until(() => child.exitCode !== null || child.signalCode !== null, 10000);
      }
    });
    return { child, output: () => output };
  };
  const read = async () => { try { return await (await fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(500) })).json(); } catch { return null; } };
  return { root, git, port, start, read };
}

test('foreground launcher reloads a fast-forward in a new owned process; parent loss closes only that listener', { timeout: 35000 }, async (t) => {
  const f = await fixture(t), running = f.start();
  const first = await until(f.read);
  await writeFile(path.join(f.root, 'prototype/server.js'), `import http from 'node:http';
export function createServer() { return http.createServer((req,res) => res.end(JSON.stringify({pid:process.pid,value:'second'}))); }\n`);
  f.git('add', '.'); f.git('commit', '--quiet', '-m', 'synthetic fast-forward');
  const second = await until(async () => { const value = await f.read(); return value?.value === 'second' && value.pid !== first.pid ? value : null; });
  assert.notEqual(second.pid, first.pid);
  assert.ok(running.output().includes(f.git('rev-parse', 'HEAD')));
  running.child.kill('SIGKILL'); await once(running.child, 'exit');
  await until(async () => !await f.read()); // IPC disconnect shutdown, no orphan adoption.
});

test('occupied port is not killed or adopted and registry/public-host launch is refused', { timeout: 20000 }, async (t) => {
  const f = await fixture(t);
  const unrelated = http.createServer((req, res) => res.end('unrelated'));
  unrelated.listen(f.port, '127.0.0.1'); await once(unrelated, 'listening');
  t.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const occupied = f.start();
  await once(occupied.child, 'exit'); assert.equal(occupied.child.exitCode, 1);
  assert.equal(await (await fetch(`http://127.0.0.1:${f.port}`)).text(), 'unrelated');
  for (const env of [{ HOST: '0.0.0.0' }, { FM_PREVIEW_REGISTRY_PATH: '/synthetic/registry.json' }, { FM_PREVIEW_ROOT: '/synthetic/previews' }, { FM_DEV: '1' }]) {
    const refused = f.start(env); await once(refused.child, 'exit'); assert.equal(refused.child.exitCode, 1);
    assert.ok(!refused.output().includes('listener started'));
  }
});
