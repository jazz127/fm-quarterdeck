import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const audit = fileURLToPath(new URL('../skills/fmqd-toolcheck/audit.mjs', import.meta.url));
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
function goBinary(module, version) {
  const prefix = Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex');
  const suffix = Buffer.from('f932433186182072008242104116d8f2', 'hex');
  const text = Buffer.concat([prefix, Buffer.from(`path\t${module}/cmd/${module.split('/').at(-1)}\nmod\t${module}\t${version}\t\n`), suffix]);
  const str = b => Buffer.concat([Buffer.from([b.length < 128 ? b.length : (b.length & 127) | 128, ...(b.length < 128 ? [] : [b.length >> 7])]), b]);
  const header = Buffer.alloc(32);
  Buffer.from('ff20476f206275696c64696e663a', 'hex').copy(header); header[15] = 2;
  return Buffer.concat([Buffer.from('7f454c46', 'hex'), Buffer.alloc(32), header, str(Buffer.from('go1.25.0')), str(text)]);
}
test('bootstrap scope, ownership, shadowing, provenance, compatibility and no mutations', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmqd-toolcheck-'));
  try {
    const root = path.join(tmp, 'fm'), bin = path.join(root, 'bin'), early = path.join(tmp, 'early'), late = path.join(tmp, 'late'), clone = path.join(tmp, 'clone');
    for (const d of [bin, early, late, clone]) fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(bin, 'fm-bootstrap.sh'), `install_cmd() {\n case "$1" in\n treehouse) echo "curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh" ;;\n no-mistakes) echo "curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh" ;;\n gh-axi|quota-axi|stranger-axi) echo "npm install -g $1" ;;\n node|pi|shellcheck|tailscale) echo "npm install -g $1" ;;\n esac\n}\nGH_AXI_MIN=0.1.29\n`);
    fs.writeFileSync(path.join(bin, 'fm-quota-axi-lib.sh'), 'FM_QUOTA_AXI_MIN=0.1.29\n');
    const wrapper = '#!/bin/sh\necho BAD >> "' + path.join(tmp, 'mutation') + '"\n';
    for (const n of ['gh-axi', 'node', 'pi', 'shellcheck', 'tailscale', 'git']) fs.writeFileSync(path.join(early, n), wrapper, { mode: 0o755 });
    fs.writeFileSync(path.join(clone, 'package.json'), JSON.stringify({ name: 'gh-axi', version: '0.1.1', repository: 'https://github.com/kunchenguid/gh-axi.git' }));
    fs.writeFileSync(path.join(clone, 'gh-axi'), wrapper, { mode: 0o755 });
    git(clone, 'init', '-q'); git(clone, 'config', 'user.name', 'Test'); git(clone, 'config', 'user.email', 'test@example.invalid');
    git(clone, 'remote', 'add', 'origin', 'https://github.com/kunchenguid/gh-axi.git');
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'baseline');
    git(clone, 'checkout', '-qb', 'custom');
    fs.appendFileSync(path.join(clone, 'gh-axi'), '# custom\n');
    fs.symlinkSync(path.join(clone, 'gh-axi'), path.join(late, 'gh-axi'));
    const env = { ...process.env, PATH: [early, late, '/usr/bin', '/bin'].join(':') };
    const run = (...args) => spawnSync(process.execPath, [audit, '--firstmate-root', root, ...args], { env, encoding: 'utf8', timeout: 15000 });
    const result = run();
    assert.equal(result.status, 0, result.stderr);
    for (const text of ['gh-axi (kunchenguid/gh-axi)', 'PATH copies: 2', 'unidentified executable not run', 'dirty source clone', 'custom branch', 'incompatible version', 'installation integrity remains unverified', 'Scope proof:', 'treehouse (kunchenguid/treehouse)', 'quota-axi: excluded', 'stranger-axi: excluded', 'Available version: not requested']) assert.ok(result.stdout.includes(text), text);
    for (const name of ['node (', 'pi (', 'shellcheck (', 'tailscale (']) assert.ok(!result.stdout.includes(name), name);
    assert.ok(!fs.existsSync(path.join(tmp, 'mutation')));
    assert.equal(fs.readFileSync(path.join(clone, 'gh-axi'), 'utf8').endsWith('# custom\n'), true);
    // Inject an offline HTTPS transport; no real network or mutable cache needed.
    const mock = path.join(tmp, 'offline.cjs');
    fs.writeFileSync(mock, `require('node:https').get = () => { const e = new (require('node:events').EventEmitter)(); process.nextTick(() => e.emit('error', Error('offline'))); return e; };`);
    const offline = spawnSync(process.execPath, [audit, '--firstmate-root', root, '--releases'], { env: { ...env, NODE_OPTIONS: `--require=${mock}` }, encoding: 'utf8', timeout: 15000 });
    assert.equal(offline.status, 0, offline.stderr);
    assert.match(offline.stdout, /Available version: GitHub latest release tag=unavailable/);
    assert.match(offline.stdout, /dirty source clone/);
    assert.ok(!fs.existsSync(path.join(tmp, 'mutation')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('static Go version claims, verified nested clone, false owner and bounded traversal without execution', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fmqd-toolcheck-native-'));
  try {
    const root = path.join(tmp, 'fm'), bin = path.join(root, 'bin'), commands = path.join(tmp, 'commands');
    fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(commands);
    fs.writeFileSync(path.join(bin, 'fm-bootstrap.sh'), `install_cmd() {\n treehouse) echo "curl -fsSL https://kunchenguid.github.io/treehouse/install.sh | sh" ;;\n no-mistakes) echo "curl -fsSL https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh | sh" ;;\n}\nNO_MISTAKES_MIN=1.0.0\n`);
    const clone = path.join(tmp, 'src');
    const nested = path.join(clone, 'build', 'bin'); fs.mkdirSync(nested, { recursive: true });
    const target = path.join(nested, 'treehouse');
    fs.writeFileSync(target, goBinary('github.com/kunchenguid/treehouse', 'v2.3.0'), { mode: 0o755 });
    git(clone, 'init', '-q'); git(clone, 'config', 'user.name', 'Test'); git(clone, 'config', 'user.email', 'test@example.invalid');
    git(clone, 'remote', 'add', 'origin', 'https://github.com/kunchenguid/treehouse.git');
    git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'baseline');
    const baseline = spawnSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
    git(clone, 'checkout', '-qb', 'custom');
    fs.writeFileSync(path.join(clone, 'custom.txt'), 'local change'); git(clone, 'add', '.'); git(clone, 'commit', '-qm', 'custom');
    git(clone, 'update-ref', 'refs/remotes/origin/custom', baseline);
    git(clone, 'branch', '--set-upstream-to', 'origin/custom', 'custom');
    fs.appendFileSync(target, Buffer.from('changed')); fs.symlinkSync(target, path.join(commands, 'treehouse'));
    const indexBefore = fs.readFileSync(path.join(clone, '.git/index'));
    git(clone, 'config', 'core.fsmonitor', `sh -c 'echo BAD > ${path.join(tmp, 'mutation')}'`);
    const outer = path.join(tmp, 'outer'); fs.mkdirSync(outer);
    git(outer, 'init', '-q'); git(outer, 'remote', 'add', 'origin', 'https://github.com/kunchenguid/no-mistakes.git');
    const alien = path.join(outer, 'foreign'); fs.mkdirSync(path.join(alien, 'out'), { recursive: true });
    git(alien, 'init', '-q'); git(alien, 'remote', 'add', 'origin', 'https://github.com/someone/no-mistakes.git');
    const alienTarget = path.join(alien, 'out', 'no-mistakes');
    fs.writeFileSync(alienTarget, goBinary('github.com/kunchenguid/no-mistakes', 'v1.75.2'), { mode: 0o755 });
    fs.symlinkSync(alienTarget, path.join(commands, 'no-mistakes'));
    const run = () => spawnSync(process.execPath, [audit, '--firstmate-root', root], { env: { ...process.env, PATH: `${commands}:/usr/bin:/bin` }, encoding: 'utf8', timeout: 15000 });
    let report = run(); assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /version=v2\.3\.0 \(static Go build module claim \(not CLI release\)\)/);
    assert.match(report.stdout, /version=v1\.75\.2 \(static Go build module claim \(not CLI release\)\)/);
    assert.match(report.stdout, /verified remote=https:\/\/github.com\/kunchenguid\/treehouse\.git/);
    assert.match(report.stdout, /dirty source clone; diverged source clone; custom branch/);
    assert.match(report.stdout, /ahead\/behind cached upstream=1\s+0/);
    assert.deepEqual(fs.readFileSync(path.join(clone, '.git/index')), indexBefore);
    assert.match(report.stdout, /unverified source remote: https:\/\/github.com\/someone\/no-mistakes\.git/);
    assert.doesNotMatch(report.stdout, /verified remote=https:\/\/github.com\/kunchenguid\/no-mistakes/);
    // A script that contains valid-looking Go bytes is still not a native binary.
    fs.writeFileSync(alienTarget, Buffer.concat([Buffer.from('#!/bin/sh\necho BAD > ' + path.join(tmp, 'mutation') + '\n'), goBinary('github.com/kunchenguid/no-mistakes', 'v9.9.9')]), { mode: 0o755 });
    report = run(); assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /version=unknown \(unidentified executable not run\)/);
    assert.ok(!fs.existsSync(path.join(tmp, 'mutation')));
    // Even a verified ancestor beyond the six-parent limit is not attributed.
    const deep = path.join(tmp, 'deep'); let dir = deep;
    for (let i = 0; i < 7; i++) dir = path.join(dir, `level${i}`);
    fs.mkdirSync(dir, { recursive: true });
    git(deep, 'init', '-q'); git(deep, 'remote', 'add', 'origin', 'https://github.com/kunchenguid/treehouse.git');
    const deepTarget = path.join(dir, 'treehouse'); fs.writeFileSync(deepTarget, goBinary('github.com/kunchenguid/treehouse', 'v0.0.0-20260822132253-35b8a41d8b0f'), { mode: 0o755 });
    fs.unlinkSync(path.join(commands, 'treehouse')); fs.symlinkSync(deepTarget, path.join(commands, 'treehouse'));
    report = run(); assert.equal(report.status, 0, report.stderr);
    assert.match(report.stdout, /version=v0\.0\.0-20260822132253-35b8a41d8b0f/);
    assert.match(report.stdout, /not attributable \(no verified installed-target source clone within six ancestors\)/);
    assert.doesNotMatch(report.stdout, /verified remote=https:\/\/github.com\/kunchenguid\/treehouse/);
    assert.ok(!fs.existsSync(path.join(tmp, 'mutation')));
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
