#!/usr/bin/env node
// Read-only Firstmate bootstrap audit. Never load/eval bootstrap, installed scripts, or package code.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('Usage: node skills/fm-toolcheck/audit.mjs --firstmate-root /path/to/firstmate [--releases]'); process.exit(0); }
const idx = args.indexOf('--firstmate-root');
if (idx < 0 || !args[idx + 1] || args.some((a, i) => !['--firstmate-root', '--releases'].includes(a) && i !== idx + 1)) {
  console.error('Specify --firstmate-root and optionally --releases'); process.exit(2);
}
const root = path.resolve(args[idx + 1]);
const bootstrap = fs.readFileSync(path.join(root, 'bin/fm-bootstrap.sh'), 'utf8');
// Parse ONLY the install_cmd case arms, not lists of all platform requirements or watched tools.
const installBody = bootstrap.match(/^install_cmd\(\) \{([\s\S]*?)^\}/m)?.[1];
if (!installBody) throw Error('Firstmate install_cmd declaration unavailable; refusing inventory');
const names = new Set();
const evidence = new Map();
for (const [, label, instruction] of installBody.matchAll(/^\s*([\w|-]+)\) echo "([^"]+)" ;;\s*$/gm)) {
  for (const name of label.split('|')) {
    if (!['treehouse', 'no-mistakes'].includes(name) && !/^([a-z0-9-]+)-axi$/.test(name)) continue;
    // Kunchenguid owner proof: exact bootstrap-owned install URL, or the
    // repository field of an installed package manifest (checked below).
    const literal = name === 'treehouse' && instruction.includes('https://kunchenguid.github.io/treehouse/install.sh')
      || name === 'no-mistakes' && instruction.includes('https://raw.githubusercontent.com/kunchenguid/no-mistakes/main/docs/install.sh');
    if (!literal && !instruction.includes(`npm install -g $1`)) continue;
    names.add(name); evidence.set(name, literal ? `Firstmate bootstrap Kunchenguid install URL: ${instruction}` : `Firstmate bootstrap npm install declaration: ${instruction}`);
  }
}
// Hard denylist, even if a future bootstrap install arm adds an unrelated tool.
const excluded = new Set(['pi', 'node', 'git', 'gh', 'tmux', 'shellcheck', 'actionlint', 'tailscale', 'bash', 'zsh', 'sh', 'curl', 'jq', 'orca', 'zellij', 'cmux', 'npm']);
const paths = (name) => [...new Set((process.env.PATH || '').split(':').map(d => path.resolve(d || '.', name)).filter(p => {
  try { return fs.statSync(p).isFile() && !!(fs.statSync(p).mode & 0o111); } catch { return false; }
}))];
function real(p) { try { return fs.realpathSync(p); } catch { return null; } }
function manifest(target, name) {
  if (!target) return null;
  let dir = path.dirname(target);
  // Do not treat a runtime manager parent manifest as the installed package.
  for (let n = 0; n < 3; n++, dir = path.dirname(dir)) {
    try {
      const file = path.join(dir, 'package.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data.name !== name) continue;
      const repo = typeof data.repository === 'string' ? data.repository : data.repository?.url;
      return { dir, version: data.version, repo: repo || 'unknown', file };
    } catch { /* no package claim */ }
    if (dir === path.dirname(dir)) break;
  }
  return null;
}
const owned = (repo, name) => typeof repo === 'string' && new RegExp(`^(?:git\\+)?(?:https://github\\.com/kunchenguid/|git@github\\.com:kunchenguid/)${name}(?:\\.git)?/?$`, 'i').test(repo);
function nativeVersion(target, name) {
  // Inspect bounded Go build info *inside* an ELF/Mach-O binary, never execute it.
  // The module version is build metadata, not a CLI release or installation receipt.
  if (!target) return null;
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null;
    const data = fs.readFileSync(target);
    const magic = data.subarray(0, 4).toString('hex');
    if (!['7f454c46', 'feedface', 'feedfacf', 'cefaedfe', 'cffaedfe'].includes(magic)) return null;
    const marker = Buffer.from('ff20476f206275696c64696e663a', 'hex'); // Go buildinf
    const start = data.indexOf(marker);
    if (start < 0 || data.indexOf(marker, start + 1) !== -1 || start + 32 >= data.length || !(data[start + 15] & 2)) return null;
    let pos = start + 32;
    function goString() {
      let size = 0, shift = 0, byte;
      do {
        if (pos >= data.length || shift > 28) return null;
        byte = data[pos++]; size += (byte & 127) * (2 ** shift); shift += 7;
      } while (byte & 128);
      if (size > 65536 || pos + size > data.length) return null;
      const value = data.subarray(pos, pos + size); pos += size;
      return value;
    }
    if (!/^go\d+\./.test(goString()?.toString('utf8') || '')) return null;
    const info = goString();
    const prefix = Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex');
    const suffix = Buffer.from('f932433186182072008242104116d8f2', 'hex');
    if (!info?.subarray(0, 16).equals(prefix) || !info.subarray(-16).equals(suffix)) return null;
    const lines = info.subarray(16, -16).toString('utf8').split('\n');
    if (!lines.includes(`path\tgithub.com/kunchenguid/${name}`) &&
        !lines.includes(`path\tgithub.com/kunchenguid/${name}/cmd/${name}`)) return null;
    const modules = lines.filter(line => line.startsWith(`mod\tgithub.com/kunchenguid/${name}\t`));
    if (modules.length !== 1 || lines.some(line => line.startsWith('=>\t'))) return null;
    const version = modules[0].split('\t')[2];
    return /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ? version : null;
  } catch { return null; }
}
function git(dir, ...argv) {
  // OS Git only; prohibit optional locks, fsmonitor, submodule recursion and inherited Git overrides.
  if (!fs.existsSync('/usr/bin/git')) return null;
  const result = spawnSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'submodule.recurse=false', '-C', dir, ...argv],
    { encoding: 'utf8', timeout: 2500, maxBuffer: 65536, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
  return result.status === 0 ? result.stdout.trim() : null;
}
function source(pkg, target, name) {
  if (!target) return 'not attributable (no installed package source clone)';
  // Inspect at most six parent directories of the actual target, never unrelated
  // same-named folders. A nearer foreign Git boundary prevents claiming its parent.
  let dir = path.dirname(target);
  for (let depth = 0; depth < 6 && dir !== path.dirname(dir); depth++, dir = path.dirname(dir)) {
    if (pkg && dir === path.dirname(pkg.dir)) break; // no runtime-manager parent for npm
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    if (git(dir, 'rev-parse', '--show-toplevel') !== dir) return 'unverified source clone (Git boundary could not be established)';
    const remote = git(dir, 'config', '--local', '--get', 'remote.origin.url');
    if (!owned(remote, name)) return `unverified source remote: ${remote || 'unknown'}`;
    const changes = git(dir, 'status', '--porcelain', '--untracked-files=normal', '--ignore-submodules=all');
    const branch = git(dir, 'symbolic-ref', '--quiet', '--short', 'HEAD') || 'detached';
    const counts = git(dir, 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}');
    return `verified remote=${remote}; branch=${branch}; tracked/untracked changes=${changes === null ? 'unknown' : changes ? 'present' : 'none'}; ahead/behind cached upstream=${counts || 'unknown (no fetch)'}`;
  }
  return 'not attributable (no verified installed-target source clone within six ancestors)';
}
function floor(name) {
  const variable = ({ 'no-mistakes': 'NO_MISTAKES_MIN', 'gh-axi': 'GH_AXI_MIN', 'lavish-axi': 'LAVISH_AXI_MIN', 'tasks-axi': 'FM_TASKS_AXI_MIN', 'quota-axi': 'FM_QUOTA_AXI_MIN' })[name];
  if (!variable) return null;
  const text = name === 'tasks-axi' || name === 'quota-axi'
    ? fs.readFileSync(path.join(root, `bin/fm-${name}-lib.sh`), 'utf8') : bootstrap;
  return text.match(new RegExp(`^${variable}=([0-9]+\\.[0-9]+\\.[0-9]+)$`, 'm'))?.[1] || null;
}
function compare(a, b) {
  if (!/^\d+\.\d+\.\d+$/.test(a || '')) return null;
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
function release(name) {
  return new Promise(resolve => {
    const req = https.get(`https://api.github.com/repos/kunchenguid/${name}/releases/latest`,
      { timeout: 4000, headers: { 'User-Agent': 'fm-quarterdeck-toolcheck', Accept: 'application/vnd.github+json' } }, res => {
        let body = '';
        res.on('data', part => { body += part; if (body.length > 65536) req.destroy(); });
        res.on('end', () => { try { const tag = JSON.parse(body).tag_name; resolve(res.statusCode === 200 && typeof tag === 'string' && tag.length < 80 ? tag : 'unavailable'); } catch { resolve('unavailable'); } });
      });
    req.on('timeout', () => req.destroy()); req.on('error', () => resolve('unavailable'));
  });
}
console.log(`Firstmate bootstrap audit (read-only) | root=${root}`);
let count = 0;
for (const name of names) {
  if (excluded.has(name)) continue;
  const copies = paths(name).map(p => ({ p, target: real(p) }));
  const literal = name === 'treehouse' || name === 'no-mistakes';
  const records = copies.map(c => {
    const pkg = manifest(c.target, name);
    const native = !pkg && literal ? nativeVersion(c.target, name) : null;
    const comparable = pkg?.version || (native && /^v\d+\.\d+\.\d+$/.test(native) ? native.slice(1) : null);
    return { ...c, pkg, native, comparable };
  });
  const proof = literal ? evidence.get(name) : records.find(c => owned(c.pkg?.repo, name))?.pkg?.repo;
  // npm's bootstrap name alone does not prove repository ownership. Fail closed.
  if (!proof) { console.log(`\n${name}: excluded (bootstrap npm name, but no installed Kunchenguid repository ownership proof)`); continue; }
  count++;
  const conflicts = [];
  const first = records[0];
  const f = floor(name);
  console.log(`\n${name} (kunchenguid/${name})`);
  console.log(`  Scope proof: ${proof}`);
  console.log(`  Bootstrap declaration: ${evidence.get(name)}`);
  console.log(`  Resolved command: ${first?.p || 'missing'}`);
  console.log(`  PATH copies: ${records.length || 'none'}`);
  for (const c of records) {
    const version = c.pkg?.version || c.native || 'unknown (unidentified executable not run)';
    const hash = c.target && fs.statSync(c.target).size <= 16 * 1024 * 1024
      ? crypto.createHash('sha256').update(fs.readFileSync(c.target)).digest('hex') : 'unavailable';
    const perCopy = f ? compare(c.comparable, f) : null;
    console.log(`    ${c.p} -> ${c.target || 'unresolved'}; version=${version} (${c.pkg ? 'package manifest claim' : c.native ? 'static Go build module claim (not CLI release)' : 'no safe version evidence'}); manifest=${c.pkg?.file || 'none'}; repository=${c.pkg?.repo || 'unknown'}; sha256=${hash}; floor=${f || 'none'} (${perCopy === null ? 'unverified' : perCopy < 0 ? 'below' : 'reported version meets'})`);
    if (c.p !== c.target) conflicts.push('symlink or wrapper target');
    if (c.pkg && !owned(c.pkg.repo, name)) conflicts.push('manifest owner mismatch');
    if (!c.pkg) conflicts.push('unknown provenance/integrity');
    const cloneCopy = source(c.pkg, c.target, name);
    console.log(`      source: ${cloneCopy}`);
    if (/changes=present/.test(cloneCopy)) conflicts.push('dirty source clone');
    if (/ahead\/behind cached upstream=(?!0\s+0)/.test(cloneCopy) && !cloneCopy.includes('unknown (no fetch)')) conflicts.push('diverged source clone');
    if (/branch=(?!main\b|master\b|detached\b)/.test(cloneCopy)) conflicts.push('custom branch');
    if (cloneCopy.startsWith('unverified')) conflicts.push('unverified clone owner');
  }
  if (records.length > 1) conflicts.push('duplicate/shadowed PATH copies');
  if (!first) conflicts.push('missing installation');
  if (f) {
    const comp = compare(first?.comparable, f);
    console.log(`  Firstmate compatibility: floor >=${f}; ${comp === null ? 'unverified' : comp < 0 ? 'incompatible version' : 'reported version meets floor (features not probed)'}`);
    if (records.some(c => compare(c.comparable, f) !== null && compare(c.comparable, f) < 0)) conflicts.push('incompatible version (PATH copy)');
    if (comp === null) conflicts.push('compatibility unverified');
  } else console.log('  Firstmate compatibility: no static floor; feature probe not run against installed code');
  console.log(`  Conflict assessment: ${[...new Set(conflicts)].join('; ') || 'none detected'}; installation integrity remains unverified`);
  console.log(`  Available version: ${args.includes('--releases') ? `GitHub latest release tag=${await release(name)} (bounded optional network metadata)` : 'not requested (no network)'}; not proof of safe upgrade`);
  console.log('  Upgrade plan: review hashes, provenance, local modifications and compatibility separately; obtain approval before any change');
}
if (!count) console.log('No bootstrap-declared tools with explicit Kunchenguid ownership proof found; no general tools substituted.');
