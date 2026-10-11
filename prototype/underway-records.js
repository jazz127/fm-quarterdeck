// Read-only projection of stock fm-fleet-snapshot.v1 records. Run attribution,
// lifecycle reconciliation and registered-home collection remain stock owners.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const validId = value => typeof value === 'string' && idPattern.test(value);

// fm-spawn.sh writes s<Unix seconds>.<BASHPID>.<RANDOM> for every fresh
// spawn/relaunch. This is the current worker incarnation, not task creation.
export function workerSpawnTime(generation, observedAt, { now = Date.now() } = {}) {
  const match = typeof generation === 'string' && /^s([1-9][0-9]{0,11})\.([1-9][0-9]{0,15})\.([0-9]{1,5})$/.exec(generation);
  const observed = Date.parse(observedAt);
  if (!match || Number(match[3]) > 32767 || typeof observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(observedAt)
      || !Number.isFinite(observed) || observed > now) return null;
  const timestamp = Number(match[1]) * 1000;
  return timestamp <= observed && Number.isFinite(new Date(timestamp).valueOf()) ? new Date(timestamp).toISOString() : null;
}

export function currentPipeline(current, { cached = false, now = Date.now() } = {}) {
  const unknown = { position: 'unknown', substep: null, milestones: [] };
  const observed = Date.parse(current?.observed_at);
  if (!object(current) || cached || current.freshness !== 'fresh' || !Number.isFinite(observed)
      || now - observed < 0 || now - observed > 300000 || current.source !== 'run-step') return unknown;
  // The stock reader already attributes this result to the current run and
  // reconciles contradictory/generation/daemon evidence. Match only its fixed
  // leading vocabulary, never status tails, PR pointers or arbitrary prose.
  const detail = typeof current.detail === 'string' ? current.detail.split(' · ')[0] : '';
  if (current.state === 'working' && /^validating \((?:running|fixing|background run)\)$/.test(detail)) return { ...unknown, position: 'validating' };
  if (current.state === 'working' && detail === 'ci running') return { ...unknown, position: 'checks' };
  if (current.state === 'parked' && /^parked at /.test(detail)) {
    const step = /^parked at (review|test|docs|lint)(?:$|:)/.exec(detail)?.[1] || null;
    return { ...unknown, position: 'validation decision', substep: step };
  }
  if (current.state !== 'done') return unknown;
  if (/^checks green: PR ready for review(?:$|[: (])/.test(detail)) return { ...unknown, position: 'ready for review', milestones: ['checks green'] };
  if (/^checks green: PR held for merge(?:$|[: (])/.test(detail)) return { ...unknown, position: 'awaiting merge', milestones: ['checks green'] };
  if (/^(?:run passed: PR merged|checks green: PR merged)(?:$|[: (])/.test(detail)) return { ...unknown, position: 'merged', milestones: /^checks green:/.test(detail) ? ['checks green'] : [] };
  if (/^run passed: PR open(?:$|[: (])/.test(detail)) return { ...unknown, position: 'PR open' };
  return unknown;
}

export function currentStage(current, { cached = false } = {}) {
  if (!object(current) || cached || current.freshness === 'stale') return 'Stage unavailable';
  const { state, source, detail = '' } = current;
  // Only the fixed vocabulary emitted by fm-crew-state's attributed run path
  // establishes validation/PR stages. Arbitrary status prose cannot establish one.
  if (source === 'run-step') {
    if (state === 'working' && /^(?:validating \((?:running|fixing|background run)\)|ci running)(?:$| ·)/.test(detail)) return 'Validating / review';
    if (state === 'done' && /^(?:run passed: PR open|checks green: PR (?:held for merge|ready for review))(?:$|[: (])/.test(detail)) return 'PR open / awaiting merge';
    if (state === 'done' && /^run passed: PR merged(?:$|[: (])/.test(detail)) return 'Merged';
    if (state === 'parked' && /^parked at /.test(detail)) return 'Waiting for validation decision';
  }
  if (state === 'blocked') return 'Blocked';
  if (state === 'failed') return 'Failed';
  if (state === 'parked' && source === 'status-log') return 'Waiting for captain decision';
  if (state === 'paused') return 'Paused';
  if (state === 'done') return 'Completed';
  if (state === 'working') return 'Working · stage unavailable';
  return 'Stage unavailable';
}

export function projectUnderwayRecords(snapshot, fallback = { children: new Map(), observations: new Map(), disclosures: [] }) {
  if (!object(snapshot) || snapshot.schema !== 'fm-fleet-snapshot.v1' || !Array.isArray(snapshot.tasks)
      || !object(snapshot.secondmate_current) || !Array.isArray(snapshot.secondmate_current.records)) throw Error('Canonical work records unavailable');
  const rows = [], disclosures = [...fallback.disclosures];
  for (const task of snapshot.tasks) {
    if (!object(task) || !validId(task.id)) { disclosures.push('Main-home work record unavailable: invalid identity'); continue; }
    if (task.kind === 'secondmate' || task.backlog?.current_role === 'program'
        || (task.backlog?.current_role === 'held' && task.current_state?.state !== 'working')) continue;
    rows.push({ id: task.id, owner: '(main)', home: 'Main home', name: task.backlog?.title || task.id,
      repo: task.backlog?.repo || task.project, kind: task.kind, state: task.current_state?.state,
      doing: task.current_state?.detail, stage: currentStage(task.current_state),
      startedAt: task.current_state?.source === 'none' && task.current_state?.detail === 'task generation changed during snapshot'
        ? null : workerSpawnTime(task.spawn_gen, snapshot.generated),
      pipeline: currentPipeline(task.current_state) });
  }
  const registry = snapshot.secondmate_current;
  if (registry.registry?.available !== true) disclosures.push('Registered-home registry unavailable');
  if (registry.truncated || registry.registry?.input_truncated || registry.registry?.records_truncated) disclosures.push('Registered-home inventory incomplete: source bound reached');
  for (const home of registry.records) {
    if (!object(home)) { disclosures.push('Registered-home record unavailable: invalid identity'); continue; }
    if (home.registered !== true) continue;
    if (!validId(home.id)) { disclosures.push('Registered-home record unavailable: invalid identity'); continue; }
    if (home.provenance?.selected !== 'structured-home' || !Array.isArray(home.active_children)) {
      disclosures.push(`${home.id}: work records unavailable`); continue;
    }
    const cached = home.freshness?.status === 'cached';
    if (cached) disclosures.push(`${home.id}: cached work records; current stage unavailable`);
    if (home.provenance?.trust === 'partial-structured') disclosures.push(`${home.id}: work inventory incomplete`);
    if ((home.counts?.active_children ?? 0) > home.active_children.length) disclosures.push(`${home.id}: active work omitted by source bound`);
    for (const task of home.active_children) {
      if (!object(task) || !validId(task.id)) { disclosures.push(`${home.id}: child work record unavailable: invalid identity`); continue; }
      if (task.kind === 'secondmate') continue;
      rows.push({ id: `${home.id}/${task.id}`, owner: home.id, home: home.id, name: task.name || task.id,
        repo: task.repo, kind: task.kind, state: task.state, doing: task.doing,
        stage: currentStage({ state: task.state, source: task.source, detail: task.doing }, { cached }),
        startedAt: fallback.observations?.get(`${home.id}/${task.id}`)?.startedAt || null,
        pipeline: fallback.observations?.get(`${home.id}/${task.id}`)?.pipeline || currentPipeline(null) });
    }
    for (const task of fallback.children.get(home.id) || []) {
      if (home.active_children.some(child => child?.id === task.id)) continue;
      rows.push({ ...task, id: `${home.id}/${task.id}`, owner: home.id, home: home.id });
    }
  }
  return { rows, disclosures };
}
