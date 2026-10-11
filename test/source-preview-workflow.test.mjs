import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/source-preview.yml', import.meta.url), 'utf8');

test('CI selects and persists the same stable browser in the advisory job before process tests and the browser gate', (t) => {
  const selection = workflow.match(/      - name: Select browser for all behavioral checks\n        run: \|\n([\s\S]*?)(?=      - name:)/);
  assert.ok(selection, 'browser selection is its own step');
  assert.ok(selection.index < workflow.indexOf('run: npm run test:integration\n'), 'Node browser tests receive the selection too');
  assert.match(workflow, /run: npm run test:browser\n/);
  assert.equal((workflow.match(/CHROMIUM=/g) || []).length, 2, 'one selection and one persisted assignment, not a later override');
  const script = selection[1].replace(/^          /gm, '');
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
  rmSync(path.join(dir, 'google-chrome'));
  assert.equal(select(), `CHROMIUM=${dir}/chromium\n`, 'Chromium remains a supported fallback');
  rmSync(path.join(dir, 'chromium'));
  assert.throws(select, 'missing browsers fail the gate rather than skipping geometry coverage');
});


test('CI runs once per PR and keeps the required validate job browser-free', () => {
  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /push:\n    branches: \[main\]/);
  assert.match(workflow, /workflow_dispatch:/);
  const required = workflow.split('  validate:')[1].split('  browser:')[0];
  assert.match(required, /npm run test:ci/);
  assert.doesNotMatch(required, /CHROMIUM|test:browser|test:integration|chrome-devtools/);
  for (const command of ['unittest discover -s expenses', 'node --test test/*.test.mjs', "unittest discover -s test -p 'test_*.py'", 'check-source-syntax.py', 'check-product-boundary.py']) {
    assert.ok(required.includes(command), command);
  }
  assert.match(workflow, /id: integration\n        continue-on-error: true/);
  assert.match(workflow, /id: chromium\n        continue-on-error: true/);
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
