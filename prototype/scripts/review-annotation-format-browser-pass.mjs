// Isolated spare-port candidate, synthetic guarded intake, and desktop/phone paint proof.
// SCREENSHOT_DIR may name an external proof directory. No private home is read.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { deliverLocalReview, reconcileLocalReview, localReviewStatus, awaitingReviewCount, reviewVersion } from "../review.js";
import { openBrowser, openReadingControls, closeReadingControls } from "./browser-harness.mjs";

assert.match(reviewVersion, /^[a-f0-9]{40}$/, "Use a clean committed candidate");
const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-review-format-"));
const home = path.join(scratch, "home"), receipts = path.join(scratch, "receipts");
await mkdir(path.join(home, "data"), { recursive: true });
await mkdir(path.join(home, "state/main-session"), { recursive: true });
await mkdir(path.join(home, "inbox")); await mkdir(path.join(home, "state/inbox/.requests"), { recursive: true }); await mkdir(path.join(home, "bin"));
await writeFile(path.join(home, "data/projects.md"), "- Demo - Synthetic annotation evidence\n");
await writeFile(path.join(home, "state/main-session/session.jsonl"), JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "assistant", content: "Merged the build fix; CI is green on main.\n\nNext: retry the flaky preview test." } }) + "\n");
const checklist = "Synthetic checklist\n\n- First item\n- Second item\n- Third item";
await writeFile(path.join(home, "inbox/checklist.note"), `at=2026-01-01T00:01:00Z\n--\n${checklist}`);
// An executable fake of the public guarded inbox contract, not direct private-home writes.
await writeFile(path.join(home, "bin/fm-inbox.sh"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const home = process.env.FM_HOME, args = process.argv.slice(2);
if (args[0] === 'ready') console.log(JSON.stringify({schema:'fm-primary-ready.v1',can_receive:true}));
else if (args[0] === 'note') {
  const request_id = args[args.indexOf('--request-id')+1], id = request_id.split(':')[1];
  const body = fs.readFileSync(0,'utf8');
  // Stock layout: the note under its own id plus the request reservation naming it.
  fs.writeFileSync(path.join(home,'state/inbox/.requests',request_id),id+'\\n');
  fs.writeFileSync(path.join(home,'state/inbox',id+'.note'),'id='+id+'\\nat=2030-01-01T00:00:00Z\\nsource=text\\nrequest_id='+request_id+'\\n--\\n'+body);
  console.log(JSON.stringify({schema:'fm-inbox-note.v1',request_id,id,saved:true,announced:true}));
} else if (args[0] === 'receipts') {
  const pending = fs.readdirSync(path.join(home,'state/inbox')).filter(name => /^[0-9a-f-]{36}\\.note$/.test(name)).map(name => ({id:name.slice(0,-5),request_id:'agentos-review:'+name.slice(0,-5),announced:true}));
  console.log(JSON.stringify({schema:'fm-inbox-receipts.v1',pending,handled:[],replies:[],omitted:[]}));
} else process.exit(1);
`, { mode: 0o700 });
const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(scratch, "presentation.json") }, {
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
  localReviewDeliver: (payload) => deliverLocalReview(payload, receipts),
  localReviewReceipt: (payload) => reconcileLocalReview(payload, receipts),
  reviewStatus: (id) => localReviewStatus(id, receipts), reviewCount: (intake) => awaitingReviewCount(receipts, intake),
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/#lanes`;
  console.log(`Spare-port candidate ${url} at ${reviewVersion}`);
  for (const width of [1280, 390]) {
    browser = await openBrowser();
    const { command, evaluate, until } = browser;
    await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 720 });
    await command("Page.navigate", { url });
    // The legacy inbox notes below are unverified input, outside the default feed.
    await until("document.querySelectorAll('article.message').length >= 1 && document.querySelector('#review-context').textContent.includes('Firstmate inbox intake')");
    await evaluate("document.querySelector('#message-type-filters input[value=input]').click()");
    await until("document.querySelectorAll('article.message').length >= 2");
    const clickElement = async (selector, alt = width >= 720) => {
      const point = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); node.scrollIntoView({block:'center'}); const r=node.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
      await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, modifiers: alt ? 1 : 0, ...point });
      await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, modifiers: alt ? 1 : 0, ...point });
    };
    if (width < 720) await evaluate("document.querySelector('#review-toggle').click()");
    const paragraphSelector = await evaluate(`(() => { const p=[...document.querySelectorAll('.message-content p')].find(n=>n.textContent.includes('CI is green')); const article=p.closest('article'); return '[data-lane-message-index="'+article.dataset.laneMessageIndex+'"] .message-content p'; })()`);
    await evaluate(`(() => { const p=document.querySelector(${JSON.stringify(paragraphSelector)}); const node=p.firstChild; const start=node.textContent.indexOf('CI is green'); const range=document.createRange(); range.setStart(node,start); range.setEnd(node,start+11); const selection=getSelection(); selection.removeAllRanges(); selection.addRange(range); })()`);
    await clickElement(paragraphSelector);
    await until("!document.querySelector('#review-annotation').hidden || !document.querySelector('#review-panel').hidden");
    await evaluate("document.querySelector('#review-message').value='Link the CI run here.'; document.querySelector('#review-form').requestSubmit(); document.querySelector('#review-send').click()");
    await until("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.length === 1");
    const batch = await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent[0]");
    const receipt = JSON.parse(await readFile(path.join(receipts, `${batch.id}.json`), "utf8"));
    assert.equal(receipt.payload.schema, "fm-agentos-review.v2");
    const entry = receipt.payload.entries[0];
    assert.equal(entry.tag, "text"); assert.equal(entry.text, "CI is green");
    assert.equal(entry.label, undefined, 'do not duplicate paragraph text as an accessible label');
    assert.equal(entry.target.start.offset, 22); assert.equal(entry.target.end.offset, 33);
    assert.equal(entry.target.prefix, "Merged the build fix; "); assert.equal(entry.target.suffix, " on main.");
    assert.match(entry.record.recordId, /\.jsonl(?:@0|:1):0$/);
    assert.equal(entry.version, undefined); assert.equal(entry.route, undefined);
    const note = await readFile(path.join(home, "state/inbox", `${batch.id}.note`), "utf8");
    assert.match(note, new RegExp(`request_id=agentos-review:${batch.id}`)); assert.match(note, /```json fm-review/);
    await evaluate("document.querySelector('#review-close').click(); getSelection().removeAllRanges(); document.querySelector('#refresh').click()");
    await until(`Array.from(document.querySelectorAll('article.message')).some(node => node.querySelector('.message-source')?.textContent.includes(${JSON.stringify(batch.id)}))`);
    const key = await evaluate(`Array.from(document.querySelectorAll('article.message')).find(node => node.querySelector('.message-source')?.textContent.includes(${JSON.stringify(batch.id)})).dataset.recordKey`);
    const noteSelector = `[data-record-key=${JSON.stringify(key)}]`;
    await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}).scrollIntoView({block:'start'})`);
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command('Page.captureScreenshot', { format: 'png' });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `review-annotation-collapsed-${width}.png`), Buffer.from(data, 'base64'));
    }
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}+' .review-meta').open`), false);
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}+' .message-content').innerText.includes('Quarterdeck review:')`), false);
    const summary = noteSelector + ' [data-review-chip="note-0"] > summary';
    await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`);
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}+' [data-review-chip="note-0"]').open`), true);
    assert.ok(await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}+' [data-review-chip="note-0"] .review-meta-card').innerText.includes('CI is green')`));
    const geometry = await evaluate(`(() => { const chip=document.querySelector(${JSON.stringify(summary)}), r=chip.getBoundingClientRect(); return {width:r.width,height:r.height,overflow:document.documentElement.scrollWidth>innerWidth,feedOverflow:document.querySelector('#messages').scrollWidth>document.querySelector('#messages').clientWidth}; })()`);
    assert.equal(geometry.overflow, false); assert.equal(geometry.feedOverflow, false);
    if (width < 720) { assert.ok(geometry.width >= 32); assert.ok(geometry.height >= 32); }
    await writeFile(path.join(home, 'inbox/refresh-marker.note'), `at=2027-01-01T00:00:00Z\n--\nRefresh marker at ${width}px`);
    await evaluate("document.querySelector('#refresh').click()");
    await until(`document.querySelector(${JSON.stringify(noteSelector)}+' [data-review-chip="note-0"]').open && document.querySelector('#messages').innerText.includes('Refresh marker at ${width}px')`);
    if (process.env.SCREENSHOT_DIR) {
      await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}).scrollIntoView({block:'start'})`);
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `review-annotation-${width}.png`), Buffer.from(data, "base64"));
    }
    await evaluate(`document.querySelector(${JSON.stringify(summary)}).focus()`);
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate(`document.querySelector(${JSON.stringify(noteSelector)}+' [data-review-chip="note-0"]').open`), false);
    // Clicking the third list item retains the exact sub-element plus bounded no-ID identity.
    const liSelector = await evaluate(`(() => { const li=[...document.querySelectorAll('.message-content li')].find(n=>n.textContent==='Third item'); return '[data-lane-message-index="'+li.closest('article').dataset.laneMessageIndex+'"] .message-content li:nth-of-type(3)'; })()`);
    await clickElement(liSelector);
    await evaluate("document.querySelector('#review-message').value='Clarify the third item.'");
    await until("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).selected?.record?.sha256");
    await evaluate("document.querySelector('#review-form').requestSubmit(); document.querySelector('#review-send').click()");
    await until("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.length === 2");
    const second = await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent[1].entries[0]");
    assert.equal(second.tag, "li"); assert.match(second.selector, /\.message-content > ul > li:nth-of-type\(3\)$/);
    assert.equal(second.text, "Third item"); assert.match(second.record.sha256, /^[a-f0-9]{16}$/);
    assert.equal(second.record.source, "inbox/checklist.note"); assert.equal(second.record.at, "2026-01-01T00:01:00.000Z");
    assert.ok(!JSON.stringify(second).includes(checklist));
    // Metadata-only search opens the annotation card; raw view keeps the full body.
    await evaluate("document.querySelector('#review-close').click(); document.querySelector('#refresh').click()");
    await until(`document.querySelectorAll('.review-prompts').length >= ${width === 1280 ? 2 : 4}`);
    await openReadingControls(browser);
    await evaluate("const search=document.querySelector('#transcript-search'); search.value='commonAncestorSelector'; search.dispatchEvent(new Event('input',{bubbles:true}))");
    await closeReadingControls(browser);
    await until("document.querySelector('.review-meta[data-review-chip=note-0]')?.open");
    assert.ok(await evaluate("document.querySelector('.review-prompt-line').innerText.includes('Link the CI run here.')"));
    // Send takes text still in the compose box together with notes already queued.
    await evaluate(`(() => {
      const panel = document.querySelector('#review-panel');
      if (panel.hidden) document.querySelector('#review-panel-toggle').click();
      document.querySelector('#review-conversation-tab').click();
      const message = document.querySelector('#review-message');
      message.value = 'Queued before the batch.';
      message.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#review-form').requestSubmit();
      message.value = 'Typed with the queued note.';
      message.dispatchEvent(new Event('input', { bubbles: true }));
      message.scrollIntoView({ block: 'center' });
    })()`);
    await until("!document.querySelector('#review-send').disabled && document.querySelector('#review-message').value === 'Typed with the queued note.' && JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).queue.some(entry => entry.prompt === 'Queued before the batch.')");
    if (process.env.SCREENSHOT_DIR) {
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `send-batch-compose-${width}.png`), Buffer.from(data, "base64"));
    }
    await evaluate("document.querySelector('#review-send').click()");
    await until("document.querySelector('#review-message').value === '' && JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.some(batch => batch.entries.some(entry => entry.prompt === 'Typed with the queued note.'))");
    const combined = await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent.find(batch => batch.entries.some(entry => entry.prompt === 'Typed with the queued note.')).entries.map(entry => entry.prompt)");
    assert.deepEqual(combined, ["Queued before the batch.", "Typed with the queued note."]);
    if (process.env.SCREENSHOT_DIR) {
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `send-batch-compose-sent-${width}.png`), Buffer.from(data, "base64"));
    }
    console.log(`PASS ${width}px: text-range receipt/intake, prompt-only chips, keyboard/open-state, no overflow, clicked list item/fingerprint, metadata search, send batch includes compose`);
    await browser.close(); browser = null;
  }
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
