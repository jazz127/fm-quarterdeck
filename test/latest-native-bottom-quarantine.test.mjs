import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const source = readFileSync(new URL('../prototype/scripts/latest-browser-pass.mjs', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../prototype/package.json', import.meta.url), 'utf8'));
const workflow = readFileSync(new URL('../.github/workflows/source-preview.yml', import.meta.url), 'utf8');
const declaration = source.match(/    const atLatest = async [\s\S]*?\n    };/)[0];
const flag = source.match(/const includeNativeBottom = ([^;]+);/)[1];

// Execute the production function and CLI selection, without launching Chromium.
function fixture(argv = [], bottom = 0, companion = true) {
  const output = [], probes = [];
  const atLatest = new Function('assert', 'distance', 'evaluate', 'process', 'console', 'width', 'height',
    `const includeNativeBottom = ${flag};\n${declaration}\nreturn atLatest;`)(
    assert, async () => { probes.push('distance'); return bottom; },
    async expression => { probes.push(expression); return companion; },
    { argv }, { log: line => output.push(line) }, 390, 844,
  );
  return { atLatest, output, probes };
}

test('default excludes only the named caller distance assertion and reports exclusion truthfully', async () => {
  const f = fixture([], 120);
  await f.atLatest({ quarantineNativeBottom: true });
  assert.equal(f.probes.length, 3, 'all hidden/page/row companion assertions still execute');
  assert.ok(!f.probes.includes('distance'));
  assert.match(f.output[0], /CI-Q3.*EXCLUDED.*issues\/83.*not native acceptance/);
  assert.doesNotMatch(f.output.join('\n'), /passed/);
  await assert.rejects(f.atLatest(), /Latest reaches the native scroll bottom/, 'ordinary callers still enforce native bottom');
});

test('explicit opt-in executes the unchanged assertion and propagates failure', async () => {
  const f = fixture(['--include-quarantined-native-bottom'], 2);
  await assert.rejects(f.atLatest({ quarantineNativeBottom: true }), {
    code: 'ERR_ASSERTION', message: 'Latest reaches the native scroll bottom',
  });
  assert.deepEqual(f.probes, ['distance']);
  assert.deepEqual(f.output, []);
  const passing = fixture(['--include-quarantined-native-bottom'], 1);
  await passing.atLatest({ quarantineNativeBottom: true });
  assert.equal(passing.probes.length, 4);
  assert.deepEqual(passing.output, []);
});

test('companion failures remain failures with and without opt-in', async () => {
  for (const argv of [[], ['--include-quarantined-native-bottom']]) {
    await assert.rejects(fixture(argv, 0, false).atLatest({ quarantineNativeBottom: true }), { code: 'ERR_ASSERTION' });
  }
});

test('one post-pointer/touch caller is quarantined; all other Latest contexts and default suites remain', () => {
  assert.equal((source.match(/await atLatest\(\{ quarantineNativeBottom: true \}\);/g) || []).length, 1);
  assert.equal((source.match(/await atLatest\(\);/g) || []).length, 7);
  assert.match(source, /assert\.ok\(await distance\(\) <= 1, "Latest reaches the native scroll bottom"\);/);
  assert.match(source, /Input.dispatchTouchEvent", \{ type: "touchStart", touchPoints: \[pill\] \}\);\n      await command\("Input.dispatchTouchEvent", \{ type: "touchEnd", touchPoints: \[\] \}\);/);
  assert.match(source, /Input.dispatchMouseEvent", \{ type: "mouseReleased"[\s\S]*?await until\("document.querySelector\('#jump-to-latest-floating'\).hidden"\);\n    \/\/[^\n]+\n    await atLatest\(\{ quarantineNativeBottom: true \}\);/);
  for (const retained of ['touchMove', 'mouseWheel', 'PageUp', 'keyboard focus is visible', 'selected source unchanged', 'fleet and kind filters unchanged', 'all original records remain reachable', 'latest loaded page selected', 'last original row clears feed and dock']) {
    assert.ok(source.includes(retained), retained);
  }
  assert.doesNotMatch(source, /catch\s*\(/, 'assertion failures cannot be caught and passed');
  const suites = ['hardening', 'mixed-lane', 'lanes-first-paint', 'last-viewed', 'latest', 'compact-messages', 'kind-navigation', 'message-classification', 'review-annotation-format', 'authorship', 'primary-input', 'captain-call-live', 'notifications'];
  assert.equal(pkg.scripts['test:browser'], suites.map(name => `node scripts/${name}-browser-pass.mjs`).join(' && '));
  assert.equal(pkg.scripts['test:browser:quarantine-native-bottom'], 'node scripts/latest-browser-pass.mjs --include-quarantined-native-bottom');
});

test('CI opt-in is explicit dispatch only, and its failure fails the advisory job', () => {
  assert.match(workflow, /latest_native_bottom:[\s\S]*?type: boolean\n        default: false/);
  assert.match(workflow, /id: native_bottom\n        if: \$\{\{ github.event_name == 'workflow_dispatch' && inputs.latest_native_bottom \}\}\n        continue-on-error: true\n        run: npm run test:browser:quarantine-native-bottom/);
  assert.match(workflow, /NATIVE_BOTTOM: \$\{\{ steps.native_bottom.outcome \}\}/);
  const report = workflow.split('      - name: Report advisory failures')[1].split('        run: |\n')[1].replace(/^          /gm, '');
  for (const [integration, chromium, native, expected] of [
    ['success', 'success', 'skipped', 0], ['success', 'success', 'success', 0],
    ['success', 'success', 'failure', 1], ['failure', 'success', 'skipped', 1],
    ['success', 'failure', 'skipped', 1],
  ]) {
    const result = spawnSync('/bin/bash', ['-e', '-c', report], {
      env: { INTEGRATION: integration, CHROMIUM_GATE: chromium, NATIVE_BOTTOM: native },
    });
    assert.equal(result.status, expected, `${integration}/${chromium}/${native}`);
  }
});
