import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chatCard, createChatAskScanner, createCallSource, memoryStateFile } from '../chat-asks.js';
import { createServer } from '../server.js';

// Whole invented native records/ledger items, never partial real-message projections.
const T0 = Date.parse('2030-01-02T10:00:00Z');
const at = n => new Date(T0 + n * 60000).toISOString();
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const frame = (id, role, text, n) => ({ type: 'message', id, parentId: 'synthetic-parent', timestamp: at(n), message: { role, content: [{ type: 'text', text }], metadata: { synthetic: true } } });
const encode = record => `${JSON.stringify(record)}\n`;
async function reference(file, offset = 0, length = null) {
  const bytes = await readFile(file), info = await stat(file);
  length ??= bytes.length;
  return { file, offset, length, sha256: digest(bytes.subarray(offset, offset + length)), identity: { dev: info.dev, ino: info.ino } };
}
async function fixture(t, { configured = true, ledger = null } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'qd-historical-answer-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'primary'), owner = path.join(root, 'owner');
  await mkdir(path.join(home, 'state'), { recursive: true });
  await mkdir(path.join(owner, 'data'), { recursive: true });
  const file = path.join(home, 'state', 'main.jsonl'), source = 'state/main.jsonl';
  await writeFile(path.join(home, 'state', '.main-session'), `${source}\n`);
  const answerText = '[task:sample-work] Proceed with a source-only sample draft.\n\nNo live acceptance.';
  const request = frame('original-event', 'assistant', 'DECISION NEEDED: Preserve a source-only sample draft? [task:sample-work]', 2);
  const answer = frame('answer-event', 'user', answerText, 3);
  const independent = frame('independent-event', 'assistant', 'APPROVAL NEEDED: Choose a separate sample window. [task:sample-other]', 5);
  const newer = frame('newer-event', 'assistant', 'DECISION NEEDED: Admit future sample qualification? [task:sample-work]', 6);
  const wait = frame('prospective-wait', 'user', 'Wait prospectively for actual sample qualification.', 7);
  const records = [request, answer, independent, newer, wait];
  await writeFile(file, records.map(encode).join(''));
  const previous = `  Resolution recorded by fm-captain-hold.\n  Decision digest: ${digest('Previous sample retention.')}\n  Resolution mode: released\n\n  Captain decision:\n  Previous sample retention.\n\n  Original sample context.\n\n`;
  const held = `- [ ] sample-work - Sample work (hold: fm-hold-v1:${Buffer.from('Confirm the sample scope.').toString('base64')}) (hold-kind: captain)\n  Captain hold set: ${at(0)}\n\n${previous}`;
  const decision = answerText.split('\n').map(line => line ? `  ${line}` : '').join('\n');
  const resolution = `- [ ] sample-work - Sample work (kind: ship)\n  Resolution recorded by fm-captain-hold.\n  Decision digest: ${digest(answerText)}\n  Resolution mode: released\n\n  Captain decision:\n${decision}\n\n${previous}`;
  const heldFile = path.join(owner, 'data', 'note-archive.md'), resolutionFile = path.join(owner, 'data', 'backlog.md');
  const native = ledger?.({ answerText, decision }) ?? { archive: held, held: [0, Buffer.byteLength(held)], backlog: resolution, resolution: [0, Buffer.byteLength(resolution)], occurrence: 2 };
  await writeFile(heldFile, native.archive);
  await writeFile(resolutionFile, native.backlog);
  const parentKey = `captain-hold-sample-work-${native.occurrence}`;
  const parentFile = path.join(home, 'state', 'sample-fleet.status');
  const raised = `needs-decision [key=${parentKey}] [at=${(T0 + 60000) / 1000}]: captain hold sample-work: Confirm scope.\n`;
  const resolved = `resolved [key=${parentKey}] [at=${(T0 + 240000) / 1000}]: captain hold sample-work: released\n`;
  await writeFile(parentFile, raised + resolved);
  let selection = null, calls = 0;
  const producer = async () => { calls++; return selection; };
  const store = memoryStateFile();
  const scanner = createChatAskScanner({ home, store, now: () => T0 + 600000, historicalAnswer: configured ? producer : null });
  const base = { state: 'ready', cards: [{ key: 'decision:sample-owner/sample-work', type: 'decision', task: 'sample-owner/sample-work', holdVersion: 'reheld', summary: 'Independent re-held qualification' }, { key: 'decision:sample-host/publication-choice', type: 'decision', task: 'sample-host/publication-choice', summary: 'Unanswered publication choice' }], holds: [], omitted: [] };
  const sourceModel = createCallSource({ hub: { current: () => base }, chat: scanner });
  await sourceModel.refresh();
  const ask = scanner.asks().find(ask => ask.recordId === request.id);
  const claim = {
    request: { source, key: ask.key, rev: chatCard(ask).rev, eventId: request.id, part: 0, ref: await reference(file, 0, Buffer.byteLength(encode(request))) },
    answer: { eventId: answer.id, part: 0, digest: digest(answerText), ref: await reference(file, Buffer.byteLength(encode(request)), Buffer.byteLength(encode(answer))) },
    owner: { home: owner, task: 'sample-work', fleet: 'sample-fleet', heldAt: at(0), occurrence: native.occurrence, parentKey, mode: 'released', resolvedAt: at(4), held: await reference(heldFile, ...native.held), resolution: await reference(resolutionFile, ...native.resolution), raised: await reference(parentFile, 0, Buffer.byteLength(raised)), resolved: await reference(parentFile, Buffer.byteLength(raised), Buffer.byteLength(resolved)) },
  };
  return { home, root, file, records, claim, scanner, store, sourceModel, base, producer, calls: () => calls, select: value => { selection = value; }, snapshots: { source: await readFile(file), held: await readFile(heldFile), resolution: await readFile(resolutionFile), parent: await readFile(parentFile) } };
}

test('native positive resolves ONLY exact original through scanner/call-source; history/canonical/independent/reheld/publication unchanged, idempotent', async t => {
  const f = await fixture(t);
  const key = f.claim.request.key;
  assert.ok(f.sourceModel.current().cards.find(card => card.key === key)?.answer);
  f.select(f.claim);
  await f.sourceModel.refresh();
  const model = f.sourceModel.current();
  assert.equal(model.cards.some(card => card.key === key), false);
  assert.deepEqual(f.scanner.asks().map(ask => ask.recordId), ['independent-event', 'newer-event']);
  assert.deepEqual(model.cards.filter(card => card.type === 'decision'), f.base.cards);
  assert.deepEqual(model.chat.resolved.map(row => [row.key, row.status, row.resolutions[0].resolution]), [[key, 'answered', 'released']]);
  const state = await f.store.read();
  assert.equal(state.asks[key].resolvedBy, 'answered');
  assert.equal(state.asks[key].text, 'Preserve a source-only sample draft? [task:sample-work]');
  assert.ok(state.tombstones[key]);
  assert.deepEqual(await readFile(f.file), f.snapshots.source);
  assert.deepEqual(await readFile(f.claim.owner.held.file), f.snapshots.held);
  assert.deepEqual(await readFile(f.claim.owner.resolution.file), f.snapshots.resolution);
  assert.deepEqual(await readFile(f.claim.owner.raised.file), f.snapshots.parent);
  const before = JSON.stringify(await f.store.read());
  await f.sourceModel.refresh();
  assert.equal(JSON.stringify(await f.store.read()), before);
  assert.deepEqual(f.scanner.view().warnings, []);
});

test('default-off and null selection preserve ordinary unverified input/receipts and add no authority', async t => {
  const f = await fixture(t, { configured: false });
  f.select(f.claim);
  await f.sourceModel.refresh();
  assert.equal(f.calls(), 0);
  assert.ok(f.scanner.asks().find(ask => ask.key === f.claim.request.key));
  assert.equal(f.sourceModel.current().chat.resolved.length, 0);
  assert.throws(() => createChatAskScanner({ home: f.home, historicalAnswer: f.claim }), /explicitly configured function/);
  const g = await fixture(t);
  g.select({ handled: [{ body: 'A receipt is not original-source authority.' }], replies: [{ body: 'Proceed.' }] });
  await g.sourceModel.refresh();
  assert.ok(g.scanner.asks().find(ask => ask.key === g.claim.request.key));
});

// Exact native ledger framing written by fm-captain-hold through the markdown task backend:
// each superseded body is appended to the note archive as `\n## Archived <date>\n<item>\n`,
// and the released item ahead of the next backlog section heading keeps one blank separator.
const nativeHeader = '- [ ] sample-work - Sample work (kind: ship) (since 2030-01-02)';
const nativeHeld = (reason, stamp) => `${nativeHeader} (hold: fm-hold-v1:${Buffer.from(reason).toString('base64')}) (hold-kind: captain)\n  Captain hold set: ${stamp}`;
const nativeResolution = (answerText, decision) => `  Resolution recorded by fm-captain-hold.\n  Decision digest: ${digest(answerText)}\n  Resolution mode: released\n\n  Captain decision:\n${decision}`;
const archived = item => `\n## Archived 2030-01-02\n${item}\n`;
const queued = item => `## In flight\n\n## Queued\n${item}\n\n## Done\n`;
const span = (text, item, separator = 0) => [Buffer.byteLength(text.slice(0, text.indexOf(item))), Buffer.byteLength(item) + 1 + separator];
const nativeLedger = ({ cycle, laterArchive = false, retained = true }) => ({ answerText, decision }) => {
  const prior = nativeResolution('Previous sample retention.', '  Previous sample retention.');
  const heldItem = cycle === 1 ? nativeHeld('Confirm the sample scope.', at(0)) : `${nativeHeld('Confirm the sample scope again.', at(0))}\n\n${prior}`;
  const resolutionItem = `${nativeHeader}\n${nativeResolution(answerText, decision)}${cycle === 2 && retained ? `\n\n${prior}` : ''}`;
  const archive = (cycle === 2 ? archived(nativeHeld('Confirm the sample scope.', at(-60))) : '') + archived(heldItem) +
    (laterArchive ? archived('- [ ] sample-other - Sample other (kind: ship) (since 2030-01-02)\n  Later sample context.') : '');
  const backlog = queued(resolutionItem);
  return { archive, held: span(archive, heldItem, laterArchive ? 1 : 0), backlog, resolution: span(backlog, resolutionItem, 1), occurrence: cycle };
};

for (const [name, options] of [
  ['first cycle with no previous body', { cycle: 1 }],
  ['first cycle archived ahead of a later archive block', { cycle: 1, laterArchive: true }],
  ['second cycle retaining the earlier resolution', { cycle: 2 }],
]) test(`native fm-captain-hold ledger framing admits ${name}`, async t => {
  const f = await fixture(t, { ledger: nativeLedger(options) });
  f.select(f.claim);
  await f.sourceModel.refresh();
  assert.deepEqual(f.scanner.view().warnings, []);
  assert.equal(f.sourceModel.current().cards.some(card => card.key === f.claim.request.key), false);
  assert.deepEqual(f.sourceModel.current().chat.resolved.map(row => [row.key, row.status, row.resolutions[0].resolution]), [[f.claim.request.key, 'answered', 'released']]);
});

for (const [name, options, alter, code] of [
  ['a second-cycle archive range that stops before retained context', { cycle: 2 }, async c => { c.owner.held = await reference(c.owner.held.file, c.owner.held.offset, Buffer.byteLength(`${nativeHeld('Confirm the sample scope again.', at(0))}\n\n`)); }, 'item-boundary'],
  ['a second-cycle resolution that drops retained context', { cycle: 2, retained: false }, async () => {}, 'owner-resolution'],
]) test(`native fm-captain-hold ledger framing still rejects ${name}`, async t => {
  const f = await fixture(t, { ledger: nativeLedger(options) }), c = structuredClone(f.claim);
  await alter(c);
  f.select(c);
  await f.sourceModel.refresh();
  assert.equal((await f.store.read()).asks[c.request.key].status, 'open');
  assert.match(f.scanner.view().warnings.at(-1), new RegExp(`${code}$`));
});

const invalid = [
  ['source', c => { c.request.source = 'different/source.jsonl'; }],
  ['file', c => { c.request.ref.file = c.owner.resolution.file; }],
  ['file identity', c => { c.request.ref.identity.ino++; }],
  ['request event', c => { c.request.eventId = 'other-event'; }],
  ['offset', c => { c.request.ref.offset++; }],
  ['record boundary', c => { c.request.ref.length--; }],
  ['part', c => { c.request.part++; }],
  ['negative part', c => { c.answer.part = -1; }],
  ['key', c => { c.request.key = 'chat:1111111111111111'; }],
  ['revision', c => { c.request.rev = '2222222222222222'; }],
  ['raw record digest', c => { c.request.ref.sha256 = '0'.repeat(64); }],
  ['answer event', c => { c.answer.eventId = 'other-answer'; }],
  ['answer part', c => { c.answer.part++; }],
  ['answer digest', c => { c.answer.digest = '0'.repeat(64); }],
  ['owner', (c, f) => { c.owner.home = f.home; }],
  ['owner task', c => { c.owner.task = 'sample-other'; }],
  ['owner fleet', c => { c.owner.fleet = 'other-fleet'; }],
  ['occurrence', c => { c.owner.occurrence = 1; c.owner.parentKey = 'captain-hold-sample-work-1'; }],
  ['parent key', c => { c.owner.parentKey = 'captain-hold-sample-work-3'; }],
  ['held stamp', c => { c.owner.heldAt = at(1); }],
  ['resolution mode', c => { c.owner.mode = 'answered'; }],
  ['Done is not answer authority', c => { c.owner.mode = 'done'; }],
  ['resolution event', c => { c.owner.resolved = c.owner.raised; }],
  ['release clock', c => { c.owner.resolvedAt = at(3); }],
  ['partial owner record', c => { c.owner.resolution.length -= 8; }],
  ['different hold version', c => { c.request.holdVersion = 'other-historical-version'; }],
  ['newer target', (c, f) => { const newer = f.scanner.asks().find(ask => ask.recordId === 'newer-event'); c.request.key = newer.key; c.request.rev = chatCard(newer).rev; }],
];
for (const [name, alter] of invalid) test(`new native boundary rejects ${name} without clearing original or independent calls`, async t => {
  const f = await fixture(t), c = structuredClone(f.claim);
  alter(c, f);
  f.select(c);
  await f.sourceModel.refresh();
  assert.ok(f.scanner.asks().find(ask => ask.key === f.claim.request.key));
  assert.equal(f.scanner.asks().length, 3);
  assert.deepEqual(f.sourceModel.current().cards.filter(card => card.type === 'decision'), f.base.cards);
  assert.equal(Object.keys((await f.store.read()).tombstones).length, 0);
  assert.match(f.scanner.view().warnings.at(-1), /^Historical answer not admitted:/);
});

test('changed actual answer bytes fail even with newly correct full raw-record checksum', async t => {
  const f = await fixture(t), c = structuredClone(f.claim);
  f.records[1].message.content[0].text += ' Changed.';
  await writeFile(f.file, f.records.map(encode).join(''));
  c.answer.ref = await reference(f.file, Buffer.byteLength(encode(f.records[0])), Buffer.byteLength(encode(f.records[1])));
  f.select(c);
  await f.sourceModel.refresh();
  assert.ok(f.scanner.asks().find(ask => ask.key === c.request.key));
  assert.match(f.scanner.view().warnings.at(-1), /answer-digest$/);
});

test('hashed partial canonical body cannot hide retained history', async t => {
  const f = await fixture(t), c = structuredClone(f.claim);
  const body = (await readFile(c.owner.resolution.file)).toString('utf8');
  const end = body.indexOf('\n\n  Resolution recorded by fm-captain-hold.', body.indexOf('  Captain decision:')) + 2;
  assert.ok(end > 2);
  c.owner.resolution = await reference(c.owner.resolution.file, 0, Buffer.byteLength(body.slice(0, end)));
  f.select(c);
  await f.sourceModel.refresh();
  assert.equal((await f.store.read()).asks[c.request.key].status, 'open');
  assert.match(f.scanner.view().warnings.at(-1), /item-boundary$/);
});

for (const [name, field, change] of [
  ['changed recorded resolution', 'resolution', text => text.replace('Resolution mode: released', 'Resolution mode: done')],
  ['changed held stamp', 'held', text => text.replace(`Captain hold set: ${at(0)}`, `Captain hold set: ${at(1)}`)],
  ['current owner reheld', 'resolution', text => text.replace('(kind: ship)', `(kind: ship) (hold: fm-hold-v1:${Buffer.from('New qualification.').toString('base64')}) (hold-kind: captain)`)],
]) test(`actual ${name} fails with valid updated file checksum`, async t => {
  const f = await fixture(t), c = structuredClone(f.claim), file = c.owner[field].file;
  await writeFile(file, change((await readFile(file)).toString('utf8')));
  c.owner[field] = await reference(file);
  f.select(c);
  await f.sourceModel.refresh();
  assert.equal((await f.store.read()).asks[c.request.key].status, 'open');
  assert.match(f.scanner.view().warnings.at(-1), /owner-(?:occurrence|resolution)$/);
});

test('current-target version race is rechecked inside existing state transaction after evidence validation', async t => {
  const f = await fixture(t);
  f.select(f.claim);
  await f.store.update(state => { state.asks[f.claim.request.key].holdVersion = 'newer-reheld-version'; return { write: true }; });
  await f.sourceModel.refresh();
  assert.equal((await f.store.read()).asks[f.claim.request.key].status, 'open');
  assert.equal(Object.keys((await f.store.read()).tombstones).length, 0);
  assert.match(f.scanner.view().warnings.at(-1), /current-target$/);
});

test('actual createServer caller threads explicit callback to native scanner, with no network/listener or live activation', async t => {
  const f = await fixture(t);
  f.select(f.claim);
  t.mock.method(Date, 'now', () => T0 + 600000);
  const server = createServer({ FM_HOME: f.home, FM_QUARTERDECK_STATE_PATH: path.join(f.root, 'presentation.json') }, { historicalAnswer: f.producer });
  t.after(() => server.emit('close'));
  await server.bearings.refresh();
  assert.ok(server.bearings.current().chat.resolved.find(row => row.key === f.claim.request.key));
  assert.equal(server.bearings.current().cards.some(card => card.key === f.claim.request.key), false);
  assert.equal(server.listening, false);
});
