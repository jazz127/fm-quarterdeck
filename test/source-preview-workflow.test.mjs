import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/source-preview.yml', import.meta.url), 'utf8');

test('CI selects and persists the same stable browser before npm test and the browser gate', (t) => {
  const selection = workflow.match(/      - name: Select browser for all behavioral checks\n        run: \|\n([\s\S]*?)(?=      - name:)/);
  assert.ok(selection, 'browser selection is its own step');
  assert.ok(selection.index < workflow.indexOf('run: npm test\n'), 'Node browser tests receive the selection too');
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
