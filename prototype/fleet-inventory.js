// Read-only fleet inventory from the same bounded stock snapshot used by Underway.
// No child endpoints are probed and no remote commands are run here.
import path from 'node:path';
import { safeWorkNote, EXECUTING_STATES } from './work-model.js';
import { currentLocalDate } from './firstmate-records.js';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(value);
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\d(?:T|$)/.test(value) && Number.isFinite(Date.parse(value)) ? (value.length === 10 && new Date(value).toISOString().slice(0, 10) === value ? value : value.length > 10 ? new Date(value).toISOString() : null) : null;
const repo = value => typeof value === 'string' ? safeWorkNote(path.basename(value)) : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const MAX_ROWS = 256;

export function projectFleetInventory(snapshot, underway, { now = Date.now() } = {}) {
  const records = [], homes = [], disclosures = [];
  const work = new Map(underway.rows.map(row => [row.id, row]));
  const fresh = stamp => { const at = Date.parse(stamp); return Number.isFinite(at) && now >= at && now - at <= 300000; };
  function record(row, owner, bucket, freshness, endpoints = []) {
    if (!validId(row?.id) || row.kind === 'secondmate') return null;
    const id = owner === '(main)' ? row.id : `${owner}/${row.id}`;
    const canonical = work.get(id);
    const until = row.holdUntil || row.hold_until || row.until;
    const held = bucket === 'held' || Boolean(row.hold_kind || row.holdKind || row.unresolved_blocker_ids?.length);
    const holdKind = held ? safeWorkNote(row.holdKind || row.hold_kind || (row.kind === 'captain' ? 'captain' : 'external')) : null;
    const deferred = row.hold_bucket ? row.hold_bucket === 'dated' : row.captain_actionable === true ? false
      : row.deferred === true || row.holdDeferred === true || Boolean(date(until) && date(until).slice(0, 10) > currentLocalDate(now));
    const pipeline = freshness === 'fresh' ? canonical?.pipeline : null;
    const endpoint = endpoints.find(entry => entry?.id === row.id)?.endpoint || row.endpoint;
    const weak = freshness === 'fresh' && EXECUTING_STATES.has(canonical?.state) && endpoint?.exists === true && endpoint?.freshness === 'fresh' && endpoint?.agent_alive !== 'dead';
    return { id, localTask: row.id, spawnGeneration: validId(row.spawn_gen) ? row.spawn_gen : null, owner, readOnly: owner !== '(main)', bucket,
      name: safeWorkNote(row.name || row.title || row.what || canonical?.name || row.id),
      repositoryPath: repo(row.repo || canonical?.repo), state: bucket === 'landed' ? 'done' : canonical?.state || (bucket === 'held' ? 'waiting' : 'unknown'),
      queued: bucket === 'queued' && !held, inFlight: bucket === 'active',
      holdOpen: held, holdKind,
      captainActionable: held ? (typeof row.captain_actionable === 'boolean' ? row.captain_actionable : row.hold_bucket ? row.hold_bucket === 'live' : holdKind === 'captain' && !deferred) : null,
      holdDeferred: held && deferred, holdActive: held, holdUntil: date(until)?.slice(0, 10) || null,
      activeBlockers: (row.unresolved_blocker_ids || []).filter(validId),
      waitingOn: safeWorkNote(row.reason || row.holdReason || row.hold_reason || canonical?.doing),
      pipeline: pipeline || { position: 'unknown', substep: null, milestones: [] },
      reviewRun: Boolean(pipeline && ['validating', 'checks', 'validation decision', 'ready for review', 'awaiting merge', 'PR open'].includes(pipeline.position)),
      endpointLive: weak ? true : null,
      endpointEvidence: weak ? 'live terminal pane (weaker evidence; worker process unverified)' : 'liveness unknown',
      completionAt: date(row.landedAt || row.landed_at || row.doneDate || row.done_date || row.completion?.date || row.at || row.date),
      completionIdentity: { owner, task: row.id, at: date(row.landedAt || row.landed_at || row.doneDate || row.done_date || row.completion?.date || row.at || row.date) },
      artifact: safeWorkNote(row.artifact || row.pr_url || row.local_note || row.report_path), freshness };
  }
  // Selected-home backlog/worker identity stays owned by its existing reader; this
  // snapshot supplies only canonical current pipeline state for that exact task.
  for (const task of snapshot.tasks || []) {
    if (!validId(task?.id) || task.kind === 'secondmate') continue;
    const current = record({ ...task, repo: task.backlog?.repo || task.project }, '(main)', 'active', fresh(task.current_state?.observed_at) && task.current_state?.freshness === 'fresh' ? 'fresh' : 'stale');
    if (current) records.push(current);
  }
  const registry = snapshot.secondmate_current;
  for (const home of (registry?.records || []).slice(0, 64)) {
    if (!home?.registered || !validId(home.id)) continue;
    const available = home.provenance?.selected === 'structured-home';
    const freshness = !available ? 'unavailable' : home.contradiction === true || home.terminal_evidence?.contradiction === true ? 'stale' : home.freshness?.status === 'cached' ? 'cached' : home.freshness?.status === 'fresh' && fresh(home.freshness.observed_at) ? 'fresh' : 'stale';
    const inventory = {}, bounds = {}, homeRecords = new Map(), warnings = [];
    const queuedById = new Map((home.queued || []).map(row => [row.id, row]));
    for (const [source, bucket] of [['active_children', 'active'], ['queued', 'queued'], ['holds', 'held'], ['landed', 'landed']]) {
      let input = available && Array.isArray(home[source]) ? home[source] : null;
      if (input && bucket === 'active') {
        const known = new Set(['active_children', 'queued', 'holds', 'landed'].flatMap(key => (home[key] || []).map(row => row?.id)));
        input = [...input, ...underway.rows.filter(row => row.owner === home.id && !known.has(row.id.split('/').at(-1)))
          .map(row => ({ ...row, id: row.id.split('/').at(-1) }))];
      }
      const rows = (input || []).slice(0, MAX_ROWS).map(row => record({ ...queuedById.get(row.id), ...row }, home.id, bucket, freshness, home.endpoints)).filter(Boolean);
      inventory[bucket] = rows;
      bounds[bucket] = { shown: rows.length, total: input && input.length > home[source].length ? null : count(home.counts?.[source]), available: Boolean(input) };
      if (!input) warnings.push(`${bucket} inventory unavailable`);
      if (input && (input.length > rows.length || (bounds[bucket].total ?? 0) > rows.length)) warnings.push(`${bucket} showing ${rows.length} of ${bounds[bucket].total ?? 'unknown'}`);
      for (const row of rows) {
        // Queued is a ledger inventory and deliberately overlaps held rows.
        if (!homeRecords.has(row.id) || bucket === 'held') homeRecords.set(row.id, row);
      }
    }
    if (home.provenance?.trust === 'partial-structured') warnings.push('Partial structured inventory');
    for (const omission of home.omitted || []) {
      const text = typeof omission === 'string' ? omission : omission?.surface;
      if (text) warnings.push(safeWorkNote(text));
    }
    records.push(...homeRecords.values());
    homes.push({ id: home.id, freshness, observedAt: date(home.freshness?.observed_at), inventory, bounds,
      captainCalls: [...homeRecords.values()].filter(row => row.captainActionable === true).length,
      deferredHolds: [...homeRecords.values()].filter(row => row.holdDeferred).length, warnings });
  }
  if (!registry?.registry?.available) disclosures.push('Registered-home registry unavailable');
  if (registry?.truncated || registry?.registry?.input_truncated || registry?.registry?.records_truncated || registry?.records?.length > 64) disclosures.push('Registered-home inventory bounded');
  return { records, homes, disclosures, observedAt: date(snapshot.generated) };
}
