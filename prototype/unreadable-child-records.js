// Quarterdeck-only fallback: selected local records, never runtime observations.
import path from 'node:path';
import { inspectPath, readConfinedFile } from './private-runtime.js';
import { parseBacklogTask } from './firstmate-records.js';
import { currentPipeline, workerSpawnTime } from './underway-records.js';

const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
const sameFile = (a, b) => a && b && ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every(key => a[key] === b[key]);
const reason = 'Child current state cannot be read. Listed from matching in-flight backlog and metadata records; progress and liveness are unknown.';

function localHomeEligible(home, registry, now) {
  const observed = Date.parse(home?.freshness?.observed_at);
  return registry?.registry?.available === true && home?.registered === true && validId(home.id)
    && home.remote === false && typeof home.home === 'string' && path.isAbsolute(home.home)
    && path.normalize(home.home) === home.home && home.home !== path.parse(home.home).root
    && home.provenance?.selected === 'structured-home' && home.provenance.structured_home === home.home
    && home.provenance.summary_source === 'local-ledger'
    && home.contradiction === false && home.terminal_evidence?.contradiction !== true
    && home.freshness.status === 'fresh' && Number.isFinite(observed) && now - observed >= 0 && now - observed <= 300000
    && Number.isFinite(home.freshness.age_seconds) && home.freshness.age_seconds >= 0 && home.freshness.age_seconds <= 300
    && ['active_children', 'endpoints', 'queued', 'holds', 'landed', 'decisions_open', 'omitted'].every(key => Array.isArray(home[key]));
}

export function unreadableHomeEligible(home, registry, now = Date.now()) {
  return localHomeEligible(home, registry, now) && home.provenance.summary_valid === false
    && home.provenance.trust === 'partial-structured' && home.current?.state === 'unknown'
    && home.invalidity?.kind === 'child_current_unavailable' && home.reconcile_inventory?.kind === 'child_current_unavailable'
    && Array.isArray(home.invalidity.ids) && home.invalidity.ids.length > 0 && home.invalidity.ids.length <= 256
    && home.invalidity.ids.every(validId) && new Set(home.invalidity.ids).size === home.invalidity.ids.length
    && JSON.stringify(home.invalidity.ids) === JSON.stringify(home.reconcile_inventory.ids);
}

// Only the existing checkbox format and shared trailing-field parser are supported.
// Other stock formats remain unavailable rather than adding another classifier.
function inFlightRecords(text) {
  const records = new Map(), seen = new Set();
  let section = '';
  for (const line of text.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) { section = heading[1]; continue; }
    const item = /^-\s+\[([ xX])\]\s+(\S+)\s+-\s+(.+)$/.exec(line);
    if (!item) {
      if (section === 'In flight' && line.trim() && !/^\s/.test(line)) throw Error('Unsupported in-flight record');
      continue;
    }
    const [, checked, id, prose] = item;
    if (!validId(id) || seen.has(id)) throw Error('Invalid or duplicate backlog identity');
    seen.add(id);
    const parsed = parseBacklogTask(prose, checked !== ' ');
    // Reject residual metadata the shared parser could not classify, including
    // combined/unsupported fields. Hold prose alone never establishes work.
    if (section === 'In flight' && checked === ' ' && parsed.title && !parsed.doneDate
        && !parsed.holdKind && !parsed.holdReason && !parsed.holdUntil && !parsed.blockers.length
        && !/\([^)]*,\s*(?:repo|kind|hold|hold-kind|hold-until):/i.test(prose)
        && !/\((?:kind|hold|hold-kind|hold-until|repo):|\((?:done|merged|reported|closed)\s|blocked-by:/i.test(parsed.title)
        && (!parsed.kind || ['ship', 'scout'].includes(parsed.kind))) records.set(id, parsed);
  }
  return records;
}

function metadata(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-z_]+)=([^\x00-\x1f\x7f]*)$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) throw Error('Malformed metadata');
    values[match[1]] = match[2];
  }
  return values;
}

export async function readUnreadableChildren(snapshot, { now = Date.now(), read = readConfinedFile } = {}) {
  const children = new Map(), observations = new Map(), disclosures = [];
  if (snapshot?.schema !== 'fm-fleet-snapshot.v1' || !Array.isArray(snapshot.secondmate_current?.records)) {
    return { children, observations, disclosures: ['Canonical work records unavailable; unsupported snapshot'] };
  }
  const homes = snapshot.secondmate_current.records;
  let totalBytes = 0;
  for (const home of homes) {
    const unreadable = home?.invalidity?.kind === 'child_current_unavailable';
    if (!unreadable && !home?.active_children?.length) continue;
    const eligible = unreadable ? unreadableHomeEligible(home, snapshot.secondmate_current, now)
      : localHomeEligible(home, snapshot.secondmate_current, now) && home.provenance.summary_valid === true
        && home.provenance.trust === 'complete' && home.invalidity?.kind === null;
    if (!eligible
        || homes.filter(row => row?.id === home.id || row?.home === home.home).length !== 1) {
      if (unreadable && validId(home.id)) disclosures.push(`${home.id}: unreadable-state work records unavailable; fresh trusted local provenance required`);
      continue;
    }
    const captures = [];
    const capture = async (relative, limit) => {
      const file = path.join(home.home, relative), before = await inspectPath(file);
      if (!before || before.size > limit || before.mtimeMs > Date.parse(home.freshness.observed_at)) throw Error('Record missing, oversized or newer than summary');
      const bytes = await read(file);
      if (!bytes || bytes.length > limit || (totalBytes += bytes.length) > 32 * 1024 * 1024) throw Error('Read bound reached');
      const after = await inspectPath(file);
      if (!sameFile(before, after)) throw Error('Record changed');
      captures.push({ file, info: after });
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    };
    try {
      const records = inFlightRecords(await capture('data/backlog.md', 2 * 1024 * 1024));
      const rows = [], samples = new Map();
      const excluded = new Set([...home.queued, ...home.holds, ...home.landed, ...home.decisions_open, ...home.active_children].map(row => row?.id));
      const ids = unreadable ? home.invalidity.ids : home.active_children.map(row => row?.id);
      if (ids.length > 256 || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) throw Error('Invalid child inventory');
      for (const id of ids) {
        const work = records.get(id);
        if (!work || (unreadable && excluded.has(id))) continue;
        const endpoints = home.endpoints.filter(row => row?.id === id);
        const active = home.active_children.find(row => row?.id === id);
        if (endpoints.length !== 1 || endpoints[0].state !== (unreadable ? 'unknown' : active.state)
            || (!unreadable && endpoints[0].source !== active.source) || endpoints[0].endpoint?.exists !== true
            || endpoints[0].endpoint?.freshness !== 'fresh' || endpoints[0].endpoint?.agent_alive === 'dead') {
          disclosures.push(`${home.id}/${id}: matching child endpoint record unavailable`); continue;
        }
        try {
          const meta = metadata(await capture(`state/${id}.meta`, 64 * 1024));
          const target = meta.backend === 'orca' ? meta.terminal : meta.window;
          const kind = work.kind || (/^SCOUT\b/.test(work.title) ? 'scout' : /^SHIP\b/.test(work.title) ? 'ship' : null);
          if (meta.endpoint_task_id !== id || !validId(meta.spawn_gen) || !['ship', 'scout'].includes(meta.kind)
              || (kind && kind !== meta.kind) || meta.remote_host || meta.home
              || !['tmux', 'orca', 'herdr', 'zellij', 'cmux'].includes(meta.backend || 'tmux')
              || !target || target !== endpoints[0].endpoint.target) throw Error('Metadata identity mismatch');
          const startedAt = workerSpawnTime(meta.spawn_gen, home.freshness.observed_at);
          if (!unreadable && meta.kind !== active.kind) throw Error('Child kind mismatch');
          if (unreadable) rows.push({ id, kind: meta.kind, name: work.title, repo: work.repositoryPath || meta.project,
            state: 'unknown', doing: reason, stage: 'running (state not readable)', startedAt, pipeline: currentPipeline(null) });
          else samples.set(`${home.id}/${id}`, { startedAt, pipeline: currentPipeline({ state: active.state, source: active.source, detail: active.doing,
            freshness: 'fresh', observed_at: home.freshness.observed_at }, { now }) });
        } catch {
          disclosures.push(`${home.id}/${id}: matching child metadata unavailable`);
        }
      }
      // Recheck all captured files after collecting the home, including generation
      // metadata. Replacement, reassignment and edits discard the entire join.
      for (const { file, info } of captures) if (!sameFile(info, await inspectPath(file))) throw Error('Records changed during collection');
      if (unreadable) children.set(home.id, rows);
      else for (const [key, sample] of samples) observations.set(key, sample);
      if (unreadable && rows.length < home.invalidity.ids.length) disclosures.push(`${home.id}: some unreadable children withheld; matching in-flight work records unavailable or classified outside active work`);
    } catch {
      disclosures.push(`${home.id}: ${unreadable ? 'unreadable-state work records' : 'worker start and pipeline details'} unavailable; records missing, changed or unsupported`);
    }
  }
  return { children, observations, disclosures };
}
