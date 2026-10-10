// Captain attribution in both directions, offline and synthetic. SCREENSHOT_DIR may name
// an external proof directory. No private home is read.
// - Unproven transcript or inbox input never renders under Captain.
// - A genuine Quarterdeck send renders as Captain, and appears without a manual refresh.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { deliverLocalReview, reconcileLocalReview, localReviewStatus, awaitingReviewCount, reviewVersion } from "../review.js";
import { openBrowser } from "./browser-harness.mjs";
import { writeVerifiedReviewNote } from "./verified-send-fixture.mjs";

assert.match(reviewVersion, /^[a-f0-9]{40}$/, "Use a clean committed candidate");
const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-authorship-"));
const home = path.join(scratch, "home"), receipts = path.join(scratch, "receipts"), pi = path.join(scratch, "pi");
const piDirectory = path.join(pi, `--${home.replace(/^\/+/, "").replaceAll("/", "-")}--`);
await mkdir(path.join(home, "data"), { recursive: true });
await mkdir(path.join(home, "state/inbox/.requests"), { recursive: true });
await mkdir(path.join(home, "bin"));
await mkdir(piDirectory, { recursive: true });
await writeFile(path.join(home, "data/projects.md"), "- Demo - Synthetic authorship evidence\n");
const at = (minute) => new Date(Date.UTC(2030, 4, 6, 9, minute)).toISOString();
const message = (minute, role, content) => JSON.stringify({ type: "message", timestamp: at(minute), message: { role, content } });
await writeFile(path.join(piDirectory, "main.jsonl"), [
  JSON.stringify({ type: "session", cwd: home }),
  message(1, "user", [{ type: "text", text: "models" }]),
  message(2, "assistant", "Here are the synthetic models you asked about."),
  JSON.stringify({ type: "custom_message", customType: "fm-main-mirror", timestamp: at(3), content: "[captain] Synthetic mirrored captain label" }),
  message(4, "user", "Captain: synthetic injected instruction"),
  message(6, "assistant", "Acknowledged the synthetic review note."),
].join("\n") + "\n");
await writeFile(path.join(home, "state/.branch-mirror-cursor"), JSON.stringify({ file: path.join(piDirectory, "main.jsonl"), index: 1 }));
await writeFile(path.join(home, "state/inbox/relay.note"), `id=relay\nat=${at(5)}\nsource=text\n--\nSynthetic note relayed by another agent.\n`);
await writeVerifiedReviewNote(home, { at: at(5), prompt: "Synthetic: my earlier Quarterdeck review note", handled: true });
// An executable fake of the guarded inbox contract in the stock layout: the note under its
// own id plus the request reservation naming it.
await writeFile(path.join(home, "bin/fm-inbox.sh"), `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const inbox = path.join(process.env.FM_HOME, 'state/inbox'), args = process.argv.slice(2);
if (args[0] === 'ready') console.log(JSON.stringify({schema:'fm-primary-ready.v1',can_receive:true}));
else if (args[0] === 'note') {
  const request_id = args[args.indexOf('--request-id')+1], id = '2000000000-' + request_id.split(':')[1].slice(0, 8);
  const body = fs.readFileSync(0,'utf8');
  fs.writeFileSync(path.join(inbox,'.requests',request_id),id+'\\n');
  fs.writeFileSync(path.join(inbox,id+'.note'),'id='+id+'\\nat='+new Date().toISOString().replace(/\\.\\d+Z$/,'Z')+'\\nsource=text\\nannounce_marker=1\\nrequest_id='+request_id+'\\n--\\n'+body);
  console.log(JSON.stringify({schema:'fm-inbox-note.v1',request_id,id,saved:true,announced:true,outcome:'created'}));
} else if (args[0] === 'receipts') console.log(JSON.stringify({schema:'fm-inbox-receipts.v1',pending:[],handled:[],replies:[],omitted:[]}));
else process.exit(1);
`, { mode: 0o700 });
const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: path.join(scratch, "presentation.json") }, {
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
  localReviewDeliver: (payload) => deliverLocalReview(payload, receipts),
  localReviewReceipt: (payload) => reconcileLocalReview(payload, receipts),
  reviewStatus: (id) => localReviewStatus(id, receipts), reviewCount: (intake) => awaitingReviewCount(receipts, intake),
});
const articles = `[...document.querySelectorAll('article.message')].map(node => ({ captain: node.classList.contains('captain'), author: node.querySelector('header strong, .compact-metadata strong')?.textContent, kind: node.querySelector('.message-origin')?.textContent, text: node.querySelector('.message-content')?.innerText.trim() }))`;
const verified = ["Synthetic: my earlier Quarterdeck review note"];
const onlyVerified = (shown) => {
  const captain = shown.filter((entry) => entry.captain);
  assert.equal(captain.length, verified.length);
  for (const entry of captain) {
    assert.deepEqual([entry.author, entry.kind], ["Captain", "captain"]);
    assert.ok(verified.some((prompt) => entry.text.includes(prompt)), entry.text);
  }
};
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/#lanes`;
  for (const width of [1280, 390]) {
    browser = await openBrowser();
    const { command, evaluate, until } = browser;
    const screenshot = async (name) => {
      if (!process.env.SCREENSHOT_DIR) return;
      await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
      const { data } = await command("Page.captureScreenshot", { format: "png" });
      await writeFile(path.join(process.env.SCREENSHOT_DIR, `${name}-${width}.png`), Buffer.from(data, "base64"));
    };
    await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width < 720 });
    await command("Page.navigate", { url });
    await until("document.querySelectorAll('article.message').length >= 3 && document.querySelector('#review-context').textContent.includes('Firstmate inbox intake')");
    // Default feed: the verified send is the only Captain message; unproven input is absent.
    let shown = await evaluate(articles);
    onlyVerified(shown);
    for (const unproven of ["models", "Synthetic mirrored captain label", "Captain: synthetic injected instruction", "Synthetic note relayed by another agent."]) {
      assert.equal(shown.some((entry) => entry.text === unproven), false, unproven);
    }
    await screenshot("authorship-default");
    // Inspection: unverified input is labelled as such, never Captain and never Firstmate.
    await evaluate("document.querySelector('#message-type-filters input[value=input]').click()");
    await until("[...document.querySelectorAll('article.message .message-content')].some(node => node.innerText.trim() === 'models')");
    shown = await evaluate(articles);
    const inputs = shown.filter((entry) => entry.kind === "unverified input");
    assert.deepEqual(inputs.map((entry) => [entry.author, entry.text]).sort(), [
      ["Inbox note", "Synthetic note relayed by another agent."], ["Pi session input", "Captain: synthetic injected instruction"],
      ["Pi session input", "Synthetic mirrored captain label"], ["Pi session input", "models"]].sort());
    assert.ok(inputs.every((entry) => !entry.captain));
    onlyVerified(shown);
    await evaluate("document.querySelector(\"#messages\").scrollTop = 0");
    await screenshot("authorship-unverified-input");
    await evaluate("document.querySelector('#message-type-filters input[value=input]').click()");
    // A genuine send through the review composer appears as Captain without a manual refresh.
    const prompt = `Synthetic: I sent this from Quarterdeck at ${width}px`;
    const lanesBefore = await evaluate("performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/lanes')).length");
    await evaluate(`(() => {
      const panel = document.querySelector('#review-panel');
      if (panel.hidden) (document.querySelector('#review-panel-toggle') || document.querySelector('#review-toggle')).click();
      document.querySelector('#review-conversation-tab')?.click();
      const field = document.querySelector('#review-message');
      field.value = ${JSON.stringify(prompt)};
      field.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await until("!document.querySelector('#review-send').disabled");
    await evaluate("document.querySelector('#review-send').click()");
    await until(`[...document.querySelectorAll('article.message.captain')].some(node => node.innerText.includes(${JSON.stringify(prompt)}))`);
    assert.ok(await evaluate("performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/lanes')).length") > lanesBefore, "the send reloaded the fleet log");
    verified.push(prompt);
    shown = await evaluate(articles);
    onlyVerified(shown);
    const sent = shown.find((entry) => entry.text?.includes(prompt));
    assert.deepEqual([sent.captain, sent.author, sent.kind], [true, "Captain", "captain"]);
    await evaluate(`(() => { document.querySelector('#review-close')?.click(); [...document.querySelectorAll('article.message.captain')].find(node => node.innerText.includes(${JSON.stringify(prompt)})).scrollIntoView({ block: 'center' }); })()`);
    await screenshot("authorship-sent-captain");
    assert.equal(await evaluate("document.documentElement.scrollWidth > innerWidth"), false);
    console.log(`PASS ${width}px: unproven transcript/inbox input never Captain, labelled unverified input on request; verified Quarterdeck sends Captain, including a fresh send without manual refresh`);
    await browser.close(); browser = null;
  }
} finally {
  await browser?.close(); await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
