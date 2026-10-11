// Read-only projection of stock fm-fleet-snapshot.v1 records. Run attribution,
// lifecycle reconciliation and registered-home collection remain stock owners.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;

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

export function projectUnderwayRecords(snapshot) {
  if (!object(snapshot) || snapshot.schema !== 'fm-fleet-snapshot.v1' || !Array.isArray(snapshot.tasks)
      || !object(snapshot.secondmate_current) || !Array.isArray(snapshot.secondmate_current.records)) throw Error('Canonical work records unavailable');
  const rows = [], disclosures = [];
  for (const task of snapshot.tasks) {
    if (!object(task) || !idPattern.test(task.id) || task.kind === 'secondmate' || task.backlog?.current_role === 'program'
        || (task.backlog?.current_role === 'held' && task.current_state?.state !== 'working')) continue;
    rows.push({ id: task.id, owner: '(main)', home: 'Main home', name: task.backlog?.title || task.id,
      repo: task.backlog?.repo || task.project, kind: task.kind, state: task.current_state?.state,
      doing: task.current_state?.detail, stage: currentStage(task.current_state) });
  }
  const registry = snapshot.secondmate_current;
  if (registry.registry?.available !== true) disclosures.push('Registered-home registry unavailable');
  if (registry.truncated || registry.registry?.input_truncated || registry.registry?.records_truncated) disclosures.push('Registered-home inventory incomplete: source bound reached');
  for (const home of registry.records) {
    if (!object(home) || home.registered !== true || !idPattern.test(home.id)) continue;
    if (home.provenance?.selected !== 'structured-home' || !Array.isArray(home.active_children)) {
      disclosures.push(`${home.id}: work records unavailable`); continue;
    }
    const cached = home.freshness?.status === 'cached';
    if (cached) disclosures.push(`${home.id}: cached work records; current stage unavailable`);
    if (home.provenance?.trust === 'partial-structured') disclosures.push(`${home.id}: work inventory incomplete`);
    if ((home.counts?.active_children ?? 0) > home.active_children.length) disclosures.push(`${home.id}: active work omitted by source bound`);
    for (const task of home.active_children) {
      if (!object(task) || !idPattern.test(task.id) || task.kind === 'secondmate') continue;
      rows.push({ id: `${home.id}/${task.id}`, owner: home.id, home: home.id, name: task.name || task.id,
        repo: task.repo, kind: task.kind, state: task.state, doing: task.doing,
        stage: currentStage({ state: task.state, source: task.source, detail: task.doing }, { cached }) });
    }
  }
  return { rows, disclosures };
}
