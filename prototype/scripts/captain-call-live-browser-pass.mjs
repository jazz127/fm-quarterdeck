// Offline exact-revision acceptance. One isolated axi browser, synthetic snapshot and transcript.
import assert from 'node:assert/strict';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFile, mkdtemp, mkdir, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.js';
import { claudeProjectDirectory } from '../claude-transcript.js';
import { captureKpiGeometry } from './kpi-geometry.mjs';
import { waitForBrowserPort, cleanupBrowserProfile } from './browser-harness.mjs';
const root = path.resolve(import.meta.dirname, '../..');
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim(), '', 'serve a clean committed candidate');
const temp = await mkdtemp(path.join(os.tmpdir(), 'quarterdeck-call-pass-'));
const proof = process.env.SCREENSHOT_DIR || temp;
await mkdir(proof, { recursive: true });
const home = path.join(temp, 'home');
for (const dir of ['bin', 'data', 'state']) await mkdir(path.join(home, dir), { recursive: true });
const config = path.join(temp, 'claude');
const transcriptDir = claudeProjectDirectory(config, home);
await mkdir(transcriptDir, { recursive: true });
await writeFile(path.join(home, 'state/.lock-session'), 'synthetic-main\n');
const transcriptPath = path.join(transcriptDir, 'synthetic-main.jsonl');
const chatRecord = (uuid, text) => `${JSON.stringify({ type: 'assistant', uuid, timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'synthetic-model', content: [{ type: 'text', text }] } })}\n`;
await writeFile(transcriptPath, chatRecord('synthetic-ask-one', '**APPROVAL NEEDED:** Publish the sample notes. Reply "publish" or "wait".') + chatRecord('synthetic-ask-link', 'DECISION NEEDED: Also weigh alpha-call before publishing.'));
const fixturePath = path.join(home, 'snapshot.json');
let raw = JSON.parse(await readFile(new URL('../test/fixtures/bearings/two-calls.json', import.meta.url), 'utf8'));
raw.decisions_open[0].updated_at = new Date(Date.now() - 120000).toISOString();
const alphaFull = `Choose the example-app release window. ${'The staged release limits exposure while validation continues. '.repeat(8)}Recommended: staged — smaller blast radius. Immediate — faster delivery.`;
raw.decisions_open[0].summary = `${alphaFull.slice(0, 96).replace(/\s+$/, '')}…`;
raw.decisions_open.find(row => row.id === 'gamma-credential').summary = 'Provide the gamma sandbox credential…';
raw.contributions.captain.find(row => row.task === 'alpha-call').url = 'https://example.invalid/acme/example-app/pull/42';
raw.contributions.captain.find(row => row.task === 'beta-merge').reason = `Review example-app compatibility. ${'The change is ready for review but older clients need attention. '.repeat(6)}Risk: older clients may require a migration.`;
raw.landed = [
  { id: 'ship-window', what: 'Ship the example-app release…', artifact: 'https://example.invalid/acme/example-app/pull/42', owner: '(main)' },
  { id: 'local-notes', what: 'Notes from the other ledger…', artifact: 'local main', owner: '(main)' },
];
await writeFile(fixturePath, JSON.stringify(raw));
let extraBacklog = "";
const landedBacklog = `- [x] ship-window - Ship the example-app release window (repo: example-app) (done 2026-10-01)
- [x] local-notes - Land the sample notes on local main (repo: sample-notes) (merged 2026-10-02)
`;
const alphaBacklog = () => `# Synthetic backlog ${raw.generated}\n- [ ] alpha-call - ${alphaFull} (repo: example-app)\n${landedBacklog}${extraBacklog}`;
await writeFile(path.join(home, 'data/backlog.md'), alphaBacklog());
await writeFile(path.join(home, 'data/projects.md'), '- synthetic-repository - Offline fixture\n');
const secondmateHome = path.join(temp, 'secondmate');
await mkdir(path.join(secondmateHome, 'data'), { recursive: true });
await writeFile(path.join(secondmateHome, 'data/backlog.md'), '- [ ] sample-work - Synthetic work\n- [ ] sample-call - Synthetic decision (hold-kind: captain)\n');
await writeFile(path.join(home, 'data/secondmates.md'), `- navigator - Synthetic planning (home: ${secondmateHome}; scope: Planning; projects: synthetic-repository; added 2026-01-01)\n`);
const script = path.join(home, 'bin/fm-bearings-snapshot.sh');
await writeFile(script, '#!/bin/sh\ncat "$FM_HOME/snapshot.json"\n');
await chmod(script, 0o755);
await mkdir(path.join(home, '.lavish'), { recursive: true });
const boardPayload = {
  schema: 'fm-bearings-board.v1', home: 'synthetic-home', generated: new Date().toISOString(), prs_live: false,
  captains_call: [
    { key: 'alpha-call', type: 'decision', repo: 'example-app', title: 'Choose the example-app release window', recommend_value: 'staged', options: [
      { value: 'staged', label: 'Staged rollout', hint: 'Limit exposure while checks continue' },
      { value: 'now', label: 'Release now', hint: 'Use the full release window' },
      { value: 'reconcile', label: 'Reconcile', hint: 'Re-check the latest state' },
    ] },
    { key: 'alpha-call', type: 'merge', repo: 'example-app', title: 'Ignore this merge card', risk: 'not used', options: [{ value: 'ship', label: 'Ship from the merge card' }] },
  ],
  underway: [], landed: [], charted: [],
};
await writeFile(path.join(home, '.lavish', 'bearings-board.html'), `<!doctype html><script id="bearings-data" type="application/json">\n${JSON.stringify(boardPayload).replaceAll('<', '\\u003c')}\n</script>\n`);
// Synthetic guarded inbox: records the relayed answer note (thread questions separately); never a real Firstmate home.
const inbox = path.join(home, 'bin/fm-inbox.sh');
await writeFile(inbox, `#!/bin/sh
case "$1" in
  note) case "$3" in quarterdeck-thread:*) printf '%s\\n' "$3" >> "$FM_HOME/thread-attempts"; cat > "$FM_HOME/thread-note.txt"; cp "$FM_HOME/thread-note.txt" "$FM_HOME/thread-$3.txt"; printf '%s' "$3" > "$FM_HOME/thread-request-id"; printf '{"schema":"fm-inbox-note.v1","request_id":"%s","saved":true,"id":"thread-1","announced":true,"outcome":"created"}\\n' "$3"; exit 0 ;; esac
    printf '%s\\n' "$3" >> "$FM_HOME/answer-attempts"; cat > "$FM_HOME/answer-note.txt"; cp "$FM_HOME/answer-note.txt" "$FM_HOME/answer-$3.txt"; [ ! -e "$FM_HOME/fail-answer" ] || exit 1; [ ! -e "$FM_HOME/delay-answer" ] || sleep 5; printf '%s' "$3" > "$FM_HOME/answer-request-id"; printf '{"schema":"fm-inbox-note.v1","request_id":"%s","saved":true,"id":"note-1","announced":true,"outcome":"created"}\\n' "$3" ;;
  receipts)
    node "$FM_HOME/receipts.mjs" ;;
  *) exit 2 ;;
esac
`);
await chmod(inbox, 0o755);
await writeFile(path.join(home, 'receipts.mjs'), `
import { readFile } from 'node:fs/promises';
const read = async name => readFile(process.env.FM_HOME + '/' + name, 'utf8').catch(() => '');
const id = await read('answer-request-id');
const state = await read('receipt-state');
const note = { id: 'note-1', request_id: id };
const data = { schema: 'fm-inbox-receipts.v1', pending: state === 'received' || state === 'replied' ? [] : [note], handled: state === 'received' || state === 'replied' ? [note] : [], replies: state === 'replied' ? [{ id: 'note-1', body: 'Synthetic answer recorded' }] : [] };
const lines = async (name) => (await read(name)).split('\\n').map((line) => line.trim()).filter(Boolean);
const threadIds = await lines('thread-attempts');
const acked = new Set(await lines('thread-acked'));
const repliedIds = new Set(await lines('thread-replied'));
for (let i = 0; i < threadIds.length; i++) {
  const requestId = threadIds[i];
  const body = await read('thread-' + requestId + '.txt');
  if (!body) continue;
  const minute = String(i).padStart(2, '0');
  const note = { id: 'thread-' + (i + 1), request_id: requestId, at: '2026-01-02T10:' + minute + ':00.000Z', body };
  const answered = repliedIds.has(requestId);
  if (answered || acked.has(requestId)) data.handled.push(note);
  else data.pending.push(note);
  if (answered) data.replies.push({ id: note.id, at: '2026-01-02T11:' + minute + ':00.000Z', body: 'This call chooses the synthetic release window.' });
}
console.log(JSON.stringify(data));
`);
const env = { ...process.env, HOME: temp, CHROME_DEVTOOLS_AXI_SESSION: `quarterdeck-call-${process.pid}`, CHROME_DEVTOOLS_AXI_HEADED: '0', CHROME_DEVTOOLS_AXI_USER_DATA_DIR: path.join(temp, 'profile'), CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: '60000' };
for (const name of ['CHROME_DEVTOOLS_AXI_AUTO_CONNECT', 'CHROME_DEVTOOLS_AXI_BROWSER_URL', 'CHROME_DEVTOOLS_AXI_MCP_SERVER_URL']) delete env[name];
// Launch exactly one bounded fixture browser; all page operations go through axi.
// Explicit CDP attachment avoids MCP's implicit Chrome/startup-tab discovery.
const profile = path.join(temp, 'profile');
await mkdir(profile, { recursive: true });
const chrome = spawn(process.env.CHROMIUM || 'chromium', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--no-first-run', ...(process.env.FM_BROWSER_FORCED_COLORS === '1' ? ['--force-high-contrast'] : []), '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
let spawnError, diagnostics = '';
chrome.on('error', error => { spawnError = error; });
chrome.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk.toString()).slice(-2000); });
const exec = promisify(execFile);
const browser = async (...args) => (await exec('chrome-devtools-axi', args, { env, timeout: 45000, maxBuffer: 1024 * 1024 })).stdout;
const results = [];
async function evaluate(js) {
  const output = await browser('eval', js);
  if (/isError":\s*true|Error:|Exception:/.test(output)) throw Error(output);
  results.push(output);
  return output;
}
const until = (condition) => evaluate(`async () => { for(let i=0;i<350;i++){if(${condition})return 'PASS ${condition.replaceAll("'", '').replaceAll('"', '')}';await new Promise(r=>setTimeout(r,100));}throw Error('bounded readiness timeout'); }`);
async function settleReload() {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < 20000) {
    try {
      const output = await browser('eval', `() => (!document.documentElement.dataset.reloadProof && document.querySelector('#call-lifecycle-filter')) ? 'ready' : 'loading'`);
      last = output;
      if (output.includes('ready') && !/isError"\s*:\s*true|Error:|Exception:/.test(output)) return;
    } catch (error) { last = String(error); }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw Error(`reload did not return Captain's Call: ${last}`);
}
const change = async () => {
  raw.generated = new Date().toISOString();
  await writeFile(fixturePath, JSON.stringify(raw));
  // Exercise the filtered watch trigger (not a private record parser or manual API).
  await writeFile(path.join(home, 'data/backlog.md'), alphaBacklog());
};
const server = createServer({ FM_HOME: home, CLAUDE_CONFIG_DIR: config, FM_BEARINGS_MIN_GAP_MS: '15000', FM_QUARTERDECK_STATE_PATH: path.join(temp, 'presentation.json') }, {
  quotaReader: async () => ({ providers: [], stale: false, error: 'Offline fixture' }),
  costReader: async () => ({ azure: { status: 'unavailable' }, github: { status: 'unavailable' } }),
  lanesReader: async () => ({ lanes: [], transcript: { sessions: [], warnings: [] } }),
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const deadline = setTimeout(() => { console.error('Captain Call browser deadline exceeded'); process.exit(1); }, 360000);
try {
  const port = await waitForBrowserPort(chrome, profile, { spawnError: () => spawnError, diagnostics: () => diagnostics });
  env.CHROME_DEVTOOLS_AXI_BROWSER_URL = `http://127.0.0.1:${port}`;
  await browser('newpage', `http://127.0.0.1:${server.address().port}/#overview`);
  await evaluate(`async () => { for(let i=0;i<350;i++){ const ask=document.querySelector('[data-call-key="decision:alpha-call"]'); if(document.querySelectorAll('[data-call-key]').length===4 && document.querySelectorAll('#summary .metric-card').length===3 && ask && ask.textContent.includes('Also asked in chat')) return 'linked ask ready'; await new Promise(r=>setTimeout(r,100)); } const ask=document.querySelector('[data-call-key="decision:alpha-call"]'); throw Error('calls '+document.querySelectorAll('[data-call-key]').length+' linked '+(ask&&!!ask.querySelector('.call-context-ask'))); }`);
  // Transcript cards load and stream without a snapshot write or an AI call.
  for (const scheme of ['light', 'dark']) {
    await browser('emulate', '--color-scheme', scheme);
    for (const width of [1280, 360, 390]) {
      await browser('resize', String(width), '844');
      await evaluate(`() => { const c=document.querySelector('[data-call-type="chat"]'); c.scrollIntoView({block:'center'}); if(!c.innerText.includes('Approval · Chat ask')||c.querySelectorAll('input[type=radio]').length!==2||document.documentElement.scrollWidth>innerWidth||c.scrollWidth>c.clientWidth+1||getComputedStyle(c).borderLeftStyle!=='double')throw Error('chat card identity or geometry'); const head=c.querySelector('header.call-head'); const dismiss=c.querySelector('[data-call-dismiss]'); const park=c.querySelector('[data-call-procrastinate-toggle]'); const chip=c.querySelector('.state-chip'); if(!head.contains(dismiss)||!head.contains(park))throw Error('dismiss and procrastinate are not in the header'); const dr=dismiss.getBoundingClientRect(); const pr=park.getBoundingClientRect(); const cr=chip.getBoundingClientRect(); const right=head.getBoundingClientRect().right; const sameRow=Math.abs(pr.top-dr.top)<=4; if(Math.abs(pr.height-cr.height)>2||Math.abs(dr.height-cr.height)>2||Math.abs(pr.right-right)>16)throw Error('procrastinate is not a top-right badge'); if(sameRow ? pr.left+1<dr.right : (dr.top>pr.bottom || Math.abs(dr.right-right)>16))throw Error('dismiss is not paired with procrastinate'); for(const b of c.querySelectorAll('button')){if(b.closest('.call-head')&&!b.closest('[data-call-procrastinate-menu]'))continue; if(b.getBoundingClientRect().height && b.getBoundingClientRect().height<44)throw Error('chat touch target');} return {chat:true,width:innerWidth,scheme:'${scheme}'}; }`);
      await browser('screenshot', path.join(proof, `captain-chat-${scheme}-${width}.png`));
      await evaluate(`() => { const decision=document.querySelector('[data-call-key="decision:alpha-call"]'); const chat=document.querySelector('[data-call-type="chat"]'); const d=decision.getBoundingClientRect(); const c=chat.getBoundingClientRect(); if(Math.abs(d.left-c.left)>2||Math.abs(d.width-c.width)>2||getComputedStyle(decision).borderLeftWidth!==getComputedStyle(chat).borderLeftWidth)throw Error('chat card does not share the decision card edge'); const row=decision.querySelector('.call-context-ask'); const dt=row.querySelector('dt').getBoundingClientRect(); const dd=row.querySelector('dd').getBoundingClientRect(); if(dd.left>d.left+28||dt.bottom>dd.top+1||document.documentElement.scrollWidth>innerWidth||decision.scrollWidth>decision.clientWidth+1)throw Error('also asked indents the card'); if(decision.querySelector('h3').textContent.includes('…'))throw Error('alpha headline stayed shortened'); return {askLayout:true,width:innerWidth}; }`);
      if (scheme === 'light' && (width === 1280 || width === 390)) await browser('screenshot', path.join(proof, `captain-ask-layout-${width}.png`));
    }
  }
  await browser('emulate', '--color-scheme', 'light');
  await evaluate(`() => { const c=document.querySelector('[data-call-type="chat"]'); c.querySelector('[data-call-dismiss]').click(); if(c.querySelector('[data-call-dismiss-confirm]').hidden||document.activeElement!==c.querySelector('[data-call-dismiss-send]')||c.getAttribute('aria-current'))throw Error('dismiss review/focus/control'); c.querySelector('[data-call-dismiss-cancel]').click(); if(!c.querySelector('[data-call-dismiss-confirm]').hidden)throw Error('cancel dismissal'); c.querySelector('[data-call-dismiss]').click(); return 'dismiss reviewed locally'; }`);
  assert.equal(await readFile(path.join(home, 'answer-note.txt'), 'utf8').catch(() => null), null, 'Dismiss review does not send an inbox note');
  await browser('screenshot', path.join(proof, 'captain-chat-dismiss-confirm-390.png'));
  await evaluate(`() => { document.querySelector('[data-call-dismiss-send]').click(); return 'confirmed dismissal'; }`);
  await until(`!document.querySelector('[data-call-type="chat"]')`);
  await evaluate(`() => { if(!document.activeElement.matches('.primary-tab[data-view="overview"], [data-mobile-view="overview"]'))throw Error('dismiss focus destination'); return 'dismiss focus retained on Overview'; }`);
  assert.equal(await readFile(path.join(home, 'answer-note.txt'), 'utf8').catch(() => null), null, 'Dismiss never sends an inbox note');
  await appendFile(transcriptPath, chatRecord('synthetic-ask-two', 'ACTION NEEDED: Rotate the sample token. Reply "rotated".'));
  await until(`!!document.querySelector('[data-call-type="chat"]')`);
  await evaluate(`() => { const c=document.querySelector('[data-call-type="chat"]'); if(!c.innerText.includes('Rotate the sample token'))throw Error('appended transcript ask missed'); const radio=c.querySelector('input[value="reply-1"]'); radio.checked=true; radio.dispatchEvent(new Event('change',{bubbles:true})); c.querySelector('.call-answer-queue').click(); if(c.querySelector('[data-call-answer-confirm]').hidden||c.querySelector('[data-call-answer-preview]').textContent!=='rotated')throw Error('suggested reply review'); c.querySelector('[data-call-answer-send]').click(); return 'chat reply sent'; }`);
  await until(`document.querySelector('[data-call-type="chat"] [data-call-answer]')?.dataset.callAnswerPhase==='sent'`);
  const chatNote = await readFile(path.join(home, 'answer-note.txt'), 'utf8');
  const chatEnvelope = JSON.parse(/```json fm-bearings-answer\n([\s\S]*?)\n```/.exec(chatNote)[1]);
  assert.deepEqual([chatEnvelope.type, chatEnvelope.selection, chatEnvelope.note], ['chat', '', 'rotated']);
  await evaluate(`() => { document.activeElement?.blur(); document.getSelection().removeAllRanges(); document.body.click(); return 'chat answer disengaged'; }`);
  await until(`!document.querySelector('[data-call-type="chat"]')`);
  await rm(path.join(home, 'answer-note.txt'));
  await until("document.querySelectorAll('[data-call-key]').length===3");
  const holdReason = "Ship the ledger change only after the captain picks a window.";
  extraBacklog = `- [ ] hold-reason - Choose a window (repo: quarterdeck) (hold: fm-hold-v1:${Buffer.from(holdReason).toString("base64")}) (hold-kind: captain)\n`;
  raw.decisions_open.push({ id: "hold-reason", key: "hold-reason", summary: "Choose", owner: "(main)", verb: "captain-hold" });
  await appendFile(transcriptPath, chatRecord("synthetic-ask-reason", 'DECISION NEEDED: [task:hold-reason] reply "option A" or "option B".'));
  await change();
  await until(`(() => { const card=document.querySelector('[data-call-key="decision:hold-reason"]'); if(!card) return false; const title=card.querySelector('h3'); const about=[...card.querySelectorAll('.call-context dd')].map(node=>node.textContent).join(' '); const ask=card.querySelector('.call-context-ask'); return !!(title && title.textContent==='${holdReason}' && about.includes('quarterdeck') && !about.includes('Repository not recorded') && ask && !ask.textContent.includes('[task:') && card.querySelectorAll('[data-call-reply]').length===2 && card.innerHTML.indexOf('data-call-reply')>card.innerHTML.indexOf(title.textContent)); })()`);
  for (const width of [1280, 390]) {
    await browser("resize", String(width), "844");
    await evaluate(`() => { document.querySelector('[data-call-key="decision:hold-reason"]').scrollIntoView({block:'center'}); return 'reason card ${width}'; }`);
    await browser("screenshot", path.join(proof, `captain-decision-reason-${width}.png`));
  }
  raw.decisions_open = raw.decisions_open.filter((row) => row.id !== "hold-reason");
  extraBacklog = "";
  await change();
  await until(`!!document.querySelector('[data-call-type="chat"]')`);
  await evaluate(`() => { const c=document.querySelector('[data-call-type="chat"]'); c.querySelector('[data-call-dismiss]').click(); c.querySelector('[data-call-dismiss-send]').click(); return 'dismissed reason ask'; }`);
  await until(`document.querySelectorAll('[data-call-key]').length===3 && !document.querySelector('[data-call-type="chat"]')`);
  if (process.env.FM_BROWSER_FORCED_COLORS === '1') await evaluate(`() => { if(!matchMedia('(forced-colors: active)').matches)throw Error('forced colors not active'); return 'native Chromium forced colors active'; }`);
  for (const width of [1280,360,390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { const cards=[...document.querySelectorAll('[data-call-key]')]; if(document.documentElement.scrollWidth>innerWidth)throw Error('rich card page overflow'); for(const card of cards){ const box=card.getBoundingClientRect(); if(box.left<0||box.right>innerWidth||card.scrollWidth>card.clientWidth+1||!card.querySelector('.call-context'))throw Error('rich card overflow/context'); } const decision=cards[0],merge=cards.find(c=>c.dataset.callType==='merge'); if(!decision.innerText.includes('Recommended: staged — smaller blast radius. Immediate — faster delivery.')||!decision.querySelector('a[href="https://example.invalid/acme/example-app/pull/42"]')||!merge.innerText.includes('Risk: older clients may require a migration.')||!merge.innerText.includes('Not provided by the snapshot')||[...decision.querySelectorAll('input[type=radio]')].map(input=>input.value).join(',')!=='staged,now'||decision.querySelector('input[value=reconcile]')||decision.querySelectorAll('.call-opt-rec').length!==1||!decision.querySelector('.call-opt:has(input[value=staged]) .call-opt-rec')||!decision.querySelector('form[data-call-answer] textarea[data-call-draft=answer]')||merge.querySelectorAll('input[type=radio]').length!==1||merge.querySelector('input[type=radio]').value!=='merge'||merge.querySelector('.call-opt-rec'))throw Error('source information lost or board options missing'); const gamma=document.querySelector('[data-call-key="decision:gamma-credential"]'); const ask=decision.querySelector('h3'); const link=decision.querySelector('a.call-link'); const clipped=(el)=>{ if(!el)return false; const clamp=getComputedStyle(el).webkitLineClamp; return el.scrollHeight>el.clientHeight+1 || getComputedStyle(el).textOverflow==='ellipsis' || (Boolean(clamp) && clamp!=='none'); }; if(clipped(ask)||clipped(link)||clipped(merge.querySelector('h3'))||decision.querySelector('[data-call-more]')||ask.textContent.length<80||!link.textContent.includes('https://example.invalid/acme/example-app/pull/42'))throw Error('long ask, link or id is clipped'); if(gamma.querySelector('input[type=radio]')||gamma.querySelector('[data-call-more]')||!gamma.querySelector('.call-id').textContent.includes('gamma-credential'))throw Error('task id must stay readable'); return {width:innerWidth,richCards:true}; }`);
    await browser('screenshot', path.join(proof, `captain-call-rich-${width}.png`));
    if (width === 1280 || width === 390) {
      await evaluate(`() => { const active=document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]'); const badges=[...document.querySelectorAll('[data-call-lifecycle-badge]')]; if(active.getAttribute('aria-pressed')!=='true'||!active.textContent.startsWith('Active')||!badges.length||badges.some(badge=>badge.getAttribute('aria-label')!=='Active'||badge.textContent!=='')||document.querySelector('#call-answered-toggle')||document.querySelector('#call-procrastinated-toggle'))throw Error('active lifecycle filter'); if(active.getBoundingClientRect().height<44||document.documentElement.scrollWidth>innerWidth)throw Error('lifecycle toggle geometry'); return 'active filter'; }`);
      await browser('screenshot', path.join(proof, `captain-lifecycle-active-${width}.png`));
    }
    await evaluate(`() => { const columns=document.querySelector('#overview-columns'); const primary=document.querySelector('#overview-primary'); const secondary=document.querySelector('#overview-secondary'); const summary=document.querySelector('#summary'); const landed=document.querySelector('#just-landed'); if(!columns||!primary||!secondary||!landed||!secondary.contains(landed)||!primary.contains(document.querySelector('#captain-call')))throw Error('overview columns'); if(landed.querySelector('[data-call-procrastinate], [data-call-key]'))throw Error('landed is not a call card'); const cards=[...landed.querySelectorAll('[data-landed-key]')]; if(cards.length!==2)throw Error('landed count '+cards.length); const ship=landed.querySelector('[data-landed-key="landed:ship-window"]'); const local=landed.querySelector('[data-landed-key="landed:local-notes"]'); const link=ship.querySelector('a.call-link'); if(!link||link.textContent!=='https://example.invalid/acme/example-app/pull/42'||link.href!==link.textContent)throw Error('pull request link'); if(!local.textContent.includes('local main')||local.querySelector('a'))throw Error('local main'); if(!ship.textContent.includes('example-app')||!local.textContent.includes('sample-notes')||!ship.textContent.includes('2026-10-01')||!ship.textContent.includes('time unknown'))throw Error('repo or when'); const shipTitle=ship.querySelector('h3'); if(!shipTitle||shipTitle.textContent!=='Ship the example-app release window'||ship.querySelector('[data-call-text-toggle]'))throw Error('ship title was not continued'); const localToggle=local.querySelector('[data-call-text-toggle]'); const localPanel=local.querySelector('[data-call-full]'); if(!localToggle||localToggle.textContent!=='Notes from the other ledger…'||!localPanel)throw Error('local title is not a toggle'); if(localPanel.hidden)localToggle.click(); if(localPanel.hidden||!localPanel.textContent.includes('Backlog title')||!localPanel.textContent.includes('Land the sample notes on local main'))throw Error('local full text'); localToggle.click(); if(!localPanel.hidden)throw Error('local full text stayed open'); const tabs=document.querySelector('#overview-section-tabs'); const callsTab=document.querySelector('#overview-tab-calls'); const landedTab=document.querySelector('#overview-tab-landed'); if(!tabs||!callsTab||!landedTab)throw Error('overview tabs missing'); if(callsTab.textContent!=="Captain's Call (3)"||landedTab.textContent!=='Just landed (2)')throw Error('tab counts '+callsTab.textContent+' / '+landedTab.textContent); const freshCount=document.querySelector('#landed-new-count'); if(!freshCount||freshCount.hidden||freshCount.textContent!=='2'||!freshCount.classList.contains('call-badge')||freshCount.parentElement?.id!=='just-landed-heading')throw Error('new landed count '+(freshCount&&freshCount.textContent)+' hidden='+(freshCount&&freshCount.hidden)); const p=primary.getBoundingClientRect(); const s=secondary.getBoundingClientRect(); if(innerWidth<=720){ if(getComputedStyle(tabs).display==='none'||tabs.getAttribute('role')!=='tablist'||callsTab.getAttribute('role')!=='tab'||callsTab.getAttribute('aria-selected')!=='true')throw Error('phone tab semantics'); if(primary.hidden||!secondary.hidden)throw Error('phone did not show Captain Call'); if(callsTab.getBoundingClientRect().height<44||landedTab.getBoundingClientRect().height<44)throw Error('tab target'); landedTab.click(); if(landedTab.getAttribute('aria-selected')!=='true'||!primary.hidden||secondary.hidden)throw Error('phone did not switch to Just landed'); const shown=secondary.getBoundingClientRect(); if(shown.width<40||shown.left<0||shown.right>innerWidth+1)throw Error('landed tab overflow'); callsTab.click(); if(primary.hidden||!secondary.hidden||callsTab.getAttribute('aria-selected')!=='true')throw Error('phone did not return to Captain Call'); } else { if(getComputedStyle(tabs).display!=='none')throw Error('desktop tabs visible'); if(primary.hidden||secondary.hidden||primary.getAttribute('role')==='tabpanel')throw Error('desktop hid a column'); if(s.width<40||Math.abs(p.width-s.width)>2||s.left<p.right-1)throw Error('secondary is not beside the first column'); if(getComputedStyle(columns).columnGap!=='22px')throw Error('column gap'); if(summary.getBoundingClientRect().bottom>p.top+1)throw Error('summary is not above the columns'); } return {overviewColumns:true,width:innerWidth}; }`);
    await evaluate(`() => { const columns=document.querySelector('#overview-columns'); const section=document.querySelector('#secondmates-section'); const mate=section?.querySelector('.secondmate-card'); if(!mate||!mate.innerText.includes('navigator')||!mate.innerText.includes('2 open · 1 captain calls'))throw Error('second mate evidence'); if(columns.contains(section))throw Error('second mates belong outside the tab panels'); const check=()=>{ const box=section.getBoundingClientRect(); if(!mate.getClientRects().length||mate.scrollWidth>mate.clientWidth+1||box.top<columns.getBoundingClientRect().bottom-1)throw Error('second mate hidden, overflowing or above columns'); }; check(); if(innerWidth<=720){ document.querySelector('#overview-tab-landed').click(); check(); document.querySelector('#overview-tab-calls').click(); check(); } return {secondmatesVisible:true,width:innerWidth}; }`);
    if (width === 1280 || width === 390) {
      await evaluate(`() => { if(innerWidth<=720)document.querySelector('#overview-tab-landed').click(); document.querySelector('#just-landed').scrollIntoView({block:'start'}); return 'just landed ${width}'; }`);
      await browser('screenshot', path.join(proof, `just-landed-${width}.png`));
      if (width === 390) {
        await evaluate(`() => { const tabs=document.querySelector('#overview-section-tabs'); const headerBottom=document.querySelector('.product-identity')?.getBoundingClientRect().bottom||48; tabs.scrollIntoView({block:'start'}); for(let n=0;n<4;n++){ const box=tabs.getBoundingClientRect(); const overlap=headerBottom+8-box.top; if(overlap<=1)break; let node=tabs.parentElement, moved=false; while(node){ if(node.scrollTop>0){ node.scrollTop-=overlap; moved=true; break; } node=node.parentElement; } if(!moved)break; } const box=tabs.getBoundingClientRect(); if(box.top<headerBottom+2||box.height<44||box.bottom>innerHeight-64)throw Error('tabs not in view top='+Math.round(box.top)+' header='+Math.round(headerBottom)+' height='+Math.round(box.height)); const callsTab=document.querySelector('#overview-tab-calls'); const landedTab=document.querySelector('#overview-tab-landed'); if(callsTab.textContent!=="Captain's Call (3)"||landedTab.textContent!=='Just landed (2)'||landedTab.getAttribute('aria-selected')!=='true')throw Error('tab shot'); return 'tabs in view'; }`);
        await browser('screenshot', path.join(proof, 'overview-tabs-390.png'));
        await evaluate(`() => { document.querySelector('#overview-tab-calls').click(); return 'calls restored'; }`);
      }
    }
  }
  const attemptsBefore = await readFile(path.join(home, 'answer-attempts'), 'utf8').catch(() => '');
  const backlogBefore = await readFile(path.join(home, 'data/backlog.md'), 'utf8');
  for (const width of [1280, 390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { const button=document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]'); button.click(); return button.getAttribute('aria-pressed'); }`);
    await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:gamma-credential"]'); card.scrollIntoView({block:'center'}); const text=card.querySelector('[data-call-text-toggle]'); const panel=card.querySelector('[data-call-full]'); if(!text||!panel)throw Error('shortened headline is not tappable'); if(panel.hidden)text.click(); if(panel.hidden||!panel.textContent.includes('full text Quarterdeck received'))throw Error('full text panel'); const toggle=card.querySelector('[data-call-procrastinate-toggle]'); const chip=card.querySelector('.state-chip'); const head=card.querySelector('header.call-head'); if(!head.contains(toggle))throw Error('procrastinate is not in the header'); const tr=toggle.getBoundingClientRect(); if(Math.abs(tr.height-chip.getBoundingClientRect().height)>2||Math.abs(tr.right-head.getBoundingClientRect().right)>16)throw Error('procrastinate is not a top-right badge'); toggle.click(); const menu=card.querySelector('[data-call-procrastinate-menu]'); if(menu.hidden)throw Error('menu closed'); for (const label of ['3h','6h','1d','3d']) { const item=menu.querySelector('[data-call-procrastinate-for="'+label+'"]'); if(!item||item.getBoundingClientRect().height<44)throw Error('missing '+label); } if(document.documentElement.scrollWidth>innerWidth||card.scrollWidth>card.clientWidth+1)throw Error('menu overflow'); return 'procrastinate menu'; }`);
    await browser('screenshot', path.join(proof, `captain-procrastinate-menu-${width}.png`));
    await evaluate(`() => { document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-for="3h"]').click(); return 'parked 3h'; }`);
    await until(`document.querySelector('[data-call-key="decision:gamma-credential"]').hidden && document.querySelector('#call-lifecycle-filter [data-call-lifecycle="procrastinated"]').textContent==='Procrastinated (1)'`);
    await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="procrastinated"]').click(); return 'opened procrastinated'; }`);
    await until(`!document.querySelector('[data-call-key="decision:gamma-credential"]').hidden && /Returns /.test(document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-until]').textContent)`);
    await browser('screenshot', path.join(proof, `captain-procrastinated-list-${width}.png`));
    if (width === 390) {
      await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:gamma-credential"]'); window.procrastinateUntil=card.querySelector('[data-call-procrastinate-until]').textContent; card.querySelector('[data-call-procrastinate-toggle]').click(); card.querySelector('[data-call-procrastinate-for="6h"]').click(); return 'extend 6h'; }`);
      await until(`document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-until]').textContent!==window.procrastinateUntil && /Returns /.test(document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-until]').textContent)`);
    }
    await evaluate(`() => { document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-return]').click(); return 'bring back'; }`);
    await until(`document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='active' && !document.querySelector('[data-call-key="decision:gamma-credential"]').hasAttribute('data-call-procrastinated')`);
    await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); return 'active after return'; }`);
    await until(`!document.querySelector('[data-call-key="decision:gamma-credential"]').hidden && document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='active'`);
    await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:gamma-credential"]'); const panel=card.querySelector('[data-call-full]'); if(panel && !panel.hidden)card.querySelector('[data-call-text-toggle]').click(); return 'text closed'; }`);
  }
  assert.equal(await readFile(path.join(home, 'answer-attempts'), 'utf8').catch(() => ''), attemptsBefore, 'procrastinate never answers');
  assert.equal(await readFile(path.join(home, 'data/backlog.md'), 'utf8'), backlogBefore, 'procrastinate never writes the backlog');
  const parkedFile = path.join(temp, 'quarterdeck-call-procrastination.json');
  assert.equal(JSON.parse(await readFile(parkedFile, 'utf8')).until['decision:gamma-credential'], undefined);
  assert.equal(path.dirname(parkedFile), path.dirname(path.join(temp, 'presentation.json')));
  assert.equal(path.relative(home, parkedFile).startsWith('..'), true);
  await browser('resize', '1280', '844');
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); const card=document.querySelector('[data-call-key="decision:gamma-credential"]'); card.querySelector('[data-call-procrastinate-toggle]').click(); card.querySelector('[data-call-procrastinate-for="3h"]').click(); return 'parked again'; }`);
  await until(`document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='procrastinated'`);
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="procrastinated"]').click(); return 'procrastinated view'; }`);
  await until(`!document.querySelector('[data-call-key="decision:gamma-credential"]').hidden`);
  raw.decisions_open.find(row => row.id === 'gamma-credential').summary = 'Gamma credential changed';
  await change();
  await until(`document.querySelector('[data-call-key="decision:gamma-credential"]').innerText.includes('Gamma credential changed') && /Returns /.test(document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-until]').textContent) && document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='procrastinated'`);
  await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:gamma-credential"]'); card.querySelector('[data-call-answer-text]').focus(); return 'holding gamma'; }`);
  raw.decisions_open.find(row => row.id === 'gamma-credential').summary = 'Gamma credential after Update now';
  await change();
  await until(`!!document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-update-now]')`);
  await evaluate(`() => { document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-update-now]').click(); return 'updated now'; }`);
  await until(`document.querySelector('[data-call-key="decision:gamma-credential"]').innerText.includes('Gamma credential after Update now') && /Returns /.test(document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-until]').textContent) && document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='procrastinated' && !document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate]').hidden`);
  await browser('screenshot', path.join(proof, 'captain-procrastinated-after-update-1280.png'));
  await evaluate(`() => { window.quarterdeckRevision.showUpdate(); document.documentElement.dataset.reloadProof='1'; const button=document.querySelector('.app-update-notice button'); if(!button||button.textContent!=='Reload')throw Error('reload control'); return 'reload armed'; }`);
  try { await browser('eval', `() => { document.querySelector('.app-update-notice button').click(); return 'reloading'; }`); } catch {}
  await settleReload();
  await browser('resize', '390', '844');
  await until(`(() => { const card=document.querySelector('[data-call-key="decision:gamma-credential"]'); return !!(card && !card.hidden && card.dataset.callLifecycle==='procrastinated' && /Returns /.test(card.querySelector('[data-call-procrastinate-until]').textContent) && card.innerText.includes('Gamma credential after Update now')); })()`);
  await browser('screenshot', path.join(proof, 'captain-procrastinated-after-reload-390.png'));
  await evaluate(`() => { document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-procrastinate-return]').click(); return 'bring back after reload'; }`);
  await until(`document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='active' && !document.querySelector('[data-call-key="decision:gamma-credential"]').hasAttribute('data-call-procrastinated')`);
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); return 'active restored'; }`);
  await until(`!document.querySelector('[data-call-key="decision:gamma-credential"]').hidden && document.querySelector('[data-call-key="decision:gamma-credential"]').dataset.callLifecycle==='active'`);
  await evaluate(`() => { const alpha=document.querySelector('[data-call-key="decision:alpha-call"]'); const field=alpha.querySelector('[data-call-answer-text]'); window.sortProof={alpha,field}; field.focus(); field.value='Sort-protected draft'; field.dispatchEvent(new Event('input',{bubbles:true})); const sort=document.querySelector('#call-sort'); sort.value='oldest'; sort.dispatchEvent(new Event('change',{bubbles:true})); if(document.querySelector('[data-call-key]')!==alpha||document.querySelector('[data-call-sort-pending]').hidden||!document.querySelector('[data-call-sort-pending]').textContent.includes('Sort waits')||!document.querySelector('#call-status').hidden||document.querySelector('#captain-call').hasAttribute('data-held'))throw Error('sort hold must stay on sort control'); if(!alpha.querySelector('[data-call-clock]').textContent.includes('Updated:')||!alpha.querySelector('[data-call-clock]').textContent.includes('ago')||!document.querySelector('[data-call-key="decision:gamma-credential"] [data-call-clock]').textContent.includes('unknown'))throw Error('card clocks missing'); document.activeElement.blur(); document.body.click(); return 'sort held on phone'; }`);
  await until(`document.querySelector('[data-call-key]').dataset.callKey==='merge:beta-merge'`);
  await evaluate(`() => { const alpha=document.querySelector('[data-call-key="decision:alpha-call"]'); if(alpha!==sortProof.alpha||alpha.querySelector('[data-call-answer-text]')!==sortProof.field||sortProof.field.value!=='Sort-protected draft'||localStorage.getItem('fm-quarterdeck-call-sort.v1')!=='oldest')throw Error('sort lost draft, node or preference'); const sort=document.querySelector('#call-sort'); sort.value='newest'; sort.dispatchEvent(new Event('change',{bubbles:true})); sortProof.field.value=''; sortProof.field.dispatchEvent(new Event('input',{bubbles:true})); const clock=alpha.querySelector('[data-call-clock]'); clock.textContent='waiting for tick'; return 'oldest applied and newest requested'; }`);
  await until(`document.querySelector('[data-call-key]').dataset.callKey==='decision:alpha-call' && document.querySelector('[data-call-key="decision:alpha-call"] [data-call-clock]').textContent!=='waiting for tick'`);
  await browser('screenshot', path.join(proof, 'captain-call-clocks-sort-390.png'));
  await browser('resize', '1280', '844');
  // One box: text with no option is a card thread note. Queue does not send; Send does.
  const beside = `const beside=(card)=>{ const hint=card.querySelector('[data-call-box-hint]'); if(!hint||hint.textContent!=='Pick an option to answer, or just type - Firstmate replies in the thread.')throw Error('hint: '+(hint&&hint.textContent)); if(card.querySelector('[data-call-thread-toggle]')||card.querySelector('[data-call-thread-text]'))throw Error('old thread composer'); for(const bar of card.querySelectorAll('.call-answer-bar')){ if(!bar.getClientRects().length)continue; const box=bar.parentElement.querySelector('textarea'); if(!box)throw Error('note missing'); const note=box.getBoundingClientRect(); const barBox=bar.getBoundingClientRect(); const overlap=Math.min(barBox.bottom,note.bottom)-Math.max(barBox.top,note.top); if(overlap<20)throw Error('action not beside the note: '+overlap); if(barBox.left<note.right-1)throw Error('action not to the right of the note'); if(note.width<80)throw Error('note collapsed'); if(note.height>96)throw Error('note is not a single line'); const hintBox=hint.getBoundingClientRect(); if(hintBox.top<note.bottom-1)throw Error('hint is not under the note'); const shown=[...bar.querySelectorAll('button')].filter(b=>!b.hidden&&b.getClientRects().length); if(!shown.length)throw Error('action missing'); for(const button of shown){ const r=button.getBoundingClientRect(); if(r.height<44)throw Error('short action'); if(r.width>card.clientWidth*0.55)throw Error('action is a slab'); } } };`;
  for (const width of [1280, 390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { ${beside} const card=document.querySelector('[data-call-key="decision:alpha-call"]'); beside(card); if(document.documentElement.scrollWidth>innerWidth||card.scrollWidth>card.clientWidth+1)throw Error('thread overflow'); card.querySelector('[data-call-answer]').scrollIntoView({block:'center'}); return {thread:'box',width:innerWidth}; }`);
    await browser('screenshot', path.join(proof, `captain-thread-open-${width}.png`));
    if (width === 1280) {
      await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); window.__alphaThreadCount=card.querySelector('[data-call-thread-count]')?.textContent||''; const field=card.querySelector('[data-call-answer-text]'); field.value='What is this call about?'; field.dispatchEvent(new Event('input',{bubbles:true})); card.querySelector('.call-answer-queue').click(); if(card.querySelector('[data-call-answer]').dataset.callAnswerPhase!=='confirm')throw Error('thread queue did not confirm'); return 'thread queued '+window.__alphaThreadCount; }`);
      await new Promise(r => setTimeout(r, 300));
      assert.equal(await readFile(path.join(home, 'thread-note.txt'), 'utf8').catch(() => null), null, 'Queue never sends a thread note');
      assert.equal(await readFile(path.join(home, 'answer-note.txt'), 'utf8').catch(() => null), null, 'a thread queue never writes an answer');
      await evaluate(`() => { document.querySelector('[data-call-key="decision:alpha-call"] [data-call-answer-send]').click(); return 'thread sent'; }`);
      await until(`/Question sent to Firstmate/.test(document.querySelector('[data-call-key="decision:alpha-call"] [data-call-thread-status]').textContent) && document.querySelector('[data-call-key="decision:alpha-call"] [data-call-answer]').dataset.callAnswerPhase==='compose' && document.querySelector('[data-call-key="decision:alpha-call"]').hidden && document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callLifecycle==='sent'`);
      await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="sent"]').click(); return 'show sent thread'; }`);
      await until(`!document.querySelector('[data-call-key="decision:alpha-call"]').hidden && document.querySelector('[data-call-key="decision:alpha-call"]').querySelector('[data-call-lifecycle-badge]').getAttribute('aria-label')==='Sent'&&document.querySelector('[data-call-key="decision:alpha-call"] [data-call-lifecycle-badge]').textContent===''`);
      const asked = await readFile(path.join(home, 'thread-note.txt'), 'utf8');
      const threadEnvelope = JSON.parse(/```json fm-quarterdeck-thread\n([\s\S]*?)\n```/.exec(asked)[1]);
      assert.deepEqual([threadEnvelope.key, threadEnvelope.task, threadEnvelope.question], ['decision:alpha-call', 'alpha-call', 'What is this call about?']);
      assert.doesNotMatch(asked, /fm-bearings-answer/, 'a question is never an answer');
      assert.equal(await readFile(path.join(home, 'answer-note.txt'), 'utf8').catch(() => null), null, 'asking never answers');
    }
    await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); const label=card.querySelector('[data-call-sent-label]'); const badge=card.querySelector('[data-call-lifecycle-badge]'); const banner=card.querySelector('[data-fm-reply]'); if(card.hidden||card.dataset.callLifecycle!=='sent')throw Error('waiting card not sent'); if(!label||label.hidden||label.textContent!=='Sent - waiting for Firstmate to read')throw Error('waiting label '+(label&&label.textContent)); if(badge.getAttribute('aria-label')!=='Sent'||badge.getAttribute('data-call-lifecycle')!=='sent'||badge.textContent!==''||getComputedStyle(badge).borderStyle!=='dashed')throw Error('sent dot'); if(!getComputedStyle(card).backgroundImage.includes('linear-gradient'))throw Error('sent hatch'); if(banner&&!banner.hidden)throw Error('reply banner while unread'); label.scrollIntoView({block:'center'}); if(document.documentElement.scrollWidth>innerWidth||card.scrollWidth>card.clientWidth+1)throw Error('waiting overflow'); return 'sent waiting'; }`);
    await browser('screenshot', path.join(proof, `captain-sent-waiting-${width}.png`));
  }
  await until(`(() => { const count=document.querySelector('[data-call-key="decision:alpha-call"] [data-call-thread-count]').textContent; return count!==window.__alphaThreadCount && count.includes('Thread · '); })()`);
  const firstThreadRequest = (await readFile(path.join(home, 'thread-attempts'), 'utf8')).trim().split('\n').filter(Boolean)[0];
  await writeFile(path.join(home, 'thread-acked'), `${firstThreadRequest}\n`);
  await until(`document.querySelector('[data-call-key="decision:alpha-call"] [data-call-sent-label]').textContent==='Firstmate is on it' && document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callLifecycle==='sent'`);
  for (const width of [1280, 390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); const label=card.querySelector('[data-call-sent-label]'); const badge=card.querySelector('[data-call-lifecycle-badge]'); const banner=card.querySelector('[data-fm-reply]'); if(card.hidden||card.dataset.callLifecycle!=='sent'||!label||label.hidden||label.textContent!=='Firstmate is on it')throw Error('on it label '+(label&&label.textContent)); if(badge.getAttribute('aria-label')!=='Sent'||badge.getAttribute('data-call-lifecycle')!=='sent'||getComputedStyle(badge).borderStyle!=='dashed')throw Error('on it dot'); if(banner&&!banner.hidden)throw Error('banner before a reply'); label.scrollIntoView({block:'center'}); if(document.documentElement.scrollWidth>innerWidth)throw Error('on it overflow'); return 'firstmate is on it'; }`);
    await browser('screenshot', path.join(proof, `captain-sent-on-it-${width}.png`));
  }
  await writeFile(path.join(home, 'thread-replied'), `${firstThreadRequest}\n`);
  await until(`document.querySelector('[data-call-key="decision:alpha-call"] [data-call-thread-count]').textContent.includes('1 new reply') && !document.querySelector('[data-call-key="decision:alpha-call"] [data-fm-reply]').hidden && document.querySelector('[data-call-key="decision:alpha-call"] [data-fm-reply]').textContent.includes('Firstmate replied: This call chooses the synthetic release window.') && document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callLifecycle==='active'`);
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); const card=document.querySelector('[data-call-key="decision:alpha-call"]'); if(card.hidden)throw Error('replied card hidden on Active'); const box=card.querySelector('[data-call-answer-text]'); const radios=[...card.querySelectorAll('input[type=radio]')]; const badge=card.querySelector('[data-call-lifecycle-badge]'); const banner=card.querySelector('[data-fm-reply]'); const label=card.querySelector('[data-call-sent-label]'); if(card.dataset.callLifecycle!=='active'||box.readOnly||box.disabled||radios.some((radio)=>radio.disabled))throw Error('reply did not unlock the card'); if(badge.getAttribute('aria-label')!=='Active'||badge.getAttribute('data-call-lifecycle')!=='active'||getComputedStyle(badge).borderStyle==='dashed')throw Error('active dot'); if(!banner||banner.hidden||!banner.textContent.startsWith('Firstmate replied:'))throw Error('reply banner'); if(label&&!label.hidden)throw Error('sent label stayed after the reply'); if(!card.querySelector('[data-call-thread-count]').textContent.includes('Thread'))throw Error('thread dropped'); return 'reply unlocked'; }`);
  for (const width of [1280, 390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); (card.querySelector('[data-fm-reply]')||card).scrollIntoView({block:'center'}); if(document.documentElement.scrollWidth>innerWidth||card.scrollWidth>card.clientWidth+1)throw Error('replied overflow'); return 'replied active'; }`);
    await browser('screenshot', path.join(proof, `captain-replied-active-${width}.png`));
    if (width === 1280) {
      await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); const count=card.querySelector('[data-call-thread-count]').textContent; const replies=card.querySelector('[data-call-thread-replies]').textContent; const history=card.querySelector('[data-call-thread-history]'); if(!count.includes('1 new reply')||!replies.includes('1 new reply')||!history.hidden)throw Error('new reply marker missing'); const expand=card.querySelector('[data-call-thread-expand]'); const box=card.querySelector('[data-call-answer-text]'); if(!expand||expand.hidden)throw Error('expand missing'); if(!(expand.compareDocumentPosition(box)&Node.DOCUMENT_POSITION_FOLLOWING))throw Error('expand is not above the text box'); if(expand.getBoundingClientRect().bottom>box.getBoundingClientRect().top+1)throw Error('expand paints below the text box'); return 'thread reply marker'; }`);
      await browser('screenshot', path.join(proof, 'captain-thread-collapsed-1280.png'));
    }
  }
  await browser('resize', '390', '844');
  await browser('screenshot', path.join(proof, 'captain-thread-collapsed-390.png'));
  await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); const history=card.querySelector('[data-call-thread-history]'); const expand=card.querySelector('[data-call-thread-expand]'); if(!history.hidden||!expand||expand.hidden)throw Error('thread should start collapsed'); expand.click(); if(history.hidden)throw Error('expand did not open the thread'); if(!card.querySelector('[data-call-thread-log]').textContent.includes('Firstmate replied')){ const more=card.querySelector('[data-call-thread-history-toggle]'); if(more&&!more.hidden)more.click(); } const entries=[...card.querySelectorAll('.call-thread-entry')]; if(!entries.some(e=>e.textContent.includes('You asked'))||!entries.some(e=>e.textContent.includes('Firstmate replied')&&e.textContent.includes('synthetic release window')))throw Error('thread reply/order missing'); if(!entries.every(e=>e.querySelector('time[datetime]')&&e.querySelector('button')))throw Error('thread time/copy missing'); const box=card.querySelector('[data-call-answer-text]'); if(!(expand.compareDocumentPosition(box)&Node.DOCUMENT_POSITION_FOLLOWING)||!(history.compareDocumentPosition(box)&Node.DOCUMENT_POSITION_FOLLOWING))throw Error('thread is not above the text box'); if(history.getBoundingClientRect().bottom>box.getBoundingClientRect().top+1)throw Error('open history paints below the text box'); return 'thread history reply ordered'; }`);
  await browser('screenshot', path.join(proof, 'captain-thread-expanded-390.png'));
  await browser('screenshot', path.join(proof, 'captain-thread-replied-390.png'));
  await browser('resize', '1280', '844');
  // Shared queue: alpha text is a thread note, and the merge option is an answer.
  const queueAttempts = (await readFile(path.join(home, 'answer-attempts'), 'utf8')).trim().split('\n').length;
  const threadBefore = (await readFile(path.join(home, 'thread-attempts'), 'utf8')).trim().split('\n').filter(Boolean);
  await evaluate(`() => { window.reviewPosts=0; const original=window.fetch; window.fetch=(url,init)=>{ if(String(url).includes('/api/review')&&init?.method==='POST')window.reviewPosts++; return original(url,init); }; const alpha=document.querySelector('[data-call-key="decision:alpha-call"]'); const field=alpha.querySelector('[data-call-answer-text]'); field.value='Queue rollout Tuesday'; field.dispatchEvent(new Event('input',{bubbles:true})); alpha.querySelector('.call-answer-queue').click(); const merge=document.querySelector('[data-call-key="merge:beta-merge"]'); const radio=merge.querySelector('input[value="merge"]'); radio.checked=true; radio.dispatchEvent(new Event('change',{bubbles:true})); merge.querySelector('.call-answer-queue').click(); if(window.quarterdeckCallQueue.list().length!==2)throw Error('two notes not queued'); return 'two queued'; }`);
  for (const width of [1280,390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="queued"]').click(); const merge=document.querySelector('[data-call-key="merge:beta-merge"]'); const alpha=document.querySelector('[data-call-key="decision:alpha-call"]'); const button=document.querySelector('#call-lifecycle-filter [data-call-lifecycle="queued"]'); if(merge.hidden||merge.dataset.callLifecycle!=='queued'||merge.querySelector('[data-call-lifecycle-badge]').getAttribute('aria-label')!=='Queued'||merge.querySelector('[data-call-lifecycle-badge]').textContent!==''||alpha.hidden||alpha.dataset.callLifecycle!=='queued'||alpha.querySelector('[data-call-lifecycle-badge]').getAttribute('aria-label')!=='Queued'||button.getAttribute('aria-pressed')!=='true'||button.getBoundingClientRect().height<44||document.documentElement.scrollWidth>innerWidth)throw Error('queued filter'); return 'queued filter'; }`);
    await browser('screenshot', path.join(proof, `captain-lifecycle-queued-${width}.png`));
    await evaluate(`() => { if(document.querySelector('#review-panel-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('#review-panel-toggle').click(); if(innerWidth<721)document.querySelector('#review-history-tab').click(); const root=document.querySelector(innerWidth<721?'#review-phone-thread':'#review-thread'); if(root.querySelectorAll('.review-call-answer').length!==2||!document.querySelector('#review-count').textContent.includes('2'))throw Error('queue list/count missing'); const batch=root.querySelector('details'); if(batch){batch.open=true;if(!batch.querySelector('summary').textContent.includes("Queued Captain's Call answers · 2"))throw Error('phone batch missing');} return 'shared queue list'; }`);
    await browser('screenshot', path.join(proof, `captain-shared-queue-${width}.png`));
    await evaluate(`() => {
      const phone = innerWidth < 721;
      const thread = document.querySelector('#review-phone-thread');
      if (!phone) { thread.hidden = false; thread.style.display = 'block'; }
      const summary = thread.querySelector('.review-batch > summary');
      if (!summary) throw Error('batch header missing');
      const label = summary.querySelector('.review-batch-label');
      const full = summary.querySelector('.review-batch-full');
      if (!label || label.textContent !== 'Call answers · 2') throw Error('short batch title');
      if (!full || full.textContent !== "Queued Captain's Call answers · 2" || summary.title !== full.textContent) throw Error('full batch title missing');
      const batch = summary.parentElement;
      batch.open = false;
      const box = summary.getBoundingClientRect();
      const style = getComputedStyle(label);
      const fullStyle = getComputedStyle(full);
      if (style.whiteSpace !== 'nowrap' || style.fontSize !== '12px') throw Error('compact header style ' + style.fontSize + ' ' + style.whiteSpace);
      const summaryStyle = getComputedStyle(summary);
      if (summaryStyle.display !== 'flex' || summaryStyle.whiteSpace !== 'nowrap') throw Error('summary is not one line');
      const labelBox = label.getBoundingClientRect();
      if (Math.abs((labelBox.top + labelBox.height / 2) - (box.top + box.height / 2)) > 4) throw Error('title is not on the marker line');
      if (fullStyle.position !== 'absolute') throw Error('closed header shows the long title');
      if (box.width < 40 || box.height < 8 || box.height > 48) throw Error('header box ' + Math.round(box.width) + 'x' + Math.round(box.height));
      if (label.scrollWidth > label.clientWidth + 1) throw Error('short title overflows');
      return 'closed batch header ' + Math.round(box.height);
    }`);
    await browser('screenshot', path.join(proof, `review-batch-header-${width}.png`));
    await evaluate(`() => {
      const phone = innerWidth < 721;
      const thread = document.querySelector('#review-phone-thread');
      const summary = thread.querySelector('.review-batch > summary');
      summary.parentElement.open = true;
      const full = summary.querySelector('.review-batch-full');
      const openStyle = getComputedStyle(full);
      if (!summary.parentElement.open || openStyle.position === 'absolute' || full.getBoundingClientRect().height < 8 || !full.textContent.includes("Queued Captain's Call answers · 2")) throw Error('tap did not reveal the full batch title');
      if (phone) summary.parentElement.open = true;
      else { summary.parentElement.open = false; thread.hidden = true; thread.style.display = ''; }
      return 'batch header revealed';
    }`);
  }
  await evaluate(`() => { document.querySelector('#review-phone-thread .review-call-answer button').click(); if(window.quarterdeckCallQueue.list().length!==1||document.querySelector('[data-call-key="decision:alpha-call"] [data-call-answer]').dataset.callAnswerPhase!=='compose')throw Error('Remove did not return answer'); document.querySelector('#review-close').click(); document.querySelector('[data-call-key="decision:alpha-call"] .call-answer-queue').click(); document.querySelector('#review-panel-toggle').click(); document.querySelector('#review-send').click(); return 'send queued batch'; }`);
  await until(`window.quarterdeckCallQueue.list().length===0 && document.querySelector('[data-call-key="merge:beta-merge"]').dataset.callLifecycle==='sent' && document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callLifecycle==='sent'`);
  // The phone review sheet is modal, so a note outside it cannot take focus until the sheet closes.
  await evaluate(`() => { document.querySelector('#review-close').click(); return 'review closed before sent cards'; }`);
  for (const width of [1280, 390, 360]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => {
      document.querySelector('#call-lifecycle-filter [data-call-lifecycle="sent"]').click();
      const cards=['decision:alpha-call','merge:beta-merge'].map((key)=>document.querySelector('[data-call-key="'+key+'"]'));
      const button=document.querySelector('#call-lifecycle-filter [data-call-lifecycle="sent"]');
      if(cards.some((card)=>card.hidden||card.dataset.callLifecycle!=='sent'||card.querySelector('[data-call-lifecycle-badge]').getAttribute('aria-label')!=='Sent'||card.querySelector('[data-call-lifecycle-badge]').textContent!=='')||button.getAttribute('aria-pressed')!=='true'||button.getBoundingClientRect().height<44||document.documentElement.scrollWidth>innerWidth)throw Error('sent filter after batch');
      const merge=cards[1];
      const alpha=cards[0];
      const radios=[...merge.querySelectorAll('input[type=radio]')];
      const note=merge.querySelector('[data-call-answer-text]');
      const label=merge.querySelector('[data-call-sent-label]');
      if(!radios.length||radios.some((radio)=>!radio.disabled)||note.disabled||!note.readOnly||!label||label.hidden||label.textContent!=='Sent - waiting for Firstmate to read')throw Error('sent answer is not locked');
      if(!getComputedStyle(merge).backgroundImage.includes('linear-gradient'))throw Error('sent hatch missing');
      const summary=merge.querySelector('[data-call-answer-summary]');
      const headline=merge.querySelector('h3');
      const hint=summary&&summary.querySelector('[data-call-answer-summary-hint]');
      const sentAt=summary&&summary.querySelector('[data-call-answer-summary-sent]');
      if(!summary||summary.hidden||summary.querySelector('h4').textContent!=='Your answer'||summary.querySelector('[data-call-answer-summary-label]').textContent!=='Merge now'||!hint||hint.hidden||!hint.textContent.includes('Firstmate re-checks')||summary.querySelector('[data-call-answer-summary-note]').hidden!==true||!sentAt||!sentAt.dateTime||!sentAt.textContent.startsWith('Sent '))throw Error('your answer is not laid out');
      if(!(summary.compareDocumentPosition(headline)&Node.DOCUMENT_POSITION_FOLLOWING))throw Error('your answer is not above the ask');
      const rows=[...merge.querySelectorAll('.call-opt')];
      const chosen=rows.find((row)=>row.querySelector('input:checked'));
      if(!rows.length||!chosen||rows.some((row)=>!getComputedStyle(row).backgroundImage.includes('linear-gradient')))throw Error('option hatch missing');
      const mark=getComputedStyle(chosen).boxShadow;
      if(mark==='none'||rows.some((row)=>row!==chosen&&getComputedStyle(row).boxShadow===mark))throw Error('chosen option is not marked');
      const threadSummary=alpha.querySelector('[data-call-answer-summary]');
      if(threadSummary&&!threadSummary.hidden)throw Error('thread sent card shows an answer summary');
      note.focus();
      if(document.activeElement!==note)throw Error('sent note cannot be focused '+(document.activeElement&&(document.activeElement.id||document.activeElement.tagName))+' modal='+!!document.querySelector('dialog[open]'));
      merge.scrollIntoView({block:'start'});
      const receipt=merge.querySelector('[data-call-answer-receipt-text]');
      const range=document.createRange();
      range.selectNodeContents(receipt);
      const selection=getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      if(selection.toString()!==receipt.textContent)throw Error('sent text is not selectable');
      selection.removeAllRanges();
      if(alpha.querySelector('[data-call-answer-text]').readOnly||alpha.querySelector('[data-call-answer-text]').disabled||[...alpha.querySelectorAll('input[type=radio]')].some((radio)=>radio.disabled))throw Error('thread follow-up is locked');
      const expand=alpha.querySelector('[data-call-thread-expand]');
      if(expand&&!expand.hidden&&(expand.disabled||getComputedStyle(expand).pointerEvents==='none'))throw Error('thread cannot expand');
      if(cards.some((card)=>card.scrollWidth>card.clientWidth+1))throw Error('sent card overflow');
      return 'sent underway';
    }`);
    await browser('screenshot', path.join(proof, `captain-lifecycle-sent-${width}.png`));
  }
  await browser('emulate', '--color-scheme', 'dark');
  await browser('resize', '390', '844');
  await evaluate(`() => { const card=document.querySelector('[data-call-key="merge:beta-merge"]'); card.scrollIntoView({block:'center'}); const label=card.querySelector('[data-call-sent-label]'); const ink=getComputedStyle(card.querySelector('h3')).color; const option=card.querySelector('.call-opt'); const summary=card.querySelector('[data-call-answer-summary]'); if(label.hidden||!getComputedStyle(card).backgroundImage.includes('linear-gradient')||!option||!getComputedStyle(option).backgroundImage.includes('linear-gradient')||!summary||summary.hidden||getComputedStyle(summary).color==='rgba(0, 0, 0, 0)'||ink==='rgba(0, 0, 0, 0)'||document.documentElement.scrollWidth>innerWidth)throw Error('dark sent card'); return 'dark sent card'; }`);
  await browser('screenshot', path.join(proof, 'captain-sent-underway-dark-390.png'));
  await browser('emulate', '--color-scheme', 'light');
  const queueIds = (await readFile(path.join(home, 'answer-attempts'), 'utf8')).trim().split('\n').slice(queueAttempts);
  assert.equal(queueIds.length, 1, 'only the picked option is an answer');
  const queuedAnswer = JSON.parse(/```json fm-bearings-answer\n([\s\S]*?)\n```/.exec(await readFile(path.join(home, `answer-${queueIds[0]}.txt`), 'utf8'))[1]);
  assert.deepEqual([queuedAnswer.task, queuedAnswer.selection, queuedAnswer.note], ['beta-merge', 'merge', '']);
  const threadIds = (await readFile(path.join(home, 'thread-attempts'), 'utf8')).trim().split('\n').filter(Boolean).slice(threadBefore.length);
  assert.equal(threadIds.length, 1, 'text with no option is one thread note');
  const queuedThreadNote = await readFile(path.join(home, `thread-${threadIds[0]}.txt`), 'utf8');
  const queuedThread = JSON.parse(/```json fm-quarterdeck-thread\n([\s\S]*?)\n```/.exec(queuedThreadNote)[1]);
  assert.deepEqual([queuedThread.key, queuedThread.question], ['decision:alpha-call', 'Queue rollout Tuesday']);
  assert.doesNotMatch(queuedThreadNote, /fm-bearings-answer/, 'a queued thread note is not an answer');
  await evaluate(`() => { if(window.reviewPosts)throw Error('answer batch used review delivery'); document.querySelector('#review-close').click(); const merge=document.querySelector('[data-call-key="merge:beta-merge"]'); merge.querySelector('[data-call-answer-again]').click(); const alpha=document.querySelector('[data-call-key="decision:alpha-call"]'); if(alpha.querySelector('[data-call-answer]').dataset.callAnswerPhase!=='compose')throw Error('thread send left alpha queued'); if(merge.querySelector('[data-call-answer]').dataset.callAnswerPhase!=='compose')throw Error('Answer again did not return merge'); document.activeElement?.blur(); document.body.click(); return 'queue uses both paths'; }`);
  // Active header sends the same queued card answers as Send batch, including at 360 and 390.
  const headerAnswersBefore = (await readFile(path.join(home, 'answer-attempts'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  const headerThreadsBefore = (await readFile(path.join(home, 'thread-attempts'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length;
  await evaluate(`() => {
    document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click();
    const button = document.querySelector('#call-send-queued');
    if (!button || !button.hidden) throw Error('send queued shown before anything is queued');
    const alpha = document.querySelector('[data-call-key="decision:alpha-call"]');
    const field = alpha.querySelector('[data-call-answer-text]');
    field.value = 'Queue the window note';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    alpha.querySelector('.call-answer-queue').click();
    const merge = document.querySelector('[data-call-key="merge:beta-merge"]');
    const radio = merge.querySelector('input[value="merge"]');
    radio.checked = true;
    radio.dispatchEvent(new Event('change', { bubbles: true }));
    merge.querySelector('.call-answer-queue').click();
    if (window.quarterdeckCallQueue.list().length !== 2) throw Error('header queue missing');
    if (alpha.dataset.callLifecycle !== 'sent') throw Error('queued follow-up must stay Sent while the latest note is unread');
    if (typeof window.quarterdeckReviewQueue.sendCallAnswers !== 'function') throw Error('shared sender missing');
    return 'queued for header button';
  }`);
  await evaluate(`() => {
    const button = document.querySelector('#call-send-queued');
    const active = document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]');
    if (active.getAttribute('aria-pressed') !== 'true' || button.hidden || button.disabled || button.textContent !== 'Send queued (2)' || button.getAttribute('aria-label') !== "Send 2 queued Captain's Call answers") throw Error('active label ' + button.textContent + ' / ' + button.getAttribute('aria-label'));
    for (const name of ['queued', 'sent', 'procrastinated', 'all']) {
      document.querySelector('#call-lifecycle-filter [data-call-lifecycle="' + name + '"]').click();
      if (!document.querySelector('#call-send-queued').hidden) throw Error('shown on ' + name);
    }
    active.click();
    if (button.hidden || button.textContent !== 'Send queued (2)') throw Error('not restored on active');
    return 'header visibility';
  }`);
  for (const width of [360, 390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => {
      const button = document.querySelector('#call-send-queued');
      button.scrollIntoView({ block: 'nearest' });
      const box = button.getBoundingClientRect();
      if (button.hidden || box.height < 44 || box.width < 40 || box.left < 0 || box.right > innerWidth + 1 || document.documentElement.scrollWidth > innerWidth) throw Error('send queued fit ' + innerWidth + ' ' + JSON.stringify({ left: box.left, right: box.right, top: box.top, height: box.height, width: box.width, page: document.documentElement.scrollWidth }));
      return { width: innerWidth, sendQueued: { width: Math.round(box.width), height: Math.round(box.height) } };
    }`);
    await browser('screenshot', path.join(proof, `captain-send-queued-${width}.png`));
  }
  await writeFile(path.join(home, 'delay-answer'), '1');
  await evaluate(`() => {
    const button = document.querySelector('#call-send-queued');
    const send = window.quarterdeckReviewQueue.sendCallAnswers;
    window.__headerSend = send();
    const second = send();
    window.__headerSecond = second;
    button.click();
    if (!button.disabled && !button.hidden) throw Error('button stayed enabled while sending');
    return 'header double send attempted';
  }`);
  await until(`window.quarterdeckCallQueue.list().length===0 && document.querySelector('#call-send-queued').hidden`);
  await rm(path.join(home, 'delay-answer'), { force: true });
  const headerAnswerLines = (await readFile(path.join(home, 'answer-attempts'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  const headerThreadLines = (await readFile(path.join(home, 'thread-attempts'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  assert.equal(headerAnswerLines.length - headerAnswersBefore, 1, 'header send delivers the queued answer once');
  assert.equal(headerThreadLines.length - headerThreadsBefore, 1, 'header send delivers the queued thread note once');
  await browser('resize', '1280', '844');
  await evaluate(`() => { const card=document.querySelector('[data-landed-key="landed:ship-window"]'); card.scrollIntoView({block:'center'}); const box=card.querySelector('[data-landed-text]'); box.value='Follow up on the release window'; box.dispatchEvent(new Event('input',{bubbles:true})); card.querySelector('[data-landed-queue]').click(); if(card.querySelector('[data-landed-confirm]').hidden)throw Error('landed follow-up did not queue'); card.querySelector('[data-landed-send]').click(); return 'landed follow-up sent'; }`);
  await until(`document.querySelector('[data-landed-key="landed:ship-window"] [data-landed-notice]')?.textContent.includes('Question sent to Firstmate')`);
  const landedNote = await readFile(path.join(home, 'thread-note.txt'), 'utf8');
  assert.match(landedNote, /Landed ship-window/);
  assert.match(landedNote, /nothing was decided/);
  assert.match(landedNote, /Follow up on the release window/);
  assert.doesNotMatch(landedNote, /fm-bearings-answer/);
  const landedEnvelope = JSON.parse(/```json fm-quarterdeck-thread\n([\s\S]*?)\n```/.exec(landedNote)[1]);
  assert.deepEqual([landedEnvelope.key, landedEnvelope.type, landedEnvelope.task], ['landed:ship-window', 'landed', 'ship-window']);
  await evaluate(`() => { const card=document.querySelector('[data-landed-key="landed:ship-window"]'); if(card.querySelector('[data-call-procrastinate]'))throw Error('procrastinate on landed'); card.querySelector('[data-landed-ack]').click(); return 'acknowledged'; }`);
  await until(`document.querySelector('[data-landed-key="landed:ship-window"]').hidden && document.querySelector('#landed-ack-toggle').textContent.includes('(1)') && document.querySelector('#landed-new-count').textContent==='1' && !document.querySelector('#landed-new-count').hidden && document.querySelector('#overview-tab-landed').textContent==='Just landed (1)'`);
  const ackFile = path.join(temp, 'quarterdeck-landed-acknowledgements.json');
  assert.equal(typeof JSON.parse(await readFile(ackFile, 'utf8')).acks['landed:ship-window'], 'string');
  assert.equal(path.relative(home, ackFile).startsWith('..'), true);
  await evaluate(`() => { const toggle=document.querySelector('#landed-ack-toggle'); if(toggle.getBoundingClientRect().height<44)throw Error('ack toggle'); toggle.click(); const card=document.querySelector('[data-landed-key="landed:ship-window"]'); const button=card.querySelector('[data-landed-ack]'); if(card.hidden||button.textContent!=='Acknowledged'||!button.disabled||card.querySelector('[data-landed-ack-note]').hidden)throw Error('review acknowledged'); if(document.querySelector('#landed-new-count').textContent!=='1'||document.querySelector('#landed-new-count').hidden||document.querySelector('#overview-tab-landed').textContent!=='Just landed (1)')throw Error('acknowledged review changed the new count'); return 'reviewing acknowledged'; }`);
  await browser('screenshot', path.join(proof, 'just-landed-acknowledged-1280.png'));
  await evaluate(`() => { if (window.reviewPosts) throw Error('header send used review delivery'); return 'header send stayed on the call routes'; }`);
  await browser('resize', '390', '844');
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); const button=document.querySelector('#call-send-queued'); if (!button.hidden || document.documentElement.scrollWidth > innerWidth) throw Error('button remained after send'); return 'header button hidden after send'; }`);
  await browser('screenshot', path.join(proof, 'captain-send-queued-done-390.png'));
  await evaluate(`() => {
    if (document.querySelector('#review-panel-toggle').getAttribute('aria-expanded') !== 'true') document.querySelector('#review-panel-toggle').click();
    const message = document.querySelector('#review-message');
    message.value = 'Synthetic batch header note';
    message.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#review-queue').click();
    if (!document.querySelector('#review-thread').textContent.includes('Synthetic batch header note')) throw Error('review note not queued');
    document.querySelector('#review-send').click();
    return 'review note sending';
  }`);
  await until(`document.querySelector('#review-sent-count').textContent!=='0'`);
  for (const width of [390, 360]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => {
      const phone = innerWidth < 721;
      if (phone) document.querySelector('#review-history-tab').click();
      else document.querySelector('#review-sent').open = true;
      const root = document.querySelector(phone ? '#review-phone-thread' : '#review-sent-list');
      const summary = [...root.querySelectorAll('.review-batch > summary')].find((node) => node.querySelector('.review-batch-id'));
      if (!summary) throw Error('sent batch header missing');
      const batch = summary.parentElement;
      batch.open = false;
      const box = summary.getBoundingClientRect();
      const time = summary.querySelector('time');
      const id = summary.querySelector('.review-batch-id');
      if (!time || !time.dateTime || !(/ago$/.test(time.title) || time.title === 'just now') || !time.textContent) throw Error('sent time missing');
      if (!id || id.textContent.length < 6 || id.textContent.length > 7 || id.title.length < 8 || !id.getAttribute('aria-label').includes(id.title)) throw Error('short batch id');
      const label = summary.querySelector('.review-batch-label');
      const labelBox = label.getBoundingClientRect();
      if (getComputedStyle(summary).display !== 'flex' || box.height > 48 || Math.abs((labelBox.top + labelBox.height / 2) - (box.top + box.height / 2)) > 4) throw Error('sent header is not one line ' + Math.round(box.height));
      id.click();
      if (batch.open) throw Error('copying the batch id toggled the batch');
      if (document.documentElement.scrollWidth > innerWidth) throw Error('sent header overflow');
      return 'sent batch header';
    }`);
    await browser('screenshot', path.join(proof, `review-batch-sent-${width}.png`));
  }
  await evaluate(`() => { document.querySelector('#review-close').click(); return 'review closed after batch header'; }`);
  await evaluate(`() => {
    document.querySelector('#call-lifecycle-filter [data-call-lifecycle="sent"]').click();
    const merge = document.querySelector('[data-call-key="merge:beta-merge"]');
    merge.querySelector('[data-call-answer-again]').click();
    const alpha = document.querySelector('[data-call-key="decision:alpha-call"]');
    if (alpha.querySelector('[data-call-answer]').dataset.callAnswerPhase !== 'compose') throw Error('header thread send did not return alpha to compose');
    if (merge.querySelector('[data-call-answer]').dataset.callAnswerPhase !== 'compose') throw Error('header answer did not return to compose');
    document.activeElement?.blur();
    document.body.click();
    return 'restored compose after header send';
  }`);
  // Phase 2: synthetic source options, merge, changed confirmation, failed retry and receipts.
  const phase = (key, value) => until(`document.querySelector('[data-call-key="${key}"] [data-call-answer]').dataset.callAnswerPhase==='${value}'`);
  const answer = async (key, text, selection = '') => evaluate(`() => { const card=document.querySelector('[data-call-key="${key}"]'); const field=card.querySelector('[data-call-answer-text]'); field.focus(); field.value=${JSON.stringify(text)}; field.dispatchEvent(new Event('input',{bubbles:true})); ${selection ? `const radio=card.querySelector('input[value="${selection}"]'); radio.checked=true; radio.dispatchEvent(new Event('change',{bubbles:true}));` : ''} return 'draft'; }`);
  const action = (key, name) => evaluate(`() => { document.querySelector('[data-call-key="${key}"] [data-call-answer-${name}]').click(); return '${name}'; }`);
  const review = (key) => evaluate(`() => { document.querySelector('[data-call-key="${key}"] .call-answer-queue').click(); return 'review'; }`);
  const disengage = () => evaluate(`() => { document.activeElement?.blur(); document.getSelection().removeAllRanges(); document.body.click(); return 'disengaged'; }`);
  const phoneShot = async (key, name) => {
    await browser('resize', '390', '844');
    await evaluate(`() => { const card=document.querySelector('[data-call-key="${key}"]'); card.querySelector('[data-call-answer]').scrollIntoView({block:'center'}); if(document.documentElement.scrollWidth>innerWidth||card.scrollWidth>card.clientWidth+1)throw Error('answer overflow'); for(const button of card.querySelectorAll('.call-answer button')){if(button.getBoundingClientRect().height && button.getBoundingClientRect().height<44)throw Error('short touch target');} ${beside} beside(card); return '${name} phone geometry'; }`);
    await browser('screenshot', path.join(proof, `captain-answer-${name}-390.png`));
  };
  const attempts = async () => (await readFile(path.join(home,'answer-attempts'),'utf8')).trim().split('\n');
  const envelopeNow = async () => JSON.parse(/```json fm-bearings-answer\n([\s\S]*?)\n```/.exec(await readFile(path.join(home,'answer-note.txt'),'utf8'))[1]);
  await disengage();
  raw.decisions_open[0].options = [{value:'staged',label:'Staged rollout',hint:'Limit exposure while checks continue'},{value:'now',label:'Release now',hint:'Use the full release window'}];
  raw.decisions_open[0].recommend_value = 'staged';
  raw.decisions_open[0].close = 'release';
  // The board already painted these radios. Wait until this snapshot's close mode
  // replaces the card, or a later compose holds the update and the send is refused.
  await evaluate(`() => { window.__alphaRev = document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callRev; return 'rev remembered'; }`);
  await change();
  await until(`document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callRev!==window.__alphaRev && document.querySelector('[data-call-key="decision:alpha-call"]').querySelectorAll('input[type=radio]').length===2 && !document.querySelector('[data-call-key="decision:alpha-call"] [data-call-held]')`);
  await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); if(card.querySelectorAll('.call-opt-rec').length!==1||!card.querySelector('.call-opt:has(input[value=staged]) .call-opt-rec')||card.querySelector('input:checked'))throw Error('source recommendation must not select or answer'); return 'source options and one recommendation'; }`);
  await phoneShot('decision:alpha-call','compose');
  await answer('decision:alpha-call','After the synthetic demo','staged');
  const before = (await attempts()).length;
  await review('decision:alpha-call');
  await phoneShot('decision:alpha-call','confirm');
  assert.equal((await attempts()).length,before,'review is local');
  await action('decision:alpha-call','edit');
  await phase('decision:alpha-call','compose');
  await review('decision:alpha-call');
  await action('decision:alpha-call','send');
  await phase('decision:alpha-call','sent');
  const structured = await envelopeNow();
  assert.deepEqual([structured.question,structured.selection,structured.note,structured.close],['alpha-call','staged','After the synthetic demo','release']);
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); return 'active before sent hide'; }`);
  await until(`document.querySelector('[data-call-key="decision:alpha-call"]').hidden && document.querySelector('[data-call-key="decision:alpha-call"]').dataset.callLifecycle==='sent'`);
  for (const width of [1280, 390]) {
    await browser('resize', String(width), '900');
    await evaluate(`() => { const sent=document.querySelector('#call-lifecycle-filter [data-call-lifecycle="sent"]'), card=document.querySelector('[data-call-key="decision:alpha-call"]'); sent.click(); if(card.hidden||sent.getAttribute('aria-pressed')!=='true'||card.querySelector('[data-call-lifecycle-badge]').getAttribute('aria-label')!=='Sent'||card.querySelector('[data-call-lifecycle-badge]').textContent!==''||document.querySelector('[data-call-answered-heading]'))throw Error('sent status not shown'); if(document.documentElement.scrollWidth>innerWidth||sent.getBoundingClientRect().height<44)throw Error('sent toggle geometry'); document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); if(!card.hidden)throw Error('sent call not hidden from Active'); return 'sent hide/show'; }`);
  }
  for (const width of [1280, 390]) {
    await browser('resize', String(width), '900');
    await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="all"]').click(); const button=document.querySelector('#call-lifecycle-filter [data-call-lifecycle="all"]'); const cards=[...document.querySelectorAll('[data-call-key]')]; if(button.getAttribute('aria-pressed')!=='true'||cards.some((card)=>card.hidden)||document.documentElement.scrollWidth>innerWidth)throw Error('all status'); return 'all status'; }`);
    await browser('screenshot', path.join(proof, `captain-lifecycle-all-${width}.png`));
  }
  await phoneShot('decision:alpha-call','sent');
  await writeFile(path.join(home,'receipt-state'),'received');
  await until(`document.querySelector('[data-call-key="decision:alpha-call"] [data-call-answer-receipt-text]').textContent.includes('received by Firstmate')`);
  await phoneShot('decision:alpha-call','received');
  await writeFile(path.join(home,'receipt-state'),'replied');
  await until(`(() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); const banner=card.querySelector('[data-fm-reply]'); const box=card.querySelector('[data-call-answer-text]'); return card.dataset.callLifecycle==='active' && card.querySelector('[data-call-answer]').dataset.callAnswerPhase==='compose' && !box.readOnly && !box.disabled && banner && !banner.hidden && banner.textContent.includes('Firstmate replied: Synthetic answer recorded'); })()`);
  await phoneShot('decision:alpha-call','replied');
  await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); if(card.dataset.callLifecycle!=='active'||card.querySelector('[data-call-answer]').dataset.callAnswerPhase!=='compose'||card.querySelector('[data-call-answer-text]').value||card.querySelector('input:checked')||card.querySelector('[data-call-answer-text]').readOnly)throw Error('old answer must not be an unsent draft'); return 'empty correction'; }`);
  await answer('decision:alpha-call','A revised synthetic answer','now');
  await review('decision:alpha-call');
  raw.decisions_open[0].summary += ' A changed source condition.';
  await change();
  await until(`!!document.querySelector('[data-call-key="decision:alpha-call"] [data-call-held]')`);
  const changedBefore = (await attempts()).length;
  await disengage();
  await phase('decision:alpha-call','refused');
  await phoneShot('decision:alpha-call','refused');
  await action('decision:alpha-call','send');
  assert.equal((await attempts()).length,changedBefore,'changed reviewed call never sends');
  await writeFile(path.join(home,'fail-answer'),'1');
  await writeFile(path.join(home,'receipt-state'),'accepted');
  await answer('merge:beta-merge','','merge');
  await review('merge:beta-merge');
  await action('merge:beta-merge','send');
  await phase('merge:beta-merge','failed');
  await phoneShot('merge:beta-merge','failed');
  const failedAttempts = await attempts();
  await rm(path.join(home,'fail-answer'));
  await writeFile(path.join(home,'delay-answer'),'1');
  await action('merge:beta-merge','send');
  await phase('merge:beta-merge','sending');
  await phoneShot('merge:beta-merge','sending');
  await phase('merge:beta-merge','sent');
  assert.deepEqual((await attempts()).slice(-2),[failedAttempts.at(-1),failedAttempts.at(-1)],'Retry reuses the exact request id');
  assert.equal((await envelopeNow()).selection,'merge');
  assert.equal((await envelopeNow()).question,'merge.beta-merge');
  await action('merge:beta-merge','again');
  await answer('merge:beta-merge','Only after the synthetic migration','merge');
  await review('merge:beta-merge');
  await action('merge:beta-merge','send');
  await phase('merge:beta-merge','sent');
  assert.equal((await envelopeNow()).selection,'');
  assert.equal((await envelopeNow()).note,'merge - Only after the synthetic migration');
  await rm(path.join(home,'delay-answer'));
  // Full text stays readable from the keyboard. The header pill is the first stop; the next Tab reaches the complete link, and the ask is not clipped.
  await browser('resize','1280','844');
  await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); card.tabIndex=-1; card.focus(); return 'keyboard start'; }`);
  await browser('press','Tab');
  await evaluate(`() => { const card=document.querySelector('[data-call-key="decision:alpha-call"]'); const first=document.activeElement; if(!card.contains(first)||!first.matches('[data-call-procrastinate-toggle]'))throw Error('first tab stop '+(first.className||first.tagName)); return 'header pill first'; }`);
  await browser('press','Tab');
  await evaluate(`() => { const link=document.activeElement; const ask=document.querySelector('[data-call-key="decision:alpha-call"] h3'); const clamp=getComputedStyle(ask).webkitLineClamp; if(!link.matches('a.call-link')||link.textContent!==link.href||ask.scrollHeight>ask.clientHeight+1||getComputedStyle(ask).textOverflow==='ellipsis'||(Boolean(clamp)&&clamp!=='none'))throw Error('link or ask is not fully readable '+(link.className||link.tagName)+' clip '+(ask.scrollHeight-ask.clientHeight)); return 'Tab reached the full link'; }`);
  await writeFile(path.join(proof,'captain-answer-accessibility.txt'),await browser('snapshot'));
  // Quarterdeck is deliberately light; a dark OS preference must not reduce readability.
  await browser('emulate','--color-scheme','dark');
  await phoneShot('decision:alpha-call','dark-preference');
  await browser('emulate','--color-scheme','light');
  await disengage();
  await evaluate(`() => { window.proof={}; proof.alpha=document.querySelector('[data-call-key="decision:alpha-call"]'); proof.beta=document.querySelector('[data-call-key="merge:beta-merge"]'); proof.alphaField=proof.alpha.querySelector('[data-call-answer-text]'); proof.betaField=proof.beta.querySelector('[data-call-answer-text]'); proof.rebuilds=0; new MutationObserver(ms=>proof.rebuilds+=ms.filter(m=>m.target===proof.alpha&&m.type==='childList'&&m.removedNodes.length>1).length).observe(proof.alpha,{childList:true}); return {revision:window.FM_BOOT_REVISION, noTree:!document.querySelector('#projects')}; }`);
  raw.decisions_open[0].summary = 'Changed rollout question'; await change();
  await until("proof.alpha.innerText.includes('Changed rollout question')");
  await evaluate(`() => { if(proof.alpha!==document.querySelector('[data-call-key="decision:alpha-call"]')||proof.beta!==document.querySelector('[data-call-key="merge:beta-merge"]')||proof.betaField!==proof.beta.querySelector('[data-call-answer-text]')||proof.alphaField===proof.alpha.querySelector('[data-call-answer-text]')||proof.rebuilds!==1)throw Error('keyed identity/rebuild failure'); proof.alphaField=proof.alpha.querySelector('[data-call-answer-text]'); proof.rebuilds=0; proof.alphaField.focus(); proof.alphaField.value='Unsent synthetic reminder'; proof.alphaField.dispatchEvent(new Event('input',{bubbles:true})); return 'PASS unengaged keyed inner patch; unchanged node identity'; }`);
  raw.decisions_open[0].summary = 'Latest question after typing'; raw.decisions_open.push({ id: 'extra-call', key: 'extra-call', summary: 'New synthetic call', owner: '(main)', verb: 'captain-hold' });
  raw.contributions.captain.find(c=>c.task==='beta-merge').reason = 'Unengaged beta updates immediately';
  await change();
  await until("!!proof.alpha.querySelector('[data-call-held]') && !!document.querySelector('[data-call-key=\"decision:extra-call\"]') && proof.beta.innerText.includes('Unengaged beta updates immediately')");
  for (const width of [1280,390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { const s=document.querySelector('#captain-call'), notice=proof.alpha.querySelector('[data-call-held]'); proof.alpha.scrollIntoView({block:'center'}); if(proof.alphaField!==proof.alpha.querySelector('[data-call-answer-text]')||proof.rebuilds!==0||proof.alphaField.value!=='Unsent synthetic reminder'||s.inert||s.hasAttribute('data-held')||s.hasAttribute('aria-busy')||!document.querySelector('#call-status').hidden||document.querySelector('#call-status [data-call-update-now]')||getComputedStyle(proof.alphaField).pointerEvents==='none'||document.querySelector('#call-badge').textContent!=='2'||!notice.innerText.includes('Call updated')||notice.querySelector('button').getBoundingClientRect().height<44||proof.beta.querySelector('[data-call-held]')||document.documentElement.scrollWidth>innerWidth||proof.alpha.scrollWidth>proof.alpha.clientWidth+1)throw Error('per-card hold/notice/draft/geometry failure '+JSON.stringify({width:innerWidth,sameField:proof.alphaField===proof.alpha.querySelector('[data-call-answer-text]'),rebuilds:proof.rebuilds,draft:proof.alphaField.value,sectionHeld:s.getAttribute('data-held'),sectionBusy:s.getAttribute('aria-busy'),statusHidden:document.querySelector('#call-status').hidden,badge:document.querySelector('#call-badge').textContent,notice:notice.innerText,buttonHeight:notice.querySelector('button').getBoundingClientRect().height,pageWidth:document.documentElement.scrollWidth,cardWidth:proof.alpha.clientWidth,cardScrollWidth:proof.alpha.scrollWidth})); proof.alphaField.select(); if(proof.alphaField.value.slice(proof.alphaField.selectionStart,proof.alphaField.selectionEnd)!=='Unsent synthetic reminder')throw Error('not copyable'); proof.alphaField.setSelectionRange(0,0); document.getSelection().removeAllRanges(); return {heldMessage:notice.innerText,width:innerWidth}; }`);
    await browser('screenshot', path.join(proof, `captain-call-held-${width}.png`));
  }
  await evaluate(`() => { proof.alpha.querySelector('[data-call-update-now]').click(); return 'local Update now'; }`);
  await until("!proof.alpha.querySelector('[data-call-held]')");
  await evaluate(`() => { if(proof.rebuilds!==1||proof.alpha.querySelector('[data-call-answer-text]').value!=='Unsent synthetic reminder')throw Error('Update now must rebuild once and restore draft'); proof.alpha.querySelector('[data-call-answer-text]').focus(); return 'PASS per-card notice, copyable draft, local Update now'; }`);
  raw.decisions_open = raw.decisions_open.filter(c=>c.id!=='alpha-call'); raw.contributions.captain = raw.contributions.captain.filter(c=>c.task!=='alpha-call'); await change();
  await until("!!proof.alpha.querySelector('[data-call-held]')");
  await evaluate(`() => { if(!proof.alpha.isConnected||!proof.alpha.querySelector('[data-call-held]').innerText.includes('Call resolved')||proof.alpha.classList.contains('call-card-leaving')||!document.querySelector('#call-status').hidden)throw Error('resolved card must wait with local notice'); return 'held removal'; }`);
  await browser('screenshot', path.join(proof, 'captain-call-resolved-held-390.png'));
  await evaluate("() => { proof.alpha.querySelector('[data-call-answer-text]').blur(); document.getSelection().removeAllRanges(); return 'released'; }");
  await until("!!document.querySelector('[data-call-stub]')");
  await evaluate(`() => { const stub=document.querySelector('[data-call-stub]'); if(!stub.querySelector('[data-call-stub-copy]')||!stub.innerText.includes('Unsent synthetic reminder'))throw Error('resolved draft lost'); return 'PASS resolved stub with Copy'; }`);
  // Renew the GET lease explicitly: the longer answer matrix may outlive the boot
  // read's 60-second lease. Hidden tabs have no stream and must not invent a watcher.
  await evaluate(`async () => { await fetch('/api/bearings'); return 'renewed fixture read lease'; }`);
  // Deterministic visibility lifecycle events: no native OS/background claims.
  await evaluate(`() => { Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'}); document.dispatchEvent(new Event('visibilitychange')); return 'synthetic hidden'; }`);
  raw.decisions_open[0].summary = 'Caught up from hidden'; await change();
  // One last GET lease may still watch; wait on hub evidence, not an unbounded sleep.
  for (let i=0;i<350&&!server.bearings.current().cards.some(c=>c.summary==='Caught up from hidden');i++) await new Promise(r=>setTimeout(r,100));
  assert.ok(server.bearings.current().cards.some(c=>c.summary==='Caught up from hidden'));
  await evaluate(`() => { if(document.querySelector('#call-cards').innerText.includes('Caught up from hidden'))throw Error('hidden stream stayed open'); Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'}); document.dispatchEvent(new Event('visibilitychange')); return 'synthetic visible'; }`);
  await until("document.querySelector('#call-cards').innerText.includes('Caught up from hidden')");
  await evaluate(`() => { document.querySelector('#call-lifecycle-filter [data-call-lifecycle="active"]').click(); return 'active list for the default overview'; }`);
  for (let i=0;i<12;i++) raw.decisions_open.push({ id:`scroll-${i}`, key:`scroll-${i}`, summary:`Synthetic scroll call ${i}`, owner:'(main)', verb:'captain-hold' });
  // The ask that was linked to alpha-call becomes its own card once that hold leaves.
  await change(); await until("document.querySelectorAll('[data-call-key]').length===16");
  await evaluate(`() => { document.getSelection().removeAllRanges(); document.activeElement?.blur(); const v=document.querySelector('#overview-view'); v.scrollTop=900; proof.anchor=[...document.querySelectorAll('[data-call-key]')].find(n=>n.getBoundingClientRect().bottom>v.getBoundingClientRect().top); proof.anchor.querySelector('[data-call-answer-text]').focus({preventScroll:true}); proof.anchorTop=proof.anchor.getBoundingClientRect().top; return {anchor:proof.anchor.dataset.callKey,top:proof.anchorTop}; }`);
  raw.decisions_open.unshift({ id:'insert-above',key:'insert-above',summary:'Inserted above scroll anchor',owner:'(main)',verb:'captain-hold' }); await change();
  await until("document.querySelectorAll('[data-call-key]').length===17");
  await evaluate(`() => { const delta=proof.anchor.getBoundingClientRect().top-proof.anchorTop; if(Math.abs(delta)>2||!proof.anchor.contains(document.activeElement))throw Error('engaged scroll anchor moved/lost focus '+delta); return {scrollAnchorDelta:delta}; }`);
  raw.decisions_open = raw.decisions_open.filter(c=>c.id!=='insert-above'); await change();
  await until("!document.querySelector('[data-call-key=\"decision:insert-above\"]')");
  await evaluate(`() => { const delta=proof.anchor.getBoundingClientRect().top-proof.anchorTop; if(Math.abs(delta)>2||!proof.anchor.contains(document.activeElement))throw Error('removal moved engaged anchor '+delta); document.activeElement.blur(); return {removedAnchorDelta:delta}; }`);
  for (const width of [360,390]) {
    await browser('resize', String(width), '844');
    await evaluate(`() => { document.querySelector('#overview-view').scrollTop=0; const kpi=(${captureKpiGeometry.toString()})(); if(innerWidth!==${width}||document.querySelector('#call-mobile-badge').hidden||document.querySelector('#call-mobile-badge').textContent!=='15'||document.documentElement.scrollWidth>innerWidth||kpi.cards.length!==3||kpi.cards.some((c,i)=>c.width<=0||Math.abs(c.top-kpi.cards[0].top)>1||c.scrollWidth>c.clientWidth+1))throw Error('phone/KPI geometry'); return {width:innerWidth,kpi,calls:document.querySelectorAll('[data-call-key]').length}; }`);
    await browser('screenshot', path.join(proof, `captain-call-${width}.png`));
  }
  // Firstmate confirmation is disappearance from bearings, not a receipt reply.
  await disengage();
  raw.contributions.captain = raw.contributions.captain.filter(c => c.task !== 'beta-merge');
  await change();
  await until(`!document.querySelector('[data-call-key="merge:beta-merge"]')`);
  await evaluate(`() => { if(document.querySelector('[data-call-key="merge:beta-merge"]')||document.querySelector('[data-call-answered-heading]')||document.querySelector('#call-answered-toggle'))throw Error('confirmed call remains'); return 'confirmed call removed'; }`);
  await evaluate("() => { location.hash='#work'; return 'Work Split smoke'; }");
  // The fixture publishes one unchecked backlog row so the call can show its full title.
  await until("document.querySelector('#work-view').classList.contains('active') && document.querySelector('#tight-work').innerText.includes('alpha-call')");
  await evaluate("() => { if(!document.querySelector('#work-phase-buttons').children.length||document.documentElement.scrollWidth>innerWidth)throw Error('Work Split smoke failed'); location.hash='#expenses'; return 'Work Split intact'; }");
  await until("document.querySelector('#expenses-view').classList.contains('active')");
  await evaluate("() => { if(!document.querySelector('#expense-entries')||document.documentElement.scrollWidth>innerWidth)throw Error('Expenses smoke failed'); return 'PASS Work Split and Expenses route containment'; }");
  const report = { head, results, scheduler: server.bearings.stats(), visibility: 'synthetic visibility events; native phone/background acceptance remains pending' };
  await writeFile(path.join(proof,'captain-call-live.json'), JSON.stringify(report,null,2));
  console.log(`PASS Captain Call exact revision ${head}; proof ${proof}`);
} catch (error) {
  const snapshot = await browser('snapshot').catch(e => String(e));
  const consoleLog = await browser('console').catch(e => String(e));
  await writeFile(path.join(proof, 'captain-call-failure.json'), JSON.stringify({ head, error: String(error), results, snapshot, consoleLog, model: server.bearings.current(), scheduler: server.bearings.stats() }, null, 2));
  throw error;
} finally {
  clearTimeout(deadline);
  await browser('stop').catch(()=>{});
  await cleanupBrowserProfile(chrome, profile);
  await new Promise(resolve=>server.close(resolve));
  await rm(temp,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
