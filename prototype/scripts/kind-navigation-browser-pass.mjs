// Generic-only kind navigation, including the bounded recent-window path.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { openBrowser, openReadingControls, closeReadingControls } from "./browser-harness.mjs";
import { writeVerifiedReviewNote } from "./verified-send-fixture.mjs";

const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-kinds-"));
await mkdir(path.join(scratch, "data"));
await mkdir(path.join(scratch, "state/main-session"), { recursive: true });
await writeFile(path.join(scratch, "data/projects.md"), "- Alpha - Synthetic fleet\n- Beta - Synthetic fleet\n");
// Captain slots are verified Quarterdeck sends; transcript role=user input is never the Captain's.
const captainSlot = i => !(i >= 201 && i <= 350 || i === 450) && i % 20 === 0;
const slotTime = i => new Date(Date.UTC(2030, 0, 1, 12, i)).toISOString();
const writeCaptainNotes = async () => {
  for (let i = 0; i < 451; i++) if (captainSlot(i)) await writeVerifiedReviewNote(scratch, { at: slotTime(i), prompt: `Alpha update ${i}: Synthetic kind navigation.` });
};
const fixture = padding => Array.from({ length: 451 }, (_, i) => {
  if (captainSlot(i)) return null;
  const mixed = i >= 201 && i <= 350 || i === 450;
  const text = (mixed ? ["General", "Alpha", "Beta"] : ["Alpha"]).map(name =>
    `[fm-lane ${name}]\n${name} update ${i}: **Synthetic kind navigation**.\n${padding || "Readable body."}\n[end ${name}]`).join("\n\n");
  return JSON.stringify({ type: "message", timestamp: new Date(Date.UTC(2030, 0, 1, 12, i)).toISOString(), message: {
    role: i === 370 ? "toolResult" : "assistant",
    toolName: i === 370 ? "Synthetic tool" : undefined, content: [{ type: "text", text }],
  } });
}).filter(Boolean).join("\n") + "\n";
const requests = [];
const server = createServer({}, {
  lanesReader: async (_, options) => loadFirstmateHome(scratch, options),
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
});
server.on("request", req => {
  if (req.url.startsWith("/api/lanes")) requests.push(Number(new URL(req.url, "http://localhost").searchParams.get("windowBytes")));
});
let browser;
try {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/#lanes`;
  const evaluate = (...args) => browser.evaluate(...args), until = (...args) => browser.until(...args);
  const enter = async () => {
    await browser.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await browser.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  };
  const screenshot = async name => {
    if (!process.env.SCREENSHOT_DIR) return;
    await mkdir(process.env.SCREENSHOT_DIR, { recursive: true });
    const { data } = await browser.command("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(process.env.SCREENSHOT_DIR, name), Buffer.from(data, "base64"));
  };
  for (const [width, height] of [[1600, 900], [390, 844]]) {
    const openKinds = async () => {
      if (width < 720) await evaluate("if(document.querySelector('#lane-filter-toggle').getAttribute('aria-expanded')!=='true') document.querySelector('#lane-filter-toggle').click(); document.querySelector('#mobile-kinds-tab').click()");
    };
    const jump = async (kind, step, expected) => {
      await openKinds();
      const selector = `button[data-kind-jump="${kind}"][data-kind-step="${step}"]`;
      assert.equal(await evaluate(`document.querySelector(${JSON.stringify(selector)}).disabled`), false, selector);
      await evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
      await enter();
      await until(`document.activeElement?.matches('article.message[data-record-index="${expected}"]')`);
      assert.ok(await evaluate(`document.activeElement.classList.contains('last-viewed-highlight')`));
      assert.ok(Math.abs(await evaluate("document.activeElement.getBoundingClientRect().top-document.querySelector('#messages').getBoundingClientRect().top") - 12) < 2);
      if (width < 720) assert.equal(await evaluate("document.querySelector('#lane-options').hidden"), true, "phone sheet closes to reveal the destination");
    };
    const position = async index => {
      await evaluate(`(() => {const f=document.querySelector('#messages'),n=f.querySelector('article[data-record-index="${index}"]'); f.scrollTop+=n.getBoundingClientRect().top-f.getBoundingClientRect().top-12;})()`);
      await until(`document.querySelector('article[data-record-index="${index}"]').getBoundingClientRect().top-document.querySelector('#messages').getBoundingClientRect().top<14`);
    };
    await writeCaptainNotes();
    await writeFile(path.join(scratch, "state/main-session/session.jsonl"), fixture(""));
    browser = await openBrowser();
    await browser.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await browser.command("Page.navigate", { url });
    await until("document.querySelectorAll('article.message').length>0");
    await evaluate("while(true){const n=[...document.querySelectorAll('#lane-filter-rows input')].find(n=>n.checked!==(n.dataset.filterLane==='alpha'));if(!n)break;n.click();} document.querySelector('#message-type-filters input[value=tools]').click()");
    await openReadingControls(browser);
    await evaluate("document.querySelector('#message-compact-toggle').click()");
    await closeReadingControls(browser);
    // Compact tail rows cannot be placed at the top when fewer than one
    // viewport remains. Use a reachable cursor, then exercise the last target
    // after the first kind jump has expanded the full records.
    await position(411);
    await jump("captain", 1, 420);
    await jump("captain", 1, 440);
    assert.equal(await evaluate("document.querySelector('button[data-kind-jump=captain][data-kind-step=\"1\"]').disabled"), true, "no later captain message exists");
    await jump("captain", -1, 420);
    await jump("captain", -1, 400);
    await jump("captain", -1, 380);
    assert.match(await evaluate("document.querySelector('#transcript-page').textContent"), /201–400 of 451/);
    assert.equal(await evaluate("document.querySelector('#messages').classList.contains('is-compact')"), false);
    await evaluate("document.querySelector('.kind-tools details').open=false");
    await jump("tools", -1, 370);
    assert.equal(await evaluate("document.activeElement.querySelector('details').open"), true);
    await evaluate("for(const i of [349,350]) {const n=document.querySelector(`article[data-record-index=\"${i}\"] .mixed-lane-section:last-child .mixed-lane-toggle`); if(n.getAttribute('aria-expanded')==='true')n.click();}");
    await position(351);
    await jump("conversation", -1, 350);
    assert.equal(await evaluate("document.activeElement.querySelectorAll('.mixed-lane-toggle[aria-expanded=false]').length"), 0, "same-page collapsed lanes reveal without discarding other choices");
    assert.equal(await evaluate("document.querySelector('article[data-record-index=\"349\"] .mixed-lane-section:last-child .mixed-lane-toggle').getAttribute('aria-expanded')"), "false");
    await screenshot(`kind-target-${width}x${height}.png`);
    // Fleet jumps share the same strict anchor, page reveal and focus behavior.
    const openFleets = async () => {
      await evaluate("if(innerWidth<720){if(document.querySelector('#lane-filter-toggle').getAttribute('aria-expanded')!=='true')document.querySelector('#lane-filter-toggle').click();document.querySelector('#mobile-lanes-tab').click();}else if(document.querySelector('#lane-options').dataset.collapsed==='true')document.querySelector('#lane-panel-toggle').click()");
    };
    await openFleets();
    assert.equal(await evaluate("[...document.querySelectorAll('button[data-fleet-jump=beta]')].every(n=>n.disabled)"), true, "excluded fleet cannot change selection via navigation");
    await evaluate("document.querySelector('#lane-filter-rows input[data-filter-lane=beta]').click(); document.querySelector('#transcript-older').click()");
    await position(351);
    await openFleets();
    await evaluate("document.querySelector('button[data-fleet-jump=beta][data-kind-step=\"-1\"]').focus()");
    await enter();
    await until("document.activeElement?.matches('article.message[data-record-index=\"350\"]')");
    assert.equal(await evaluate("document.querySelector('#sr-announcer').textContent"), "Previous message from Beta.");
    assert.equal(await evaluate("document.querySelector('#lane-filter-rows input[data-filter-lane=alpha]').checked && document.querySelector('#lane-filter-rows input[data-filter-lane=beta]').checked"), true);
    await openFleets();
    const fleetControls = await evaluate("[...document.querySelectorAll('button[data-fleet-jump]')].map(n=>({width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))");
    for (const control of fleetControls) assert.ok(control.width >= (width < 720 ? 44 : 24) && control.height >= (width < 720 ? 44 : 24));
    await screenshot(`fleet-controls-light-${width}x${height}.png`);
    // The current app has a light-only palette. Exercise shared arrow tokens
    // under a synthetic dark palette without introducing a product theme.
    await evaluate("document.documentElement.style.cssText='--surface:#18201d;--surface-soft:#26322c;--canvas:#111814;--text:#e9f1ec;--muted:#a5b7ac;--line-strong:#637c6d;--accent:#93d6b1;--accent-soft:#263f32'");
    await screenshot(`fleet-controls-dark-tokens-${width}x${height}.png`);
    await evaluate("document.documentElement.removeAttribute('style')");
    await evaluate("document.querySelector('#message-type-filters input[value=thinking]').click()");
    await openKinds();
    assert.equal(await evaluate("[...document.querySelectorAll('button[data-kind-jump=thinking]')].every(n=>n.disabled)"), true, "absent native kind has no invented targets");
    const controls = await evaluate("[...document.querySelectorAll('button[data-kind-jump]')].map(n=>({label:n.getAttribute('aria-label'),width:n.getBoundingClientRect().width,height:n.getBoundingClientRect().height}))");
    assert.equal(controls.length, 22, "eleven kinds, including Firstmate progress, each have Previous and Next controls");
    for (const control of controls) {
      assert.match(control.label, /^(Previous|Next) /);
      assert.ok(control.width >= (width < 720 ? 44 : 24) && control.height >= (width < 720 ? 44 : 24), JSON.stringify(control));
    }
    await screenshot(`kind-controls-full-${width}x${height}.png`);
    await openReadingControls(browser);
    await evaluate("document.querySelector('#message-compact-toggle').click()");
    await closeReadingControls(browser);
    await screenshot(`kind-controls-compact-${width}x${height}.png`);
    assert.equal(await evaluate("document.documentElement.scrollWidth>innerWidth"), false);
    await browser.close(); browser = null;

    // A >1 MiB archive makes Previous explicitly demand older source records. Inbox
    // sends are never windowed, so this transcript-window case runs without them.
    await rm(path.join(scratch, "state/inbox"), { recursive: true, force: true });
    await writeFile(path.join(scratch, "state/main-session/session.jsonl"), fixture(" padding".repeat(256)));
    const start = requests.length;
    browser = await openBrowser();
    await browser.command("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    await browser.command("Page.navigate", { url });
    await until("document.querySelectorAll('article.message').length>0 && !document.querySelector('#transcript-window-status').hidden");
    await evaluate("while(true){const n=[...document.querySelectorAll('#lane-filter-rows input')].find(n=>n.checked!==(n.dataset.filterLane==='alpha'));if(!n)break;n.click();} while(!document.querySelector('#transcript-older').disabled)document.querySelector('#transcript-older').click(); document.querySelector('#messages').scrollTop=0");
    const anchor = await evaluate("({key:document.querySelector('article.message').dataset.recordKey,time:document.querySelector('article.message time').getAttribute('datetime')})");
    await openFleets();
    await evaluate("document.querySelector('button[data-fleet-jump=alpha][data-kind-step=\"-1\"]').focus()");
    await enter();
    await until("document.activeElement?.matches('article.message') && document.activeElement.classList.contains('last-viewed-highlight')");
    assert.ok(await evaluate("document.activeElement.querySelector('time').getAttribute('datetime')") < anchor.time);
    assert.ok(await evaluate(`!![...document.querySelectorAll('article.message')].find(n=>n.dataset.recordKey===${JSON.stringify(anchor.key)})`), "byte-offset identity survives partial-to-whole-file expansion");
    assert.deepEqual(requests.slice(start), [1024 * 1024, 2 * 1024 * 1024], "recent first load, then exactly one explicit bounded expansion");
    assert.equal(await evaluate("document.querySelector('#transcript-window-status').hidden"), true);
    await screenshot(`kind-older-source-${width}x${height}.png`);
    await browser.close(); browser = null;
    console.log(`${width}x${height}: kind arrows, strict relative cursor, cross-page jumps, compact/full and same-page disclosure reveal, native tools, absent kinds, touch targets, and bounded older-source load passed`);
  }
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
