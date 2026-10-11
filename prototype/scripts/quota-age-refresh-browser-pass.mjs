// Exact-head, account-free desktop/phone acceptance through one isolated axi browser.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { createQuotaReader } from '../quota.js';
import { waitForBrowserPort, cleanupBrowserProfile } from './browser-harness.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'quota-age-'));
const profile = path.join(temp, 'profile');
await mkdir(profile);
let clock = Date.now(), refreshed = clock, calls = 0, mode = 'fresh';
const run = async () => {
  calls++;
  if (mode === 'fail') throw new Error('Synthetic unavailable refresh');
  if (mode === 'fresh') refreshed = clock;
  return JSON.stringify({ schemaVersion: 6, generatedAt: new Date(clock).toISOString(), providers: [{
    provider: 'codex', state: { status: 'fresh', reused: mode === 'reuse', refreshedAt: new Date(refreshed).toISOString() },
    quotaSemantics: { status: 'known', effectiveAvailability: [{ scope: 'all_models', status: 'known', effectivePercentRemaining: 42, boundedBy: ['session'] }] },
    windows: [{ id: 'session', label: 'Session', kind: 'session', percentRemaining: 42 }],
  }] });
};
let reader = createQuotaReader({ run, now: () => clock, maxAge: '5m' });
const server = createServer({}, { quotaReader: () => reader(),
  costReader: async () => ({ azure: { status: 'unavailable' }, github: { status: 'unavailable' } }),
  lanesReader: async () => ({ lanes: [], transcript: { sessions: [], warnings: [] } }),
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let spawnError, diagnostics = '';
chrome.on('error', error => { spawnError = error; });
chrome.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
const env = { ...process.env, CHROME_DEVTOOLS_AXI_SESSION: `quota-age-${process.pid}`, CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: '60000' };
for (const key of ['CHROME_DEVTOOLS_AXI_AUTO_CONNECT', 'CHROME_DEVTOOLS_AXI_MCP_SERVER_URL']) delete env[key];
const exec = promisify(execFile);
const browser = async (...args) => (await exec('chrome-devtools-axi', args, { env, timeout: 40000, maxBuffer: 1024 * 1024 })).stdout;
const evaluate = async js => {
  const output = await browser('eval', js);
  assert.doesNotMatch(output, /isError":\s*true|Error:|Exception:/);
  return output;
};
const until = condition => evaluate(`async () => { for(let i=0;i<250;i++){if(${condition})return 'PASS';await new Promise(r=>setTimeout(r,100));}throw Error('quota condition timeout'); }`);
const setClock = async value => { clock = value; await evaluate(`() => { Date.now = () => ${clock}; return 'clock set'; }`); };
const deadline = setTimeout(() => { console.error('Quota age acceptance deadline exceeded'); process.exit(1); }, 240000);
try {
  const port = await waitForBrowserPort(chrome, profile, { spawnError: () => spawnError, diagnostics: () => diagnostics });
  env.CHROME_DEVTOOLS_AXI_BROWSER_URL = `http://127.0.0.1:${port}`;
  for (const [width, height, surface] of [[1280, 900, '#sidebar-quota'], [390, 844, '#mobile-quota-sheet']]) {
    mode = 'fresh'; clock += 300000;
    await browser('resize', String(width), String(height));
    await browser('newpage', `http://127.0.0.1:${server.address().port}/#quota`);
    await until(`document.querySelector('#quota-providers .quota-card') && !document.querySelector('#quota-providers .quota-staleness')`);
    if (width < 720) await evaluate(`() => { document.querySelector('.mobile-dock-quota').click(); return 'opened'; }`);
    await setClock(clock);
    let before = calls;
    await setClock(clock + 300001);
    await until(`document.querySelector('#quota-providers .quota-reused') === null && !document.querySelector('#quota-providers .quota-staleness')`);
    // The existing age ticker must make actual server/source demand without dashboard polling.
    for (let i = 0; i < 200 && calls === before; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(calls, before + 1, 'five-minute demand executes the existing source reader once');
    const successful = refreshed;
    mode = 'fail';
    await setClock(successful + 900000);
    await until(`document.querySelector('${surface} .quota-staleness')?.textContent.includes('15m') && document.querySelector('#quota-state').textContent.includes('refresh unavailable')`);
    await evaluate(`() => { const e=document.querySelector('${surface} .quota-staleness'); if(e.classList.contains('quota-overdue'))throw Error('exactly fifteen is overdue'); return 'boundary amber'; }`);
    await setClock(successful + 900001);
    await until(`document.querySelector('${surface} .quota-overdue')`);
    await evaluate(`() => { const e=document.querySelector('${surface} .quota-overdue'), r=e.getBoundingClientRect(); if(getComputedStyle(e).color!=='rgb(171, 53, 67)' || !e.textContent.includes('stale') || r.width<=0 || r.height<=0 || r.right>innerWidth)throw Error('red stale age is not visible'); return 'visible red stale age'; }`);
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      await browser('screenshot', path.join(process.env.SCREENSHOT_DIR, `quota-overdue-${width}.png`));
    }
    // A new response with old provider data must retain its age, even after a successful read.
    mode = 'reuse'; before = calls;
    await setClock(successful + 1200001);
    await until(`document.querySelector('${surface} .quota-overdue')?.textContent.includes('20m') && !document.querySelector('#quota-state').textContent.includes('refresh unavailable')`);
    assert.equal(calls, before + 1);
    mode = 'fresh'; before = calls;
    await setClock(clock + 300001);
    await until(`!document.querySelector('${surface} .quota-staleness') && !document.querySelector('#quota-providers .quota-staleness')`);
    assert.equal(calls, before + 1, 'recovery refreshes authoritative provider data');
    // A second visible-demand event at the same clock must not schedule another source execution.
    await evaluate(`() => { document.dispatchEvent(new Event('visibilitychange')); document.dispatchEvent(new Event('visibilitychange')); return 'visibility events'; }`);
    assert.equal(calls, before + 1);
    await browser('closepage', '1');
  }
  mode = 'fail'; reader = createQuotaReader({ run, now: () => clock, maxAge: '5m' });
  await browser('newpage', `http://127.0.0.1:${server.address().port}/#quota`);
  await until(`document.querySelector('#quota-providers').textContent.includes('Quota unavailable')`);
  console.log('Exact-head desktop/phone age boundary, visible red stale age, five-minute source execution, failure, cached old data, recovery and unavailable acceptance passed');
} finally {
  clearTimeout(deadline);
  await browser('stop').catch(() => {});
  chrome.kill('SIGTERM');
  await cleanupBrowserProfile(chrome, profile);
  await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
