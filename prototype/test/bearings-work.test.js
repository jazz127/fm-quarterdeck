import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readUnreadableChildren } from '../unreadable-child-records.js';
import { projectUnderwayRecords } from '../underway-records.js';
import { readConfinedFile } from '../private-runtime.js';
import { backlogWorkRepos, contentRevision, createBearingsHub, normalizeSnapshot } from '../bearings.js';
import { composeCallModel } from '../chat-asks.js';
import { callDom, fakeTimers } from './helpers/call-dom.js';

const base = () => JSON.parse(readFileSync(new URL('./fixtures/bearings/clear.json', import.meta.url), 'utf8'));
const source = () => ({ ...base(), in_flight: [
  { id: 'build-preview', name: 'Build the sample preview', state: 'working', doing: 'Validating the sample', kind: 'ship', repo: '/synthetic/checkouts/sample' },
  { id: 'sample-mate/check-notes', name: 'Check sample notes', state: 'paused', doing: 'Waiting for review', kind: 'scout' },
], gates: [
  { id: 'older', title: 'Older sample', reason: 'Deferred until 2026-12-01', blocked_by: '-', filed: '2026-01-01', owner: '(main)' },
  { id: '(main-inventory)', title: 'Repair sample inventory', reason: 'main inventory', filed: null },
  { id: 'newer', title: 'Newer sample', reason: 'Dependency', blocked_by: 'build-preview', filed: '2026-02-01', owner: 'sample-mate' },
] });

async function unreadableFixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-records-'));
  const now = Math.floor(Date.now() / 1000) * 1000;
  const snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [], secondmate_current: { registry: { available: true }, records: [] } };
  const put = async (home, relative, text) => {
    const file = path.join(home.home, relative);
    await writeFile(file, text); await utimes(file, (now - 10000) / 1000, (now - 10000) / 1000);
  };
  const addHome = async id => {
    const home = { id, home: path.join(root, id), remote: false, registered: true,
      current: { state: 'unknown' }, invalidity: { kind: 'child_current_unavailable', ids: ['build'] },
      reconcile_inventory: { kind: 'child_current_unavailable', ids: ['build'] }, contradiction: false,
      provenance: { selected: 'structured-home', structured_home: path.join(root, id), summary_source: 'local-ledger', summary_valid: false, trust: 'partial-structured' },
      freshness: { status: 'fresh', observed_at: new Date(now).toISOString(), age_seconds: 0 },
      active_children: [], endpoints: [{ id: 'build', state: 'unknown', source: 'pane', endpoint: { target: 'sample-terminal', exists: true, freshness: 'fresh', agent_alive: 'unknown' } }],
      queued: [], holds: [], landed: [], decisions_open: [], omitted: [], counts: { active_children: 0 } };
    await mkdir(path.join(home.home, 'data'), { recursive: true }); await mkdir(path.join(home.home, 'state'));
    await put(home, 'data/backlog.md', '# Sample backlog\n## In flight\n- [ ] build - Build sample preview (kind: ship) (repo: sample-app)\n## Queued\n- [ ] next - Prepare sample follow-up\n');
    await put(home, 'state/build.meta', 'endpoint_task_id=build\nkind=ship\nspawn_gen=sample-generation\nbackend=orca\nterminal=sample-terminal\nproject=sample-app\n');
    snapshot.secondmate_current.records.push(home); return home;
  };
  try { await run({ root, now, snapshot, put, addHome }); } finally { await rm(root, { recursive: true, force: true }); }
}

test('unreadable-state projection retains matching in-flight work with exact label, reason and cross-home identity', async () => {
  await unreadableFixture(async ({ snapshot, now, addHome }) => {
    await addHome('home-alpha'); await addHome('home-beta');
    const readable = { id: 'review', kind: 'ship', name: 'Review sample', state: 'working', source: 'run-step', doing: 'validating (running)' };
    snapshot.secondmate_current.records[0].active_children.push(readable);
    snapshot.tasks.push({ id: 'build', kind: 'ship', backlog: { title: 'Build main sample' }, current_state: { state: 'working', source: 'run-step', detail: 'ci running' } });
    const fallback = await readUnreadableChildren(snapshot, { now });
    const work = projectUnderwayRecords(snapshot, fallback);
    assert.deepEqual(work.rows.map(row => row.id), ['build', 'home-alpha/review', 'home-alpha/build', 'home-beta/build']);
    assert.equal(work.rows[1].stage, 'Validating / review');
    assert.ok(work.rows.slice(2).every(row => row.stage === 'running (state not readable)' && row.state === 'unknown'));
    assert.match(work.rows[2].doing, /current state cannot be read.*progress and liveness are unknown/);
    const model = normalizeSnapshot({ ...base(), in_flight: work.rows.map(({ stage, ...row }) => ({ ...row, quarterdeckStage: stage })), quarterdeckWorkDisclosures: work.disclosures });
    assert.equal(new Set(model.underway.map(row => row.key)).size, 4);
    const dom = callDom(), context = vm.createContext({ window: {}, document: dom.document });
    vm.runInContext(readFileSync(new URL('../public/bearings-work.js', import.meta.url), 'utf8'), context);
    const card = dom.document.createElement('article'); card.innerHTML = context.window.bearingsWork.cardHtml(model.underway[2]);
    assert.match(card.textContent, /running \(state not readable\).*Build sample preview.*Home: home-alpha.*progress and liveness are unknown/s);
    assert.doesNotMatch(JSON.stringify(model), /quarterdeck-records-|sample-terminal|sample-generation/);
  });
});

test('unreadable-state fallback rejects other failures, stale/untrusted provenance and unavailable endpoints without reading', async () => {
  await unreadableFixture(async ({ snapshot, now, addHome }) => {
    const good = await addHome('home-alpha');
    for (const mutate of [
      home => { home.invalidity.kind = 'orphan_in_flight'; },
      home => { home.provenance.selected = 'parent-event-fallback'; },
      home => { home.provenance.trust = 'untrusted-supplement'; },
      home => { home.provenance.summary_source = 'unsupported-ledger'; },
      home => { home.freshness.status = 'cached'; },
      home => { home.freshness.observed_at = new Date(now - 301000).toISOString(); },
      home => { home.remote = true; },
      home => { home.contradiction = true; },
      home => { home.registered = false; },
      home => { home.reconcile_inventory.ids = ['other']; },
    ]) {
      const home = structuredClone(good); mutate(home); snapshot.secondmate_current.records = [home];
      const fallback = await readUnreadableChildren(snapshot, { now, read: async () => { throw Error('Must not read'); } });
      assert.equal(fallback.children.size, 0);
      assert.deepEqual(projectUnderwayRecords(snapshot, fallback).rows, []);
    }
    for (const mutate of [home => { home.endpoints = []; }, home => { home.endpoints[0].endpoint.exists = false; },
      home => { home.endpoints[0].state = 'done'; }, home => { home.endpoints[0].endpoint.agent_alive = 'dead'; }]) {
      const home = structuredClone(good); mutate(home); snapshot.secondmate_current.records = [home];
      const fallback = await readUnreadableChildren(snapshot, { now });
      assert.deepEqual(fallback.children.get(home.id), []);
      assert.match(fallback.disclosures.join(' '), /endpoint record unavailable/);
    }
  });
});

test('unreadable-state fallback withholds queued, held, terminal, program and contradictory or missing records', async () => {
  await unreadableFixture(async ({ snapshot, now, addHome, put }) => {
    const home = await addHome('home-alpha');
    for (const line of [
      '## Queued\n- [ ] build - Sample work (kind: ship)',
      '## In flight\n- [x] build - Sample work (kind: ship)',
      '## In flight\n- [ ] build - Sample work (kind: program)',
      '## In flight\n- [ ] build - Sample work (repo: sample-app, kind: program)',
      '## In flight\n- [ ] build - Sample work (repo: sample-app, hold-kind: external)',
      '## In flight\n- [ ] build - Sample work (kind: secondmate)',
      '## In flight\n- [ ] build - Sample work (kind: ship) (hold: Choose a window) (hold-kind: captain)',
      '## In flight\n- [ ] build - Sample work (hold: Await dependency) (hold-kind: external)',
      '## In flight\n- [ ] build - Sample work (done 2026-01-01)',
      '## In flight\n- [ ] missing - Other work (kind: ship)',
      '## In flight\n- [ ] build - Sample work (kind: scout)',
      '## In flight\n- [ ] build - One\n- [ ] build - Two',
      '## In flight\n- **build** - Unsupported row',
    ]) {
      await put(home, 'data/backlog.md', line + '\n');
      const fallback = await readUnreadableChildren(snapshot, { now });
      assert.deepEqual(projectUnderwayRecords(snapshot, fallback).rows, []);
      assert.ok(fallback.disclosures.length);
    }
    await put(home, 'data/backlog.md', '## In flight\n- [ ] build - Sample work (kind: ship)\n');
    for (const surface of ['queued', 'holds', 'landed', 'decisions_open']) {
      home[surface] = [{ id: 'build' }];
      assert.deepEqual((await readUnreadableChildren(snapshot, { now })).children.get(home.id), []);
      home[surface] = [];
    }
    await rm(path.join(home.home, 'state/build.meta'));
    const missing = await readUnreadableChildren(snapshot, { now });
    assert.deepEqual(missing.children.get(home.id), []); assert.match(missing.disclosures.join(' '), /metadata unavailable/);
  });
});

test('unreadable-state fallback rejects generation changes, path escapes and metadata reassignment', async () => {
  await unreadableFixture(async ({ snapshot, now, addHome, put, root }) => {
    const home = await addHome('home-alpha');
    const meta = 'endpoint_task_id=build\nkind=ship\nspawn_gen=sample-generation\nwindow=sample-terminal\n';
    for (const text of [meta.replace('endpoint_task_id=build', 'endpoint_task_id=other'), meta.replace('spawn_gen=sample-generation\n', ''), meta + 'kind=scout\n', meta.replace('window=sample-terminal', 'window=other-terminal')]) {
      await put(home, 'state/build.meta', text);
      assert.deepEqual((await readUnreadableChildren(snapshot, { now })).children.get(home.id), []);
    }
    await put(home, 'state/build.meta', meta);
    const reassigned = await readUnreadableChildren(snapshot, { now, read: async file => {
      const bytes = await readConfinedFile(file);
      if (file.endsWith('.meta')) await put(home, 'state/build.meta', meta.replace('sample-generation', 'replacement-generation'));
      return bytes;
    } });
    assert.deepEqual(projectUnderwayRecords(snapshot, reassigned).rows, []);
    await put(home, 'state/build.meta', meta);
    const changed = await readUnreadableChildren(snapshot, { now, read: async file => {
      const bytes = await readConfinedFile(file);
      if (file.endsWith('.meta')) await put(home, 'data/backlog.md', '## Done\n- [x] build - Sample work\n');
      return bytes;
    } });
    assert.equal(changed.children.size, 0); assert.match(changed.disclosures.join(' '), /changed/);
    await put(home, 'data/backlog.md', '## In flight\n- [ ] build - Sample work\n');
    await utimes(path.join(home.home, 'state/build.meta'), (now + 1000) / 1000, (now + 1000) / 1000);
    assert.deepEqual((await readUnreadableChildren(snapshot, { now })).children.get(home.id), []);
    await rm(path.join(home.home, 'state/build.meta'));
    await writeFile(path.join(root, 'outside.meta'), meta);
    await symlink(path.join(root, 'outside.meta'), path.join(home.home, 'state/build.meta'));
    assert.deepEqual((await readUnreadableChildren(snapshot, { now })).children.get(home.id), []);
  });
});

test('work projection retains producer buckets, child ids, gates and durable ordering without exposing paths', () => {
  const raw = source(), model = normalizeSnapshot(raw);
  assert.equal(model.underway[0].state, 'working');
  assert.equal(model.underway[0].repo, 'sample');
  assert.equal(model.underway[1].task, 'sample-mate/check-notes');
  assert.deepEqual(model.charted.map(row => row.task), ['newer', 'older', '(main-inventory)']);
  assert.equal(model.charted[0].blockedBy, 'build-preview');
  assert.equal(model.charted[2].kind, 'warning');
  assert.equal(model.cards.length, 0);
  assert.doesNotMatch(JSON.stringify(model), /\/synthetic/);
  const rev = contentRevision(model);
  raw.generated = '2026-03-01T00:00:00Z';
  assert.equal(contentRevision(normalizeSnapshot(raw)), rev);
  raw.in_flight[0].doing = 'Checking another sample';
  assert.notEqual(contentRevision(normalizeSnapshot(raw)), rev);
  raw.gates[0].reason = 'Waiting for an external review';
  assert.notEqual(contentRevision(normalizeSnapshot(raw)), rev);
});

test('malformed rows disclose omissions, missing sections stay unavailable and present invalid sections fail closed', () => {
  const raw = source(); raw.gates.push({ id: '/synthetic/home', title: 'invalid' }, raw.gates[0]); raw.in_flight.push({ id: 'missing-title' });
  const model = normalizeSnapshot(raw);
  assert.deepEqual(model.omitted.filter(row => row.kind.startsWith('invalid-')), [{kind:'invalid-underway',count:1},{kind:'invalid-charted',count:2}]);
  assert.equal(normalizeSnapshot(base()).workCoverage.charted, false);
  assert.throws(() => normalizeSnapshot({ ...raw, gates: {} }), /gates invalid/);
  assert.deepEqual(normalizeSnapshot({ ...base(), gates: [], in_flight: [] }).charted, []);
});

test('selected-home repo supplement uses trailing metadata, refuses duplicates and creates no work rows', () => {
  const repos = backlogWorkRepos('- [ ] sample - Prose (repo: fake) remains prose (repo: sample-repo)\n- [ ] repeat - One (repo: sample)\n- [x] repeat - Two (repo: other)');
  assert.equal(repos.get('sample'), 'sample-repo');
  assert.equal(repos.has('repeat'), false);
  assert.deepEqual(normalizeSnapshot(base()).underway, []);
});

test('a failed snapshot preserves underway and gates as stale without changing their content revision', async () => {
  let fail = false, now = 100000;
  const timers = fakeTimers();
  const hub = createBearingsHub({ now: () => now, timers, runner: async () => { if (fail) throw Error('synthetic failure'); return JSON.stringify(source()); }, fingerprint: null, watchRecords: null });
  try {
    hub.touch(); await new Promise(resolve => setImmediate(resolve));
    const first = hub.current(); fail = true; now += 32000; hub.request(); timers.advance(32000); await new Promise(resolve => setImmediate(resolve));
    assert.equal(hub.current().state, 'stale');
    assert.deepEqual(hub.current().underway, first.underway);
    assert.deepEqual(hub.current().charted, first.charted);
    assert.equal(hub.current().rev, first.rev);
  } finally { hub.close(); }
});

test('work UI renders active/gated rows, escapes source text and retains nodes on freshness changes', () => {
  const dom = callDom(), context = vm.createContext({ window: {}, document: dom.document });
  vm.runInContext(readFileSync(new URL('../public/bearings-work.js', import.meta.url), 'utf8'), context);
  const sections = {};
  for (const name of ['underway', 'charted']) { const root = dom.document.createElement('section'); root.innerHTML = '<b data-work-count></b><p data-work-status></p><div data-work-cards></div>'; sections[name] = root; dom.document.body.append(root); }
  const view = context.window.bearingsWork.createController({ sections, doc: dom.document });
  const model = { ...normalizeSnapshot(source()), state: 'ready' };
  view.update(model);
  assert.equal(view.count('charted'), 2);
  const node = sections.underway.querySelector('[data-work-key]');
  assert.match(node.textContent, /Stage unavailable.*Build the sample preview.*Validating the sample/s);
  assert.match(sections.charted.textContent, /Needs repair/);
  assert.match(sections.charted.textContent, /Blocked by: build-preview/);
  view.observe({ state: 'stale', stale: true });
  assert.equal(sections.underway.querySelector('[data-work-key]'), node);
  assert.match(sections.underway.querySelector('[data-work-status]').textContent, /stale/);
  assert.match(context.window.bearingsWork.cardHtml({title:'<script>sample</script>',type:'underway'}), /&lt;script&gt;/);
  view.update({ ...normalizeSnapshot({ ...base(), in_flight: [], gates: [] }), state: 'ready' });
  assert.equal(sections.underway.querySelector('[data-work-key]'), null);
  assert.match(sections.underway.textContent, /Nothing is underway/);
  view.update({ ...normalizeSnapshot(base()), state: 'ready' });
  assert.match(sections.charted.textContent, /unavailable/);
});

test('Underway renders full long text, plain stages and explicit home labels', () => {
  const dom = callDom(), context = vm.createContext({ window: {}, document: dom.document });
  vm.runInContext(readFileSync(new URL('../public/bearings-work.js', import.meta.url), 'utf8'), context);
  const title = `Build example-app ${'longword'.repeat(100)} final title`, doing = `Full detail ${'context '.repeat(100)}final detail`;
  const card = { type: 'underway', title, doing, stage: 'Validating / review', home: 'home-alpha', task: 'home-alpha/build', kind: 'ship' };
  const node = dom.document.createElement('article'); node.innerHTML = context.window.bearingsWork.cardHtml(card);
  assert.ok(node.textContent.includes(title)); assert.ok(node.textContent.includes(doing));
  assert.match(node.textContent, /Validating \/ review/);
  assert.equal(node.querySelector('[data-work-home]').textContent, 'Home: home-alpha');
  assert.match(context.window.bearingsWork.cardHtml({ ...card, stage: null }), /Stage unavailable/);
});

test('stock current-state projections reject prose, stale events and historical validation runs', async () => {
  const { currentStage } = await import('../underway-records.js');
  const current = (state, source, detail) => ({ state, source, detail, freshness: 'fresh' });
  assert.equal(currentStage(current('working', 'run-step', 'validating (fixing) · run: synthetic')), 'Validating / review');
  assert.equal(currentStage(current('working', 'run-step', 'ci running')), 'Validating / review');
  assert.equal(currentStage(current('done', 'run-step', 'run passed: PR open')), 'PR open / awaiting merge');
  assert.equal(currentStage(current('done', 'run-step', 'checks green: PR ready for review (still monitoring for merge/close)')), 'PR open / awaiting merge');
  assert.equal(currentStage(current('parked', 'run-step', 'parked at test: 2 finding(s)')), 'Waiting for validation decision');
  assert.equal(currentStage(current('parked', 'status-log', 'Choose the window')), 'Waiting for captain decision');
  assert.equal(currentStage(current('blocked', 'status-log', 'Source unavailable')), 'Blocked');
  assert.equal(currentStage(current('working', 'pane', 'harness busy (building)')), 'Working · stage unavailable');
  assert.equal(currentStage(current('working', 'status-log', 'validating (running)')), 'Working · stage unavailable');
  assert.equal(currentStage({ ...current('working', 'run-step', 'validating (running)'), freshness: 'stale' }), 'Stage unavailable');
  assert.equal(currentStage(current('working', 'run-step', 'validating (running)'), { cached: true }), 'Stage unavailable');
  // Current stock attribution already rejected this historical branch/run; the
  // historical event and meta delivery mode must not override its current result.
  const { projectUnderwayRecords } = await import('../underway-records.js');
  const projected = projectUnderwayRecords({ schema: 'fm-fleet-snapshot.v1', tasks: [{ id: 'build', kind: 'ship', mode: 'delivery',
    current_state: current('working', 'pane', 'harness busy'), hints: { last_event_text: 'done: PR open' },
    validation: { outcome: 'passed', branch: 'fm/old', head: 'old-head' } }], secondmate_current: { records: [], registry: { available: true } } });
  assert.equal(projected.rows[0].stage, 'Working · stage unavailable');
  assert.equal(projected.rows[0].doing, 'harness busy');
});

test('registered canonical homes retain same-named work, exclude idle mates and disclose unavailable sources', async () => {
  const { projectUnderwayRecords } = await import('../underway-records.js');
  const home = (id, children) => ({ id, registered: true, provenance: { selected: 'structured-home' },
    freshness: { status: 'fresh' }, active_children: children, counts: { active_children: children.length } });
  const child = { id: 'build', kind: 'ship', name: 'Build example-app', state: 'working', source: 'run-step', doing: 'validating (running)' };
  const snapshot = { schema: 'fm-fleet-snapshot.v1', tasks: [{ id: 'build', kind: 'ship', backlog: { title: 'Build main example-app' },
    current_state: { state: 'blocked', source: 'status-log', detail: 'Dependency' } }, { id: 'idle', kind: 'secondmate' }],
    secondmate_current: { registry: { available: true }, records: [home('home-alpha', [child, child]), home('home-beta', [child]), home('home-idle', []),
      { id: 'home-unavailable', registered: true, provenance: { selected: 'parent-event-fallback' }, parent_event: { note: 'working: build' } },
      { ...home('unregistered', [child]), registered: false }] } };
  const work = projectUnderwayRecords(snapshot);
  const model = normalizeSnapshot({ ...base(), in_flight: work.rows.map(({ stage, ...row }) => ({ ...row, quarterdeckStage: stage })), quarterdeckWorkDisclosures: work.disclosures });
  assert.deepEqual(model.underway.map(row => row.home), ['Main home', 'home-alpha', 'home-beta']);
  assert.equal(new Set(model.underway.map(row => row.key)).size, 3);
  assert.equal(model.underway[1].stage, 'Validating / review');
  assert.deepEqual(model.workCoverage.underwayDisclosures, ['home-unavailable: work records unavailable']);
  assert.ok(model.omitted.some(row => row.kind === 'invalid-underway' && row.count === 1));
  snapshot.secondmate_current.registry.available = false;
  snapshot.secondmate_current.records[0].freshness.status = 'cached';
  const partial = projectUnderwayRecords(snapshot);
  assert.ok(partial.disclosures.includes('Registered-home registry unavailable'));
  assert.equal(partial.rows[1].stage, 'Stage unavailable');
});

test('malformed canonical identities disclose gaps without inventing home or task names', async () => {
  const { projectUnderwayRecords } = await import('../underway-records.js');
  const children = [{ name: 'Build example-app', state: 'working' }];
  const home = id => ({ id, registered: true, provenance: { selected: 'structured-home' }, active_children: children });
  const work = projectUnderwayRecords({ schema: 'fm-fleet-snapshot.v1', tasks: [{ kind: 'ship' }],
    secondmate_current: { registry: { available: true }, records: [home(undefined), home(42), home('home-alpha')] } });
  assert.deepEqual(work.rows, []);
  assert.deepEqual(work.disclosures, ['Main-home work record unavailable: invalid identity',
    'Registered-home record unavailable: invalid identity', 'Registered-home record unavailable: invalid identity',
    'home-alpha: child work record unavailable: invalid identity']);
  const model = normalizeSnapshot({ ...base(), in_flight: work.rows, quarterdeckWorkDisclosures: work.disclosures });
  assert.deepEqual(model.underway, []);
  assert.equal(model.workCoverage.underwayDisclosures.length, 4);
});

 test('chat composition retains work-only revisions through the existing stream model', () => {
  const raw = source(), first = normalizeSnapshot(raw);
  const chat = { state: 'ready', sources: [], resolved: [], checkedAt: null };
  const composed = composeCallModel(first, [], chat);
  raw.gates[0].reason = 'Waiting for the sample reviewer';
  const next = composeCallModel(normalizeSnapshot(raw), [], chat);
  assert.notEqual(next.rev, composed.rev);
  assert.deepEqual(next.underway, first.underway);
  assert.notDeepEqual(next.charted, composed.charted);
});
