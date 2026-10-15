#!/usr/bin/env node
// fm-quarterdeck: inactive snapshot-only skill reports. No owner execution or actions.
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MODES = Object.freeze(['fleet-health', 'cleanup-sweep', 'pr-readiness', 'pr-identity-guard', 'restart-ready']);
const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 512;
const MAX_AGE_MS = 300_000;
const states = ['working', 'parked', 'done', 'blocked', 'paused', 'failed'];
const sources = ['run-step', 'pane', 'status-log', 'remote-endpoint'];
const unknown = reason => ({ status: 'UNKNOWN', reason });
const fact = value => ({ status: 'OBSERVED', value });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const head = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
const homePath = value => typeof value === 'string' && value.startsWith('/') && value !== '/' && path.posix.normalize(value) === value && !/[\x00-\x1f\x7f]/.test(value) && !value.endsWith('/');
const label = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.\/-]{0,119}$/.test(value);

function freshness(observedAt, asOf) {
  if (!timestamp(observedAt)) return 'observation time missing or invalid';
  const age = Date.parse(asOf) - Date.parse(observedAt);
  if (age < 0) return 'observation is in the future';
  if (age > MAX_AGE_MS) return 'observation older than five minutes';
  return null;
}

// Envelope provenance is caller-supplied evidence, not authenticated authority.
function evidence(input, key, home, asOf) {
  const value = input[key];
  if (!object(value)) return { error: `${key} snapshot unavailable` };
  if (value.home !== home) return { error: `${key} selected-home mismatch` };
  if (!label(value.owner)) return { error: `${key} owner missing or invalid` };
  const error = freshness(value.observedAt, asOf);
  if (error) return { error: `${key}: ${error}` };
  if (!object(value.data)) return { error: `${key} data unavailable` };
  return { data: value.data };
}

function fleetEvidence(input, home, asOf) {
  const value = input.fleet;
  if (!object(value) || value.schema !== 'fm-fleet-snapshot.v1') return { error: 'fleet snapshot unavailable or unsupported schema' };
  if (value.fm_home !== home) return { error: 'fleet selected-home mismatch' };
  const error = freshness(value.generated, asOf);
  if (error) return { error: `fleet: ${error}` };
  return { data: value };
}

function crewRows(fleet, asOf) {
  if (fleet.error) return unknown(fleet.error);
  if (!Array.isArray(fleet.data.tasks) || fleet.data.tasks.length > MAX_ROWS) return unknown('task inventory unavailable or over bound');
  const ids = fleet.data.tasks.map(row => row?.id);
  if (ids.some(id => !label(id)) || new Set(ids).size !== ids.length) return unknown('invalid or conflicting task identities');
  return fact(fleet.data.tasks.map(row => {
    const current = row.current_state;
    const error = freshness(current?.observed_at, asOf);
    const valid = !row.remote && object(current) && current.freshness === 'fresh' && !error && states.includes(current.state) && sources.includes(current.source);
    return {
      id: row.id,
      current: valid ? fact({ state: current.state, source: current.source }) : unknown(row.remote ? 'remote state not inspected' : (error || 'current state unavailable or conflicting')),
      // Do not turn a historical event, idle pane or technical block into a captain call.
      historicalEvent: ['working', 'needs-decision', ...states].includes(row.paths?.status_log?.last_event?.state)
        ? fact(row.paths.status_log.last_event.state) : unknown('event unavailable'),
      wait: valid && current.state === 'paused' ? fact('paused according to current-state owner; target and completion condition not structured') : unknown('no structured current wait target or completion condition'),
    };
  }));
}

function oldestCall(fleet, asOf) {
  if (fleet.error) return unknown(fleet.error);
  const backlog = fleet.data.backlog;
  if (backlog?.present !== true || !Array.isArray(backlog.records) || backlog.records.length > MAX_ROWS) return unknown('structured captain-held inventory unavailable or over bound');
  if (backlog.records.some(row => !object(row) || row.structured !== true) || new Set(backlog.records.map(row => row.id)).size !== backlog.records.length) return unknown('incomplete or conflicting structured backlog coverage');
  const holds = backlog.records.filter(row => row.hold_kind === 'captain' && row.state !== 'done');
  if (!holds.length) return unknown('no structured active captain hold observed; not an all-clear');
  if (holds.some(row => !label(row.id) || !['in_flight', 'queued'].includes(row.state) || !['live', 'blocked', 'dated', 'aged'].includes(row.hold_bucket) || row.captain_actionable !== (row.hold_bucket === 'live'))) return unknown('conflicting or incomplete captain-hold classification');
  const live = holds.filter(row => row.captain_actionable);
  if (!live.length) return unknown('no currently actionable captain hold observed');
  if (live.some(row => !timestamp(row.hold_set) || Date.parse(row.hold_set) > Date.parse(asOf))) return unknown('captain hold-set time missing or invalid; oldest cannot be established');
  live.sort((a, b) => a.hold_set.localeCompare(b.hold_set) || a.id.localeCompare(b.id));
  return fact({ id: live[0].id, heldSince: live[0].hold_set, basis: 'structured captain_actionable and hold_set only' });
}

function resourceFacts(input, home, asOf) {
  const capacity = evidence(input, 'capacity', home, asOf);
  const ram = evidence(input, 'ram', home, asOf);
  return {
    capacity: !capacity.error && integer(capacity.data.limit) && capacity.data.limit > 0 && integer(capacity.data.occupied)
      ? fact({ limit: capacity.data.limit, occupied: capacity.data.occupied }) : unknown(capacity.error || 'capacity counts unavailable'),
    ram: !ram.error && integer(ram.data.totalBytes) && ram.data.totalBytes > 0 && integer(ram.data.availableBytes) && ram.data.availableBytes <= ram.data.totalBytes
      ? fact({ totalBytes: ram.data.totalBytes, availableBytes: ram.data.availableBytes }) : unknown(ram.error || 'RAM counts missing or conflicting'),
    admission: unknown('recorded resource facts do not authorize spawning or establish headroom policy'),
  };
}

function prFacts(input, home, asOf) {
  const pr = evidence(input, 'pr', home, asOf);
  const served = evidence(input, 'served', home, asOf);
  if (pr.error) return { source: unknown(pr.error), servedHead: unknown('PR identity unavailable') };
  const data = pr.data;
  const identity = head(data.headRefOid) && label(data.repository) && label(data.target);
  const checks = data.checks;
  const checksValid = identity && Array.isArray(checks) && checks.length > 0 && checks.length <= MAX_ROWS && checks.every(check => object(check) && check.head === data.headRefOid && ['PASS', 'FAIL', 'PENDING', 'SKIPPED'].includes(check.state));
  const servedValid = identity && !served.error && head(served.data.head) && served.data.repository === data.repository && served.data.target === data.target && served.data.independent === true && typeof served.data.healthy === 'boolean';
  return {
    source: identity ? fact({ head: data.headRefOid, repository: data.repository, target: data.target }) : unknown('exact source identity incomplete'),
    state: ['OPEN', 'CLOSED', 'MERGED'].includes(data.state) ? fact(data.state) : unknown('PR state unavailable'),
    draft: typeof data.isDraft === 'boolean' ? fact(data.isDraft) : unknown('draft state unavailable'),
    reportedChecks: checksValid ? fact({ total: checks.length, failed: checks.filter(c => c.state === 'FAIL').length, pending: checks.filter(c => c.state === 'PENDING').length, skipped: checks.filter(c => c.state === 'SKIPPED').length }) : unknown('checks absent, malformed or not bound to exact source head'),
    requiredCoverage: unknown('reported checks cannot enumerate required checks that have never reported'),
    openWork: identity && data.openWork?.head === data.headRefOid && integer(data.openWork.count) ? fact(data.openWork.count) : unknown('head-bound open-work inventory unavailable'),
    servedHead: servedValid ? fact({ head: served.data.head, matches: served.data.head === data.headRefOid, healthy: served.data.healthy, basis: 'independently supplied evidence; provenance not authenticated by this report' }) : unknown(served.error || 'independent exact served repository/target/head evidence unavailable'),
    acceptance: unknown('source checks are not deployment, merge permission or acceptance'),
  };
}

function identityFacts(input, home, asOf) {
  const value = evidence(input, 'identity', home, asOf);
  if (value.error) return { comparison: unknown(value.error), credentialIdentity: unknown('no credential preflight performed') };
  const { expected, observed, basis } = value.data;
  const actor = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9-]{0,79}(?:\[bot\])?$/.test(v);
  const email = v => typeof v === 'string' && v.length <= 160 && /^[A-Za-z0-9.+_-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(v);
  const valid = object(expected) && object(observed) && actor(expected.actor) && actor(observed.actor) && email(expected.email) && email(observed.email) && ['app-owner-read', 'pr-author', 'commit-author', 'supplied-snapshot'].includes(basis);
  return {
    comparison: valid ? fact({ expected: { actor: expected.actor, email: expected.email }, observed: { actor: observed.actor, email: observed.email }, actorMatches: expected.actor === observed.actor, emailMatches: expected.email === observed.email, basis }) : unknown('observed/expected identity facts incomplete or invalid'),
    credentialIdentity: unknown('author or supplied observations do not prove current credentials; existing App token owner remains external'),
    authority: unknown('identity facts confer no publication, comment or merge authority'),
  };
}

export function reportSkill(mode, input, { home, asOf }) {
  if (!MODES.includes(mode) || !homePath(home) || !timestamp(asOf)) throw new Error('usage');
  const base = { schema: 'fmqd-skill-report.v1', integrationTag: 'fm-quarterdeck', skill: `fmqd-${mode}`, asOf, posture: 'snapshot-only; report-first; no actions' };
  if (!object(input) || input.schema !== 'fmqd-skill-input.v1') return { ...base, evidence: unknown('input unavailable or unsupported schema'), ...(mode === 'restart-ready' ? { stowSafety: unknown('not-verified: no structured machine-readable stow checkpoint exists') } : {}) };
  const fleet = fleetEvidence(input, home, asOf);
  if (mode === 'fleet-health') return { ...base, crew: crewRows(fleet, asOf), oldestCaptainCall: oldestCall(fleet, asOf), ...resourceFacts(input, home, asOf), coverage: unknown('selected snapshot only; no endpoint or other-home sweep, no fleet all-clear') };
  if (mode === 'cleanup-sweep') {
    const crew = crewRows(fleet, asOf);
    return { ...base, inventory: crew.status === 'OBSERVED' ? fact(crew.value.map(row => ({ id: row.id, current: row.current, eligibility: unknown('inventory only; landing, exclusive ownership and cleanup authority not verified') }))) : crew,
      dryRunOwner: { status: 'UNAVAILABLE', reason: 'no supported read-only teardown dry-run contract supplied; teardown is never invoked' },
      refusal: 'no cleanup eligibility derived from idle, reachability, branch presence or caller flags; all resources retained' };
  }
  if (mode === 'pr-readiness') return { ...base, ...prFacts(input, home, asOf) };
  if (mode === 'pr-identity-guard') return { ...base, ...identityFacts(input, home, asOf) };
  const receipt = evidence(input, 'receipt', home, asOf);
  const blockers = evidence(input, 'restart', home, asOf);
  const allowed = ['uncommitted-work', 'unpublished-work', 'open-decision', 'unacknowledged-note', 'unknown-owner'];
  return { ...base,
    stowSafety: unknown('not-verified: stock Firstmate has no structured machine-readable stow checkpoint; prose receipts cannot establish safety'),
    receipt: !receipt.error && homePath(receipt.data.newestReceiptPath) ? fact({ path: receipt.data.newestReceiptPath, informationalOnly: true, basis: 'caller-selected newest receipt path; never opened or parsed' }) : unknown(receipt.error || 'receipt path unavailable'),
    blockers: !blockers.error && Array.isArray(blockers.data.blockers) && blockers.data.blockers.length <= MAX_ROWS && blockers.data.blockers.every(v => allowed.includes(v)) ? fact(blockers.data.blockers) : unknown(blockers.error || 'structured concrete blockers unavailable'),
    afterRestartChecklist: ['Re-establish the selected home and current role from existing owners.', 'Read current crew state and durable task records; do not use the last event as current state.', 'Verify exact source and separately supplied served-head evidence.', 'Reconcile receipt and resumption evidence through existing Firstmate owners under separate authority; stow safety remains unverified.'],
  };
}

async function main(args) {
  if (args.length !== 5 || !MODES.includes(args[0]) || args[1] !== '--home' || args[3] !== '--as-of' || !homePath(args[2]) || !timestamp(args[4])) {
    process.stderr.write('Usage: quarterdeck-skill-report.mjs <fleet-health|cleanup-sweep|pr-readiness|pr-identity-guard|restart-ready> --home /absolute/selected/firstmate --as-of <UTC-ISO-time> < snapshot.json\n');
    process.exitCode = 2;
    return;
  }
  try {
    let bytes = 0;
    const chunks = [];
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) throw new Error('bound');
      chunks.push(chunk);
    }
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    process.stdout.write(`${JSON.stringify(reportSkill(args[0], input, { home: args[2], asOf: args[4] }), null, 2)}\n`);
  } catch {
    process.stderr.write('REFUSED: invalid or oversized snapshot input; no input diagnostics emitted\n');
    process.exitCode = 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
