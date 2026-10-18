import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSnapshot } from '../bearings.js';
import { countSecondmateBacklog } from '../secondmates.js';
import { projectWork } from '../work-model.js';
import { emptyAgentState } from '../agent-state.js';

const raw = extra => ({ schema: 'fm-bearings.v1', decisions_open: [], contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [], ...extra });

test('bounded landing disclosures and supplied remote dates survive projection', () => {
  const model = normalizeSnapshot(raw({ landed: [{ id: 'shipped', owner: 'mate', what: 'Shipped', landedAt: '2026-10-01T10:00:00Z' }], omitted: [{ surface: 'landed showing 6 of 47' }] }));
  assert.equal(model.landed[0].clock.at, '2026-10-01T10:00:00.000Z');
  assert.ok(model.workCoverage.disclosures.includes('landed showing 6 of 47'));
});

test('home summaries exclude deferred captain holds from current pressure', () => {
  const counts = countSecondmateBacklog('## Queued\n- [ ] later - Later (hold-kind: captain) (hold-until: 2999-01-01)\n- [ ] now - Now (hold-kind: captain)\n');
  assert.equal(counts.openWork, 2);
  assert.equal(counts.captainCalls, 1);
});

test('weaker worker evidence is disclosed beside the strict active count', async () => {
  const work = await projectWork([{ id: 'sample', state: 'working', inFlight: true, endpointLive: true, endpointEvidence: 'live terminal pane (weaker evidence; worker process unverified)' }], emptyAgentState());
  assert.equal(work.activeWorkerCount, 0);
  assert.equal(work.weakerWorkerCount, 1);
});

import { projectFleetInventory } from '../fleet-inventory.js';
import { projectUnderwayRecords } from '../underway-records.js';
import { loadFirstmateHome, dashboardData, createServer } from '../server.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function fleetFixture() {
  const at = new Date().toISOString();
  const home = id => ({ id, registered: true, provenance: { selected: 'structured-home', trust: 'complete' }, freshness: { status: 'fresh', observed_at: at },
    active_children: [{ id: 'worker', name: 'Worker', kind: 'ship', state: 'working', source: 'pane' }],
    endpoints: [{ id: 'worker', endpoint: { exists: true, freshness: 'fresh', agent_alive: 'unknown' } }],
    queued: [{ id: 'next', title: 'Queued work', repo: '/private/example-app' }],
    holds: [{ id: 'later', title: 'Deferred decision', kind: 'captain', until: '2999-01-01' }, { id: 'now', title: 'Current decision', kind: 'captain' }],
    landed: [{ id: 'shipped', what: 'Shipped work', landedAt: '2026-10-01T10:00:00Z' }], counts: { active_children: 1, queued: 1, holds: 2, landed: 47 }, omitted: [{ surface: 'landed showing 1 of 47' }] });
  return { schema: 'fm-fleet-snapshot.v1', generated: at, tasks: [{ id: 'local', kind: 'ship', current_state: { state: 'working', source: 'run-step', detail: 'ci running', freshness: 'fresh', observed_at: at } }],
    secondmate_current: { registry: { available: true }, records: [home('alpha'), home('beta')] } };
}

test('canonical inventory reaches Work Split, home summaries and KPI counts with owner separation', async t => {
  const snapshot = fleetFixture();
  const fleetWork = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot));
  const home = await mkdtemp(path.join(os.tmpdir(), 'qd-fleet-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, 'data')); await mkdir(path.join(home, 'state'));
  await writeFile(path.join(home, 'data/projects.md'), '- example-app - Sample work\n');
  await writeFile(path.join(home, 'data/backlog.md'), '## In flight\n- [ ] local - Local work (repo: example-app)\n');
  const owner = { read: async () => emptyAgentState() };
  const loaded = await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, fleetWork });
  const split = loaded.workSplit;
  assert.equal(split.items.find(row => row.id === 'local').status, 'review', 'canonical run evidence needs no validation_state writer');
  assert.equal(split.counts.review, 1);
  assert.equal(split.items.filter(row => row.status === 'backlog').length, 2);
  assert.equal(split.counts['captain-action'], 2, 'deferred holds are waiting, not captain pressure');
  assert.equal(split.weakerWorkerCount, 2);
  assert.equal(split.activeWorkerCount, 0);
  assert.equal(new Set(split.items.map(row => row.id)).size, 11);
  assert.ok(split.items.filter(row => row.owner !== '(main)').every(row => row.readOnly));
  assert.equal(loaded.secondmates.items[0].inventory.bounds.landed.total, 47);
  assert.equal(loaded.secondmates.items[0].inventory.deferredHolds, 1);
  assert.equal(loaded.secondmates.items[0].backlog.captainCalls, 1);
  const dashboard = await dashboardData({ FM_HOME: home }, owner, async () => [], async () => ({}), {}, fleetWork);
  assert.equal(dashboard.fleet.summary.workCounts.review, 1);
  assert.equal(dashboard.fleet.summary.weakerWorkers, 2);
  assert.equal(dashboard.fleet.summary.activeAgents, 0);
  assert.equal(JSON.stringify(fleetWork).includes('/private/'), false);
});

test('cached, bounded and unavailable home inventories retain explicit coverage without current worker evidence', () => {
  const snapshot = fleetFixture();
  snapshot.secondmate_current.records[0].freshness.status = 'cached';
  snapshot.secondmate_current.records[1].provenance.selected = 'unavailable';
  const projected = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot));
  assert.equal(projected.homes[0].freshness, 'cached');
  assert.match(projected.homes[0].warnings.join(' '), /landed showing 1 of 47/);
  assert.equal(projected.homes[1].bounds.queued.available, false);
  assert.equal(projected.homes[1].freshness, 'unavailable');
  assert.ok(projected.records.filter(row => row.owner !== '(main)').every(row => row.endpointLive === null && !row.reviewRun));
});

test('producer-shaped overlapping holds use queued classification and completion dates without duplicate pressure', async () => {
  const snapshot = fleetFixture();
  const home = snapshot.secondmate_current.records[0];
  home.queued = [
    { id: 'later', title: 'Deferred', hold_kind: 'captain', hold_until: '2999-01-01', hold_bucket: 'dated', captain_actionable: false },
    { id: 'now', title: 'Live', hold_kind: 'captain', hold_bucket: 'live', captain_actionable: true },
    { id: 'old', title: 'Aged', hold_kind: 'captain', hold_bucket: 'aged', captain_actionable: false },
    { id: 'external', title: 'External wait', hold_kind: 'external', captain_actionable: false },
  ];
  home.holds = home.queued.map(row => ({ id: row.id, title: row.title, source: 'backlog', reason: 'Waiting' }));
  home.landed = [{ id: 'shipped', title: 'Shipped', completion: { date: '2026-10-01' }, local_note: 'local main' }];
  const fleet = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot));
  const rows = fleet.records.filter(row => row.owner === 'alpha');
  assert.equal(rows.length, 6);
  assert.equal(fleet.homes[0].captainCalls, 1);
  assert.equal(fleet.homes[0].deferredHolds, 1);
  assert.equal(rows.find(row => row.localTask === 'shipped').completionAt, '2026-10-01');
  const work = await projectWork(rows, emptyAgentState());
  assert.equal(work.counts['captain-action'], 1);
  assert.equal(work.counts.waiting, 3);
});

test('short bearings rows retain canonical remote completion dates by exact owner', () => {
  const snapshot = fleetFixture();
  const fleet = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot));
  const model = normalizeSnapshot(raw({ quarterdeckFleet: fleet, landed: [{ id: 'shipped', owner: 'alpha', what: 'Short recap' }, { id: 'shipped', owner: 'unread', what: 'Another home' }] }));
  assert.equal(model.landed[0].clock.at, '2026-10-01T10:00:00.000Z');
  assert.equal(model.landed[0].what, 'Short recap');
  assert.equal(model.landed[1].clock.at, null);
  assert.equal(model.landedHistory.length, 3);
});

test('producer hold buckets and local calendar fallback agree across inventory and Work Split', async () => {
  const previous = process.env.TZ;
  let fleet;
  try {
    process.env.TZ = 'Australia/Brisbane';
    const snapshot = fleetFixture(), at = '2026-10-17T23:00:00Z';
    snapshot.secondmate_current.records = [snapshot.secondmate_current.records[0]];
    const home = snapshot.secondmate_current.records[0];
    home.freshness.observed_at = at;
    home.queued = [
      { id: 'live', hold_kind: 'captain', hold_until: '2026-10-18', hold_bucket: 'live', captain_actionable: true },
      { id: 'fallback', hold_kind: 'captain', hold_until: '2026-10-18' },
      { id: 'later', hold_kind: 'captain', hold_until: '2026-10-19' },
      { id: 'aged', hold_kind: 'captain', hold_until: '2999-01-01', hold_bucket: 'aged', captain_actionable: false },
    ];
    home.holds = home.queued.map(({ id }) => ({ id }));
    fleet = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot), { now: Date.parse(at) });
  } finally {
    if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous;
  }
  assert.equal(fleet.homes[0].captainCalls, 2);
  assert.equal(fleet.homes[0].deferredHolds, 1);
  const split = await projectWork(fleet.records.filter(row => row.bucket === 'held'), emptyAgentState());
  assert.equal(split.counts['captain-action'], 2);
  assert.equal(split.counts.waiting, 2);
  for (const bucket of ['queued', 'held']) {
    assert.equal(fleet.homes[0].inventory[bucket].find(row => row.localTask === 'live').holdDeferred, false);
    assert.equal(fleet.homes[0].inventory[bucket].find(row => row.localTask === 'fallback').holdDeferred, false);
  }
});

test('registered-home source bounds survive and supplemented children never exceed their total', () => {
  for (const flag of ['input_truncated', 'records_truncated']) {
    const snapshot = fleetFixture();
    snapshot.secondmate_current.registry[flag] = true;
    const home = snapshot.secondmate_current.records[0];
    home.active_children = [];
    home.counts.active_children = 0;
    const underway = projectUnderwayRecords(snapshot);
    underway.rows.push({ id: 'alpha/unread', owner: 'alpha', state: 'working', name: 'Unread child' });
    const fleet = projectFleetInventory(snapshot, underway);
    assert.ok(fleet.disclosures.includes('Registered-home inventory bounded'));
    assert.equal(fleet.homes[0].bounds.active.shown, 1);
    assert.equal(fleet.homes[0].bounds.active.total, null);
  }
});

test('every supported executing state discloses weaker evidence without increasing verified counts', async () => {
  for (const state of ['working', 'active', 'in-progress']) {
    const local = await projectWork([{ id: 'local', state, inFlight: true, endpointLive: true, endpointEvidence: 'live terminal pane (weaker evidence; worker process unverified)' }], emptyAgentState());
    assert.equal(local.activeWorkerCount, 0);
    assert.equal(local.weakerWorkerCount, 1, state);
    const snapshot = fleetFixture();
    snapshot.secondmate_current.records = [snapshot.secondmate_current.records[0]];
    snapshot.secondmate_current.records[0].active_children[0].state = state;
    const fleet = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot));
    const remote = await projectWork(fleet.records.filter(row => row.owner !== '(main)'), emptyAgentState());
    assert.equal(remote.activeWorkerCount, 0);
    assert.equal(remote.weakerWorkerCount, 1, state);
  }
});

test('canonical-only completion can be acknowledged using the displayed fingerprint', async t => {
  const root = await mkdtemp(path.join(process.cwd(), '.fleet-ack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await mkdir(path.join(home, 'data'), { recursive: true });
  await mkdir(path.join(home, 'state'));
  await writeFile(path.join(home, 'data/projects.md'), '- firstmate - Home work\n');
  await writeFile(path.join(home, 'data/backlog.md'), '## In flight\n- [ ] local - Canonical completion (repo: firstmate)\n');
  const snapshot = fleetFixture();
  snapshot.tasks[0].current_state = { state: 'done', source: 'run-step', detail: 'run passed: PR open', freshness: 'fresh', observed_at: snapshot.generated };
  snapshot.secondmate_current.records = [];
  const fleetWork = projectFleetInventory(snapshot, projectUnderwayRecords(snapshot));
  let current = { state: 'ready', stale: false, fleetWork };
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(root, 'state.json') }, {
    bearingsSource: { current: () => current }, durabilityVerifier: async () => [], expenseReader: async () => ({}),
    quotaReader: { read: async () => ({}) }, costReader: async () => ({}),
    revisionResolver: { initial: 'a'.repeat(40), snapshot: async () => 'a'.repeat(40) },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await (await fetch(`${origin}/api/dashboard`)).json()).fleet.workSplit.items.find(row => row.id === 'local');
  const item = await get();
  assert.equal(item.completionAttention, 'newly-done');
  const acknowledge = () => fetch(`${origin}/api/work-state`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'acknowledge', taskFingerprint: item.taskFingerprint, completionFingerprint: item.completionFingerprint }) });
  assert.equal((await acknowledge()).status, 200);
  assert.equal((await acknowledge()).status, 200);
  assert.equal((await get()).completionAttention, 'previously-done');
  current = { ...current, state: 'stale', stale: true };
  assert.equal((await acknowledge()).status, 409);
});
