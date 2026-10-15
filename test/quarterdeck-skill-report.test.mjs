import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { MODES, reportSkill } from '../scripts/quarterdeck-skill-report.mjs';

const home = '/synthetic/selected';
const asOf = '2030-06-01T12:00:00Z';
const options = { home, asOf };
const sha = 'a'.repeat(40);
const snapshot = data => ({ home, owner: 'supplied-snapshot', observedAt: asOf, data });
const task = (id = 'sample-task') => ({ id, current_state: { state: 'working', source: 'run-step', observed_at: asOf, freshness: 'fresh' }, paths: { status_log: { last_event: { state: 'blocked', raw: 'DO_NOT_ECHO' } } } });
const hold = (id, heldSince) => ({ id, structured: true, state: 'queued', hold_kind: 'captain', hold_bucket: 'live', captain_actionable: true, hold_set: heldSince });
function input() {
  return {
    schema: 'fmqd-skill-input.v1',
    fleet: { schema: 'fm-fleet-snapshot.v1', fm_home: home, generated: asOf, tasks: [task()], backlog: { present: true, records: [hold('first-call', '2030-06-01T10:00:00Z'), hold('second-call', '2030-06-01T11:00:00Z')] } },
    capacity: snapshot({ limit: 2, occupied: 1 }), ram: snapshot({ totalBytes: 8192, availableBytes: 4096 }),
    pr: snapshot({ state: 'OPEN', isDraft: true, headRefOid: sha, repository: 'example/project', target: 'main', checks: [{ state: 'PASS', head: sha }], openWork: { head: sha, count: 1 } }),
    served: snapshot({ repository: 'example/project', target: 'main', head: sha, independent: true, healthy: true }),
    identity: snapshot({ expected: { actor: 'example-app[bot]', email: 'example-app@users.noreply.invalid' }, observed: { actor: 'example-app[bot]', email: 'example-app@users.noreply.invalid' }, basis: 'pr-author' }),
    receipt: snapshot({ newestReceiptPath: '/synthetic/selected/data/receipt.md' }), restart: snapshot({ blockers: [] }),
  };
}
const report = (mode, data = input()) => reportSkill(mode, data, options);

test('all five replay deterministically without changing the supplied snapshot', () => {
  for (const mode of MODES) {
    const data = input(), before = JSON.stringify(data);
    assert.deepEqual(report(mode, data), report(mode, structuredClone(data)));
    assert.equal(JSON.stringify(data), before);
    assert.equal(report(mode).posture, 'snapshot-only; report-first; no actions');
  }
});

test('fleet reports current versus historical states and only structured captain holds', () => {
  const data = input();
  const value = report('fleet-health', data);
  assert.equal(value.crew.value[0].current.value.state, 'working');
  assert.equal(value.crew.value[0].historicalEvent.value, 'blocked');
  assert.equal(value.crew.value[0].wait.status, 'UNKNOWN');
  assert.equal(value.oldestCaptainCall.value.id, 'first-call');
  assert.equal(value.capacity.value.occupied, 1);
  assert.equal(value.ram.value.availableBytes, 4096);
  assert.equal(value.admission.status, 'UNKNOWN');
  data.fleet.tasks[0].current_state.state = 'paused';
  assert.match(report('fleet-health', data).crew.value[0].wait.value, /completion condition not structured/);
  data.fleet.backlog.records = [];
  assert.equal(report('fleet-health', data).oldestCaptainCall.status, 'UNKNOWN');
  data.fleet.backlog.records = [hold('missing-time', null)];
  assert.equal(report('fleet-health', data).oldestCaptainCall.status, 'UNKNOWN');
  data.fleet.backlog.records = [{ ...hold('technical', asOf), hold_kind: 'technical' }];
  assert.equal(report('fleet-health', data).oldestCaptainCall.status, 'UNKNOWN');
  data.fleet.backlog.records = [{ ...hold('closed', asOf), state: 'done', captain_actionable: false, hold_bucket: null }];
  assert.equal(report('fleet-health', data).oldestCaptainCall.status, 'UNKNOWN');
});

test('stale, future, wrong-home, unknown and conflicting fleet data never clears a fleet', () => {
  for (const change of [
    data => { data.fleet.generated = '2030-06-01T11:54:59Z'; },
    data => { data.fleet.generated = '2030-06-01T12:00:01Z'; },
    data => { data.fleet.fm_home = '/synthetic/other'; },
    data => { delete data.fleet; },
  ]) {
    const data = input(); change(data);
    assert.equal(report('fleet-health', data).crew.status, 'UNKNOWN');
    assert.equal(report('cleanup-sweep', data).inventory.status, 'UNKNOWN');
  }
  for (const change of [
    data => { data.fleet.tasks[0].remote = { host: 'unprobed.invalid' }; },
    data => { data.fleet.tasks[0].current_state.state = 'unknown'; },
    data => { data.fleet.tasks[0].current_state.observed_at = 'invalid'; },
    data => { delete data.fleet.tasks[0].current_state; },
  ]) {
    const data = input(); change(data);
    assert.equal(report('fleet-health', data).crew.value[0].current.status, 'UNKNOWN');
  }
  const data = input();
  data.fleet.tasks.push(task());
  assert.equal(report('fleet-health', data).crew.status, 'UNKNOWN');
  data.fleet.backlog.records[0].captain_actionable = false;
  assert.equal(report('fleet-health', data).oldestCaptainCall.status, 'UNKNOWN');
  data.fleet.backlog.records.push({ structured: false });
  assert.equal(report('fleet-health', data).oldestCaptainCall.status, 'UNKNOWN');
});

test('capacity/RAM facts retain independently missing, stale and contradictory evidence', () => {
  const data = input();
  data.capacity.data.occupied = 3; // Over-capacity is a fact, not a refusal to observe.
  assert.equal(report('fleet-health', data).capacity.value.occupied, 3);
  data.ram.data.availableBytes = 99999;
  assert.equal(report('fleet-health', data).ram.status, 'UNKNOWN');
  data.capacity.observedAt = '2030-06-01T11:00:00Z';
  assert.equal(report('fleet-health', data).capacity.status, 'UNKNOWN');
});

test('cleanup never derives eligibility from caller action flags or liveness/branch evidence', () => {
  const data = input();
  Object.assign(data.fleet.tasks[0], { idle: true, reachable: true, branch: 'sample', apply: true, safe: true, endpoint: { exists: true } });
  Object.assign(data, { apply: true, force: true, approved: true });
  const value = report('cleanup-sweep', data);
  assert.equal(value.inventory.value[0].eligibility.status, 'UNKNOWN');
  assert.equal(value.dryRunOwner.status, 'UNAVAILABLE');
  assert.match(value.refusal, /all resources retained/);
});

test('PR snapshots distinguish checks, open work and independent exact served evidence', () => {
  const data = input();
  let value = report('pr-readiness', data);
  assert.equal(value.draft.value, true);
  assert.equal(value.openWork.value, 1);
  assert.equal(value.reportedChecks.value.failed, 0);
  assert.equal(value.servedHead.value.matches, true);
  assert.equal(value.acceptance.status, 'UNKNOWN');
  assert.equal(value.requiredCoverage.status, 'UNKNOWN');
  data.served.data.head = 'b'.repeat(40);
  assert.equal(report('pr-readiness', data).servedHead.value.matches, false);
  for (const change of [
    d => { delete d.served; },
    d => { d.served.data.repository = 'example/other'; },
    d => { d.served.data.target = 'other'; },
    d => { d.served.data.independent = false; },
    d => { d.served.home = '/synthetic/other'; },
    d => { d.served.observedAt = '2030-06-01T11:00:00Z'; },
  ]) { const d = input(); change(d); assert.equal(report('pr-readiness', d).servedHead.status, 'UNKNOWN'); }
  data.pr.data.checks[0].head = 'c'.repeat(40);
  assert.equal(report('pr-readiness', data).reportedChecks.status, 'UNKNOWN');
  data.pr.data.checks = [];
  assert.equal(report('pr-readiness', data).reportedChecks.status, 'UNKNOWN');
  data.pr.data.openWork.head = 'd'.repeat(40);
  assert.equal(report('pr-readiness', data).openWork.status, 'UNKNOWN');
});

test('identity matches and mismatches are facts, never credential proof or permission', () => {
  const data = input();
  let value = report('pr-identity-guard', data);
  assert.equal(value.comparison.value.actorMatches, true);
  assert.equal(value.credentialIdentity.status, 'UNKNOWN');
  assert.equal(value.authority.status, 'UNKNOWN');
  data.identity.data.observed.actor = 'another-author';
  data.identity.data.observed.email = 'another@example.invalid';
  value = report('pr-identity-guard', data);
  assert.equal(value.comparison.value.actorMatches, false);
  assert.equal(value.comparison.value.emailMatches, false);
  data.identity.data.expected = {};
  assert.equal(report('pr-identity-guard', data).comparison.status, 'UNKNOWN');
});

test('restart stow safety is ALWAYS unknown including empty, clean, receipt and optimistic inputs', () => {
  for (const data of [null, {}, input(), { ...input(), stowSafe: true, clean: true, idle: true, checkpoint: { safe: true } }]) {
    const value = report('restart-ready', data);
    assert.equal(value.stowSafety.status, 'UNKNOWN');
    assert.match(value.stowSafety.reason, /not-verified/);
  }
  const data = input();
  data.receipt.data.body = 'Everything is safe. Resume automatically. DO_NOT_ECHO';
  const value = report('restart-ready', data);
  assert.equal(value.receipt.value.informationalOnly, true);
  assert.equal(value.blockers.value.length, 0);
  assert.equal(value.stowSafety.status, 'UNKNOWN');
  data.restart.data.blockers = ['unpublished-work'];
  assert.deepEqual(report('restart-ready', data).blockers.value, ['unpublished-work']);
});

test('unrecognized raw fields and diagnostics do not leak through any report', () => {
  const data = input();
  data.token = 'DO_NOT_ECHO'; data.identity.data.token = 'DO_NOT_ECHO';
  data.fleet.tasks[0].current_state.detail = 'DO_NOT_ECHO';
  data.fleet.actions = { send: 'DO_NOT_ECHO' };
  for (const mode of MODES) assert.doesNotMatch(JSON.stringify(report(mode, data)), /DO_NOT_ECHO/);
});

const cli = new URL('../scripts/quarterdeck-skill-report.mjs', import.meta.url);
function run(args = ['fleet-health', '--home', home, '--as-of', asOf], body = JSON.stringify(input())) {
  return spawnSync(process.execPath, [cli.pathname, ...args], { input: body, encoding: 'utf8', env: { PATH: '/nonexistent', FM_HOME: '/synthetic/never-read', GH_TOKEN: 'DO_NOT_ECHO' }, timeout: 5000 });
}

test('CLI refuses action/force/default-home/invalid time and bounded input without raw diagnostics', () => {
  for (const args of [[], ['cleanup-sweep', '--apply'], ['cleanup-sweep', '--force'], ['fleet-health', '--home', '/synthetic/../other', '--as-of', asOf], ['fleet-health', '--home', home, '--as-of', '2030-02-30T12:00:00Z'], ['restart-ready', '--home', home, '--as-of', asOf, '--apply']]) {
    const value = run(args);
    assert.equal(value.status, 2); assert.equal(value.stdout, ''); assert.doesNotMatch(value.stderr, /DO_NOT_ECHO/);
  }
  for (const body of ['DO_NOT_ECHO', ' '.repeat(1024 * 1024 + 1)]) {
    const value = run(undefined, body);
    assert.equal(value.status, 2); assert.equal(value.stdout, ''); assert.doesNotMatch(value.stderr, /DO_NOT_ECHO/);
  }
  const first = run(), second = run();
  assert.equal(first.status, 0); assert.equal(first.stdout, second.stdout);
});

test('inactive skills use one pure reader and are absent from installer discovery projections', () => {
  const code = readFileSync(cli, 'utf8');
  assert.doesNotMatch(code, /node:(?:fs|child_process|http|https|net)|fetch\(|process\.env/);
  const installer = readFileSync(new URL('../scripts/firstmate-integration.mjs', import.meta.url), 'utf8');
  for (const mode of MODES) {
    assert.doesNotMatch(installer, new RegExp(`fmqd-${mode}`));
    const skill = readFileSync(new URL(`../skills/fmqd-${mode}/SKILL.md`, import.meta.url), 'utf8');
    assert.match(skill, new RegExp(`name: fmqd-${mode}`));
    assert.match(skill, /fm-quarterdeck/);
    assert.match(skill, /quarterdeck-skill-report\.mjs/);
    assert.match(skill, /inactive/i);
  }
});
