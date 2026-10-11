import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { workflowModel } from './helpers/declarative.mjs';

const workflow = workflowModel();

test('CI selects and persists the same stable browser in the advisory job before process tests and the browser gate', (t) => {
  const steps = workflow.jobs.browser.steps;
  const selection = steps.find(step => step.name === 'Select browser for all behavioral checks');
  assert.ok(selection, 'browser selection is its own step');
  for (const run of ['npm run test:integration', 'npm run test:browser']) {
    const consumer = steps.find(step => step.run === run);
    assert.ok(consumer);
    assert.ok(steps.indexOf(selection) < steps.indexOf(consumer), 'behavioral checks receive browser selection');
    assert.equal(consumer['working-directory'], 'prototype');
  }
  assert.equal(workflow.jobs.browser.env.CHROMIUM, undefined);
  for (const step of steps) assert.equal(step.env?.CHROMIUM, undefined);
  const script = selection.run;
  const dir = mkdtempSync(path.join(tmpdir(), 'quarterdeck-browser-selection-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const browser = (name) => {
    const file = path.join(dir, name);
    writeFileSync(file, '#!/bin/sh\necho "fixture browser"\n');
    chmodSync(file, 0o755);
  };
  browser('chromium');
  browser('google-chrome');
  const envFile = path.join(dir, 'github-env');
  const select = () => {
    writeFileSync(envFile, '');
    execFileSync('/bin/bash', ['-e', '-c', script], { env: { PATH: dir, GITHUB_ENV: envFile }, stdio: 'pipe' });
    return readFileSync(envFile, 'utf8');
  };
  assert.equal(select(), `CHROMIUM=${dir}/google-chrome\n`, 'stable Chrome wins even when Chromium is present');
  for (const run of ['npm run test:integration', 'npm run test:browser']) {
    const step = steps.find(step => step.run === run);
    const observed = execFileSync('/bin/bash', ['-e', '-c', `npm() { printf '%s\\n' "$CHROMIUM"; }\n${step.run}`], {
      encoding: 'utf8', env: { PATH: dir, CHROMIUM: `${dir}/google-chrome`, GITHUB_ENV: envFile },
    });
    assert.equal(observed, `${dir}/google-chrome\n`, 'both behavioral consumers retain the persisted browser');
  }
  rmSync(path.join(dir, 'google-chrome'));
  assert.equal(select(), `CHROMIUM=${dir}/chromium\n`, 'Chromium remains a supported fallback');
  rmSync(path.join(dir, 'chromium'));
  assert.throws(select, 'missing browsers fail the gate rather than skipping geometry coverage');
});


test('CI runs once per PR and keeps the required validate job browser-free', () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push', 'workflow_dispatch']);
  assert.deepEqual(workflow.on.push.branches, ['main']);
  const steps = workflow.jobs.validate.steps;
  assert.equal(steps.some(step => step.run === 'npm run test:ci' && step['working-directory'] === 'prototype'), true);
  const observed = execFileSync('/bin/bash', ['-e', '-c', `
    npm() { printf 'npm %s\n' "$*"; }
    node() { printf 'node %s\n' "$*"; }
    python3() { printf 'python3 %s\n' "$*"; }
    ${steps.filter(step => step.run).map(step => step.run).join('\n')}
  `], { encoding: 'utf8' }).trim().split('\n');
  assert.deepEqual(observed, [
    'npm ci --ignore-scripts --no-audit --no-fund', 'npm run test:ci',
    'python3 -m unittest discover -s expenses', 'node --test ' + readdirSync(new URL('./', import.meta.url)).filter(name => name.endsWith('.test.mjs')).sort().map(name => `test/${name}`).join(' '),
    'python3 -m unittest discover -s test -p test_*.py',
    'python3 scripts/check-source-syntax.py', 'python3 scripts/check-product-boundary.py',
  ]);
  for (const id of ['integration', 'chromium']) {
    assert.equal(workflow.jobs.browser.steps.find(step => step.id === id)['continue-on-error'], true);
  }
});

test('explicit CI selections cover every npm test file exactly once', () => {
  const selection = JSON.parse(readFileSync(new URL('../prototype/scripts/test-selection.json', import.meta.url)));
  const actual = readdirSync(new URL('../prototype/test/', import.meta.url))
    .filter(name => /\.test\.(js|mjs)$/.test(name)).map(name => `test/${name}`).sort();
  const selected = [...selection.deterministic, ...selection.integration];
  assert.equal(new Set(selected).size, selected.length);
  assert.deepEqual(selected.sort(), actual, 'classify new suites explicitly so CI cannot silently lose coverage');
  for (const file of ['preview-lifecycle.test.js', 'browser-harness.test.mjs', 'chat-feed-min-width.test.js', 'synthetic-history.test.js', 'server.test.js']) {
    assert.ok(selection.integration.includes(`test/${file}`), file);
  }
});
