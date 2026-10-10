#!/usr/bin/env node
// Operator-only explicit install/remove of one exact pinned hook entry.
import { execFileSync } from 'node:child_process';
import { lstat, readFile, realpath, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const source = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function hookEntry(home, sourceRoot, node = process.execPath, configDir = null) {
  return { hooks: [{ type: 'command', command: `FM_HOME=${quote(home)}${configDir ? ` CLAUDE_CONFIG_DIR=${quote(configDir)}` : ''} ${quote(node)} ${quote(path.join(sourceRoot, 'scripts/captain-ask-stop-hook.mjs'))}`, timeout: 8 }] };
}
export async function configure(file, entry, install) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lockPath = `${file}.quarterdeck-hook.lock`, temp = `${file}.${randomUUID()}.tmp`;
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    let before = null;
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.size > 1024 * 1024 || await realpath(file) !== file) throw new Error('Settings must be a bounded nonsymlink regular file');
      before = await readFile(file, 'utf8');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const settings = before === null ? {} : JSON.parse(before);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid settings');
    settings.hooks ||= {};
    if (typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) throw new Error('Invalid hooks');
    const entries = settings.hooks.Stop || [];
    if (!Array.isArray(entries)) throw new Error('Invalid Stop hooks');
    const exact = value => JSON.stringify(value) === JSON.stringify(entry);
    // No blind replacement of a different revision/node/home or user-owned entry.
    if (entries.some(value => JSON.stringify(value).includes('captain-ask-stop-hook.mjs') && !exact(value))) throw new Error('Different ask hook exists; remove using its original pinned installer first');
    if (install) { if (!entries.some(exact)) entries.push(entry); }
    else if (!entries.some(exact)) throw new Error('Exact pinned ask hook not found; refusing removal');
    settings.hooks.Stop = install ? entries : entries.filter(value => !exact(value));
    if (!settings.hooks.Stop.length) delete settings.hooks.Stop;
    if (!Object.keys(settings.hooks).length) delete settings.hooks;
    const current = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    if (current !== before) throw new Error('Settings changed during edit');
    const handle = await open(temp, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(lockPath); }
}
async function main() {
  const [mode, home, revision, configDir] = process.argv.slice(2);
  if (!['install', 'uninstall'].includes(mode) || !home || !path.isAbsolute(home) || !/^[a-f0-9]{40}$/.test(revision || '') || (configDir && !path.isAbsolute(configDir))) throw new Error('Usage: node scripts/captain-ask-hook-install.mjs install|uninstall /absolute/FM_HOME <pinned-40-hex-revision> [/absolute/CLAUDE_CONFIG_DIR]');
  if (execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() !== revision || execFileSync('git', ['-C', source, 'status', '--porcelain'], { encoding: 'utf8' }).trim()) throw new Error('Installer requires the exact clean pinned source revision');
  const root = await realpath(home);
  const directory = path.join(root, '.claude');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (await realpath(directory) !== directory) throw new Error('Refusing symlink settings directory');
  await configure(path.join(directory, 'settings.local.json'), hookEntry(root, source, process.execPath, configDir), mode === 'install');
  console.log(`${mode} complete: ${directory}/settings.local.json`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
