import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink, lstat, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const skills = ['fmqd-lanes', 'fmqd-quarterdeck-health', 'fmqd-quartermaster', 'fmqd-toolcheck'];
// Synthetic prior-release discovery names; ownership schema and rollback stay v1.
const legacySkills = ['fm-lanes', 'fm-quarterdeck-health', 'fm-quartermaster', 'fm-toolcheck'];

async function fixture(t, { alias = false, discoveryDirectory = false, registrationFails = false, legacy = false } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-integration-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = path.join(dir, 'source'), home = path.join(dir, 'home');
  await mkdir(path.join(source, 'scripts'), { recursive: true });
  for (const file of ['firstmate-integration.mjs', 'captain-ask-hook-install.mjs']) await cp(new URL(`../scripts/${file}`, import.meta.url), path.join(source, 'scripts', file));
  if (legacy) {
    const installer = path.join(source, 'scripts/firstmate-integration.mjs');
    await writeFile(installer, (await readFile(installer, 'utf8')).replace(/^const skills = .+;$/m, `const skills = ${JSON.stringify(legacySkills)};`));
  }
  await writeFile(path.join(source, 'FIRSTMATE.md'), '# Synthetic rules\n');
  await mkdir(path.join(source, 'prototype/public'), { recursive: true });
  await writeFile(path.join(source, 'prototype/public/unneeded-ui.js'), '// Excluded from integration pin.\n');
  await writeFile(path.join(source, 'scripts/quarterdeck-health-check.sh'), '#!/bin/bash\nexit 0\n');
  for (const name of legacy ? legacySkills : skills) {
    await mkdir(path.join(source, 'skills', name), { recursive: true });
    await writeFile(path.join(source, 'skills', name, 'SKILL.md'), `# ${name}\n`);
  }
  const git = (...args) => execFileSync('git', ['-C', source, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic integration');
  const revision = git('rev-parse', 'HEAD').trim();
  for (const name of ['bin', 'data', 'state', '.claude', '.agents/skills']) await mkdir(path.join(home, name), { recursive: true });
  if (alias) await symlink('../.agents/skills', path.join(home, '.claude/skills'));
  if (discoveryDirectory) await mkdir(path.join(home, '.claude/skills'));
  const register = `#!${process.execPath}\nconst fs=require('fs'),crypto=require('crypto'),path=require('path');
const state=path.join(process.env.FM_HOME,'state');
if (${registrationFails}) process.exit(1);
const id=process.argv[2];
const bytes=fs.readFileSync(path.join(state,id+'.check.sh'));
fs.writeFileSync(path.join(state,id+'.check-trust'),'fm-custom-check-v1\\n'+crypto.createHash('sha256').update(bytes).digest('hex')+'\\n',{mode:0o600});\n`;
  await writeFile(path.join(home, 'bin/fm-check-register.sh'), register, { mode: 0o700 });
  await writeFile(path.join(home, 'bin/fm-check-unregister.sh'), `#!${process.execPath}\nconst fs=require('fs'),path=require('path');for(const ext of ['check.sh','check-trust'])fs.rmSync(path.join(process.env.FM_HOME,'state',process.argv[2]+'.'+ext),{force:true});\n`, { mode: 0o700 });
  const { integrate } = await import(pathToFileURL(path.join(source, 'scripts/firstmate-integration.mjs')));
  const run = (mode, options = {}) => integrate(mode, home, { revision, ...options });
  return { dir, source, home, revision, run, git };
}
async function snapshot(root) {
  const result = {};
  async function walk(dir, prefix = '') {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = prefix + name, stat = await lstat(file);
      if (stat.isDirectory()) await walk(file, relative + '/');
      else result[relative] = stat.isSymbolicLink() ? { symlink: await import('node:fs/promises').then(fs => fs.readlink(file)) } : { bytes: (await readFile(file)).toString('base64'), mode: stat.mode & 0o777, mtime: stat.mtimeMs };
    }
  }
  await walk(root); return result;
}

function cli(script, home, mode, ...args) {
  const result = spawnSync(process.execPath, [script, mode, home, ...args], { encoding: 'utf8', timeout: 15000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('canonical skill directories and frontmatter declare only the four fmqd names', async () => {
  const root = new URL('../skills/', import.meta.url);
  assert.deepEqual((await readdir(root)).sort(), [...skills].sort());
  for (const name of skills) {
    const body = await readFile(new URL(`${name}/SKILL.md`, root), 'utf8');
    assert.match(body, new RegExp(`^---\nname: ${name}\n`));
  }
});

for (const discovery of ['absent', 'alias', 'directory']) {
  const options = { alias: discovery === 'alias', discoveryDirectory: discovery === 'directory' };
  test(`fresh CLI install discovers only fmqd skills with ${discovery} Claude discovery`, async t => {
    const { source, home, revision } = await fixture(t, options);
    const script = path.join(source, 'scripts/firstmate-integration.mjs');
    assert.equal(cli(script, home, 'install', revision).ok, true);
    for (const base of ['.agents/skills', '.claude/skills']) {
      assert.deepEqual((await readdir(path.join(home, base))).sort(), [...skills].sort());
    }
    const inventory = cli(script, home, 'inventory');
    for (const name of skills) assert.ok(inventory.artifacts.some(item => item.file === `.agents/skills/${name}` && item.present));
    assert.equal(cli(script, home, 'verify').ok, true);
    assert.equal(cli(script, home, 'uninstall').ok, true);
    assert.ok(cli(script, home, 'inventory').artifacts.every(item => item.retained));
  });

  for (const retireWith of ['current', 'original-pin']) {
    test(`old skills retire via ${retireWith} CLI and repin without cleanup with ${discovery} discovery`, async t => {
      const { source, home, revision, git } = await fixture(t, { ...options, legacy: true });
      const script = path.join(source, 'scripts/firstmate-integration.mjs');
      const unrelated = ['firstmate-coding-guidelines', 'example-custom-skill'];
      const bases = ['.agents/skills', ...(options.discoveryDirectory ? ['.claude/skills'] : [])];
      for (const base of bases) for (const name of unrelated) {
        await mkdir(path.join(home, base, name));
        await writeFile(path.join(home, base, name, 'SKILL.md'), '# Synthetic upstream or user skill\n');
      }
      const originals = await snapshot(home);
      const privateConfig = path.join(source, '..', 'health-config.json');
      await writeFile(privateConfig, JSON.stringify({ FM_QUARTERDECK_HEALTH_PORT: '4321' }));
      cli(script, home, 'install', revision, privateConfig);
      const oldPin = path.join(home, 'data/quarterdeck-integration/pins', revision);
      for (const name of legacySkills) assert.equal((await lstat(path.join(home, '.agents/skills', name))).isSymbolicLink(), true);

      // Publish a synthetic new revision using the actual current installer.
      await cp(new URL('../scripts/firstmate-integration.mjs', import.meta.url), script);
      for (let i = 0; i < skills.length; i++) await rename(path.join(source, 'skills', legacySkills[i]), path.join(source, 'skills', skills[i]));
      git('add', '.'); git('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@users.noreply.github.com', 'commit', '-qm', 'Synthetic skill prefix');
      const next = git('rev-parse', 'HEAD').trim();
      for (const mode of ['status', 'verify']) {
        const result = spawnSync(process.execPath, [script, mode, home], { encoding: 'utf8' });
        assert.equal(result.status, 1);
        assert.deepEqual(JSON.parse(result.stdout).problems, ['legacy-skill-names:reinstall-required']);
      }
      const installedInventory = cli(script, home, 'inventory');
      for (const base of bases) for (const name of legacySkills) assert.ok(installedInventory.artifacts.some(item => item.file === `${base}/${name}` && item.present));
      const before = await snapshot(home);
      const replacement = spawnSync(process.execPath, [script, 'install', home, next], { encoding: 'utf8' });
      assert.equal(replacement.status, 1, 'new pin must require explicit uninstall');
      assert.deepEqual(await snapshot(home), before);

      // Preserve the actual installed config as the normal review-only repin recipe does.
      await cp(path.join(home, 'state/quarterdeck-health.json'), privateConfig);
      cli(retireWith === 'current' ? script : path.join(oldPin, 'scripts/firstmate-integration.mjs'), home, 'uninstall');
      assert.equal(cli(script, home, 'status').ok, true);
      assert.ok(cli(script, home, 'inventory').artifacts.every(item => item.retained && item.file.startsWith('data/quarterdeck-integration/pins/')));
      for (const name of legacySkills) assert.equal(await lstat(path.join(home, '.agents/skills', name)).catch(() => null), null);
      cli(script, home, 'install', next, privateConfig);
      assert.equal(cli(script, home, 'verify').ok, true);
      assert.equal(JSON.parse(await readFile(path.join(home, 'state/quarterdeck-health.json'))).FM_QUARTERDECK_HEALTH_PORT, '4321');
      for (const base of ['.agents/skills', '.claude/skills']) assert.deepEqual((await readdir(path.join(home, base))).sort(), [...skills, ...unrelated].sort());
      const inventory = cli(script, home, 'inventory');
      assert.ok(!inventory.artifacts.some(item => bases.some(base => legacySkills.some(name => item.file === `${base}/${name}`))));
      assert.ok(inventory.artifacts.some(item => item.file === path.relative(home, oldPin) && item.retained), 'old pin remains an inert, inventoried cache');
      cli(script, home, 'uninstall');
      const removed = await snapshot(home);
      for (const [file, value] of Object.entries(originals)) assert.deepEqual(removed[file], value, file);
      assert.ok(cli(script, home, 'inventory').artifacts.every(item => item.retained));
    });
  }
}

test('old-name links remain inventoried after journal loss, with no adoption or blind cleanup', async t => {
  const { source, home, revision } = await fixture(t, { legacy: true, discoveryDirectory: true });
  const script = path.join(source, 'scripts/firstmate-integration.mjs');
  cli(script, home, 'install', revision);
  await rm(path.join(home, 'state/quarterdeck-integration.json'));
  // Inspection/removal use the current source, not the synthetic prior declaration.
  const { integrate } = await import(new URL('../scripts/firstmate-integration.mjs', import.meta.url));
  const before = await snapshot(home);
  const inventory = await integrate('inventory', home);
  for (const base of ['.agents/skills', '.claude/skills']) for (const name of legacySkills) assert.ok(inventory.artifacts.some(item => item.file === `${base}/${name}` && item.identification === 'tagged-pin'));
  const status = await integrate('status', home);
  for (const name of legacySkills) assert.ok(status.problems.includes(`legacy-untagged:.agents/skills/${name}`));
  await integrate('uninstall', home);
  assert.deepEqual(await snapshot(home), before);
});

for (const base of ['.agents/skills', '.claude/skills']) {
  test(`unjournaled old names in ${base} refuse fresh install without touching upstream skills`, async t => {
    const { home, run } = await fixture(t, { discoveryDirectory: true });
    for (const name of [...legacySkills, 'firstmate-coding-guidelines']) await symlink('/synthetic/unowned/skill', path.join(home, base, name));
    const before = await snapshot(home);
    const status = await run('status');
    for (const name of legacySkills) assert.ok(status.problems.includes(`legacy-untagged:${base}/${name}`));
    await assert.rejects(run('install'), /Unowned legacy/);
    await run('uninstall');
    assert.deepEqual(await snapshot(home), before);
  });
}

test('single install pins source, discovers home-local skills, registers check; retries/status are byte-and-time idempotent', async t => {
  const { home, revision, run } = await fixture(t);
  const before = await snapshot(home);
  assert.equal((await run('status')).installed, false);
  assert.equal((await run('verify')).ok, false);
  assert.deepEqual(await snapshot(home), before);
  assert.equal((await run('install', { config: { FM_QUARTERDECK_HEALTH_PORT: '4321' } })).ok, true);
  assert.equal((await run('verify')).revision, revision);
  const installed = await snapshot(home);
  assert.ok(!Object.keys(installed).some(file => file.includes('unneeded-ui.js')), 'do not deploy UI assets inside Firstmate');
  await run('install'); await run('status'); await run('verify');
  assert.deepEqual(await snapshot(home), installed);
  const settings = JSON.parse(await readFile(path.join(home, '.claude/settings.local.json')));
  assert.match(settings.hooks.Stop[0].hooks[0].command, /FM_QUARTERDECK_ENFORCE_LANES=1/);
  assert.match(settings.hooks.Stop[0].hooks[0].command, new RegExp(revision));
  assert.equal((await lstat(path.join(home, 'state/fm-quarterdeck-health.check.sh'))).mode & 0o777, 0o700);
  await run('uninstall');
  assert.equal((await run('status')).installed, false);
  const removed = await snapshot(home);
  await run('uninstall');
  assert.deepEqual(await snapshot(home), removed);
  assert.ok(!('data/captain.md' in removed));
  assert.ok(!('.claude/settings.local.json' in removed));
  assert.ok(Object.keys(removed).some(file => file.includes('/pins/'))); // inert cache retained deliberately
});

test('preserves exact original bytes and existing stock discovery alias', async t => {
  const { home, run } = await fixture(t, { alias: true });
  const settings = '{"theme":"synthetic","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo unrelated"}]}]}}\n';
  const preferences = '# Working preferences\n\n## Existing\nKeep synthetic preference.\n';
  await writeFile(path.join(home, '.claude/settings.local.json'), settings);
  await writeFile(path.join(home, 'data/captain.md'), preferences);
  await run('install'); await run('uninstall');
  assert.equal(await readFile(path.join(home, '.claude/settings.local.json'), 'utf8'), settings);
  assert.equal(await readFile(path.join(home, 'data/captain.md'), 'utf8'), preferences);
  assert.equal((await lstat(path.join(home, '.claude/skills'))).isSymbolicLink(), true);
});

test('unrelated post-install settings and preference edits survive semantic removal', async t => {
  const { home, run } = await fixture(t);
  await run('install');
  const file = path.join(home, '.claude/settings.local.json');
  const settings = JSON.parse(await readFile(file)); settings.newUnrelatedSetting = true;
  await writeFile(file, JSON.stringify(settings));
  const captain = path.join(home, 'data/captain.md');
  await writeFile(captain, (await readFile(captain, 'utf8')) + '\n## New preference\nRetain.\n');
  assert.equal((await run('verify')).ok, true);
  await run('install'); await run('uninstall');
  assert.deepEqual(JSON.parse(await readFile(file)), { newUnrelatedSetting: true });
  assert.equal(await readFile(captain, 'utf8'), '\n## New preference\nRetain.\n');
});

test('unknown legacy destinations refuse; no home projection gets overwritten', async t => {
  const { home, run } = await fixture(t);
  await writeFile(path.join(home, 'state/quarterdeck-health.check.sh'), '# legacy unknown bytes\n');
  await assert.rejects(run('install'), /Unowned/);
  assert.equal(await readFile(path.join(home, 'state/quarterdeck-health.check.sh'), 'utf8'), '# legacy unknown bytes\n');
  assert.equal((await run('status')).installed, false);
  assert.equal(await lstat(path.join(home, '.claude/settings.local.json')).catch(() => null), null);
});

test('detects projection and source drift; uninstall refuses before removing any other projection', async t => {
  const { home, revision, run } = await fixture(t);
  await run('install');
  const config = path.join(home, 'state/quarterdeck-health.json');
  await writeFile(config, '{}\n');
  assert.equal((await run('verify')).ok, false);
  const before = await snapshot(home);
  await assert.rejects(run('uninstall'), /drift/);
  assert.deepEqual(await snapshot(home), before);
  const pinFile = path.join(home, 'data/quarterdeck-integration/pins', revision, 'FIRSTMATE.md');
  await writeFile(pinFile, 'changed');
  assert.ok((await run('status')).problems.includes('pin-drift'));
  await assert.rejects(run('install'), /Pinned source changed/);
});

test('failed registration is journaled, reports incomplete, and can be uninstalled safely', async t => {
  const { home, run } = await fixture(t, { registrationFails: true });
  await assert.rejects(run('install'));
  assert.ok((await run('status')).problems.includes('transaction-installing'));
  await run('uninstall');
  assert.equal((await run('status')).installed, false);
  assert.equal(await lstat(path.join(home, 'state/fm-quarterdeck-health.check.sh')).catch(() => null), null);
});

test('interrupted install retries the journal without duplicating hook, reference or registration', async t => {
  const { home, run } = await fixture(t, { registrationFails: true });
  await assert.rejects(run('install'));
  const register = path.join(home, 'bin/fm-check-register.sh');
  await writeFile(register, (await readFile(register, 'utf8')).replace('if (true)', 'if (false)'));
  await run('install');
  assert.equal((await run('verify')).ok, true);
  const settings = JSON.parse(await readFile(path.join(home, '.claude/settings.local.json')));
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal((await readFile(path.join(home, 'data/captain.md'), 'utf8')).split('Quarterdeck operating rules: read').length, 2);
  await run('uninstall');
});

test('configuration and legacy policy reference are checked mechanically before projection', async t => {
  const { home, run } = await fixture(t);
  for (const config of [{ shellCommand: 'never execute' }, { FM_QUARTERDECK_STATE_PATH: 'relative' }, { FM_QUARTERDECK_HEALTH_PORT: '0' }, { FM_QUARTERDECK_HEALTH_URL: 'http://example.invalid' }]) {
    await assert.rejects(run('install', { config }));
  }
  await writeFile(path.join(home, 'data/captain.md'), 'Quarterdeck operating rules: read /absolute/old/FIRSTMATE.md\n');
  await assert.rejects(run('install'), /legacy|unowned operating reference/);
  assert.equal((await run('status')).installed, false);
});

test('changed shared hook refuses complete removal without touching other artifacts', async t => {
  const { home, run } = await fixture(t);
  await run('install');
  const file = path.join(home, '.claude/settings.local.json');
  const settings = JSON.parse(await readFile(file)); settings.hooks.Stop[0].hooks[0].timeout = 99;
  await writeFile(file, JSON.stringify(settings));
  assert.equal((await run('verify')).ok, false);
  const before = await snapshot(home);
  await assert.rejects(run('uninstall'), /changed Quarterdeck hook/);
  assert.deepEqual(await snapshot(home), before);
});

test('symlink parent refused without writes outside selected home; dirty sources refused', async t => {
  const { dir, source, home, run } = await fixture(t);
  const outside = path.join(dir, 'outside'); await mkdir(outside);
  await rm(path.join(home, '.agents'), { recursive: true }); await symlink(outside, path.join(home, '.agents'));
  await assert.rejects(run('install'), /symlinked directory/);
  assert.deepEqual(await readdir(outside), []);
  await writeFile(path.join(source, 'FIRSTMATE.md'), 'dirty');
  await assert.rejects(run('install'), /clean source/);
});

test('tracked Firstmate destinations are never edited', async t => {
  const { home, run } = await fixture(t);
  execFileSync('git', ['-C', home, 'init', '-q']);
  await writeFile(path.join(home, 'data/captain.md'), '# tracked, unsafe\n');
  execFileSync('git', ['-C', home, 'add', 'data/captain.md']);
  await assert.rejects(run('install'), /tracked Firstmate destination/);
  assert.equal(await readFile(path.join(home, 'data/captain.md'), 'utf8'), '# tracked, unsafe\n');
});

test('every projection is tagged directly or by manifest; inventory includes pin cache and runtime bookkeeping without writes', async t => {
  const { home, run } = await fixture(t);
  await run('install');
  const manifest = JSON.parse(await readFile(path.join(home, 'state/quarterdeck-integration.json')));
  assert.equal(manifest.tag, 'fm-quarterdeck');
  assert.equal(manifest.checkId, 'fm-quarterdeck-health');
  assert.match(manifest.entry.hooks[0].command, /# fm-quarterdeck$/);
  assert.match(manifest.block, /<!-- fm-quarterdeck:integration:v1 -->/);
  assert.match(manifest.block, /<!-- \/fm-quarterdeck:integration:v1 -->/);
  assert.equal(JSON.parse(await readFile(path.join(home, 'state/quarterdeck-health.json'))).integrationTag, 'fm-quarterdeck');
  for (const op of manifest.operations) assert.equal(op.tag, 'fm-quarterdeck');
  for (const file of ['fm-quarterdeck-health.lock', 'fm-quarterdeck-health.stamp']) await writeFile(path.join(home, 'state', file), 'synthetic runtime');
  const before = await snapshot(home);
  const inventory = await run('inventory');
  assert.deepEqual(await snapshot(home), before);
  assert.ok(inventory.artifacts.every(item => item.tag === 'fm-quarterdeck' && item.present));
  for (const file of Object.keys(before).filter(file => !file.startsWith('bin/'))) {
    assert.ok(inventory.artifacts.some(item => item.file === file), `inventory missing ${file}`);
  }
  await run('uninstall');
  const removed = await run('inventory');
  assert.equal(removed.installed, false);
  assert.ok(removed.artifacts.length > 0);
  assert.ok(removed.artifacts.every(item => item.retained && item.file.startsWith('data/quarterdeck-integration/pins/')));
  assert.equal((await run('status')).ok, true);
});

test('inventory identifies tagged remnants after journal loss without granting removal authority', async t => {
  const { home, run } = await fixture(t);
  await run('install');
  await rm(path.join(home, 'state/quarterdeck-integration.json'));
  const before = await snapshot(home);
  const inventory = await run('inventory');
  for (const file of ['.claude/settings.local.json', 'data/captain.md', '.agents/skills/fmqd-lanes', 'state/quarterdeck-health.json', 'state/fm-quarterdeck-health.check.sh', 'state/fm-quarterdeck-health.check-trust']) assert.ok(inventory.artifacts.some(item => item.file === file), file);
  assert.equal(inventory.installed, false);
  assert.deepEqual(await snapshot(home), before);
  await run('uninstall');
  assert.deepEqual(await snapshot(home), before);
});

test('tag tampering and unsafe runtime bookkeeping are reported read-only and refuse blind uninstall', async t => {
  const { home, run } = await fixture(t);
  await run('install');
  await symlink('quarterdeck-health.json', path.join(home, 'state/fm-quarterdeck-health.stamp'));
  const before = await snapshot(home);
  assert.ok((await run('verify')).problems.includes('state/fm-quarterdeck-health.stamp'));
  await assert.rejects(run('uninstall'), /Unsafe runtime/);
  assert.deepEqual(await snapshot(home), before);
  await rm(path.join(home, 'state/fm-quarterdeck-health.stamp'));
  const file = path.join(home, 'state/quarterdeck-integration.json');
  const manifest = JSON.parse(await readFile(file));
  delete manifest.operations[0].tag;
  await writeFile(file, JSON.stringify(manifest));
  assert.ok((await run('status')).problems.includes('legacy-untagged-install:reinstall-required'));
});

test('current untagged journal is detected and uninstalled backward-compatibly, preserving unrelated edits', async t => {
  const { home, run } = await fixture(t);
  await run('install');
  const file = path.join(home, 'state/quarterdeck-integration.json');
  const manifest = JSON.parse(await readFile(file));
  delete manifest.tag; delete manifest.checkId; delete manifest.pin.tag;
  await rm(path.join(home, manifest.pin.relative, 'fm-quarterdeck.json'));
  manifest.entry.hooks[0].command = manifest.entry.hooks[0].command.replace(' # fm-quarterdeck', '');
  manifest.block = manifest.block.replaceAll('fm-quarterdeck:integration:v1', 'quarterdeck-integration:v1');
  const legacyCheck = Buffer.from(manifest.operations.find(op => op.file.endsWith('.check.sh')).after.bytes, 'base64').toString().replace('# fm-quarterdeck\n', '');
  for (const op of manifest.operations) {
    delete op.tag;
    const old = op.file;
    op.file = op.file.replace('fm-quarterdeck-health.', 'quarterdeck-health.');
    if (old !== op.file) await rename(path.join(home, old), path.join(home, op.file));
    if (op.shared === 'settings') op.after.bytes = Buffer.from(JSON.stringify({ hooks: { Stop: [manifest.entry] } }, null, 2) + '\n').toString('base64');
    if (op.shared === 'preferences') op.after.bytes = Buffer.from(manifest.block).toString('base64');
    if (op.file.endsWith('.check.sh')) op.after.bytes = Buffer.from(legacyCheck).toString('base64');
    if (op.file.endsWith('.check-trust')) op.after.bytes = Buffer.from(`fm-custom-check-v1\n${createHash('sha256').update(legacyCheck).digest('hex')}\n`).toString('base64');
    if (op.file.endsWith('quarterdeck-health.json')) {
      const config = JSON.parse(Buffer.from(op.after.bytes, 'base64'));
      delete config.integrationTag;
      op.after.bytes = Buffer.from(JSON.stringify(config, null, 2) + '\n').toString('base64');
    }
    if (op.after.bytes) await writeFile(path.join(home, op.file), Buffer.from(op.after.bytes, 'base64'), { mode: op.after.mode });
  }
  await writeFile(file, JSON.stringify(manifest));
  const preferences = path.join(home, 'data/captain.md');
  await writeFile(preferences, (await readFile(preferences, 'utf8')) + '\n## Unrelated\nKeep.\n');
  const before = await snapshot(home);
  const status = await run('status');
  assert.equal(status.ok, false);
  assert.equal(status.needsReinstall, true);
  assert.ok(status.problems.includes('legacy-untagged-install:reinstall-required'));
  assert.deepEqual((await run('verify')).problems, status.problems);
  assert.deepEqual(await snapshot(home), before);
  await assert.rejects(run('install'), /Legacy untagged/);
  await run('uninstall');
  assert.equal(await readFile(preferences, 'utf8'), '\n## Unrelated\nKeep.\n');
  assert.equal(await lstat(path.join(home, 'state/quarterdeck-health.check.sh')).catch(() => null), null);
  assert.equal((await run('status')).ok, true);
});

test('standalone untagged legacy is flagged without adopting ownership or writing', async t => {
  const { home, run } = await fixture(t);
  await writeFile(path.join(home, 'state/quarterdeck-health.check.sh'), '# unowned legacy\n');
  const before = await snapshot(home);
  const status = await run('status');
  assert.equal(status.ok, false);
  assert.equal(status.needsReinstall, true);
  assert.ok(status.problems.includes('legacy-untagged:state/quarterdeck-health.check.sh'));
  assert.deepEqual((await run('inventory')).artifacts, []);
  await run('uninstall'); // no journal means no authority to delete the legacy file
  assert.deepEqual(await snapshot(home), before);
});

test('toolcheck runs status/verify, reports pin and projection drift with exact reinstall command, never writes or executes checks', async t => {
  const { source, home, run, revision } = await fixture(t);
  await writeFile(path.join(home, 'bin/fm-bootstrap.sh'), 'install_cmd() {\n}\n');
  await run('install');
  const audit = fileURLToPath(new URL('../skills/fmqd-toolcheck/audit.mjs', import.meta.url));
  const report = () => execFileSync(process.execPath, [audit, '--firstmate-root', home, '--quarterdeck-root', source], { encoding: 'utf8', timeout: 15000 });
  const before = await snapshot(home);
  assert.match(report(), /Drift: none detected/);
  assert.deepEqual(await snapshot(home), before);
  await writeFile(path.join(source, 'FIRSTMATE.md'), '# New synthetic rules\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'New main']);
  const main = execFileSync('git', ['-C', source, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  await writeFile(path.join(home, '.claude/settings.local.json'), '{}\n');
  await writeFile(path.join(home, 'data/captain.md'), '# Working preferences\n');
  await rm(path.join(home, '.agents/skills/fmqd-toolcheck'));
  await rm(path.join(home, 'state/fm-quarterdeck-health.check-trust'));
  await writeFile(path.join(home, 'state/quarterdeck-health.json'), '{}\n');
  const drifted = await snapshot(home);
  const output = report();
  for (const evidence of ['status:', 'verify:', 'out-of-date-pin', revision, main, '.claude/settings.local.json', 'data/captain.md', '.agents/skills/fmqd-toolcheck', 'state/fm-quarterdeck-health.check-trust', 'state/quarterdeck-health.json', 'Exact reinstall command (review only; NEVER executed)', source + '/scripts/firstmate-integration.mjs', 'cp --', 'uninstall', 'install', 'mktemp']) assert.ok(output.includes(evidence), evidence);
  assert.deepEqual(await snapshot(home), drifted);
});

test('printed reinstall command is executable after separate operator approval and preserves private config', async t => {
  const { source, home, run } = await fixture(t);
  await writeFile(path.join(home, 'bin/fm-bootstrap.sh'), 'install_cmd() {\n}\n');
  await run('install', { config: { FM_QUARTERDECK_HEALTH_PORT: '4321' } });
  await writeFile(path.join(source, 'FIRSTMATE.md'), '# Reviewed new rules\n');
  execFileSync('git', ['-C', source, 'add', '.']);
  execFileSync('git', ['-C', source, '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Reviewed main']);
  const main = execFileSync('git', ['-C', source, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
  const audit = fileURLToPath(new URL('../skills/fmqd-toolcheck/audit.mjs', import.meta.url));
  const before = await snapshot(home);
  const output = execFileSync(process.execPath, [audit, '--firstmate-root', home, '--quarterdeck-root', source], { encoding: 'utf8', timeout: 15000 });
  assert.deepEqual(await snapshot(home), before, 'audit must not execute its printed command');
  const command = output.split('\n').find(line => line.includes('Exact reinstall command')).split('executed): ')[1];
  assert.ok(command, 'exact shell command provided');
  // This test explicitly approves execution only in its own synthetic home.
  execFileSync('/bin/bash', ['-c', command], { encoding: 'utf8', timeout: 15000 });
  const status = await run('verify');
  assert.equal(status.ok, true);
  assert.equal(status.revision, main);
  const config = JSON.parse(await readFile(path.join(home, 'state/quarterdeck-health.json')));
  assert.equal(config.FM_QUARTERDECK_HEALTH_PORT, '4321');
  assert.equal(config.integrationTag, 'fm-quarterdeck');
});
