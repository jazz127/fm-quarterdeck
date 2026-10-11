// One owned-page geometry pass. No Clear/Send activation or delivery claim.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { acquireFixturePage, waitForBrowserPort, cleanupBrowserProfile } from './browser-harness.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'clean committed candidate');
const temp = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-review-layout-'));
const proof = process.env.SCREENSHOT_DIR || temp;
await mkdir(proof, { recursive: true });
const profile = path.join(temp, 'profile');
await mkdir(profile);
const env = { ...process.env, HOME: temp, CHROME_DEVTOOLS_AXI_SESSION: `review-layout-${process.pid}`,
  CHROME_DEVTOOLS_AXI_HEADED: '0', CHROME_DEVTOOLS_AXI_USER_DATA_DIR: profile };
for (const key of ['CHROME_DEVTOOLS_AXI_AUTO_CONNECT', 'CHROME_DEVTOOLS_AXI_BROWSER_URL', 'CHROME_DEVTOOLS_AXI_MCP_SERVER_URL']) delete env[key];
const chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu',
  '--disable-dev-shm-usage', '--no-first-run', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
{ stdio: ['ignore', 'ignore', 'pipe'] });
let spawnError, diagnostics = '';
chrome.on('error', error => { spawnError = error; });
chrome.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
const exec = promisify(execFile);
const evidence = [];
const browser = async (...args) => {
  try {
    const { stdout } = await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 1024 * 1024 });
    evidence.push({ command: args[0], output: stdout });
    if (/isError":\s*true|Error:|Exception:/.test(stdout)) throw Error(stdout);
    return stdout;
  } catch (error) {
    evidence.push({ command: args[0], failure: error.stdout || String(error) });
    throw error;
  }
};
const app = createServer({ FM_QUARTERDECK_STATE_PATH: path.join(temp, 'state.json') }, {
  quotaReader: async () => ({ providers: [], stale: false, error: 'Offline fixture' }),
  costReader: async () => ({ azure: { status: 'unavailable' }, github: { status: 'unavailable' } }),
  lanesReader: async () => ({ lanes: [], transcript: { sessions: [], warnings: [] } }),
  reviewCount: async () => 0,
  localReviewDeliver: async () => { throw Error('This geometry fixture must never deliver'); },
});
await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${app.address().port}/#lanes`;
try {
  const port = await waitForBrowserPort(chrome, profile, { spawnError: () => spawnError, diagnostics: () => diagnostics });
  env.CHROME_DEVTOOLS_AXI_BROWSER_URL = `http://127.0.0.1:${port}`;
  await acquireFixturePage(browser, url, head);
  await browser('eval', `() => {
    const entry = { prompt: 'Synthetic queued note', selector: '', tag: 'message', text: '', label: 'Message', version: ${JSON.stringify(head)}, route: '#lanes' };
    sessionStorage.setItem('fm-agentos-review-draft-v1', JSON.stringify({ queue: [entry], queueIds: ['synthetic-queued-note'],
      message: 'Synthetic retained draft', open: false, retryBatches: [],
      sent: [{ id: 'synthetic-delivered-note', receiptId: 'local:synthetic-delivered-note', state: 'completed', entries: [entry] }] }));
    location.reload();
  }`);
  await browser('eval', `async () => {
    for (let i=0;i<100;i++) {
      if (window.FM_BOOT_REVISION === ${JSON.stringify(head)} && document.querySelector('#review-message')?.value === 'Synthetic retained draft' && !document.querySelector('#review-send').disabled) {
        window.layoutControls = ['review-clear-messages','review-queue','review-send'].map(id => document.getElementById(id));
        window.layoutDraft = sessionStorage.getItem('fm-agentos-review-draft-v1');
        return 'synthetic fixture ready at exact revision';
      }
      await new Promise(resolve => setTimeout(resolve,100));
    }
    throw Error('fixture readiness timeout');
  }`);
  for (const [width, height] of [[1440, 900], [820, 1180], [390, 844]]) {
    await browser('resize', String(width), String(height));
    await browser('emulate', '--color-scheme', 'light');
    await browser('eval', `async () => {
      document.documentElement.style.colorScheme = 'light';
      if (!document.querySelector('#review-panel').hidden) document.querySelector('#review-close').click();
      if (innerWidth <= 720) { document.querySelector('#review-panel-toggle').click(); document.querySelector('#review-conversation-tab').click(); }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const send = document.querySelector('#review-send'), row = send.parentElement;
      window.messageOrder = [...row.children].map(node => node.id);
      window.messageRight = send.getBoundingClientRect().right;
      if (send.form?.id !== 'review-form' || document.querySelector('#review-queue').form?.id !== 'review-form') throw Error('Message form ownership');
      if (innerWidth <= 720 && Math.abs(window.messageRight - row.getBoundingClientRect().right)>1) throw Error('Message Send right alignment');
      return { width: innerWidth, messageOrder: window.messageOrder, messageRight: window.messageRight };
    }`);
    await browser('screenshot', path.join(proof, `${width}-message.png`));
    await browser('eval', `async () => {
      if (document.querySelector('#review-panel').hidden) document.querySelector('#review-panel-toggle').click();
      if (innerWidth <= 720) document.querySelector('#review-history-tab').click();
      else document.querySelector('#review-sent').open = true;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      return 'Review opened';
    }`);
    for (const scheme of ['light', 'dark']) {
      // Explicit theme override exercises the existing product tokens in both schemes.
      await browser('emulate', '--color-scheme', scheme);
      await browser('eval', `async () => {
        document.documentElement.style.colorScheme = ${JSON.stringify(scheme)};
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const q = id => document.getElementById(id), rect = node => { const r=node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height}; };
        const panel=rect(q('review-panel')), row=rect(q('review-history-actions')), clear=rect(q('review-clear-messages')), send=rect(q('review-send'));
        const ids=[...q('review-history-actions').children].map(node=>node.id);
        const expected=innerWidth<=720 ? ['review-clear-messages','review-send'] : ['review-clear-messages','review-queue','review-send'];
        if (JSON.stringify(ids)!==JSON.stringify(expected)) throw Error('Review order '+ids);
        if (Math.abs(clear.left-row.left)>1 || Math.abs(send.right-row.right)>1 || Math.abs(clear.top-send.top)>1) throw Error('left/right alignment');
        if (innerWidth<=720 && Math.abs(send.right-window.messageRight)>1) throw Error('Message/Review Send alignment');
        if (row.top<q(innerWidth<=720?'review-phone-thread':'review-queued').getBoundingClientRect().bottom-1 || panel.bottom-row.bottom>50) throw Error('actions below history at bottom');
        let previous=0;
        for (const id of ids) {
          const node=q(id), r=rect(node);
          if (r.width<44 || r.height<44 || r.left<panel.left || r.right>panel.right+1 || r.top<panel.top || r.bottom>panel.bottom+1 || r.left<previous-1) throw Error('target/containment/overlap '+id);
          previous=r.right;
          if (document.elementFromPoint((r.left+r.right)/2,(r.top+r.bottom)/2)!==node) throw Error('covered target '+id);
        }
        if (document.documentElement.scrollWidth>innerWidth || q('review-panel').scrollWidth>q('review-panel').clientWidth) throw Error('horizontal overflow');
        const cs=getComputedStyle(q('review-clear-messages')), ss=getComputedStyle(q('review-send'));
        const luminance = color => { const channels=color.match(/[0-9.]+/g).slice(0,3).map(Number).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});return channels[0]*.2126+channels[1]*.7152+channels[2]*.0722; };
        const a=luminance(cs.color), b=luminance(cs.backgroundColor), contrast=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);
        if (contrast<4.5 || cs.backgroundColor===ss.backgroundColor || cs.color===ss.color) throw Error('Clear distinction/contrast '+contrast);
        if (q('review-queue').form?.id!=='review-form') throw Error('Queue form owner');
        for (const [index,id] of ['review-clear-messages','review-queue','review-send'].entries()) if (q(id)!==window.layoutControls[index] || document.querySelectorAll('#'+id).length!==1) throw Error('duplicated/replaced '+id);
        const before=JSON.parse(window.layoutDraft), after=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));
        for (const key of ['queue','queueIds','message','sent','retryBatches']) if(JSON.stringify(before[key])!==JSON.stringify(after[key])) throw Error('changed persisted '+key);
        return { revision:window.FM_BOOT_REVISION,width:innerWidth,scheme:${JSON.stringify(scheme)},ids,panel,row,clear,send,clearColor:cs.color,clearBackground:cs.backgroundColor,contrast };
      }`);
      await browser('screenshot', path.join(proof, `${width}-review-${scheme}.png`));
    }
    await browser('eval', `() => {
      if(innerWidth<=720) document.querySelector('#review-conversation-tab').click(); else document.querySelector('#review-close').click();
      const order=[...document.querySelector('#review-form .review-actions').children].map(node=>node.id);
      if(JSON.stringify(order)!==JSON.stringify(window.messageOrder)) throw Error('Message order changed');
      return 'original Message order restored';
    }`);
  }
  console.log(`PASS ${head}: desktop/tablet/phone Review placement, containment, color/contrast, targets and Message restoration (synthetic geometry only).`);
} finally {
  await writeFile(path.join(proof, 'review-layout-evidence.json'), JSON.stringify({ head, evidence }, null, 2));
  await browser('stop').catch(() => {});
  await cleanupBrowserProfile(chrome, profile);
  await new Promise(resolve => app.close(resolve));
}
