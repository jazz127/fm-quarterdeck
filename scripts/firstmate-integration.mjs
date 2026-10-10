#!/usr/bin/env node
// Explicit operator transaction; never runs at server startup or touches stock source.
import { execFileSync } from 'node:child_process';
import { lstat, realpath, readFile, writeFile, mkdir, open, rename, unlink, symlink, readlink, readdir } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { hookEntry } from './captain-ask-hook-install.mjs';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const skills = ['fmqd-lanes', 'fmqd-health', 'fmqd-quartermaster', 'fmqd-toolcheck'];
// Prior discovery names are inspection-only; the saved journal owns removal.
const legacySkills = ['fm-lanes', 'fm-quarterdeck-health', 'fm-quartermaster', 'fm-toolcheck'];
const knownSkills = [...skills, ...legacySkills];
const tag = 'fm-quarterdeck';
const marker = '<!-- fm-quarterdeck:integration:v1 -->';
const endMarker = '<!-- /fm-quarterdeck:integration:v1 -->';
const pinTagFile = 'fm-quarterdeck.json';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
function git(root, args) { return execFileSync('/usr/bin/git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-C', root, ...args], { env: { ...gitEnv(), GIT_OPTIONAL_LOCKS: '0' }, maxBuffer: 32 * 1024 * 1024 }); }
async function info(file) { try { return await lstat(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function directory(dir, create = false) {
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  if (!(await info(dir))?.isDirectory() || await realpath(dir) !== dir) throw new Error('Refusing absent or symlinked directory');
}
async function parents(home, relative, create = false) {
  const parts = relative.split('/');
  if (path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid owned relative path');
  let dir = home;
  for (const part of parts.slice(0, -1)) {
    dir = path.join(dir, part);
    if (!await info(dir) && !create) return;
    await directory(dir, create);
  }
}
async function capture(home, relative) {
  await parents(home, relative);
  const file = path.join(home, relative), stat = await info(file);
  if (!stat) return null;
  if (stat.isSymbolicLink()) return { link: await readlink(file) };
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 2 * 1024 * 1024) throw new Error('Refusing unsafe or oversized integration artifact');
  return { bytes: (await readFile(file)).toString('base64'), mode: stat.mode & 0o777 };
}
async function publish(home, relative, value) {
  await parents(home, relative, value !== null);
  const file = path.join(home, relative);
  if (!value) { if (await info(file)) await unlink(file); return; }
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    if (value.link) await symlink(value.link, temp);
    else await writeFile(temp, Buffer.from(value.bytes, 'base64'), { flag: 'wx', mode: value.mode });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}
const regular = (text, mode = 0o600) => ({ bytes: Buffer.from(text).toString('base64'), mode });
const textOf = value => value ? Buffer.from(value.bytes, 'base64').toString('utf8') : '';
function settingsEdit(before, entry, install) {
  if (before?.link) throw new Error('Symlink settings refused');
  const settings = JSON.parse(textOf(before) || '{}');
  if (!settings || Array.isArray(settings) || typeof settings !== 'object') throw new Error('Invalid settings');
  const hooks = settings.hooks || {};
  if (!hooks || Array.isArray(hooks) || typeof hooks !== 'object') throw new Error('Invalid hooks');
  const stops = hooks.Stop || [];
  if (!Array.isArray(stops)) throw new Error('Invalid Stop hooks');
  const related = stops.filter(value => JSON.stringify(value).includes('captain-ask-stop-hook.mjs'));
  if (install ? related.length !== 0 : related.length !== 1 || !same(related[0], entry)) throw new Error('Unowned or changed Quarterdeck hook; remove with original installer before migration');
  hooks.Stop = install ? [...stops, entry] : stops.filter(value => !same(value, entry));
  if (!hooks.Stop.length) delete hooks.Stop;
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  return regular(`${JSON.stringify(settings, null, 2)}\n`, before?.mode ?? 0o600);
}
function preferenceEdit(before, block, install) {
  if (before?.link) throw new Error('Symlink preferences refused');
  const text = textOf(before);
  if (install) {
    if (/<!-- (?:fm-quarterdeck:integration|quarterdeck-integration):v1 -->/.test(text) || /Quarterdeck operating rules: read/.test(text)) throw new Error('Existing unowned operating reference; review migration first');
    return regular(`${text}${block}`, before?.mode ?? 0o600);
  }
  // The journal owns the exact block, including the previous untagged markers.
  const markers = block.match(/<!--[^\n]+-->/g);
  if (text.split(block).length !== 2 || markers?.length !== 2 || markers.some(value => text.split(value).length !== 2)) throw new Error('Changed owned operating reference');
  return regular(text.replace(block, ''), before?.mode ?? 0o600);
}
async function stockGuard(home, files) {
  if (!await info(path.join(home, '.git'))) return;
  for (const file of files) {
    if (git(home, ['ls-files', '--', file]).length) throw new Error('Refusing tracked Firstmate destination');
  }
}
function requireSource(revision) {
  if (!/^[a-f0-9]{40}$/.test(revision)) throw new Error('Expected full pinned revision');
  if (git(source, ['rev-parse', '--show-toplevel']).toString().trim() !== source || git(source, ['rev-parse', 'HEAD']).toString().trim() !== revision || git(source, ['status', '--porcelain', '--untracked-files=all']).length) throw new Error('Install requires exact clean source revision');
}
async function pinSource(home, revision) {
  requireSource(revision);
  const relative = `data/quarterdeck-integration/pins/${revision}`;
  await parents(home, `${relative}/pin.json`, true);
  const root = path.join(home, relative);
  const records = git(source, ['ls-tree', '-rz', revision, '--', 'FIRSTMATE.md', 'README.md', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'scripts', 'skills', 'docs', 'prototype']).toString().split('\0').filter(Boolean);
  const files = [];
  for (const record of records) {
    const match = record.match(/^(100644|100755) blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error('Pin contains unsupported tree entry');
    const [, mode, blob, name] = match;
    // This is an integration pin, not a second dashboard deployment. Keep
    // shared producer readers, but omit UI assets, tests and browser tooling.
    if (/^prototype\/(?:public|test|scripts|data)\//.test(name)) continue;
    const bytes = git(source, ['cat-file', 'blob', blob]);
    const value = { bytes: bytes.toString('base64'), mode: mode === '100755' ? 0o700 : 0o600 };
    const current = await capture(root, name);
    if (current && !same(current, value)) throw new Error('Existing pin differs; never repin in place');
    if (!current) await publish(root, name, value);
    files.push({ name, hash: hash(bytes), mode: value.mode });
  }
  const pin = { relative, files, tag };
  const tagged = regular(`${JSON.stringify(pin, null, 2)}\n`);
  const previous = await capture(root, pinTagFile);
  if (previous && !same(previous, tagged)) throw new Error('Existing pin tag differs');
  if (!previous) await publish(root, pinTagFile, tagged);
  return pin;
}
async function verifyPin(home, pin) {
  const root = path.join(home, pin.relative), expected = new Set(pin.files.map(file => file.name));
  if (pin.tag === tag) {
    expected.add(pinTagFile);
    if (!same(await capture(root, pinTagFile), regular(`${JSON.stringify(pin, null, 2)}\n`))) throw new Error('Pin tag changed or missing');
  }
  async function walk(dir, prefix = '') {
    await directory(dir);
    for (const name of await readdir(dir)) {
      const relative = prefix + name, stat = await lstat(path.join(dir, name));
      if (stat.isDirectory()) await walk(path.join(dir, name), `${relative}/`);
      else if (!expected.has(relative)) throw new Error('Unexpected pin artifact');
    }
  }
  await walk(root);
  for (const file of pin.files) {
    const value = await capture(root, file.name);
    if (!value?.bytes || value.mode !== file.mode || hash(Buffer.from(value.bytes, 'base64')) !== file.hash) throw new Error('Pinned source changed or missing');
  }
}
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('Invalid private configuration');
  const allowed = new Set(['FM_HOME', 'CLAUDE_CONFIG_DIR', 'FM_QUARTERDECK_HEALTH_PORT', 'FM_QUARTERDECK_HEALTH_URL', 'TAILSCALE_BIN', 'FM_QUARTERDECK_HEALTH_MAX_AGE', 'FM_QUARTERDECK_STATE_PATH', 'FM_AGENTOS_STATE_PATH']);
  for (const [key, value] of Object.entries(config)) {
    if (key === 'integrationTag' && value === tag) continue;
    if (!allowed.has(key) || typeof value !== 'string' || !value || value.includes('\0') || value.length > 4096) throw new Error('Unsupported private configuration');
    if (['FM_HOME', 'CLAUDE_CONFIG_DIR', 'FM_QUARTERDECK_STATE_PATH', 'FM_AGENTOS_STATE_PATH'].includes(key) && !path.isAbsolute(value)) throw new Error('Configuration path must be absolute');
    if (key === 'FM_QUARTERDECK_HEALTH_PORT' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535)) throw new Error('Invalid health port');
    if (key === 'FM_QUARTERDECK_HEALTH_MAX_AGE' && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 86400)) throw new Error('Invalid health age');
    if (key === 'FM_QUARTERDECK_HEALTH_URL') {
      const url = new URL(value);
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.port || !['', '/'].includes(url.pathname) || url.search || url.hash) throw new Error('Invalid private HTTPS origin');
    }
  }
  if (config.FM_QUARTERDECK_STATE_PATH && config.FM_AGENTOS_STATE_PATH && config.FM_QUARTERDECK_STATE_PATH !== config.FM_AGENTOS_STATE_PATH) throw new Error('Conflicting state owners');
}
function registration(home, mode, checkId) {
  execFileSync(path.join(home, `bin/fm-check-${mode}.sh`), [checkId], {
    cwd: home, env: { ...process.env, FM_HOME: home, FM_STATE_OVERRIDE: path.join(home, 'state'), FM_ROOT_OVERRIDE: home }, timeout: 10000, stdio: 'pipe'
  });
}
async function planInstall(home, revision, config) {
  for (const file of runtimeFiles) if (await capture(home, file)) throw new Error('Unowned runtime bookkeeping; review migration first');
  const pin = await pinSource(home, revision), root = path.join(home, pin.relative);
  await verifyPin(home, pin);
  const entry = hookEntry(home, root, process.execPath, config.CLAUDE_CONFIG_DIR || null);
  entry.hooks[0].command = `FM_QUARTERDECK_ENFORCE_LANES=1 ${entry.hooks[0].command} # fm-quarterdeck`;
  const block = `\n${marker}\nQuarterdeck operating rules: read ${root}/FIRSTMATE.md\n${endMarker}\n`;
  const operations = [];
  async function add(file, after, shared = null) {
    const before = await capture(home, file);
    if (!shared && before) throw new Error('Unowned integration destination exists; review migration first');
    operations.push({ tag, file, before, after: typeof after === 'function' ? after(before) : after, shared });
  }
  await add('.claude/settings.local.json', before => settingsEdit(before, entry, true), 'settings');
  await add('data/captain.md', before => preferenceEdit(before, block, true), 'preferences');
  for (const name of skills) await add(`.agents/skills/${name}`, { link: `${root}/skills/${name}` });
  // Stock Claude skill discovery commonly aliases this exact home-local directory.
  const discovery = await captureDiscovery(home);
  if (discovery === 'absent') await add('.claude/skills', { link: '../.agents/skills' });
  else if (discovery === 'directory') for (const name of skills) await add(`.claude/skills/${name}`, { link: `${root}/skills/${name}` });
  const checkId = 'fm-quarterdeck-health';
  const check = `#!/usr/bin/env bash\n# fm-quarterdeck\nexport FM_HOME=${quote(home)}\nexport FM_QUARTERDECK_HEALTH_STATE_DIR=${quote(path.join(home, 'state'))}\nexec bash ${quote(`${root}/scripts/quarterdeck-health-check.sh`)}\n`;
  await add(`state/${checkId}.check.sh`, regular(check, 0o700));
  await add(`state/${checkId}.check-trust`, regular(`fm-custom-check-v1\n${hash(Buffer.from(check))}\n`));
  await add('state/quarterdeck-health.json', regular(`${JSON.stringify({ ...config, FM_HOME: home, integrationTag: tag }, null, 2)}\n`));
  await stockGuard(home, operations.map(op => op.file));
  return { schema: 'quarterdeck-firstmate-integration.v1', tag, checkId, home, revision, node: process.execPath, pin, entry, block, phase: 'installing', operations };
}
async function captureDiscovery(home) {
  await parents(home, '.claude/skills');
  const file = path.join(home, '.claude/skills'), stat = await info(file);
  if (!stat) return 'absent';
  if (stat.isSymbolicLink() && await readlink(file) === '../.agents/skills') return 'alias';
  if (stat.isDirectory() && await realpath(file) === file) return 'directory';
  throw new Error('Unsupported Claude skill discovery; never change stock projections');
}
async function apply(home, operation, after) {
  const current = await capture(home, operation.file);
  if (same(current, after)) return;
  if (!same(current, operation.before)) throw new Error('Artifact changed during transaction');
  await publish(home, operation.file, after);
}
const manifestFile = 'state/quarterdeck-integration.json';
async function save(home, manifest) { await publish(home, manifestFile, regular(`${JSON.stringify(manifest, null, 2)}\n`)); }
const runtimeFiles = ['state/fm-quarterdeck-health.lock', 'state/fm-quarterdeck-health.stamp'];
function taggedManifest(manifest) {
  return manifest.tag === tag && manifest.pin.tag === tag && manifest.checkId === 'fm-quarterdeck-health'
    && manifest.entry?.hooks?.[0]?.command?.includes('# fm-quarterdeck')
    && manifest.block?.includes(marker) && manifest.block?.includes(endMarker)
    && manifest.operations.every(op => op.tag === tag);
}
async function legacyArtifacts(home) {
  const found = [];
  const claudeLinks = await captureDiscovery(home) === 'directory' ? knownSkills.map(name => `.claude/skills/${name}`) : [];
  for (const file of ['state/quarterdeck-health.check.sh', 'state/quarterdeck-health.check-trust', 'state/quarterdeck-health.json', 'state/fm-quarterdeck-health.check.sh', 'state/fm-quarterdeck-health.check-trust', ...knownSkills.map(name => `.agents/skills/${name}`), ...claudeLinks]) {
    if (await capture(home, file)) found.push(file);
  }
  const settings = await capture(home, '.claude/settings.local.json');
  if (settings?.bytes && textOf(settings).includes('captain-ask-stop-hook.mjs')) found.push('.claude/settings.local.json');
  const preferences = await capture(home, 'data/captain.md');
  if (preferences?.bytes && /Quarterdeck operating rules: read|quarterdeck-integration:v1/.test(textOf(preferences))) found.push('data/captain.md');
  return found;
}
// Bounded inventory of the integration's home-local ownership surfaces, not a
// recursive search through private transcripts or arbitrary settings.
async function inventory(home, manifest, lockFile) {
  const artifacts = [], taggedPins = new Set();
  async function add(file, kind, extra = {}) {
    artifacts.push({ tag, file, kind, present: !!await capture(home, file), ...extra });
  }
  if (manifest?.tag === tag) {
    await add(manifestFile, 'ownership-manifest');
    for (const op of manifest.operations.filter(op => op.tag === tag)) {
      await add(op.file, op.shared || (op.after?.link ? 'skill-or-discovery-link' : 'file'), { identification: 'tagged-manifest' });
    }
  }
  for (const file of runtimeFiles) if (await capture(home, file)) await add(file, 'runtime-state');
  const lock = await capture(home, path.relative(home, lockFile));
  if (lock?.bytes && JSON.parse(textOf(lock)).tag === tag) await add(path.relative(home, lockFile), 'transaction-lock');
  // Tagged private files can survive an interrupted/unowned transaction too.
  for (const file of ['state/fm-quarterdeck-health.check.sh', 'state/fm-quarterdeck-health.check-trust', 'state/quarterdeck-health.json']) {
    const value = await capture(home, file);
    const tagged = value?.bytes && (file.includes(tag) || JSON.parse(textOf(value)).integrationTag === tag);
    if (tagged && !artifacts.some(item => item.file === file)) await add(file, 'file');
  }
  const pins = 'data/quarterdeck-integration/pins';
  await parents(home, `${pins}/placeholder`);
  if (await info(path.join(home, pins))) {
    await directory(path.join(home, pins));
    for (const revision of (await readdir(path.join(home, pins))).sort()) {
      if (!/^[a-f0-9]{40}$/.test(revision)) continue;
      const relative = `${pins}/${revision}`;
      const value = await capture(home, `${relative}/${pinTagFile}`);
      if (!value?.bytes) continue;
      const pin = JSON.parse(textOf(value));
      if (pin.tag !== tag || pin.relative !== relative || !Array.isArray(pin.files)) throw new Error('Invalid pin ownership tag');
      taggedPins.add(path.join(home, relative));
      artifacts.push({ tag, file: relative, kind: 'pin-directory', present: true, retained: true });
      for (const name of [pinTagFile, ...pin.files.map(file => file.name)]) await add(`${relative}/${name}`, 'pin-file', { retained: true });
    }
  }
  // Find directly tagged remnants even if the journal was lost. This is
  // identification only: it does not grant uninstall/adoption authority.
  const settings = await capture(home, '.claude/settings.local.json');
  if (settings?.bytes) {
    const stops = JSON.parse(textOf(settings)).hooks?.Stop || [];
    for (const [index, entry] of stops.entries()) {
      if (JSON.stringify(entry).includes(tag) && !artifacts.some(item => item.file === '.claude/settings.local.json' && item.selector === `hooks.Stop[${index}]`)) await add('.claude/settings.local.json', 'settings', { selector: `hooks.Stop[${index}]` });
    }
  }
  const preferences = await capture(home, 'data/captain.md');
  if (preferences?.bytes && textOf(preferences).includes(marker) && !artifacts.some(item => item.file === 'data/captain.md')) await add('data/captain.md', 'preferences', { marker });
  const discovery = await captureDiscovery(home);
  for (const base of ['.agents/skills', ...(discovery === 'directory' ? ['.claude/skills'] : [])]) {
    for (const name of knownSkills) {
      const file = `${base}/${name}`;
      await parents(home, file);
      if (!(await info(path.join(home, file)))?.isSymbolicLink()) continue;
      const value = await capture(home, file);
      if ([...taggedPins].some(root => value.link === `${root}/skills/${name}`) && !artifacts.some(item => item.file === file)) await add(file, 'skill-link', { identification: 'tagged-pin' });
    }
  }
  return { ok: true, tag, installed: !!manifest, artifacts };
}
export async function integrate(mode, selectedHome, { revision, config = {} } = {}) {
  if (!['install', 'uninstall', 'status', 'verify', 'inventory'].includes(mode) || !path.isAbsolute(selectedHome || '')) throw new Error('Usage: firstmate-integration.mjs install|uninstall|status|verify|inventory /absolute/FM_HOME [40-hex-revision] [private-config.json]');
  const home = path.resolve(selectedHome);
  await directory(home);
  await directory(path.join(home, 'data'));
  await directory(path.join(home, 'state'));
  await stockGuard(home, [manifestFile, 'state/quarterdeck-integration.lock', 'data/quarterdeck-integration']);
  const lockFile = path.join(home, 'state/quarterdeck-integration.lock');
  // Read-only inspection takes no lock and never creates artifacts.
  const lock = ['status', 'verify', 'inventory'].includes(mode) ? null : await open(lockFile, 'wx', 0o600);
  try {
    const raw = await capture(home, manifestFile);
    if (raw?.link) throw new Error('Unsafe manifest');
    let manifest = raw ? JSON.parse(textOf(raw)) : null;
    if (manifest && (manifest.schema !== 'quarterdeck-firstmate-integration.v1' || manifest.home !== home || !/^[a-f0-9]{40}$/.test(manifest.revision || '') || manifest.pin?.relative !== `data/quarterdeck-integration/pins/${manifest.revision}` || !Array.isArray(manifest.operations) || (manifest.checkId && !['quarterdeck-health', 'fm-quarterdeck-health'].includes(manifest.checkId)))) throw new Error('Invalid integration ownership record');
    if (lock) await lock.writeFile(`${JSON.stringify({ tag, pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    if (manifest) await stockGuard(home, manifest.operations.map(op => op.file));
    if (mode === 'inventory') return inventory(home, manifest, lockFile);
    if (mode === 'status' || mode === 'verify') {
      if (!manifest) {
        const legacy = await legacyArtifacts(home);
        return { installed: false, ok: mode === 'status' && !legacy.length, needsReinstall: true, problems: ['not-installed', ...legacy.map(file => `legacy-untagged:${file}`)] };
      }
      const problems = [];
      if (manifest.operations.some(op => ['.agents/skills/', '.claude/skills/'].some(base => legacySkills.some(name => op.file === base + name)))) problems.push('legacy-skill-names:reinstall-required');
      if (!taggedManifest(manifest)) problems.push('legacy-untagged-install:reinstall-required');
      try { await verifyPin(home, manifest.pin); } catch { problems.push('pin-drift'); }
      for (const op of manifest.operations) {
        const current = await capture(home, op.file);
        if (op.shared) {
          try {
            if (op.shared === 'settings') settingsEdit(current, manifest.entry, false);
            else preferenceEdit(current, manifest.block, false);
          } catch { problems.push(op.file); }
        } else if (!same(current, op.after)) problems.push(op.file);
      }
      if (manifest.tag === tag) for (const file of runtimeFiles) {
        try { if ((await capture(home, file))?.link) problems.push(file); }
        catch { problems.push(file); }
      }
      if (manifest.phase !== 'installed') problems.push(`transaction-${manifest.phase}`);
      if (await info(lockFile)) problems.push('transaction-locked');
      return { installed: true, revision: manifest.revision, tagged: taggedManifest(manifest), needsReinstall: !!problems.length, ok: !problems.length, problems };
    }
    if (mode === 'install') {
      revision ||= git(source, ['rev-parse', 'HEAD']).toString().trim();
      requireSource(revision);
      if (manifest && !taggedManifest(manifest)) throw new Error('Legacy untagged installation requires uninstall and reinstall');
      if (!manifest) {
        const legacy = await legacyArtifacts(home);
        if (legacy.length) throw new Error('Unowned legacy integration artifacts; review migration first');
      }
      if (manifest && (manifest.revision !== revision || manifest.node !== process.execPath || manifest.phase === 'uninstalling')) throw new Error('Remove original pin before installing a different revision or runtime');
      if (!manifest) {
        validateConfig(config);
        if (config.FM_HOME && config.FM_HOME !== home) throw new Error('Configuration belongs to a different home');
        for (const name of ['register', 'unregister']) {
          if (!(await info(path.join(home, `bin/fm-check-${name}.sh`)))?.isFile()) throw new Error('Firstmate custom-check interface required');
        }
        manifest = await planInstall(home, revision, config);
        await save(home, manifest); // Write-ahead ownership journal: retry after interruption.
      }
      await verifyPin(home, manifest.pin);
      // Preflight all artifacts before changing any; installed retries allow unrelated shared edits.
      for (const op of manifest.operations) {
        const current = await capture(home, op.file);
        if (manifest.phase === 'installed' && op.shared) {
          if (op.shared === 'settings') settingsEdit(current, manifest.entry, false); else preferenceEdit(current, manifest.block, false);
        } else if (!same(current, op.before) && !same(current, op.after)) throw new Error('Owned artifact drift; refusing reinstall');
      }
      if (manifest.phase === 'installed') return { installed: true, ok: true, revision };
      for (const op of manifest.operations) {
        if (op.file.endsWith('.check-trust')) {
          if (!same(await capture(home, op.file), op.after)) registration(home, 'register', manifest.checkId || 'quarterdeck-health');
          if (!same(await capture(home, op.file), op.after)) throw new Error('Incompatible custom-check registration');
        } else await apply(home, op, op.after);
      }
      manifest.phase = 'installed'; await save(home, manifest);
      return { installed: true, ok: true, revision };
    }
    if (!manifest) return { installed: false, ok: true };
    await verifyPin(home, manifest.pin);
    if (manifest.phase !== 'uninstalling') {
      if (manifest.tag === tag) {
        // Runtime bookkeeping is mutable but confined, tagged, and removable.
        for (const file of runtimeFiles) {
          const current = await capture(home, file);
          if (current?.link) throw new Error('Unsafe runtime bookkeeping; refusing uninstall');
          if (current) manifest.operations.push({ tag, file, before: null, after: current, shared: null });
        }
      }
      // Preflight complete rollback, retaining unrelated preferences/settings added since install.
      for (const op of manifest.operations) {
        const current = await capture(home, op.file);
        let target = op.before;
        if (!same(current, op.after) && !same(current, op.before)) {
          if (!op.shared) throw new Error('Owned artifact drift; refusing uninstall');
          target = op.shared === 'settings' ? settingsEdit(current, manifest.entry, false) : preferenceEdit(current, manifest.block, false);
        }
        op.removeFrom = current; op.removeTo = target;
      }
      manifest.phase = 'uninstalling'; await save(home, manifest);
    }
    for (const op of [...manifest.operations].reverse()) {
      const current = await capture(home, op.file);
      if (!same(current, op.removeFrom) && !same(current, op.removeTo)) throw new Error('Artifact changed during removal');
    }
    // Both registration files were preflighted; unregister only this check.
    registration(home, 'unregister', manifest.checkId || 'quarterdeck-health');
    for (const op of [...manifest.operations].reverse()) {
      if (op.file.endsWith('.check.sh') || op.file.endsWith('.check-trust')) continue;
      await apply(home, { ...op, before: op.removeFrom }, op.removeTo);
    }
    await publish(home, manifestFile, null);
    return { installed: false, ok: true };
  } finally { if (lock) { await lock.close(); await unlink(lockFile); } }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, home, revision, configFile, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Too many arguments');
    if (configFile && (!path.isAbsolute(configFile) || (await lstat(configFile)).size > 65536)) throw new Error('Private configuration must be a bounded absolute file');
    const config = configFile ? JSON.parse(await readFile(configFile, 'utf8')) : {};
    const result = await integrate(mode, home, { revision, config });
    console.log(JSON.stringify(result));
    if (!result.ok) process.exitCode = 1;
  } catch { console.error('Quarterdeck integration refused: inspect ownership, pin, configuration and transaction journal; no blind replacement.'); process.exitCode = 1; }
}
