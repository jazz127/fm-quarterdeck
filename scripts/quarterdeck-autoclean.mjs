#!/usr/bin/env node
// fm-quarterdeck: opt-in report ONLY. No subprocess, endpoint probe or write API.
import { constants } from 'node:fs';
import { lstat, realpath, open, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { foldStatusLines } from '../prototype/work-model.js';
import { parseBacklogTask } from '../prototype/firstmate-records.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const MAX_TASKS = 512;
const MAX_BYTES = 65536;
const STALE_MS = 24 * 60 * 60 * 1000;
const tag = 'fm-quarterdeck';

async function directory(dir) {
  if (!(await lstat(dir)).isDirectory() || await realpath(dir) !== dir) throw new Error('Unverified directory');
}

// Fixed selected-home sources only. Never follow recorded copy/endpoint paths.
async function text(home, relative, limit = MAX_BYTES) {
  const file = path.join(home, relative), parent = path.dirname(file);
  let handle;
  try {
    await directory(parent);
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > limit) throw new Error('Unverified file');
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const current = await handle.stat();
    if (current.dev !== before.dev || current.ino !== before.ino || current.size > limit) throw new Error('Changed file');
    // Read at most limit+1 even if a writer grows the file after stat.
    const bytes = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > limit) throw new Error('Oversized file');
    await directory(parent);
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, bytesRead)), state: 'read' };
  } catch (error) {
    return { text: '', state: error.code === 'ENOENT' ? 'missing' : 'unverified' };
  } finally { await handle?.close(); }
}

function metadata(value) {
  const record = Object.create(null);
  for (const line of value.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1) return null;
    const key = line.slice(0, separator);
    if (!/^[a-z_]+$/.test(key) || Object.hasOwn(record, key)) return null;
    record[key] = line.slice(separator + 1);
  }
  return record;
}

function backlog(value) {
  const tasks = new Map();
  let section = '', current = null;
  for (const line of value.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) { section = heading[1].toLowerCase(); current = null; continue; }
    const item = line.match(/^\s*-\s+\[([ xX])\]\s+([^\s]+)\s+-\s+(.+)$/);
    if (item && ID.test(item[2])) {
      const closed = item[1].toLowerCase() === 'x' || /^(done|completed|closed)\b/.test(section);
      current = { ...parseBacklogTask(item[3], closed), inFlight: section === 'in flight', text: item[3] };
      if (tasks.has(item[2])) current.ambiguous = true;
      tasks.set(item[2], current);
    } else if (current && /^\s{2,}\S/.test(line)) current.text += `\n${line.trim()}`;
  }
  return tasks;
}

function trackingFindings(tasks, sourceState, enabled) {
  if (!enabled) return { state: 'disabled', findings: [] };
  if (sourceState !== 'read') return { state: 'unverified', findings: [], reason: 'Backlog read owner unavailable; no remote query performed.' };
  const findings = [];
  for (const [id, task] of tasks) {
    // Existing explicit links are discovery evidence, not desired status authority.
    const links = [...new Set(task.text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*\b|https:\/\/github\.com\/(?:users|orgs)\/[A-Za-z0-9_.-]+\/projects\/[1-9]\d*\b/g) || [])];
    if (!links.length) continue;
    findings.push({ task: id, repository: task.repositoryPath || null, links, state: 'unverified',
      reason: 'Established tracking links found; current issue/Project values and reconciliation need their existing reporter. No status mapping inferred.' });
  }
  return { state: findings.length ? 'review-needed' : 'not-applicable', findings,
    reason: findings.length ? 'Local recorded links only; no GitHub reads or writes.' : 'No established issue/Project links in the selected backlog; no setup requested.' };
}

export async function autocleanReport(selectedHome, { enabled = false, tracking = false, now = Date.now() } = {}) {
  const report = { tag, mode: 'report-only', enabled: enabled === true, effects: [], inventory: [], coverage: [],
    tracking: { state: 'disabled', findings: [] }, limitations: [
      'Recorded resources only; no fleet/backend scan, liveness, ownership, landing or safety approval. Unrecorded resources are not covered.',
      'Own-pane reset and ALL acting modes deferred until a supported detach/completion interface and separate authority exist.'
    ] };
  if (enabled !== true) return report; // OFF by default: not even home discovery.
  if (!path.isAbsolute(selectedHome || '') || !Number.isFinite(now)) throw new Error('Explicit absolute home and valid time required');
  const home = path.resolve(selectedHome);
  await directory(home);
  const state = path.join(home, 'state');
  await directory(state);
  const source = await text(home, 'data/backlog.md', 1024 * 1024);
  report.coverage.push({ source: 'data/backlog.md', state: source.state });
  const tasks = backlog(source.text);
  const names = (await readdir(state)).sort();
  const ids = [...new Set([...names.filter(name => /\.(meta|status)$/.test(name)).map(name => name.replace(/\.(meta|status)$/, '')).filter(id => ID.test(id)), ...tasks.keys()])].sort();
  report.coverage.push({ source: 'state/*.meta + state/*.status', state: ids.length > MAX_TASKS ? 'partial' : 'recorded-only', omittedTasks: Math.max(0, ids.length - MAX_TASKS) });
  for (const id of ids.slice(0, MAX_TASKS)) {
    const metaSource = await text(home, `state/${id}.meta`);
    const statusSource = await text(home, `state/${id}.status`);
    const meta = metaSource.state === 'read' ? metadata(metaSource.text) : null;
    // Unknown kind deliberately preserves unresolved decisions across done lines.
    const folded = foldStatusLines(statusSource.text.split(/\r?\n/));
    const latest = folded.latest, task = tasks.get(id);
    const stamp = latest?.fields.find(field => field.name === 'at')?.value;
    const epoch = /^\d+$/.test(stamp || '') ? Number(stamp) * 1000 : NaN;
    const ageMs = Number.isSafeInteger(epoch) && epoch <= now ? now - epoch : null;
    const reasons = [];
    if (!meta || metaSource.state !== 'read') reasons.push('metadata-unverified');
    if (statusSource.state !== 'read' || !latest) reasons.push('status-unverified');
    if (source.state !== 'read' || !task) reasons.push('backlog-unverified');
    if (task?.ambiguous) reasons.push('ambiguous-backlog');
    if (meta?.remote_host || meta?.kind === 'secondmate' || (meta?.home && meta.home !== home)) reasons.push('foreign-endpoint-not-inspected');
    if (meta?.endpoint_task_id && meta.endpoint_task_id !== id) reasons.push('endpoint-binding-mismatch');
    if (folded.pendingIssues.length || task?.holdActive || task?.blockers.length) reasons.push('open-hold-or-blocker');
    if (task?.inFlight) reasons.push('in-flight');
    if (task?.holdOpen !== false || latest?.state !== 'done') reasons.push('unlanded-or-completion-unverified');
    const staleCandidate = reasons.length === 0 && ageMs !== null && ageMs >= STALE_MS;
    const observation = { task: id, status: latest?.state || 'unknown', ageMs, staleCandidate,
      disposition: 'protected-report-only', reasons, ownership: 'selected-home-record-only', landing: 'unverified',
      sources: [`state/${id}.meta`, `state/${id}.status`, 'data/backlog.md'] };
    report.inventory.push({ ...observation, kind: 'agent', resource: id });
    if (meta) {
      for (const [kind, resource] of [
        ['copy', meta.worktree],
        ['pane', meta.backend === 'herdr' && meta.herdr_session && meta.herdr_pane_id ? `${meta.herdr_session}:${meta.herdr_pane_id}` : meta.window],
        ['terminal', meta.terminal]
      ]) if (resource) report.inventory.push({ ...observation, kind, resource, observedLive: null });
    }
  }
  report.tracking = trackingFindings(tasks, source.state, tracking === true);
  await directory(home);
  await directory(state);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    const enabled = args[0] === '--enabled-report';
    const home = enabled ? args[1] : undefined;
    const tracking = enabled && args[2] === '--tracking-findings';
    if (args.length && (!enabled || !home || args.length > (tracking ? 3 : 2))) throw new Error('Unsupported arguments');
    console.log(JSON.stringify(await autocleanReport(home, { enabled, tracking }), null, 2));
  } catch { console.error('fm-quarterdeck autoclean report refused: verify explicit home and bounded local read owners. No action performed.'); process.exitCode = 1; }
}
