import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import vm from 'node:vm';

import { createLatestAssertion } from '../prototype/scripts/latest-assertions.mjs';
import { workflowModel } from './helpers/declarative.mjs';
const pkg = JSON.parse(readFileSync(new URL('../prototype/package.json', import.meta.url), 'utf8'));
const workflow = workflowModel();
const suites = ['hardening', 'mixed-lane', 'lanes-first-paint', 'last-viewed', 'latest', 'compact-messages', 'kind-navigation', 'message-classification', 'review-annotation-format', 'authorship', 'primary-input', 'captain-call-live', 'notifications'];
const defaultSuites = suites.filter(name => name !== 'latest');
const optInArgv = pkg.scripts['test:browser:quarantine-native-bottom'].split(' ').slice(2);
const contexts = ['post-pointer/touch', 'after-PageUp/Latest-click'];
function fixture(argv = [], bottom = 0, failedCompanion = -1, { lastBottom = failedCompanion === 2 ? 850 : 740, dockTop = 780, dockHeight = 64 } = {}) {
  const output = [], probes = [];
  const nodes = {
    '#jump-to-latest-floating': { hidden: failedCompanion !== 0 },
    '#transcript-newer': { disabled: failedCompanion !== 1 },
    '#messages': {
      getBoundingClientRect: () => ({ bottom: 800 }),
      querySelector: selector => selector === 'article.message:last-child' ? { getBoundingClientRect: () => ({ bottom: lastBottom }) } : null,
    },
    '#mobile-dock': { getBoundingClientRect: () => ({ height: dockHeight, top: dockTop }) },
  };
  const atLatest = createLatestAssertion({
    distance: async () => { probes.push('distance'); return bottom; },
    evaluate: async expression => {
      probes.push(expression);
      return vm.runInNewContext(expression, { document: { querySelector: selector => nodes[selector] } });
    },
    includeNativeBottom: argv.includes('--include-quarantined-native-bottom'),
    log: line => output.push(line), width: 390, height: 844,
  });
  return { atLatest, output, probes };
}

for (const context of contexts) {
  test(`direct Latest invocation without opt-in retains ${context} exclusion behavior`, async () => {
    const f = fixture([], 120);
    await f.atLatest({ quarantineNativeBottom: context });
    assert.equal(f.probes.length, 3, 'all hidden/page/row companion assertions still execute');
    assert.ok(!f.probes.includes('distance'));
    assert.ok(f.output[0].includes(`CI-Q3 ${context} native-bottom assertion EXCLUDED;`));
    assert.match(f.output[0], /issues\/83.*not native acceptance/);
    assert.doesNotMatch(f.output.join('\n'), /passed/);
    await assert.rejects(f.atLatest(), /Latest reaches the native scroll bottom/, 'ordinary callers still enforce native bottom');
  });

  test(`explicit opt-in executes ${context} unchanged assertion and propagates failure`, async () => {
    const f = fixture(optInArgv, 2);
    await assert.rejects(f.atLatest({ quarantineNativeBottom: context }), {
      code: 'ERR_ASSERTION', message: 'Latest reaches the native scroll bottom',
    });
    assert.deepEqual(f.probes, ['distance']);
    assert.deepEqual(f.output, []);
    const passing = fixture(optInArgv, 1);
    await passing.atLatest({ quarantineNativeBottom: context });
    assert.equal(passing.probes.length, 4);
    assert.deepEqual(passing.output, []);
  });

  test(`${context} hidden/page/row companion failures remain failures with and without opt-in`, async () => {
    for (const argv of [[], optInArgv]) {
      for (const companion of [0, 1, 2]) {
        const f = fixture(argv, 0, companion);
        await assert.rejects(f.atLatest({ quarantineNativeBottom: context }), { code: 'ERR_ASSERTION' });
        assert.equal(f.probes.filter(probe => probe !== 'distance').length, companion + 1);
      }
    }
  });
}

test('direct Latest invocation without opt-in retains distinct caller exclusions', async () => {
  const f = fixture([], 120);
  for (const context of contexts) await f.atLatest({ quarantineNativeBottom: context });
  assert.equal(f.output.length, 2);
  assert.notEqual(f.output[0], f.output[1]);
  assert.doesNotMatch(f.output.join('\n'), /passed/);
});

test('Latest requires the last row to clear both feed and visible dock', async () => {
  for (const geometry of [{ lastBottom: 790 }, { lastBottom: 810, dockTop: 820 }]) {
    await assert.rejects(fixture([], 0, -1, geometry).atLatest(), /last original row clears feed and dock/);
  }
  await fixture([], 0, -1, { lastBottom: 800, dockTop: 800 }).atLatest();
  await fixture([], 0, -1, { dockHeight: 0, dockTop: 600 }).atLatest();
});

test('opt-in enables native bottom and companions for ordinary and quarantined checks', async () => {
  for (const context of [undefined, ...contexts]) {
    const options = context ? { quarantineNativeBottom: context } : undefined;
    const passing = fixture(optInArgv, 1);
    await passing.atLatest(options);
    assert.equal(passing.probes.length, 4);
    assert.deepEqual(passing.output, []);
    await assert.rejects(fixture(optInArgv, 2).atLatest(options), /Latest reaches the native scroll bottom/);
    for (const companion of [0, 1, 2]) {
      await assert.rejects(fixture(optInArgv, 0, companion).atLatest(options), { code: 'ERR_ASSERTION' });
    }
  }
});

// Substitute only the node process for shell entry-point probes, never launch a browser.
function entryPoint(script, failedScript = '') {
  return spawnSync('/bin/bash', ['-c', `node() { printf 'probe:%s\\n' "$*"; [ "$1" != "$FAILED_SCRIPT" ]; }\n${script}`], {
    env: { FAILED_SCRIPT: failedScript }, encoding: 'utf8',
  });
}

test('default gate explicitly excludes whole Latest and invokes every other suite in order', () => {
  const result = entryPoint(pkg.scripts['test:browser']);
  assert.equal(result.status, 0, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.match(lines[0], /whole Latest browser pass EXCLUDED.*opt-in.*not native acceptance/);
  assert.doesNotMatch(result.stdout, /passed/);
  assert.deepEqual(lines.slice(1), defaultSuites.map(name => `probe:scripts/${name}-browser-pass.mjs`));
  assert.ok(!lines.some(line => line.startsWith('probe:scripts/latest-browser-pass.mjs')));
});

test('unchanged opt-in entry invokes whole Latest with native assertions enabled and propagates process failure', () => {
  const script = pkg.scripts['test:browser:quarantine-native-bottom'];
  for (const failed of ['', 'scripts/latest-browser-pass.mjs']) {
    const result = entryPoint(script, failed);
    assert.equal(result.status, failed ? 1 : 0, result.stderr);
    assert.equal(result.stdout, 'probe:scripts/latest-browser-pass.mjs --include-quarantined-native-bottom\n');
    assert.doesNotMatch(result.stdout, /EXCLUDED|passed/);
  }
});

test('default gate still propagates unrelated suite failures', () => {
  const result = entryPoint(pkg.scripts['test:browser'], 'scripts/primary-input-browser-pass.mjs');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /whole Latest browser pass EXCLUDED/);
  assert.match(result.stdout, /probe:scripts\/primary-input-browser-pass.mjs/);
  assert.doesNotMatch(result.stdout, /probe:scripts\/(captain-call-live|notifications)-browser-pass.mjs/);
});

test('CI opt-in is explicit dispatch only, and its failure fails the advisory job', () => {
  const input = workflow.on.workflow_dispatch.inputs.latest_native_bottom;
  assert.equal(input.type, 'boolean');
  assert.equal(input.default, false);
  const steps = workflow.jobs.browser.steps;
  const native = steps.find(step => step.id === 'native_bottom');
  const evaluate = (expression, state) => {
    if (expression === undefined) return true;
    const value = expression.trim();
    return vm.runInNewContext(value.startsWith('${{') ? value.slice(3, -2) : value, state);
  };
  for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
    for (const optedIn of [false, true]) {
      assert.equal(evaluate(native.if, { github: { event_name: event }, inputs: { latest_native_bottom: optedIn } }), event === 'workflow_dispatch' && optedIn);
    }
  }
  assert.equal(native['continue-on-error'], true);
  const invocation = spawnSync('/bin/bash', ['-e', '-c', `npm() { printf '%s\\n' "$*"; }\n${native.run}`], { encoding: 'utf8' });
  assert.equal(invocation.status, 0, invocation.stderr);
  assert.equal(invocation.stdout, 'run test:browser:quarantine-native-bottom\n');
  assert.equal(native['working-directory'], 'prototype');
  const reportStep = steps.find(step => step.name === 'Report advisory failures');
  const report = reportStep.run;
  for (const [integration, chromium, native, expected] of [
    ['success', 'success', 'skipped', 0], ['success', 'success', 'success', 0],
    ['success', 'success', 'failure', 1], ['failure', 'success', 'skipped', 1],
    ['success', 'failure', 'skipped', 1],
  ]) {
    const state = { steps: { integration: { outcome: integration }, chromium: { outcome: chromium }, native_bottom: { outcome: native } },
      always: () => true, success: () => expected === 0 };
    assert.equal(evaluate(reportStep.if, state), true, 'reporting runs even after a failed advisory check');
    const env = Object.fromEntries(Object.entries(reportStep.env).map(([name, expression]) => [name, String(evaluate(expression, state))]));
    const result = spawnSync('/bin/bash', ['-e', '-c', report], {
      env,
    });
    assert.equal(result.status, expected, `${integration}/${chromium}/${native}`);
  }
});
