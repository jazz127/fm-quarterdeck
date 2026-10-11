import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { backlogClocks, backlogRepos, backlogTitles, decisionClock, normalizeSnapshot, createSnapshotRunner } from '../bearings.js';
const window = {};
for (const name of ['bearings-view', 'bearings-patch']) vm.runInNewContext(await readFile(new URL(`../public/${name}.js`, import.meta.url), 'utf8'), { window, URL });
const raw = { schema: 'fm-bearings.v1', decisions_open: [{ id: 'alpha', owner: '(main)', summary: 'Pick a window' }], contributions: { captain: [], known: 0, checked: 0, proven_clear: false }, omitted: [] };

test('durable clocks choose latest known evidence, retain date precision and reject absent or invalid clocks', () => {
  assert.deepEqual(decisionClock({}), { label: 'Created / updated', at: null });
  assert.deepEqual(decisionClock({ created: '2026-01-01', hold_set_at: '2026-01-02T03:04:05Z', updated_at: '2026-01-03T00:00:00Z' }), { label: 'Updated', at: '2026-01-03T00:00:00.000Z' });
  assert.equal(decisionClock({ created: '2026-99-99', updated_at: 'bad' }).at, null);
  const clocks = backlogClocks('## In Flight\n- [ ] alpha - Pick a window (since 2026-01-01)\n  Captain hold set: 2026-01-02T03:04:05Z\n- [ ] beta - Missing\n  Ordinary prose\n  Captain hold set: 2026-01-04T00:00:00Z\n');
  assert.equal(decisionClock(clocks.get('alpha')).label, 'Hold set');
  assert.equal(decisionClock(clocks.get('beta')).at, null, 'only a leading hold stamp counts');
  assert.equal(normalizeSnapshot(raw).cards[0].clock.at, null);
});

test('snapshot runner supplements only selected-home main cards without mutating ledger', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'call-clocks-'));
  try {
    await mkdir(path.join(home, 'bin')); await mkdir(path.join(home, 'data'));
    const ledger = '## In Flight\n- [ ] alpha - Pick a window (since 2026-01-01)\n  Captain hold set: 2026-01-02T03:04:05Z\n';
    await writeFile(path.join(home, 'data/backlog.md'), ledger);
    await writeFile(path.join(home, 'bin/fm-bearings-snapshot.sh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ ...raw, decisions_open: [...raw.decisions_open, { id: 'beta', owner: 'other', summary: 'Choose' }] })}'\n`, { mode: 0o755 });
    const content = normalizeSnapshot(JSON.parse(await createSnapshotRunner(home)()));
    assert.equal(content.cards[0].clock.at, '2026-01-02T03:04:05.000Z');
    assert.equal(content.cards[0].summary, 'Pick a window');
    assert.equal(content.cards[0].backlogTitle, 'Pick a window');
    assert.equal(content.cards[1].clock.at, null);
    assert.equal(content.cards[1].backlogTitle, undefined, 'another owner is not supplemented');
    assert.equal(await readFile(path.join(home, 'data/backlog.md'), 'utf8'), ledger);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('main-home title and hold reason supplement a shortened ask without replacing its summary or a source reason', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'call-title-'));
  try {
    await mkdir(path.join(home, 'bin')); await mkdir(path.join(home, 'data'));
    const title = 'Pick a window and keep the rest of the recorded ask';
    const reason = 'Pick a window and keep the hold reason';
    const encoded = Buffer.from(reason).toString('base64');
    const ledger = `## In Flight\n- [ ] alpha - ${title} (hold: fm-hold-v1:${encoded}) (hold-kind: captain)\n- [ ] twin - First title\n- [ ] twin - Second title\n`;
    const snapshot = { ...raw, decisions_open: [
      { id: 'alpha', owner: '(main)', summary: 'Pick a window…', reason: 'Upstream reason wins' },
      { id: 'twin', owner: '(main)', summary: 'Twin…' },
      { id: 'beta', owner: 'other', summary: 'Choose…' },
    ] };
    await writeFile(path.join(home, 'data/backlog.md'), ledger);
    await writeFile(path.join(home, 'bin/fm-bearings-snapshot.sh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(snapshot)}'\n`, { mode: 0o755 });
    const content = normalizeSnapshot(JSON.parse(await createSnapshotRunner(home)()));
    const alpha = content.cards.find((card) => card.task === 'alpha');
    assert.equal(alpha.summary, 'Pick a window…');
    assert.equal(alpha.reason, 'Upstream reason wins');
    assert.equal(alpha.backlogTitle, title);
    assert.equal(alpha.backlogReason, reason);
    assert.equal(content.cards.find((card) => card.task === 'twin').backlogTitle, undefined, 'duplicate ids fail closed');
    assert.equal(content.cards.find((card) => card.task === 'beta').backlogTitle, undefined);
    assert.equal(backlogTitles(ledger).has('twin'), false);
    assert.equal(await readFile(path.join(home, 'data/backlog.md'), 'utf8'), ledger);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('a missing snapshot repository is filled from the backlog repo field and a flight repo still wins', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'call-repo-'));
  try {
    await mkdir(path.join(home, 'bin')); await mkdir(path.join(home, 'data'));
    const ledger = '## In Flight\n- [ ] hold-reason - Choose a window (repo: /synthetic/checkouts/quarterdeck) (hold-kind: captain)\n- [ ] alpha - Keep flight (repo: backlog-name) (hold-kind: captain)\n- [ ] twin - First (repo: one)\n- [ ] twin - Second (repo: two)\n';
    const snapshot = { ...raw, in_flight: [{ id: 'alpha', repo: '/synthetic/checkouts/alpha-repo' }], decisions_open: [
      { id: 'hold-reason', owner: '(main)', summary: 'Choose' },
      { id: 'alpha', owner: '(main)', summary: 'Keep flight' },
      { id: 'twin', owner: '(main)', summary: 'Twin' },
      { id: 'other', owner: 'delta-mate', summary: 'Other home' },
    ] };
    await writeFile(path.join(home, 'data/backlog.md'), ledger);
    await writeFile(path.join(home, 'bin/fm-bearings-snapshot.sh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(snapshot)}'\n`, { mode: 0o755 });
    const content = normalizeSnapshot(JSON.parse(await createSnapshotRunner(home)()));
    assert.equal(content.cards.find((card) => card.task === 'hold-reason').repo, 'quarterdeck');
    assert.equal(content.cards.find((card) => card.task === 'alpha').repo, 'alpha-repo');
    assert.equal(content.cards.find((card) => card.task === 'twin').repo, null, 'duplicate backlog ids fail closed');
    assert.equal(content.cards.find((card) => card.task === 'other').repo, null, 'another owner is not supplemented');
    assert.equal(backlogRepos(ledger).get('hold-reason'), 'quarterdeck');
    assert.equal(backlogRepos(ledger).has('twin'), false);
    assert.doesNotMatch(JSON.stringify(content), /\/synthetic\//);
    assert.equal(await readFile(path.join(home, 'data/backlog.md'), 'utf8'), ledger);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test('card clocks show absolute local time and tick relative time; date-only sources disclose unknown time', () => {
  const at = '2026-01-02T03:04:05Z', now = Date.parse(at);
  assert.equal(window.bearingsView.clockText({ label: 'Updated', at }, now), `Updated: ${new Date(at).toLocaleString()} · just now`);
  assert.match(window.bearingsView.clockText({ label: 'Updated', at }, now + 120000), /2m ago$/);
  assert.match(window.bearingsView.clockText({ label: 'Created', at: '2026-01-01' }, now), /time unknown/);
  assert.match(window.bearingsView.cardHtml({ type: 'decision', summary: 'Choose', clock: { label: 'Updated', at } }), /data-call-clock="2026-01-02T03:04:05Z"/);
  assert.match(window.bearingsView.cardHtml({ type: 'decision', summary: 'Choose' }), /Created \/ updated: unknown/);
});

test('sort uses durable clocks in both directions, stable ties and unknowns last', () => {
  const cards = [{ key: 'unknown' }, { key: 'new', clock: { at: '2026-02-01' } }, { key: 'old', clock: { at: '2026-01-01' } }, { key: 'tie', clock: { at: '2026-01-01' } }];
  assert.equal(window.bearingsPatch.sortCards(cards, 'newest').map(c => c.key).join(','), 'new,old,tie,unknown');
  assert.equal(window.bearingsPatch.sortCards(cards, 'oldest').map(c => c.key).join(','), 'old,tie,new,unknown');
  assert.equal(cards[0].key, 'unknown', 'sort never mutates source');
});

test('snapshot runner supplements only projected main gates with shared-parser repositories and leaves source bytes intact', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'bearings-work-source-'));
  try {
    await mkdir(path.join(home, 'bin')); await mkdir(path.join(home, 'data'));
    const ledger = '- [ ] sample - Prose (repo: ignored) remains prose (repo: sample-repo)\n- [ ] unprojected - Sample backlog only (repo: other-repo)\n';
    await writeFile(path.join(home, 'data/backlog.md'), ledger);
    const snapshot = { ...raw, gates: [
      { id: 'sample', owner: '(main)', title: 'Prepare sample', reason: 'External review' },
      { id: 'sample', owner: 'sample-mate', title: 'Review sample', reason: 'Dependency' },
    ], in_flight: [] };
    await writeFile(path.join(home, 'bin/fm-bearings-snapshot.sh'), `#!/bin/sh\nprintf '%s' '${JSON.stringify(snapshot)}'\n`, { mode: 0o755 });
    const content = normalizeSnapshot(JSON.parse(await createSnapshotRunner(home)()));
    assert.equal(content.charted.length, 2, 'same task id in different homes remains separate');
    assert.equal(content.charted[0].repo, 'sample-repo');
    assert.equal(content.charted[1].repo, null, 'another home is never supplemented');
    assert.deepEqual(content.underway, []);
    assert.equal(await readFile(path.join(home, 'data/backlog.md'), 'utf8'), ledger);
  } finally { await rm(home, { recursive: true, force: true }); }
});
