#!/usr/bin/env node
// Operator-started foreground launcher. Owns only its IPC child, never Serve.
import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createGitIdentity, sourceGitEnvironment } from '../prototype/git-identity.js';

export class LandingWatch {
  constructor({ branch, commit, prove, isAncestor, launch, stop }) {
    Object.assign(this, { branch, commit, prove, isAncestor, launch, stop });
    this.child = null;
  }
  async start() {
    const current = await this.prove();
    if (current.branch !== this.branch || current.commit !== this.commit) throw new Error('Approved clean branch/revision required');
    this.child = await this.launch(this.commit);
  }
  async tick() {
    const current = await this.prove();
    if (current.branch !== this.branch) throw new Error('Branch changed; operator review required');
    if (!current.commit || current.commit === this.commit) return false;
    if (!await this.isAncestor(this.commit, current.commit)) throw new Error('Not a fast-forward; operator review required');
    // Never start a replacement before the old owned process has exited.
    await this.stop(this.child);
    this.child = null;
    const confirmed = await this.prove();
    if (confirmed.commit !== current.commit || confirmed.branch !== this.branch) throw new Error('Checkout changed during restart');
    this.child = await this.launch(current.commit);
    this.commit = current.commit;
    return true;
  }
  async close() {
    if (this.child) await this.stop(this.child);
    this.child = null;
  }
}

const script = fileURLToPath(import.meta.url);
async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => {
    child.once('exit', resolve);
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.once('exit', () => clearTimeout(timer));
  });
}

async function childMain(root, commit) {
  if (!process.send || !process.connected || await createGitIdentity(root).snapshot() !== commit) throw new Error('Pinned child IPC required');
  const { createServer } = await import('../prototype/server.js');
  const server = createServer(process.env);
  if (await createGitIdentity(root).snapshot() !== commit) throw new Error('Checkout changed during child import');
  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    const timer = setTimeout(() => process.exit(1), 5000);
    server.close(() => { clearTimeout(timer); process.exit(0); });
  };
  process.on('disconnect', close);
  process.on('SIGTERM', close);
  process.on('SIGINT', close);
  server.on('error', () => { console.error('Quarterdeck owned listener unavailable'); process.exit(1); });
  server.listen(Number(process.env.PORT || 4173), '127.0.0.1', () => process.send({ commit }));
}

async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 24) throw new Error('Node 24 LTS required');
  const root = await realpath(path.resolve(path.dirname(script), '..'));
  const [branch, commit, extra] = process.argv.slice(2);
  if (branch === '--child' && !extra) return childMain(root, commit);
  if (!branch || !/^[a-f0-9]{40}$/.test(commit || '') || extra) throw new Error('usage: quarterdeck-watch.mjs <approved-branch> <approved-40-hex-commit>');
  if (!path.isAbsolute(process.env.FM_HOME || '') || (process.env.HOST && process.env.HOST !== '127.0.0.1') ||
      process.env.FM_PREVIEW_ROOT || process.env.FM_PREVIEW_REGISTRY_PATH || process.env.FM_DEV) throw new Error('Explicit FM_HOME and standalone loopback launch required (no registry/dev)');
  const port = process.env.PORT || '4173';
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) throw new Error('Invalid port');
  const identity = createGitIdentity(root);
  const run = promisify(execFile);
  const prove = async () => {
    const { stdout } = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: root, env: sourceGitEnvironment(), timeout: 2000, maxBuffer: 4096 });
    return { branch: stdout.trim(), commit: await identity.snapshot() };
  };
  let exiting = false;
  const watch = new LandingWatch({ branch, commit, prove, isAncestor: identity.isAncestor, stop: stopChild,
    launch: async (head) => {
      const child = fork(script, ['--child', head], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: port }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: [] });
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { void stopChild(child).then(() => reject(new Error('Owned listener startup deadline'))); }, 10000);
        const failed = () => { clearTimeout(timer); reject(new Error('Owned listener exited at startup')); };
        child.once('error', failed);
        child.once('exit', failed);
        child.once('message', (message) => {
          clearTimeout(timer);
          child.removeListener('error', failed);
          child.removeListener('exit', failed);
          if (message?.commit === head) resolve();
          else void stopChild(child).then(() => reject(new Error('Owned listener identity mismatch')));
        });
      });
      console.log(`Quarterdeck owned listener started at revision ${head}; health and remote access require verification`);
      return child;
    } });
  process.on('SIGTERM', () => { exiting = true; });
  process.on('SIGINT', () => { exiting = true; });
  try {
    await watch.start();
    while (!exiting) {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      if (exiting) break;
      if (watch.child.exitCode !== null || watch.child.signalCode !== null) throw new Error('Owned child exited; no automatic crash retry');
      await watch.tick();
    }
  } finally { exiting = true; await watch.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error('Quarterdeck launch/watch stopped; inspect clean branch, child and launch configuration. No shared route changed.'); process.exitCode = 1; });
}
