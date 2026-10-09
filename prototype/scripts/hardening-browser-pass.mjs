// Offline behavioral gate against the real page, a clean commit and isolated Chromium.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer, loadFirstmateHome } from "../server.js";
import { reviewVersion, reconcileLocalReview, deliverLocalReview, localReviewStatus } from "../review.js";
import { openBrowser } from "./browser-harness.mjs";

assert.match(reviewVersion, /^[a-f0-9]{40}$/, "Run from a clean committed source checkout");
const timeout = setTimeout(() => { console.error("Browser gate exceeded 120 seconds"); process.exit(1); }, 120000).unref();
const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-hardening-"));
const home = path.join(scratch, "home"), receipts = path.join(scratch, "receipts");
await mkdir(path.join(home, "data"), { recursive: true });
await mkdir(path.join(home, "state/branch-session"), { recursive: true });
await writeFile(path.join(home, "data/projects.md"), "- Alpha - Synthetic history\n");
for (let i = 0; i < 65; i++) {
  const id = `task-${String(i).padStart(2, "0")}`;
  await writeFile(path.join(home, "state", `${id}.meta`), "project=Alpha\n");
  const status = path.join(home, "state", `${id}.status`);
  const disk = path.join(home, "state/branch-session", `${id}.jsonl`);
  await writeFile(status, `done: Synthetic ${id}\n`);
  await writeFile(disk, JSON.stringify({ type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: `Alpha ${id}` } }) + "\n");
  const time = new Date(1700000000000 + i * 1000);
  await utimes(status, time, time); await utimes(disk, time, time);
}
const requests = [];
let deliveries = 0, noProgress = false;
const server = createServer({ FM_QUARTERDECK_STATE_PATH: path.join(scratch, "state.json") }, {
  quotaReader: async () => ({ providers: [], error: "Offline fixture", stale: false }),
  costReader: async () => ({ azure: { state: "unavailable" }, github: { state: "unavailable" } }),
  lanesReader: async (_, options) => {
    requests.push(options.sessionIds);
    const data = await loadFirstmateHome(home, options);
    if (noProgress) for (const lane of data.lanes) for (const session of lane.sessions) if (session.id === "task-00") session.loaded = false;
    return data;
  },
  localReviewReceipt: (body) => reconcileLocalReview(body, receipts),
  localReviewDeliver: async (body) => { deliveries++; return deliverLocalReview(body, receipts); },
  reviewCount: async () => 0, reviewStatus: (id) => localReviewStatus(id, receipts),
});
let browser;
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await openBrowser();
  const { command, evaluate, until } = browser;
  const reload = async () => {
    // Page.reload acknowledges the command before replacing the document.
    // Otherwise a readiness predicate can match the previous page's state.
    await evaluate("window.syntheticReloadPending = true");
    await command("Page.reload");
    await until("!window.syntheticReloadPending && document.readyState === 'complete'");
  };
  const navigation = await command("Page.navigate", { url: base });
  assert.equal(navigation.errorText, undefined, `Fixture navigation failed: ${JSON.stringify(navigation)}`);
  await until("document.querySelector('#review-context')?.textContent.includes('Version') && document.querySelector('#summary')?.children.length > 0");
  assert.equal(await evaluate("document.title"), "fm-quarterdeck");
  assert.equal(await evaluate("document.querySelector('.product-identity strong').textContent"), "Quarterdeck");
  const escape = async () => {
    await command("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  };
  // The footer help uses native keyboard activation and popover light dismissal.
  assert.equal(await evaluate("document.querySelectorAll('#review-gesture-help').length"), 1, "one annotation help control beside the toggle");
  for (const width of [800, 1280]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate("document.querySelector('#review-gesture-help').focus()");
    assert.equal(await evaluate("document.activeElement.id"), "review-gesture-help");
    await command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
    await command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
    await until("document.querySelector('#review-gesture-popover').matches(':popover-open')");
    const help = await evaluate(`(() => {
      const popup = document.querySelector('#review-gesture-popover'), r = popup.getBoundingClientRect();
      const button = document.querySelector('#review-gesture-help').getBoundingClientRect();
      const toggle = document.querySelector('.review-gesture').getBoundingClientRect();
      const icons = document.querySelector('.gesture-icons').getBoundingClientRect();
      const refresh = document.querySelector('#refresh').getBoundingClientRect();
      return { text: popup.textContent, inViewport: r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight,
        iconsFit: icons.left >= toggle.left && icons.right <= toggle.right, adjacent: Math.abs(button.left - toggle.right) <= 8, sameRow: button.top < toggle.bottom && button.bottom > toggle.top,
        controlsFit: refresh.width > 0 && refresh.right <= toggle.left && refresh.top < toggle.bottom && refresh.bottom > toggle.top && button.right <= innerWidth };
    })()`);
    assert.ok(help.inViewport); assert.ok(help.iconsFit); assert.ok(help.adjacent); assert.ok(help.sameRow); assert.ok(help.controlsFit);
    const { nodes } = await command("Accessibility.getFullAXTree");
    const helpControl = nodes.find((node) => !node.ignored && node.role?.value === "button" && node.name?.value === "How annotation clicks work");
    assert.ok(helpControl, "help exposes an accessible button name");
    assert.match(helpControl.description?.value || "", /Toggle off:.*Alt \+ left click.*Toggle on:.*A plain left click/s);
    assert.match(help.text, /Toggle off:.*Alt \+ left click on content opens an annotation/);
    assert.match(help.text, /Toggle on:.*A plain left click on content opens an annotation/);
    assert.equal(await evaluate("document.querySelector('#review-gesture-current').textContent"), "The toggle is off.");
    await evaluate("(() => { const toggle = document.querySelector('#review-toggle'); toggle.checked = true; toggle.dispatchEvent(new Event('change', {bubbles:true})); })()");
    assert.equal(await evaluate("document.querySelector('#review-gesture-current').textContent"), "The toggle is on.");
    assert.equal(await evaluate("document.activeElement.id"), "review-gesture-help", "Escape targets help, not the annotation composer");
    await escape();
    await until("!document.querySelector('#review-gesture-popover').matches(':popover-open')");
    assert.equal(await evaluate("document.activeElement.id"), "review-gesture-help");
    assert.equal(await evaluate("document.querySelector('#review-toggle').checked"), true, "help never changes annotation mode");
    await evaluate("document.querySelector('#review-gesture-help').click()");
    await until("document.querySelector('#review-gesture-popover').matches(':popover-open')");
    const outside = await evaluate("(() => { const r = document.querySelector('button.primary-tab[data-view=overview]').getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()");
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, ...outside });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, ...outside });
    await until("!document.querySelector('#review-gesture-popover').matches(':popover-open') && !document.querySelector('#review-annotation').hidden");
    assert.equal(await evaluate("document.querySelector('#review-toggle').checked"), true, "plain outside click annotates without changing the toggle");
    await escape();
    await until("document.querySelector('#review-annotation').hidden");
    await evaluate("document.querySelector('#review-gesture-help').click()");
    await until("document.querySelector('#review-gesture-popover').matches(':popover-open')");
    // Annotation mode captures plain clicks, including navigation controls.
    // Alt-click is the interaction gesture while the toggle is on; use real
    // pointer input so native popover light dismissal is still exercised.
    await command("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, modifiers: 1, ...outside });
    await command("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, modifiers: 1, ...outside });
    await until("!document.querySelector('#review-gesture-popover').matches(':popover-open')");
    assert.equal(await evaluate("document.querySelector('#review-annotation').hidden"), true, "outside Alt-click interacts instead of annotating with the toggle on");
    assert.equal(await evaluate("document.querySelector('#review-toggle').checked"), true, "outside dismissal preserves annotation mode");
    await evaluate("document.querySelector('#review-toggle').click()");
    assert.equal(await evaluate("document.querySelector('#review-toggle').checked"), false);
    await evaluate("document.querySelector('#summary').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1, altKey: true }))");
    await until("!document.querySelector('#review-annotation').hidden");
    await evaluate("document.querySelector('#review-message').value = 'Synthetic annotation draft'; document.querySelector('#review-message').dispatchEvent(new Event('input', { bubbles: true }))");
    await evaluate("document.querySelector('#review-gesture-help').focus(); document.querySelector('#review-gesture-help').click()");
    await until("document.querySelector('#review-gesture-popover').matches(':popover-open')");
    await escape();
    await until("!document.querySelector('#review-gesture-popover').matches(':popover-open')");
    assert.equal(await evaluate("document.querySelector('#review-annotation').hidden"), false, "first Escape preserves annotation");
    assert.equal(await evaluate("document.querySelector('#review-message').value"), "Synthetic annotation draft");
    await escape();
    await until("document.querySelector('#review-annotation').hidden");
    assert.equal(await evaluate("document.querySelector('#review-message').value"), "Synthetic annotation draft", "second Escape keeps draft");
    await evaluate("document.querySelector('#review-panel-toggle').click(); document.querySelector('#review-annotation-tab').click(); document.querySelector('#review-select-location').click()");
    await until("document.querySelector('#review-panel').hasAttribute('data-picking')");
    await evaluate("document.querySelector('#review-gesture-help').focus(); document.querySelector('#review-gesture-help').click()");
    await until("document.querySelector('#review-gesture-popover').matches(':popover-open')");
    await escape();
    await until("!document.querySelector('#review-gesture-popover').matches(':popover-open')");
    assert.equal(await evaluate("document.querySelector('#review-panel').hasAttribute('data-picking')"), true, "first Escape preserves armed picking");
    await escape();
    await until("!document.querySelector('#review-panel').hasAttribute('data-picking')");
    assert.equal(await evaluate("document.querySelector('#review-panel').hidden"), false, "second Escape cancels picking without closing review");
    await evaluate("document.querySelector('#review-close').click(); document.querySelector('#review-message').value = ''; document.querySelector('#review-message').dispatchEvent(new Event('input', { bubbles: true }))");
  }
  console.log("PASS: synthetic annotation help at 800/1280px; accessible description, keyboard open, Escape priority over annotation/picking, outside dismissal, both toggle states");
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await until("Boolean(document.querySelector('#header-search-toggle'))");
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  await until("Boolean(document.querySelector('.lane-list .source-status'))");
  await evaluate("document.querySelector('button.primary-tab[data-view=conversations]').click()");
  await until("document.querySelector('#lanes').dataset.view === 'conversations' && document.querySelector('#transcript-search').getClientRects().length > 0");
  await evaluate(`(() => {
    window.syntheticSearchEscapes = [];
    document.querySelector('#transcript-search').addEventListener('keydown', (event) => {
      if (event.key === 'Escape') window.syntheticSearchEscapes.push(event.defaultPrevented);
    });
  })()`);
  for (const state of ["idle", "annotation", "picking"]) {
    if (state === "annotation") {
      await evaluate("document.querySelector('#conversation-title').dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1, altKey: true }))");
      await until("!document.querySelector('#review-annotation').hidden");
    } else if (state === "picking") {
      await evaluate("document.querySelector('#review-panel-toggle').click(); document.querySelector('#review-annotation-tab').click(); document.querySelector('#review-select-location').click()");
      await until("document.querySelector('#review-panel').hasAttribute('data-picking')");
    }
    // Opening annotation/panel schedules composer autofocus. Let that finish
    // before moving focus to search, rather than racing it across CDP calls.
    if (state !== "idle") await until("document.activeElement.id === 'review-message'");
    await evaluate("window.syntheticSearchEscapes = []; document.querySelector('#review-message').value = 'Synthetic search-focus draft'; document.querySelector('#review-message').dispatchEvent(new Event('input', { bubbles: true }))");
    const reviewState = `({ annotationHidden: document.querySelector('#review-annotation').hidden,
      picking: document.querySelector('#review-panel').hasAttribute('data-picking'),
      panelHidden: document.querySelector('#review-panel').hidden, draft: document.querySelector('#review-message').value,
      toggle: document.querySelector('#review-toggle').checked })`;
    const before = await evaluate(reviewState);
    await evaluate("document.querySelector('#review-gesture-help').focus(); document.querySelector('#review-gesture-help').click()");
    await until("document.querySelector('#review-gesture-popover').matches(':popover-open')");
    await evaluate("document.querySelector('#transcript-search').focus()");
    assert.equal(await evaluate("document.activeElement.id"), "transcript-search");
    await escape();
    await until("!document.querySelector('#review-gesture-popover').matches(':popover-open')");
    assert.deepEqual(await evaluate("window.syntheticSearchEscapes"), [], `${state}: first Escape never reaches the search target`);
    assert.deepEqual(await evaluate(reviewState), before, `${state}: help dismissal preserves review state`);
    assert.equal(await evaluate("document.activeElement.id"), "transcript-search");
    await escape();
    assert.deepEqual(await evaluate("window.syntheticSearchEscapes"), [true], `${state}: second Escape retains search dismissal`);
    assert.deepEqual(await evaluate(reviewState), before);
    await evaluate("document.querySelector('#review-message').focus()");
    await escape();
    assert.equal(await evaluate("document.querySelector('#review-annotation').hidden"), true);
    assert.equal(await evaluate("document.querySelector('#review-panel').hasAttribute('data-picking')"), false);
    assert.equal(await evaluate("document.querySelector('#review-message').value"), "Synthetic search-focus draft");
    await evaluate("document.querySelector('#review-close').click(); document.querySelector('#review-message').value = ''; document.querySelector('#review-message').dispatchEvent(new Event('input', { bubbles: true }))");
  }
  await evaluate("document.querySelector('button.primary-tab[data-view=overview]').click()");
  await until("document.querySelector('#lanes').dataset.view === 'overview'");
  console.log("PASS: synthetic phone-to-desktop Fleet Chats search focus; help consumes first Escape, search retains second Escape, annotation/picking and drafts preserved");
  // A realistic persisted board: >30 distinct batches, not >30 entries in one request.
  await evaluate(`(() => {
    const entry = { kind: 'message', text: 'Synthetic retained note', region: null, route: '#overview', version: ${JSON.stringify(reviewVersion)} };
    const retries = Array.from({ length: 35 }, () => { const id = crypto.randomUUID(); return { id, payload: { schema: 'fm-agentos-review.v1', batchId: id, sessionId: '', version: entry.version, route: '#overview', end: false, entries: [entry] } }; });
    const sent = Array.from({ length: 35 }, () => { const id = crypto.randomUUID(); return { id, receiptId: 'local:' + id, state: 'accepted', entries: [entry] }; });
    sessionStorage.setItem('fm-agentos-review-draft-v1', JSON.stringify({ queue: [], queueIds: [], retryBatches: retries, sent, message: 'Unsent draft', open: false }));
  })()`);
  await reload();
  await until("document.querySelector('#review-message')?.value === 'Unsent draft'");
  assert.deepEqual(await evaluate(`(() => { const s = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')); return [s.retryBatches.length, s.sent.length]; })()`), [35, 35]);
  assert.deepEqual(await evaluate("['#review-thread', '#review-sent-list', '#review-phone-thread'].map(selector => document.querySelector(selector).children.length)"), [35, 35, 70], "all retained batches render in desktop Queued/Sent and the combined phone Review thread");
  await evaluate("sessionStorage.removeItem('fm-agentos-review-draft-v1')");
  let loseNext = true, newConfig = false, serverDown = false, eventError;
  // Board rendering is not review readiness: loadConfig() is an independent
  // fetch. Hold its response to force the ordering that used to flake in CI.
  let holdConfig = true;
  const configPaused = Promise.withResolvers();
  const heldConfigRequests = [];
  browser.onEvent((event) => {
    if (event.method !== "Fetch.requestPaused") return;
    const { requestId, request } = event.params;
    let action;
    if (request.method === "GET" && serverDown) {
      action = command("Fetch.failRequest", { requestId, errorReason: "ConnectionRefused" });
    } else if (request.method === "GET" && holdConfig) {
      // Recovery and live-connection rechecks can race the initial config fetch.
      // Hold all of them, not just the first, until the readiness assertion.
      heldConfigRequests.push(requestId);
      configPaused.resolve(requestId);
      return;
    } else if (request.method === "POST" && loseNext) {
      loseNext = false;
      action = command("Fetch.failRequest", { requestId, errorReason: "Failed" });
    } else if (request.method === "GET" && newConfig) {
      action = command("Fetch.fulfillRequest", { requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: "application/json" }],
        body: Buffer.from(JSON.stringify({ ready: true, version: "b".repeat(40), sessionId: "", delivery: "local", awaitingReview: 0 })).toString("base64") });
    } else action = command("Fetch.continueRequest", { requestId });
    action.catch((error) => { eventError = error; });
  });
  await command("Fetch.enable", { patterns: [{ urlPattern: "*/api/review", requestStage: "Response" }] });
  await reload();
  await until("document.querySelector('#review-message') && document.querySelector('#summary').children.length > 0");
  await configPaused.promise;
  await evaluate("document.querySelector('#review-message').value = 'Synthetic lost response'; document.querySelector('#review-form').requestSubmit()");
  assert.equal(await evaluate("document.querySelector('#review-send').disabled"), true, "rendered board cannot send before review configuration arrives");
  await evaluate("document.querySelector('#review-send').click()");
  assert.equal(deliveries, 0, "an early click is ignored, not a simulated lost delivery");
  assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).queue.length"), 1, "early click preserves the queued note");
  holdConfig = false;
  await Promise.all(heldConfigRequests.map(requestId => command("Fetch.continueRequest", { requestId })));
  await until("document.querySelector('#review-context')?.textContent.includes('Version') && !document.querySelector('#review-send').disabled");
  await evaluate("document.querySelector('#review-send').click()");
  await until("(() => { const s = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')); return s.retryBatches.length === 1 && !s.inFlight; })()");
  assert.equal(loseNext, false, "the POST response was intercepted and lost");
  const original = await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).retryBatches[0]");
  assert.equal(deliveries, 1, "receipt persisted before losing its response");
  newConfig = true;
  await reload();
  await until("document.querySelector('#review-context')?.textContent.includes('bbbbbbbbbbbb') && !document.querySelector('#review-send').disabled");
  assert.deepEqual(await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).retryBatches[0]"), original);
  await evaluate("document.querySelector('#review-send').click()");
  await until("(() => { const s = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')); return s.retryBatches.length === 0 && !s.inFlight && s.sent.length === 1; })()");
  assert.equal(deliveries, 1, "same receipt reconciled; no duplicate delivery");
  assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent[0].receiptId"), `local:${original.id}`);
  // A delayed original publication discovered just before explicit conversion
  // must reconcile that original receipt rather than assign another identity.
  const delayedId = await evaluate("crypto.randomUUID()");
  const delayed = { schema: "fm-agentos-review.v1", batchId: delayedId, sessionId: "", version: "a".repeat(40), route: "#overview", end: false,
    entries: [{ kind: "message", text: "Synthetic delayed publication", region: null, route: "#overview", version: "a".repeat(40) }] };
  await evaluate(`sessionStorage.setItem('fm-agentos-review-draft-v1', JSON.stringify({ queue: [], queueIds: [], sent: [], message: '', retryBatches: [{ id: ${JSON.stringify(delayedId)}, payload: ${JSON.stringify(delayed)} }] }))`);
  await reload();
  await until("document.querySelector('#review-context')?.textContent.includes('bbbbbbbbbbbb') && !document.querySelector('#review-send').disabled");
  await evaluate("document.querySelector('#review-send').click()");
  await until("Boolean(JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).retryBatches[0]?.rejected)");
  await deliverLocalReview({ ...delayed, provenance: { commit: delayed.version, branch: "uat" } }, receipts);
  await evaluate("[...document.querySelectorAll('#review-thread button')].find((button) => button.textContent.includes('Targets rechecked')).click()");
  await until("(() => { const s = JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')); return !s.inFlight && s.retryBatches.length === 0 && s.sent.length === 1; })()");
  assert.equal(await evaluate("JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1')).sent[0].id"), delayedId);
  assert.equal(deliveries, 1, "conversion reconciles a delayed original instead of duplicate delivery");
  // Phone send through real touch input: type and send, then keep the open composer
  // usable across an unreachable server without reloading the tab.
  newConfig = false;
  await command("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await evaluate("sessionStorage.removeItem('fm-agentos-review-draft-v1')");
  await reload();
  await until("document.querySelector('.mobile-dock #review-panel-toggle') && document.querySelector('#review-context')?.textContent.includes('Version')");
  const tap = async (selector) => {
    const point = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(), x = r.x + r.width / 2, y = r.y + r.height / 2;
      return { x, y, hit: Boolean(document.elementFromPoint(x, y)?.closest(${JSON.stringify(selector)})) }; })()`);
    assert.ok(point.hit, `${selector} receives the phone tap`);
    await command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: point.x, y: point.y }] });
    await command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  const phoneDraft = "JSON.parse(sessionStorage.getItem('fm-agentos-review-draft-v1') || '{}')";
  await tap(".mobile-dock #review-panel-toggle");
  await until("!document.querySelector('#review-panel').hidden && document.querySelector('#review-panel').contains(document.querySelector('#review-send'))");
  await tap("#review-message");
  await command("Input.insertText", { text: "Synthetic phone message" });
  await until("!document.querySelector('#review-send').disabled");
  await tap("#review-send");
  await until(`${phoneDraft}.sent?.length === 1 && document.querySelector('#review-message').value === ''`);
  assert.equal(deliveries, 2, "phone Send delivers the typed message");
  assert.deepEqual(await evaluate(`${phoneDraft}.sent[0].entries.map((entry) => entry.prompt)`), ["Synthetic phone message"]);
  serverDown = true;
  await tap("#review-close");
  await tap(".mobile-dock #review-panel-toggle");
  await until("document.querySelector('#review-send').disabled && document.querySelector('#review-state').textContent.includes('server down or restarting')");
  await tap("#review-message");
  await command("Input.insertText", { text: "Synthetic offline phone note" });
  assert.equal(await evaluate("document.querySelector('#review-send').disabled"), true, "Send stays greyed while the server is unreachable");
  await tap("#review-queue");
  await until(`${phoneDraft}.queue?.length === 1`);
  serverDown = false;
  // Returning to a backgrounded phone tab re-reads review configuration.
  await evaluate("document.dispatchEvent(new Event('visibilitychange'))");
  await until("!document.querySelector('#review-send').disabled && !document.querySelector('#review-state').textContent.includes('server down')");
  await tap("#review-send");
  await until(`${phoneDraft}.sent?.length === 2 && ${phoneDraft}.queue.length === 0`);
  assert.equal(deliveries, 3, "queued phone note sends once the server is back");
  await tap("#review-close");
  await command("Emulation.setTouchEmulationEnabled", { enabled: false });
  await command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 844, deviceScaleFactor: 1, mobile: false });
  console.log("PASS: phone 390×844 touch type-and-send; unreachable server greys Send with a reason, Queue stays local, tab return reconnects and sends");
  await command("Fetch.disable");
  if (eventError) throw eventError;
  // Exercise history through actual controls: six older-page clicks retain 60 IDs.
  await evaluate("location.hash = '#lanes/alpha'");
  await until("document.querySelectorAll('.session-row').length >= 65");
  for (let i = 0; i < 6; i++) {
    const count = requests.length;
    await evaluate("document.querySelector('#sessions-load-older').click()");
    await until(`document.querySelector('#session-count')?.textContent.startsWith('${Math.min(65, 12 + i * 10)} /')`);
    assert.ok(requests.length > count);
  }
  noProgress = true;
  const before = requests.length;
  await evaluate("document.querySelector('[data-session-id=\"task-00\"]').click()");
  await until("document.querySelector('#transcript-note')?.textContent.includes('automatic retries stopped')");
  assert.ok(requests.length - before <= 3, "no-progress selection cannot loop");
  assert.equal(requests.at(-1)[0], "task-00", "selected task is first even with sixty retained IDs");
  for (const width of [390, 800, 1280]) {
    await command("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 1, mobile: width === 390 });
    await evaluate("document.querySelector('#review-panel-toggle').click(); document.querySelector('#review-history-tab').click()");
    const layout = await evaluate(`(() => { const pane = document.querySelector('#review-panel'), r = pane.getBoundingClientRect(); return { overflow: document.documentElement.scrollWidth > innerWidth, width: r.width, height: r.height, display: getComputedStyle(pane).display }; })()`);
    assert.equal(layout.overflow, false); assert.ok(layout.width > 0 && layout.width <= width && layout.height > 0);
    assert.equal(layout.display, "flex");
    await evaluate("document.querySelector('#review-close').click()");
  }
  console.log("PASS: real Chromium reload >30 batches; lost-response/revision receipt reconciliation; 60-ID selected history; bounded retries; phone/tablet/desktop review layout");
} finally {
  clearTimeout(timeout);
  await browser?.close();
  if (server.listening) await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
