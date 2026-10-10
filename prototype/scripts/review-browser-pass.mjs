// Exact-build, direct local Chromium smoke. Run: node scripts/review-browser-pass.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { localReviewDir } from "../review.js";

const chromium = process.env.CHROMIUM || "chromium";
const profile = await mkdtemp(path.join(process.cwd(), ".review-chrome-"));
const batches = [];
let releaseHeld = null;
const receiver = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    const batch = JSON.parse(body);
    batches.push(batch);
    const reply = () => { res.writeHead(200, { "content-type": "application/json" }); res.end('{"receiptId":"chromium-receipt"}'); };
    if (batch.entries.some((entry) => entry.prompt === "Cutoff first")) releaseHeld = reply;
    else reply();
  });
});
const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
await listen(receiver);
const app = createServer({ FM_LAVISH_REVIEW_URL: `http://127.0.0.1:${receiver.address().port}/review`, FM_LAVISH_REVIEW_SESSION: "chromium-fixture" });
await listen(app);
const base = `http://127.0.0.1:${app.address().port}`;
const chrome = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
let ws;
let nextId = 0;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const close = (server) => new Promise((resolve) => server.close(resolve));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "Chromium CDP port opened");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  const pending = new Map();
  let staleConfigOnce = false;
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (reply.method === "Fetch.requestPaused") {
      if (staleConfigOnce && reply.params.request.method === "GET" && reply.params.request.url.endsWith("/api/review")) {
        staleConfigOnce = false;
        void cmd("Fetch.fulfillRequest", { requestId: reply.params.requestId, responseCode: 200,
          responseHeaders: [{ name: "content-type", value: "application/json" }],
          body: Buffer.from(JSON.stringify({ version: "0000000000000000000000000000000000000000", ready: true, delivery: "lavish", sessionId: "chromium-fixture" })).toString("base64") });
        void cmd("Fetch.disable");
      } else void cmd("Fetch.continueRequest", { requestId: reply.params.requestId });
    }
    if (!pending.has(reply.id)) return;
    const { resolve, reject } = pending.get(reply.id);
    pending.delete(reply.id);
    reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evalJs = async (code) => {
    const result = await cmd("Runtime.evaluate", { expression: code, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cmd("Page.enable");
  await cmd("Page.navigate", { url: base });
  let loaded = false;
  for (let i = 0; i < 100; i++) {
    loaded = await evalJs('Boolean(document.querySelector(".project-card") && document.querySelector("#review-toggle"))');
    if (loaded) break;
    await wait(100);
  }
  assert.ok(loaded, "exact Quarterdeck build loaded Overview in Chromium");
  for (const width of [390, 1280]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
    const layout = await evalJs(`(() => {
      const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; };
      return { gesture: rect('.review-gesture'), row: rect('.lane-chats-row'), nav: rect('.primary-nav'), refresh: rect('#refresh'), content: rect('#overview-view'), footer: rect('.source-status'), all: getComputedStyle(document.querySelector('.lane-select-all')).display, position: getComputedStyle(document.querySelector('.review-gesture')).position, overflow: document.documentElement.scrollWidth > innerWidth, checked: document.querySelector('#review-toggle').checked };
    })()`);
    const g = layout.gesture;
    const separated = (a, b) => a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top;
    assert.equal(layout.overflow, false);
    assert.equal(layout.checked, false, 'review starts in click-to-interact mode');
    if (width === 390) {
      assert.equal(layout.all, "none");
      await evalJs("document.querySelector('.mobile-more').click()");
      const mode = await evalJs(`(() => { const input = document.querySelector('#review-toggle'), r = input.getBoundingClientRect(); return { parent: input.closest('#mobile-tools') !== null, width: r.width, height: r.height, visible: getComputedStyle(input).opacity }; })()`);
      assert.ok(mode.parent && mode.width >= 22 && mode.height >= 22 && mode.visible === '1', 'phone checkbox is accessible in More');
      await evalJs("document.querySelector('#review-toggle').click()");
      assert.equal(await evalJs("document.querySelector('#review-toggle').checked"), true, "phone annotation mode enables");
      await evalJs("document.querySelector('#review-toggle').click(); document.querySelector('#mobile-tools .mobile-sheet-close').click()");
      assert.equal(await evalJs("document.querySelector('#review-toggle').checked"), false, "phone annotation mode disables");
      await evalJs("document.querySelector('#review-toggle').click()");
      const contentPoint = await evalJs(`(() => { const node = document.querySelector('.project-card .lane-intent'); node.scrollIntoView({ block: 'center' }); const r = node.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await cmd("Input.dispatchMouseEvent", { type: "mousePressed", ...contentPoint, button: "left", clickCount: 1 });
      await cmd("Input.dispatchMouseEvent", { type: "mouseReleased", ...contentPoint, button: "left", clickCount: 1 });
      assert.equal(await evalJs("!document.querySelector('#review-panel').hidden && document.querySelector('#review-target').textContent.includes('Annotating')"), true, "phone content tap opens annotation without Alt or hover");
      await evalJs("document.querySelector('#review-close').click(); document.querySelector('#review-close').click(); document.querySelector('#review-toggle').click()");
    } else {
      assert.notEqual(layout.position, "fixed");
      assert.equal(layout.all, "none", 'desktop All filter lives in the Lane Chat panel, not the app shell');
      assert.equal(await evalJs("Boolean(document.querySelector('#lane-options #lane-filter-rows'))"), true);
      assert.ok(g.top >= layout.footer.top && g.bottom <= layout.footer.bottom, "desktop toggle remains in footer");
    }
  }
  await cmd("Emulation.clearDeviceMetricsOverride");
  const outcome = await evalJs(`(async () => {
    const q = (s) => document.querySelector(s);
    const click = (s) => q(s).click();
    const pointerClick = (s, altKey = false) => q(s).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, altKey }));
    const initial = { mode: q('#review-toggle').checked, panel: q('#review-panel').hidden, chat: q('#review-panel-toggle').hidden, hash: location.hash };
    click('#review-toggle'); // Exercise the prior click-to-annotate path explicitly.
    const overview = q('#overview-view');
    q('#call-cards').style.minHeight = '2000px';
    overview.scrollTop = 120;
    const beforeScroll = overview.scrollTop;
    pointerClick('[data-view="preferences"].primary-tab');
    const normalControlOn = location.hash === '#preferences';
    pointerClick('[data-view="overview"].primary-tab', true);
    const altInteractsOn = location.hash === '#overview';
    const annotationIntercepted = !pointerClick('.project-card .lane-intent') && (!q('#review-panel').hidden || !q('#review-annotation').hidden) && location.hash === '#overview';
    click('#review-close');
    click('#review-toggle');
    const hiddenWhenOff = q('#review-panel').hidden;
    const normalOff = pointerClick('.project-card .lane-intent') && q('#review-panel').hidden;
    const altAnnotatesOff = !pointerClick('.project-card .lane-intent', true) && (!q('#review-panel').hidden || !q('#review-annotation').hidden);
    click('#review-close');
    click('#review-toggle');
    click('[data-view="overview"].primary-tab');
    const keyboardActivated = location.hash === '#overview';
    pointerClick('[data-view="preferences"].primary-tab', true);
    pointerClick('[data-view="overview"].primary-tab', true);
    const normalWithAlt = location.hash === '#overview';
    const afterScroll = overview.scrollTop;
    pointerClick('.project-card .lane-intent');
    const target = q('#review-target').textContent;
    q('#review-message').value = 'Annotated project'; click('#review-queue');
    q('#review-message').value = 'Free message'; click('#review-queue');
    const count = q('#review-count').textContent;
    click('#review-send');
    for (let i=0; i<50 && !q('#review-state').textContent.includes('chromium-receipt'); i++) await new Promise(r=>setTimeout(r,50));
    const sent = q('#review-state').textContent;
    q('#review-message').value = 'Finish review'; click('#review-queue');
    click('#review-end');
    for (let i=0; i<50 && !q('#review-panel').hidden; i++) await new Promise(r=>setTimeout(r,50));
    pointerClick('.project-card .lane-intent');
    const stillAvailable = q('#review-target').textContent.includes('Annotating') && (!q('#review-panel').hidden || !q('#review-annotation').hidden);
    return { initial, normalControlOn, normalOff, altInteractsOn, altAnnotatesOff, hiddenWhenOff, annotationIntercepted, keyboardActivated, normalWithAlt, beforeScroll, afterScroll, target, count, sent, ended: q('#review-toggle').checked, stillAvailable, hash: location.hash };
  })()`);
  assert.deepEqual(outcome.initial, { mode: false, panel: true, chat: false, hash: "#overview" });
  assert.equal(outcome.normalControlOn, true);
  assert.equal(outcome.altInteractsOn, true);
  assert.equal(outcome.normalOff, true);
  assert.equal(outcome.altAnnotatesOff, true);
  assert.equal(outcome.hiddenWhenOff, true);
  assert.equal(outcome.annotationIntercepted, true);
  assert.equal(outcome.keyboardActivated, true);
  assert.equal(outcome.normalWithAlt, true);
  assert.equal(outcome.beforeScroll, 120);
  assert.equal(outcome.afterScroll, 120);
  assert.match(outcome.target, /Annotating/);
  assert.equal(outcome.count, "· 2 queued");
  assert.match(outcome.sent, /chromium-receipt/);
  assert.equal(outcome.ended, true);
  assert.equal(outcome.stillAvailable, true);
  assert.equal(outcome.hash, "#overview");
  for (let i = 0; i < 100 && batches.length < 2; i++) await wait(50);
  assert.equal(batches.length, 2, 'Send & end delivers the second batch before closing');
  assert.equal(batches[0].schema, "fm-agentos-review.v2");
  assert.notEqual(batches[0].entries[0].tag, "message");
  assert.equal(batches[0].entries[1].tag, "message");
  assert.match(batches[0].entries[0].region.id, /^project:/);
  assert.equal(batches[0].end, false);
  assert.equal(batches[1].end, true);
  // A page retained across a server revision change must not ask for an
  // impossible same-ID retry. Intercept only its first config GET; the POST
  // reaches the real current-version server and is rejected before delivery.
  staleConfigOnce = true;
  await cmd("Fetch.enable", { patterns: [{ urlPattern: "*/api/review", requestStage: "Request" }] });
  await cmd("Page.navigate", { url: `${base}/?stale-page=1#overview` });
  for (let i = 0; i < 100; i++) {
    if (await evalJs('document.querySelector("#review-context")?.textContent.includes("000000000000")')) break;
    await wait(100);
  }
  assert.equal(await evalJs('document.querySelector("#review-context")?.textContent.includes("000000000000")'), true);
  const recovered = await evalJs(`(async () => {
    const q = (s) => document.querySelector(s);
    q('.project-card .lane-intent').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, altKey: true }));
    q('#review-message').value = 'Synthetic non-private retained-page browser check';
    q('#review-message').dispatchEvent(new Event('input', { bubbles: true }));
    q('#review-queue').click();
    q('#review-send').click();
    for (let i = 0; i < 100 && !q('#review-state').textContent.includes('Preview updated'); i++) await new Promise(r => setTimeout(r, 50));
    const warning = q('#review-state').textContent;
    const retained = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));
    Array.from(q('#review-thread').querySelectorAll('button')).find((button) => button.textContent === 'Retry batch').click();
    for (let i = 0; i < 100 && !q('#review-state').textContent.includes('chromium-receipt'); i++) await new Promise(r => setTimeout(r, 50));
    return { warning, retainedCount: retained.retryBatches.length, version: retained.retryBatches[0]?.payload.version, receipt: q('#review-state').textContent, remaining: q('#review-count').textContent };
  })()`);
  assert.match(recovered.warning, /Preview updated.*check annotation targets.*press Send again/);
  assert.equal(recovered.retainedCount, 1);
  assert.equal(recovered.version, batches[0].version);
  assert.match(recovered.receipt, /chromium-receipt/);
  assert.equal(recovered.remaining, "");
  assert.equal(batches.length, 3, "rejected old-version POST must not reach delivery");
  // Real local annotation flow: receipt on disk, then supervisor-authored status
  // beside that receipt. The browser must update without a page reload.
  const localApp = createServer({});
  await listen(localApp);
  const localBase = `http://127.0.0.1:${localApp.address().port}`;
  let localBatch;
  try {
    await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await cmd("Page.navigate", { url: `${localBase}/#overview` });
    for (let i = 0; i < 100 && !await evalJs('Boolean(document.querySelector(".project-card") && document.querySelector("#review-context")?.textContent.includes("Local receipt"))'); i++) await wait(100);
    localBatch = await evalJs(`(async () => {
      const q = (s) => document.querySelector(s);
      const region = q('.project-card .lane-intent');
      region.scrollIntoView({ block: 'center' });
      const target = region.getBoundingClientRect();
      const x = target.left + target.width / 2, y = target.top + target.height / 2;
      // Click-to-interact is the default; opt in to annotate before selecting content.
      if (!q('#review-toggle').checked) q('#review-toggle').click();
      region.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: x, clientY: y }));
      for (let i=0; i<30 && !q('.mobile-review-sheet').open; i++) await new Promise(r=>setTimeout(r,20));
      const anchor = q('#review-form').getBoundingClientRect();
      const pane = q('#review-panel').getBoundingClientRect();
      if (q('#review-panel').hidden || !q('.mobile-review-sheet').open || q('#review-select-location').getAttribute('aria-pressed') !== 'true' || anchor.left < pane.left || anchor.right > pane.right || anchor.top < pane.top || anchor.bottom > innerHeight || !q('#review-target').textContent.includes('Annotating')) throw Error('phone annotation tab did not contain composer: ' + JSON.stringify({ click: {x,y}, region:target.toJSON(), pane:pane.toJSON(), composer:anchor.toJSON(), viewport:{width:innerWidth,height:innerHeight} }));
      q('#review-message').value = 'Synthetic local lifecycle annotation';
      q('#review-queue').click(); q('#review-send').click();
      for (let i=0; i<100 && !q('#review-state').textContent.includes('Accepted durably'); i++) await new Promise(r => setTimeout(r, 50));
      const stored = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1'));
      return { id: stored.sent[0].id, state: q('#review-state').textContent, summary: q('#review-thread summary').textContent, route: location.hash, width: document.documentElement.scrollWidth, viewport: innerWidth };
    })()`);
    assert.match(localBatch.state, /Accepted durably.*receipt local:/);
    assert.match(localBatch.summary, /Firstmate intake not yet confirmed/);
    assert.equal(localBatch.route, "#overview");
    assert.ok(localBatch.width <= localBatch.viewport, "phone receipt has no horizontal overflow");
    const receipt = JSON.parse(await readFile(path.join(localReviewDir, `${localBatch.id}.json`), "utf8"));
    assert.notEqual(receipt.payload.entries[0].tag, "message");
    assert.equal(receipt.payload.entries[0].prompt, "Synthetic local lifecycle annotation");
    for (const state of ["received", "handling", "failed"]) {
      await writeFile(path.join(localReviewDir, `${localBatch.id}.status.json`), JSON.stringify({ schema: "fm-agentos-review-status.v1", receiptId: receipt.receiptId, state, updatedAt: new Date().toISOString() }));
      await evalJs(`document.querySelector('#review-panel-toggle').click(); document.querySelector('#review-panel-toggle').click()`);
      const expected = state === "received" ? "Received by Firstmate" : state === "handling" ? "Actively being handled" : "Failed (explicit supervisor outcome)";
      for (let i=0; i<100 && !await evalJs(`document.querySelector('#review-thread summary')?.textContent.includes(${JSON.stringify(expected)})`); i++) await wait(50);
      assert.equal(await evalJs(`document.querySelector('#review-thread summary')?.textContent.includes(${JSON.stringify(expected)})`), true);
    }
    assert.equal(await evalJs("document.documentElement.scrollWidth <= innerWidth"), true);
    console.log(`Chromium exact-build PASS: ${base}, version ${batches[0].version}; local batch ${localBatch.id} accepted/received/handling/failed on phone without reload`);
  } finally {
    if (localBatch?.id) for (const suffix of [".json", ".status.json"]) await rm(path.join(localReviewDir, `${localBatch.id}${suffix}`), { force: true });
    await close(localApp);
  }
  const original = (recordId, text) => ({ recordId, text, author: "Firstmate", role: "firstmate", kind: "conversation", state: "response",
    source: "main-pi-session/test.jsonl", occurredAt: "2026-01-01T12:00:00.000Z", time: "12:00" });
  const records = [{ ...original("main-pi-session/test.jsonl:1:0", "First synthetic reply"), kind: "thinking", state: "thinking" }, original("main-pi-session/test.jsonl:2:0", "Second synthetic reply"),
    original(undefined, "working: no original ID")];
  const fixtureLane = { id: "alpha", name: "Alpha", mission: "Synthetic", intent: "Synthetic", status: "active", closed: false, laneOpen: true,
    crew: 0, progress: 0, items: [], sessions: [], messages: records };
  const messageApp = createServer({ FM_LAVISH_REVIEW_URL: `http://127.0.0.1:${receiver.address().port}/review`, FM_LAVISH_REVIEW_SESSION: "chromium-fixture" },
    { lanesReader: async () => ({ source: "synthetic", lanes: [fixtureLane], transcript: { sessions: [], warnings: [], note: "" } }) });
  await listen(messageApp);
  try {
    for (const width of [390, 1280]) {
      await cmd("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
      await cmd("Page.navigate", { url: `http://127.0.0.1:${messageApp.address().port}/#lanes` });
      for (let i = 0; i < 100 && !await evalJs('document.querySelectorAll("#messages .message").length === 3'); i++) await wait(100);
      assert.equal(await evalJs('document.querySelectorAll("#messages .message").length'), 3, `${width}px exact build renders all three messages`);
      const selection = await evalJs(`(async () => {
        const q = (s) => document.querySelector(s);
        const click = (node, altKey = false) => node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, altKey }));
        const pick = async (index, selector, alt = false) => {
          click(q('#messages .message[data-lane-message-index="' + index + '"] ' + selector), alt);
          for(let i=0;i<100;i++){ const selected=JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).selected; if(!selected?.record || selected.record.recordId || selected.record.sha256) break; await new Promise(r=>setTimeout(r,10)); }
          q('#review-message').value = 'Synthetic message annotation ' + index; q('#review-queue').click();
          if (${width} === 390) q('#review-close').click();
        };
        const summary = q('#messages .message[data-lane-message-index="0"] summary');
        click(summary); // Ordinary clicks on nested controls still interact.
        const controlOpened = summary.parentElement.open;
        await pick(0, 'summary', true); // With click-to-interact default, Alt-click annotates a control.
        q('#review-toggle').click(); // Then enable ordinary click-to-annotate for content.
        await pick(1, 'strong');
        await pick(2, '.message-content');
        click(q('#messages'));
        q('#review-message').value = 'Synthetic feed background'; q('#review-queue').click();
        return { queue: JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).queue, controlOpened };
      })()`);
      assert.equal(selection.controlOpened, true, "ordinary nested summary click interacts");
      const selected = selection.queue;
      assert.deepEqual(selected.slice(0, 2).map((entry) => entry.record), [
        { recordId: records[0].recordId }, { recordId: records[1].recordId },
      ]);
      assert.equal(selected[2].text, records[2].text);
      assert.match(selected[2].record.sha256, /^[a-f0-9]{16}$/);
      assert.deepEqual(selected[2].record.lanes, ["Alpha"]);
      assert.notEqual(selected[3].tag, "message", "feed background remains a generic region");
      assert.equal(selected[3].target, undefined);
      await cmd("Page.reload");
      for (let i = 0; i < 100 && !await evalJs('document.querySelector("#review-count")?.textContent.includes("4 queued")'); i++) await wait(100);
      assert.equal(await evalJs('document.querySelector("#review-count")?.textContent.includes("4 queued")'), true, "message targets survive reload");
      const prior = batches.length;
      await evalJs("document.querySelector('#review-send').click()");
      for (let i = 0; i < 100 && batches.length === prior; i++) await wait(50);
      assert.equal(batches.length, prior + 1);
      assert.deepEqual(batches.at(-1).entries, selected.map(({version,route,...entry}) => entry));
    }
    console.log("Chromium Lane Chat message annotation PASS: exact build on phone and desktop; distinct records, bounded fingerprints, nested content, background and reload");
  } finally { await close(messageApp); }
  // Hold an actual network delivery after the send action to expose the cutoff on both layouts.
  for (const width of [390, 1280]) {
  await cmd("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
  await cmd("Page.navigate", { url: `${base}/#overview` });
  for (let i = 0; i < 100 && !await evalJs('document.querySelector("#review-context")?.textContent.includes("chromium-fixture")'); i++) await wait(100);
  await evalJs(`(() => {
    const q = (s) => document.querySelector(s);
    q('#review-message').value = 'Cutoff first'; q('#review-queue').click();
    q('#review-send').click();
  })()`);
  for (let i = 0; i < 100 && !releaseHeld; i++) await wait(50);
  assert.ok(releaseHeld, "first batch reached receiver");
  try {
    const during = await evalJs(`(() => {
      const q = (s) => document.querySelector(s);
      q('#review-message').value = 'Cutoff later'; q('#review-message').dispatchEvent(new Event('input', { bubbles: true }));
      q('#review-queue').click();
      return { draft: JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')), disabled: q('#review-queue').disabled };
    })()`);
    assert.equal(during.disabled, false, "a note can be queued while the captured batch is in flight");
    assert.deepEqual(during.draft.queue.map((item) => item.prompt), ["Cutoff later"]);
  } finally { releaseHeld(); releaseHeld = null; }
  for (let i = 0; i < 100 && !await evalJs('document.querySelector("#review-state")?.textContent.includes("chromium-receipt")'); i++) await wait(50);
  const after = await evalJs(`(() => { const draft = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')); return { sent: draft.sent.at(-1), queued: draft.queue.map((entry) => entry.prompt) }; })()`);
  assert.deepEqual(after.sent.entries.map((entry) => entry.prompt), ["Cutoff first"]);
  assert.deepEqual(after.queued, ["Cutoff later"]);
  await evalJs("document.querySelector('#review-send').click()");
  for (let i = 0; i < 100 && batches.at(-1)?.entries[0]?.prompt !== "Cutoff later"; i++) await wait(50);
  assert.deepEqual(batches.at(-1).entries.map((entry) => entry.prompt), ["Cutoff later"]);
  assert.notEqual(batches.at(-1).batchId, after.sent.id);
  for (let i = 0; i < 100 && !await evalJs('document.querySelector("#review-state")?.textContent.includes("chromium-receipt")'); i++) await wait(50);
  console.log(`Chromium cutoff PASS: ${width}px in-flight queue remains distinct from receipt on exact UAT path`);
  }
} finally {
  ws?.close();
  chrome.kill();
  await new Promise((resolve) => { if (chrome.exitCode !== null) resolve(); else chrome.once("exit", resolve); });
  await Promise.all([close(app), close(receiver)]);
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
