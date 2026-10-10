import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { quotaDom } from "./helpers/quota-dom.js";
import { createHash } from "node:crypto";
import { parseCss, computed, element } from './helpers/css-model.mjs';

const script = `${await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/bulk-controls.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/message-kinds.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/filter-view.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/message-font-size.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/quota-view-model.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/call-lifecycle.js", import.meta.url), "utf8")}\n${await readFile(new URL("../public/app.js", import.meta.url), "utf8")}`;
const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");

test("opt-in compact headers preserve Quota markup and expose full descriptions", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const headers = [...html.matchAll(/<header class="feature-head compact-head">[\s\S]*?<\/header>/g)];
  assert.equal(headers.length, 5);
  for (const [header] of headers) {
    assert.doesNotMatch(header, /eyebrow/);
    for (const [, title, text] of header.matchAll(/<p title="([^"]+)">([^<]+)<\/p>/g)) assert.equal(title, text);
    assert.equal((header.match(/<p\b/g) || []).length, (header.match(/<p title=/g) || []).length);
  }
  assert.equal(html.match(/id="quota-view"[\s\S]*?(<header[\s\S]*?<\/header>)/)[1], '<header class="feature-head"><div><p class="eyebrow">QUOTA</p><h1>Subscription limits</h1><p>Read-only quota evidence from quota-axi. Missing limits remain unknown.</p></div><span class="source-badge">quota-axi</span></header>');
  assert.match(css, /\.feature-head\.compact-head \{ flex-wrap: nowrap;/);
  assert.match(css, /\.compact-head h1 \{[^}]*font-size: 22px; white-space: nowrap/);
  assert.match(css, /\.compact-head p:not\(\.eyebrow\) \{[^}]*text-overflow: ellipsis; white-space: nowrap/);
});

test("freshness shows only condition and time while preserving accessible evidence", () => {
  const app = ui();
  app.node(".workspace").dataset.view = "overview";
  app.run("freshness.bearings.lastSuccess = Date.now(); freshness.bearings.duration = 70; freshness.bearings.refreshing = false; renderFreshness()");
  const reading = app.node("#view-freshness"), pill = app.node("#fleet-state");
  assert.doesNotMatch(reading.textContent, /Overview|fresh|Last success/);
  assert.equal(app.node("#fleet-state b").textContent, "fresh");
  assert.match(reading.title, /^Captain's Call · fresh · Last success.* · 70ms$/);
  assert.equal(reading.getAttribute("aria-label"), reading.title);
  assert.equal(pill.title, reading.title);
  assert.equal(pill.getAttribute("aria-label"), reading.title);
  app.run("freshness.bearings.lastSuccess = null; renderFreshness()");
  assert.equal(reading.textContent, "no reading yet");
});

test("live model and observation feed the patcher, badge and independent Overview freshness", async () => {
  const app = ui();
  await new Promise(resolve => queueMicrotask(resolve));
  app.node('.workspace').dataset.view = 'overview';
  app.run(`window.callHooks.onModel({rev:'first',state:'ready',cards:[{}],observedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),stale:false,error:null})`);
  assert.equal(app.run('window.callPatches.length'), 1);
  assert.equal(app.node('#call-badge').textContent, '1');
  assert.match(app.node('#view-freshness').title, /^Captain's Call · fresh/);
  app.run(`window.callHooks.onObserved({rev:'first',state:'stale',observedAt:new Date().toISOString(),checkedAt:new Date().toISOString(),stale:true,error:'Snapshot failed'})`);
  assert.equal(app.run('window.callPatches.length'), 1);
  assert.equal(app.run('window.callObservations.length'), 1);
  assert.match(app.node('#view-freshness').title, /Snapshot failed/);
  app.run("window.callHooks.onConnection({state:'reconnecting'})");
  assert.equal(app.node('#fleet-state b').textContent, 'stale');
  app.run("window.callHooks.onModel({rev:'missing',state:'unavailable',cards:[],stale:false,error:'Snapshot timed out'})");
  assert.equal(app.node('#call-badge').textContent, '?');
  assert.equal(app.node('#call-badge').hidden, false);
  assert.equal(app.node('#fleet-state b').textContent, 'unavailable');
  app.run("window.callHooks.onModel({rev:'empty',state:'ready',cards:[],stale:false,error:null,observedAt:new Date().toISOString()})");
  assert.equal(app.node('#call-badge').hidden, true);
});

test("unavailable preferences hide dead controls, recover, and preserve stale entries", () => {
  const app = ui(), controls = app.node("#preferences-view .scan-controls"), state = app.node("#preferences-state");
  app.run("renderPreferences({error: 'Unavailable'})");
  assert.equal(state.classList.contains("error"), true);
  assert.equal(controls.hidden, true);
  app.run(`renderPreferences({source: 'data/captain.md', entries: [{title: 'Behavior', source: 'synthetic', content: 'Example'}]})`);
  assert.equal(state.classList.contains("error"), false);
  assert.equal(controls.hidden, false);
  const previous = app.node("#preferences-list").innerHTML;
  app.run("renderPreferences({error: 'Refresh failed'})");
  assert.equal(state.classList.contains("error"), true);
  assert.equal(controls.hidden, false);
  assert.equal(app.node("#preferences-list").innerHTML, previous);
  app.run("renderPreferences({source: 'data/captain.md', entries: []})");
  assert.equal(state.classList.contains("error"), false);
  assert.equal(controls.hidden, true);
});

test("unavailable work hides controls and empty sections, then restores them", () => {
  const app = ui();
  const selectors = ['.work-tools .scan-controls', '#work-view section[aria-labelledby="tight-heading"]', '#work-view section[aria-labelledby="large-heading"]'];
  app.run("renderWorkSplit(null)");
  for (const selector of selectors) assert.equal(app.node(selector).hidden, true);
  app.run("renderWorkSplit({items: []})");
  for (const selector of selectors) assert.equal(app.node(selector).hidden, false);
});

test("dashboard errors remain visible after Work Split clears its unavailable state", async () => {
  const app = ui({ fetchImpl: url => url === '/api/dashboard' ? Promise.resolve({ok:false,status:503,json:async()=>({error:'Synthetic fleet unavailable'})}) : new Promise(()=>{}) });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.node('#overview-state').classList.contains('hidden'), false);
  assert.match(app.node('#overview-state').textContent, /Synthetic fleet unavailable/);
  assert.match(app.node('#work-state').textContent, /Work split unavailable/);
});

test("request failures use readable HTTP or network messages", async () => {
  for (const [fetchImpl, expected] of [
    [async () => ({ok: false, status: 502, json: async () => { throw new SyntaxError('HTML'); }}), 'HTTP 502'],
    [async () => ({ok: false, status: 503, json: async () => ({error: 'Serving revision unavailable'})}), 'Serving revision unavailable'],
    [async () => { throw new TypeError('fetch failed'); }, 'Server unreachable'],
  ]) {
    const app = ui({fetchImpl: (url, options) => url === '/synthetic-error' ? fetchImpl() : new Promise(() => {})});
    await assert.rejects(app.run("fetchJson('/synthetic-error')"), {message: expected});
  }
});

test("Overview retains KPIs, replaces only the project tree with accessible live calls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const overview = html.slice(html.indexOf('<section id="overview-view"'), html.indexOf('<section id="work-view"'));
  assert.match(overview, /id="summary"/);
  assert.ok(overview.indexOf('id="summary"') < overview.indexOf('id="overview-section-tabs"') && overview.indexOf('id="overview-section-tabs"') < overview.indexOf('id="overview-columns"'));
  assert.match(overview, /id="overview-section-tabs"[\s\S]*role="tablist"[\s\S]*id="overview-tab-calls"[\s\S]*Captain's Call \(0\)[\s\S]*id="overview-tab-landed"[\s\S]*Just landed \(0\)/);
  assert.match(html, /<script src="\/bearings-landed\.js"><\/script>\s*<script src="\/overview-tabs\.js"><\/script>/);
  assert.match(overview, /id="overview-columns"/);
  assert.match(overview, /id="overview-primary"[\s\S]*id="captain-call" aria-labelledby="call-heading"/);
  assert.match(overview, /id="overview-secondary"[\s\S]*id="just-landed"/);
  assert.match(overview, /id="just-landed-heading"[\s\S]*Just landed <b id="landed-new-count" class="call-badge" hidden>0<\/b>/);
  assert.match(overview, /id="landed-ack-toggle"/);
  assert.match(overview, /Checking for landings/);
  assert.doesNotMatch(overview.slice(overview.indexOf('id="overview-secondary"')), /placeholder|coming soon|Charted|Procrastinate/i);
  const landedJs = await readFile(new URL("../public/bearings-landed.js", import.meta.url), "utf8");
  assert.match(landedJs, /No recent completions are in the current baseline\./);
  assert.match(landedJs, /data-landed-key/);
  assert.doesNotMatch(landedJs, /data-call-key|data-call-procrastinate/);
  assert.match(overview, /id="call-status"[^>]*role="status"/);
  assert.doesNotMatch(overview, /id="projects"|overview-status|Repositories →/);
  const app = ui();
  app.run('renderCallBadge({cards:[{},{}]})');
  assert.equal(app.node('#call-badge').textContent, '2');
  assert.equal(app.node('#call-mobile-badge').textContent, '2');
  assert.match(app.node('#sr-announcer').textContent, /2 Captain's Calls/);
  app.node('#sr-announcer').textContent = '';
  app.run('renderCallBadge({cards:[{}]})');
  assert.equal(app.node('#sr-announcer').textContent, '');
  app.run('renderCallBadge({cards:[]})');
  assert.equal(app.node('#call-badge').hidden, true);
});

test("Active view shows Send queued for the staged count and the click reuses the review sender", () => {
  const app = ui();
  const button = app.node("#call-send-queued");
  app.run(`callPatcher.applied = { cards: [] };
    callLifecycleFilter = "active";
    callAnswers = { queued: () => [] };
    renderCallLifecycle();`);
  assert.equal(button.hidden, true, "nothing queued keeps the button hidden");
  app.run(`callAnswers = { queued: () => [{ phase: "confirm" }, { phase: "failed" }] };
    callLifecycleFilter = "queued";
    renderCallLifecycle();`);
  assert.equal(button.hidden, true, "other status views hide it even when answers are queued");
  app.run(`callLifecycleFilter = "active"; renderCallLifecycle();`);
  assert.equal(button.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Send queued (2)");
  assert.equal(button.getAttribute("aria-label"), "Send 2 queued Captain's Call answers");
  app.run(`callAnswers = { queued: () => [{ phase: "sending" }] }; renderCallLifecycle();`);
  assert.equal(button.disabled, true);
  assert.equal(button.textContent, "Send queued (1)");
  assert.equal(button.getAttribute("aria-label"), "Sending 1 queued Captain's Call answer");
  app.run(`window.__sends = 0; window.quarterdeckReviewQueue = { sendCallAnswers() { window.__sends += 1; return Promise.resolve(true); }, sending() { return false; } };`);
  button.disabled = false;
  button.hidden = false;
  button.dispatchEvent({ type: "click" });
  assert.equal(app.run("window.__sends"), 1, "the header button calls the shared review sender");
  button.disabled = true;
  button.dispatchEvent({ type: "click" });
  assert.equal(app.run("window.__sends"), 1, "a disabled button does not send again");
});

test("phone shell preserves navigation and leaves feed clear of fixed controls", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  assert.match(phone, /\.primary-nav \{[^}]*repeat\(5, minmax\(0, 1fr\)\)[^}]*48px 48px/);
  assert.match(phone, /\.main-stage \{[^}]*padding-top: 48px/);
  assert.match(phone, /\.product-view \{ height: 100%; \}/);
  assert.match(phone, /\.sidebar-quota \{ display: none; \}/);
  assert.match(phone, /\.source-status \{[^}]*display: flex/);
  assert.match(phone, /#review-panel-toggle \{[^}]*right: calc\(56px \+ env\(safe-area-inset-right/);
  assert.match(phone, /\.lane-filter \{[^}]*bottom: 104px/);
});

test("UAT phone banner consumes only its actual height and keeps bottom navigation clear", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  assert.match(phone, /\.workspace:has\(\.uat-deployment-label\) \{ display: flex; flex-direction: column; \}/);
  assert.match(phone, /\.uat-deployment-label \{[^}]*padding: 3px 8px; font-size: 11px; line-height: 1\.25/);
  assert.match(phone, /\.uat-label-desktop \{ display: none; \}/);
  assert.match(phone, /\.uat-label-phone \{ display: inline; \}/);
  assert.match(css, /\.uat-label-phone \{ display: none; \}/);
  assert.match(phone, /\.workspace:has\(\.uat-deployment-label\) \.uat-deployment-label \{[^}]*order: -1;[^}]*margin-top: 48px/);
  assert.match(phone, /\.workspace:has\(\.uat-deployment-label\) \.main-stage \{[^}]*margin-bottom: 96px; padding-top: 0/);
  assert.doesNotMatch(phone, /\.workspace:has\(\.uat-deployment-label\) \.main-stage \{ padding-top: 110px/);
  assert.match(css, /\.workspace:has\(\.uat-deployment-label\) \.main-stage \{ margin-bottom: 64px; padding-top: 0/);
});

test("preview control on phones renders compact heading and offsets stage without blank space", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  assert.match(phone, /\.preview-heading \{[^}]*display: flex/);
  assert.match(phone, /\.preview-details\[hidden\] \{ display: none !important; \}/);
  assert.match(phone, /\.preview-details:not\(\[hidden\]\) \{ display: grid !important;/);
  assert.match(phone, /\.workspace:has\(\.preview-control\) \.main-stage \{ padding-top: calc\(48px \+ 33px\); \}/);
  assert.doesNotMatch(phone, /\.workspace:has\(\.preview-control\) \.main-stage \{ padding-top: calc\(48px \+ min\(164px/);
  assert.doesNotMatch(phone, /\.preview-control \{[^}]*height: 164px/);
  assert.match(css, /\.workspace:has\(\.preview-control\) \.main-stage \{ padding-top: calc\(40px \+ 33px\); \}/);
});

test("mobile feature headings share compact top spacing, including quota override; desktop spacing stays intact", () => {
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  assert.match(phone, /\.feature-view, #quota-view\.feature-view \{ padding-top: 0; \}/);
  assert.match(phone, /\.feature-head h1 \{ margin-top: 0; \}/);
  assert.match(css, /\.feature-view \{ overflow-y: auto; padding: var\(--space-6\)/);
  assert.match(css, /#quota-view\.feature-view \{ padding-top: var\(--space-4\); \}/);
});

test("desktop control and persistent review footer keep gesture and action order without a hover button", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const review = await readFile(new URL("../public/review-client.js", import.meta.url), "utf8");
  assert.match(html, /id="refresh"[^>]*>↻ <span>Refresh<\/span><\/button>[\s\S]*class="review-gesture"/);
  assert.match(html, /class="alt-icon">Alt<\/span><svg class="mouse-icon"/);
  assert.match(css, /\.review-gesture:has\(input:checked\) \.alt-icon \{ opacity: \.35; \}/);
  assert.match(css, /\.review-gesture:has\(input:checked\) \{ border-color: #9ff0e0; background: #0a6f60; color: white; \}/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*#review-pick \{ display: none !important; \}/);
  assert.match(html, /<footer id="desktop-review-footer"[\s\S]*id="review-panel-toggle"[\s\S]*<\/footer>/);
  assert.match(review, /destination\.insertBefore\(form, el\("review-panel-toggle"\)\)/);
  assert.match(review, /destination\.insertBefore\(form, el\("review-state"\)\)/);
  assert.match(html, /id="review-message"[\s\S]*id="review-queue"[\s\S]*id="review-send"[\s\S]*id="review-end"[\s\S]*id="review-panel-toggle"/);
  assert.match(css, /\.lane-list \{ grid-column: 1; grid-row: 1 \/ 3; \}/);
  assert.match(css, /#desktop-review-footer \{ grid-column: 2 \/ -1; grid-row: 2;/);
  assert.match(html, /id="review-message"[^>]*placeholder="Message firstmate"/);
  assert.match(review, /el\("lanes"\)\.append\(banner\)/);
  const preview = await readFile(new URL("../public/preview-selector.js", import.meta.url), "utf8");
  assert.match(preview, /destination\.insertBefore\(box, destination\.firstChild\)/);
  assert.match(css, /#desktop-review-footer \{ display: contents; \}/);
});

test("annotation composer has one three-column action row with unchanged button identities", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<form id="review-form">[\s\S]*<div class="review-actions"><button id="review-queue" type="submit" aria-label="Queue message \(Enter\)" data-hint="Enter">Queue<\/button><button id="review-send" type="button" data-hint="Ctrl\/Cmd\+Enter">Send batch<\/button><button id="review-end" type="button" data-hint="Then end chat">Send &amp; End<\/button><\/div><\/form>/);
  assert.match(css, /\.review-actions \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(css, /\.review-actions button \{ min-width: 0;/);
});

test("mobile icons preserve desktop text and accessible names", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  assert.match(html, /id="review-toggle" type="checkbox" aria-label="Annotation mode off: tap or click to interact/);
  assert.match(html, /class="chats-icon" aria-hidden="true"/);
  assert.match(html, /class="mail-icon" aria-hidden="true"/);
  assert.match(html, /<span>Fleet Chats<\/span>/);
  assert.match(phone, /\.lane-chats-row \.primary-tab \.chats-icon \{ display: block; \}/);
  assert.match(phone, /\.source-status \.review-gesture \.pen-icon \{ display: block; \}/);
  assert.match(css, /\.review-awaiting\[hidden\] \{ display: none; \}/);
});

test("phone docks the one annotation checkbox in Fleet Chats in place of All, desktop retains footer layout", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  const desktop = css.slice(0, css.lastIndexOf("@media (max-width: 720px) {"));
  assert.equal((html.match(/id="review-toggle"/g) || []).length, 1);
  assert.match(html, /<footer class="source-status"[\s\S]*<label class="review-gesture"[^>]*><input id="review-toggle" type="checkbox"/);
  assert.match(desktop, /\.source-status \{ flex-shrink: 0;/);
  assert.match(desktop, /\.review-gesture \{ display: flex;/);
  assert.doesNotMatch(desktop, /\.review-gesture \{[^}]*position: fixed/);
  assert.match(phone, /\.product-identity \{[^}]*padding:[^;]*env\(safe-area-inset-right/);
  assert.match(phone, /\.source-status \.review-gesture \{[^}]*position: fixed;[^}]*bottom: calc\(48px \+ env\(safe-area-inset-bottom[^}]*right: calc\(8px \+ env\(safe-area-inset-right/);
  assert.match(phone, /\.source-status \.review-gesture:has\(input:checked\) \{ background: var\(--accent\)/);
  assert.match(phone, /\.source-status \.review-gesture:has\(input:focus-visible\) \{ outline:/);
  assert.doesNotMatch(phone, /Alt-click annotate/);
  assert.match(phone, /\.source-status \.review-gesture span \{ display: none; \}/);
  assert.match(phone, /\.lane-select-all \{ display: none; \}/);
  assert.match(phone, /\.lane-chats-row \{[^}]*grid-template-columns: minmax\(0, 1fr\) 48px 104px/);
  assert.match(phone, /\.product-identity \.view-freshness \{ display: none; \}/);
});

test("review layout shares semantics but keeps deliberate pointer and touch affordances", () => {
  const desktop = css.slice(0, css.lastIndexOf("@media (max-width: 720px) {"));
  const phone = css.slice(css.lastIndexOf("@media (max-width: 720px) {"), css.indexOf("@media (max-width: 720px) and (min-width: 600px)"));
  assert.match(desktop, /\.review-gesture \{ display: flex/);
  assert.match(desktop, /\.review-panel \{ position: fixed/);
  assert.match(phone, /\.review-gesture span \{ display: none/);
  assert.match(css, /\.review-panel \{ top: 0; right: 0; bottom: 0; width: min\(var\(--review-width, 600px\), 100vw\)/);
  assert.match(css, /#review-annotation \{ position: fixed/);
  assert.match(css, /#review-annotation\[hidden\] \{ display: none/);
  assert.match(css, /@media \(max-width: 720px\) and \(hover: none\) \{[^}]*#review-pick \{ display: none; \}/);
});

// Exercise the actual renderer and selection functions without a browser or live home.
// This is not a layout engine; responsive/keyboard checks remain a review obligation.
function ui({ fetchImpl = () => new Promise(() => {}), compact = true, storage = new Map() } = {}) {
  const nodes = new Map();
  const documentListeners = new Map();
  const windowListeners = new Map();
  const document = {
    activeElement: null,
    addEventListener(event, fn) {
      if (!documentListeners.has(event)) documentListeners.set(event, []);
      documentListeners.get(event).push(fn);
    },
    dispatchEvent(event) {
      for (const fn of documentListeners.get(event.type) || []) fn(event);
    },
    querySelector(selector) {
      if (selector === "details.transcript-coverage[open], details.kind-filter-menu[open]") {
        const d1 = nodes.get("#transcript-details");
        if (d1 && d1.getAttribute("open") !== null) return d1;
        const d2 = nodes.get(".kind-filter-menu");
        if (d2 && d2.getAttribute("open") !== null) return d2;
        return null;
      }
      if (!nodes.has(selector)) {
        if (["#quota-providers", "#quota-summary", "#quota-strip", "#mobile-quota-sheet-content", "#quota-state", "#sidebar-quota-freshness"].includes(selector)) {
          nodes.set(selector, quotaNodes.element("div", true));
          return nodes.get(selector);
        }
        const classListSet = new Set();
        const listeners = new Map();
        const attrs = new Map();
        const node = {
          innerHTML: "",
          textContent: "",
          replaceChildren(...children) {
            node.children = children;
            node.textContent = children.map((child) => child.textContent ?? String(child)).join("");
          },
          value: "",
          hidden: false,
          dataset: {},
          scrollHeight: 100,
          clientHeight: 0,
          scrollTop: 0,
          classList: {
            add(...cls) { cls.forEach((c) => classListSet.add(c)); },
            remove(...cls) { cls.forEach((c) => classListSet.delete(c)); },
            toggle(c, force) {
              const shouldHave = force !== undefined ? force : !classListSet.has(c);
              if (shouldHave) classListSet.add(c); else classListSet.delete(c);
              return shouldHave;
            },
            contains(c) { return classListSet.has(c); },
          },
          addEventListener(event, fn) {
            if (!listeners.has(event)) listeners.set(event, []);
            listeners.get(event).push(fn);
          },
          dispatchEvent(event) {
            for (const fn of listeners.get(event.type) || []) fn(event);
          },
          getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
          setAttribute(name, val) { attrs.set(name, String(val)); },
          removeAttribute(name) { attrs.delete(name); },
          hasAttribute(name) { return attrs.has(name); },
          closest() { return null; },
          getBoundingClientRect() { return { top: 0, bottom: 100, height: 100 }; },
          querySelectorAll() { return []; },
          querySelector() { return null; },
          focus() { document.activeElement = node; },
        };
        nodes.set(selector, node);
      }
      return nodes.get(selector);
    },
    querySelectorAll(selector) {
      if (selector.includes("details")) {
        const matches = [];
        const d1 = nodes.get("#transcript-details");
        if (d1 && (!selector.includes("[open]") || d1.getAttribute("open") !== null)) matches.push(d1);
        const d2 = nodes.get(".kind-filter-menu");
        if (d2 && (!selector.includes("[open]") || d2.getAttribute("open") !== null)) matches.push(d2);
        return matches;
      }
      return [];
    },
  };
  const quotaNodes = quotaDom(document);
  document.createElement = (tag) => quotaNodes.element(tag);
  const context = vm.createContext({
    document, URL,
    window: { location: { hash: "#lanes" }, callHooks: null, callPatches: [], callObservations: [],
      bearingsPatch: { createCallPatcher: () => ({ update: model => context.window.callPatches.push(model), observe: data => context.window.callObservations.push(data) }) },
      bearingsLive: { createBearingsLive: hooks => { queueMicrotask(() => { context.window.callHooks = hooks; }); return { start() {}, refresh() {} }; } },
      getSelection: () => document.selection, addEventListener(name, listener) { windowListeners.set(name, listener); }, matchMedia: (query) => ({ matches: query.includes("max-width") ? compact : false, addEventListener() {} }) },
    localStorage: { getItem: (key) => storage.get(key) ?? null, setItem(key, value) { storage.set(key, value); } },
    // Leave initial network loading pending; tests inject only synthetic records.
    fetch: fetchImpl,
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (id) => clearTimeout(id),
  });
  vm.runInContext(script, context);
  return { run: (code) => vm.runInContext(code, context), node: (id) => document.querySelector(id),
    hashchange: (hash) => windowListeners.get("hashchange")?.({ newURL: `http://localhost/${hash}` }),
    windowEvent: (name) => windowListeners.get(name)?.() };
}

test("selected unloaded task and disk displace retained IDs at the sixty-ID cap; automatic retries stop", () => {
  const app = ui();
  app.run(`Array.from({ length: 60 }, (_, i) => retainedSessions.add('task-' + i));
    Array.from({ length: 60 }, (_, i) => retainedDisk.add('disk-' + i));
    selectedSessionId = 'selected-task'; selectedTranscriptSession = 'selected-disk';`);
  const params = new URLSearchParams(app.run("lanesQuery()").slice(1));
  assert.equal(params.getAll("session").length, 60);
  assert.equal(params.getAll("disk").length, 60);
  assert.equal(params.getAll("session")[0], "selected-task");
  assert.equal(params.getAll("disk")[0], "selected-disk");
  app.run("pendingLanesRefresh = false; requestLanes(true); requestLanes(true); pendingLanesRefresh = false; requestLanes(true)");
  assert.equal(app.run("pendingLanesRefresh"), false);
  assert.match(app.node("#transcript-note").textContent, /automatic retries stopped/);
  app.run("requestLanes()");
  assert.equal(app.run("pendingLanesRefresh"), true, "explicit retry remains available");
});

test("reported lane-status filter composes with lane selection and leaves closed history explicit", async () => {
  const app = ui();
  seed(app, [lane("general", [record({ text: "General" })]),
    lane("working", [record({ text: "Working" })]),
    { ...lane("idle", [record({ text: "Idle" })]), status: "idle" },
    lane("closed", [record({ text: "Archived" })], true)]);
  app.run("renderLaneFilters(); laneStatusFilter = 'idle'; renderFeed();");
  assert.equal(app.run("allLanesSelected"), true, "All describes checked IDs, not the status-matched subset");
  assert.equal(app.node("#lane-bulk-toggle").dataset.mode, "clear");
  assert.equal(app.node("#lane-bulk-toggle").textContent, "Clear");
  assert.match(app.node("#lane-filter-rows").innerHTML, /data-filter-lane="working" checked/);
  app.node("#conversations-view").classList.add("active");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(window.fmChatViewContext({branch:"uat",commit:"' + 'a'.repeat(40) + '"}))')).lanes.map(({ id }) => id), ["idle"]);
  assert.match(app.node("#lane-status").innerHTML, /value="idle"/);
  assert.match(app.node("#messages").innerHTML, /Idle/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /Archived|Working|General/);
  app.run("allLanesSelected = false; selectedLaneIds = new Set(['working']); renderLaneFilters(); renderFeed();");
  assert.equal(app.run("allLanesSelected"), false);
  assert.equal(app.node("#lane-bulk-toggle").dataset.mode, "select");
  assert.equal(app.node("#lane-bulk-toggle").textContent, "Select all");
  assert.match(app.node("#lane-filter-rows").innerHTML, /data-filter-lane="working" checked/);
  assert.match(app.node("#messages").innerHTML, /No checked fleets match this reported status/);
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(window.fmChatViewContext({branch:"uat",commit:"' + 'a'.repeat(40) + '"}))')).lanes, []);
  assert.equal(app.run('laneSelection().routeId'), 'working');
  app.run("feedLaneOverrideId = 'closed'; renderFeed();");
  assert.match(app.node("#messages").innerHTML, /Archived/);
  app.run("feedLaneOverrideId = null; laneStatusFilter = 'all'; renderFeed();");
  assert.match(app.node("#messages").innerHTML, /Working/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /Archived|Idle/);
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="lane-status"/);
  assert.match(html, /Check fleets to include\. Tap a name to solo that fleet\./);
  assert.match(css, /@media \(max-width: 720\.005px\) \{[\s\S]*\.lane-list, \.primary-nav, \.lane-chats-row \{ background: #0b1f2a/);
});

const record = (overrides = {}) => ({
  author: "Firstmate", role: "firstmate", kind: "conversation", state: "working",
  text: "Readable response", source: "state/alpha.status", time: "12:00",
  occurredAt: "2026-02-01T12:00:00.000Z", ...overrides,
});
const lane = (id, messages, closed = false) => ({
  id, name: id, status: closed ? "closed" : "active", closed, messages,
  sessions: [], items: [], crew: 1, progress: 25, mission: "Synthetic lane",
});

function seed(ui, lanes) {
  ui.run(`lanes = ${JSON.stringify(lanes)};`);
}

test("first load is explicit, errors survive filter rerenders, and refs hydrate without losing occurrences", () => {
  const app = ui();
  app.run("renderFeed()");
  assert.match(app.node("#messages").innerHTML, /Loading Fleet Chats/);
  assert.equal(app.node("#messages").getAttribute("aria-busy"), "true");
  assert.doesNotMatch(app.node("#transcript-page").textContent, /0.*of 0/);
  app.run("renderLanesError('Synthetic unavailable'); renderFeed()");
  assert.match(app.node("#messages").innerHTML, /Synthetic unavailable/);
  assert.equal(app.node("#messages").getAttribute("aria-busy"), "false");
  const message = record();
  app.run(`renderLanes(${JSON.stringify({format: "refs.v1", messages: [message], lanes: [{...lane("general", []), messages: [0, 0]}], transcript: {sessions: [], warnings: [], expandable: true, note: "Synthetic coverage"}})})`);
  assert.equal(app.run("lanes[0].messages.length"), 2);
  assert.equal(app.run("messagesForSelection().length"), 2, "identical events within one lane survive");
  assert.match(app.node("#messages").innerHTML, /Readable response/);
  assert.equal(app.node("#messages").getAttribute("aria-busy"), "false");
  assert.equal(app.node("#transcript-window-status").hidden, false);
  app.run("selectedSessionId = 'task'; selectedTranscriptSession = 'disk'; transcriptQuery = 'keep me'; laneStatusFilter = 'idle'");
  app.node("#transcript-load-more").dispatchEvent({type: "click"});
  const params = new URLSearchParams(app.run("lanesQuery()").slice(1));
  assert.equal(params.get("windowBytes"), String(2 * 1024 * 1024));
  assert.equal(params.get("format"), "refs.v1");
  assert.equal(params.get("session"), "task");
  assert.equal(params.get("disk"), "disk");
  assert.equal(app.run("transcriptQuery"), "keep me");
  assert.equal(app.run("laneStatusFilter"), "idle");
});

test("kind index search is strict, handles gaps and empty lists, and crosses rendered pages", () => {
  const app = ui();
  for (const [cursor, previous, next] of [[0,-1,20],[20,0,200],[199,20,200],[200,20,440],[450,440,-1]]) {
    assert.equal(app.run(`kindJumpIndex([0,20,200,440], ${cursor}, -1)`), previous);
    assert.equal(app.run(`kindJumpIndex([0,20,200,440], ${cursor}, 1)`), next);
  }
  assert.equal(app.run('kindJumpIndex([], 0, -1)'), -1);
  assert.equal(app.run('kindJumpIndex([], 0, 1)'), -1);
  seed(app, [lane('alpha', Array.from({length:451}, (_, i) => record({recordId:`r${i}`, role:i%20===0?'captain':'firstmate', occurredAt:new Date(Date.UTC(2030,0,1,12,i)).toISOString()})))]);
  app.run('renderFeed(); transcriptPage=1; renderFeed()');
  const feed = app.node('#messages');
  feed.clientHeight=100; feed.scrollHeight=1000; feed.scrollTop=900;
  const target = index => {
    const node = app.node(`#kind-target-${index}`);
    node.dataset={recordKey:`r${index}`,recordIndex:String(index)};
    node.getBoundingClientRect=()=>({top:500-feed.scrollTop,bottom:540-feed.scrollTop,height:40});
    return node;
  };
  const r180=target(180), r200=target(200);
  const current={dataset:{recordKey:'r220',recordIndex:'220'},getBoundingClientRect:()=>({top:0,bottom:40,height:40})};
  feed.querySelectorAll=selector=>selector==='article.message'?(app.run('transcriptPage')===0?[r180]:[r200,current]):[];
  app.run('updateKindNavigation()');
  assert.equal(app.run('kindJumpTargets.get("captain").previous'),200);
  assert.equal(app.run('kindJumpTargets.get("captain").next'),240);
  app.run('jumpToKind("captain", -1)');
  assert.equal(r200.getBoundingClientRect().top,12);
  assert.equal(r200.classList.contains('last-viewed-highlight'),true);
  app.run('changeCompactMode(true); jumpToKind("captain", -1)');
  assert.equal(app.run('transcriptPage'),0,'previous jumps to an older loaded page');
  assert.equal(r180.getBoundingClientRect().top,12);
  assert.equal(app.node('#messages').classList.contains('is-compact'),false,'kind jumps reveal full messages');
  app.run('jumpToKind("captain", 1)');
  assert.equal(app.run('transcriptPage'),1);
  assert.equal(app.run('messagesForSelection().length'),451);
  app.run('selectedMessageTypes.delete("captain"); renderFeed()');
  assert.equal(app.run('kindJumpTargets.get("captain").previous'),-1);
  app.run('clearTimeout(lastViewedHighlightTimer)');
});

test("fleet navigation indexes deduplicated mixed records by stable fleet ID and preserves filters", () => {
  const app = ui();
  const shared = record({recordId:'shared'});
  seed(app, [lane('alpha', [record({recordId:'older',occurredAt:'2026-01-01T12:00:00.000Z'}), shared]), lane('beta', [shared])]);
  app.run('renderFeed()');
  assert.equal(app.run('messagesForSelection().length'), 2);
  assert.equal(app.run('JSON.stringify(fleetRecordIndices.get("alpha"))'), '[0,1]');
  assert.equal(app.run('JSON.stringify(fleetRecordIndices.get("beta"))'), '[1]');
  const before = app.run('readingScope()');
  app.run('jumpToKind("beta",1,"Next message from Beta.",true)');
  assert.equal(app.run('readingScope()'), before);
  app.run('allLanesSelected=false; selectedLaneIds=new Set(["alpha"]); renderFeed()');
  assert.equal(app.run('navigationEnabled("beta",true)'), false);
  assert.equal(app.run('fleetJumpTargets.get("beta").next'), -1);
  app.run('transcriptQuery="no matching record"; renderFeed()');
  assert.equal(app.run('fleetRecordIndices.size'), 0);
  app.run('clearTimeout(lastViewedHighlightTimer)');
});

test("previous-fleet uses the shared bounded history intent and cancels on a changed scope", () => {
  const {app,anchor,newer,older,respond} = kindHistoryFixture();
  app.run('jumpToKind("alpha",-1,"Previous message from Alpha.",true)');
  assert.equal(app.run('pendingKindJump.fleet'), true);
  assert.equal(app.run('transcriptWindowBytes'), 2*1024*1024);
  respond([record({recordId:'older',occurredAt:'2026-01-01T12:00:00.000Z'}),anchor,newer],2,false);
  assert.equal(app.run('pendingKindJump'), null);
  assert.equal(older.classList.contains('last-viewed-highlight'), true);
  assert.equal(app.node('#sr-announcer').textContent, 'Previous message from Alpha.');
  app.run('clearTimeout(lastViewedHighlightTimer)');
  const cancelled = kindHistoryFixture();
  cancelled.app.run('jumpToKind("alpha",-1,"Previous message from Alpha.",true); transcriptQuery="changed"; updateKindNavigation()');
  assert.equal(cancelled.app.run('pendingKindJump'), null);
});

test("same-page record navigation explicitly reveals cached lanes and native details", () => {
  const app=ui(), feed=app.node('#messages');
  seed(app,[lane('alpha',[record({recordId:'mixed',mixedLaneMessage:{recordId:'mixed',blocks:[{projectId:'alpha',name:'Alpha',text:'Alpha body'},{projectId:'beta',name:'Beta',text:'Beta body'}]}})])]);
  app.run('allLanesSelected=false; selectedLaneIds=new Set(["alpha"]); renderFeed(); document.getElementById=id=>document.querySelector("#"+id)');
  const before=feed.innerHTML, node=app.node('#kind-cached-target'), toggle=app.node('#kind-cached-toggle');
  const chevron={textContent:'▸'}, summary={hidden:false}, detail={open:false}, body=app.node('#kind-cached-body');
  body.hidden=true;
  toggle.dataset.mixedLaneKey='["mixed","alpha",1]';
  toggle.setAttribute('aria-expanded','false'); toggle.setAttribute('aria-controls','kind-cached-body');
  toggle.querySelector=()=>chevron; toggle.parentElement={querySelector:()=>summary};
  node.dataset={recordKey:'mixed',recordIndex:'0'};
  node.getBoundingClientRect=()=>({top:500-feed.scrollTop,bottom:540-feed.scrollTop,height:40});
  node.querySelectorAll=selector=>selector==='details'?[detail]:[toggle];
  feed.querySelectorAll=selector=>selector==='article.message'?[node]:[];
  app.run('navigateToRecord(0,{expand:true})');
  assert.equal(feed.innerHTML,before,'unchanged fingerprint retains message DOM');
  assert.equal(toggle.getAttribute('aria-expanded'),'true');
  assert.equal(chevron.textContent,'▾'); assert.equal(summary.hidden,true);
  assert.equal(body.hidden,false); assert.equal(detail.open,true);
  assert.equal(node.getBoundingClientRect().top,12);
  app.run('clearTimeout(lastViewedHighlightTimer)');
});

function kindHistoryFixture() {
  const app=ui(), feed=app.node('#messages');
  const anchor=record({recordId:'anchor'}), newer=record({recordId:'newer',role:'captain',occurredAt:'2026-03-01T12:00:00.000Z'});
  seed(app,[lane('alpha',[anchor,newer])]);
  app.run('renderFeed(); transcriptCoverage={sessions:[],warnings:[],expandable:true,windowBytes:1024*1024}');
  const current=app.node('#kind-history-anchor'), older=app.node('#kind-history-older');
  current.dataset={recordKey:'anchor',get recordIndex(){return String(app.run('messagesForSelection().findIndex(m=>m.recordId==="anchor")'));}};
  current.getBoundingClientRect=()=>({top:0,bottom:40,height:40});
  older.dataset={recordKey:'older',recordIndex:'0'};
  older.getBoundingClientRect=()=>({top:500-feed.scrollTop,bottom:540-feed.scrollTop,height:40});
  feed.clientHeight=100;
  feed.querySelectorAll=selector=>selector==='article.message'?(app.run('messagesForSelection().some(m=>m.recordId==="older")')?[older,current]:[current]):[];
  const previous=app.node('#kind-history-previous');
  previous.dataset={kindJump:'captain',kindStep:'-1'}; previous.setAttribute('aria-label','Previous captain message');
  app.node('#message-type-filters').querySelectorAll=()=>[previous];
  app.run('updateKindNavigation()');
  const respond=(records,windowMiB,expandable)=>app.run(`renderLanes(${JSON.stringify({lanes:[lane('alpha',records)],transcript:{sessions:[],warnings:[],windowBytes:windowMiB*1024*1024,expandable}})})`);
  return {app,anchor,newer,older,previous,respond};
}

test("previous-kind demand widens the bounded source window and follows a stable anchor despite default thinking detection", () => {
  const {app,anchor,newer,older,previous,respond}=kindHistoryFixture();
  assert.equal(previous.disabled,false,'unloaded earlier history remains discoverable');
  app.run('jumpToKind("captain",-1)');
  assert.equal(app.run('transcriptWindowBytes'),2*1024*1024);
  assert.equal(app.run('pendingKindJump.anchorKey'),'anchor');
  assert.equal(previous.disabled,true,'one navigation intent owns the pending read');
  respond([record({recordId:'older',role:'captain',occurredAt:'2026-01-01T12:00:00.000Z'}),record({recordId:'thought',kind:'thinking',occurredAt:'2026-01-15T12:00:00.000Z'}),anchor,newer],2,false);
  assert.equal(app.run('selectedMessageTypes.has("thinking")'),true);
  assert.equal(app.run('pendingKindJump'),null);
  assert.equal(older.getBoundingClientRect().top,12);
  assert.equal(older.classList.contains('last-viewed-highlight'),true);
  assert.equal(app.run('transcriptWindowBytes'),2*1024*1024,'stop as soon as a match is found');
  app.run('clearTimeout(lastViewedHighlightTimer)');
});

test("kind history expansion stops at eight MiB, cancels superseded filters/views, and survives unavailable history", () => {
  const {app,anchor,newer,previous,respond}=kindHistoryFixture();
  app.run('jumpToKind("captain",-1)');
  for (const windowMiB of [2,4,8]) respond([anchor,newer],windowMiB,windowMiB<8);
  assert.equal(app.run('pendingKindJump'),null);
  assert.equal(app.run('transcriptWindowBytes'),8*1024*1024);
  assert.equal(previous.disabled,true);
  assert.match(app.node('#sr-announcer').textContent,/No earlier matching/);
  const stalled=kindHistoryFixture();
  stalled.app.run('jumpToKind("captain",-1)');
  stalled.respond([stalled.anchor,stalled.newer],1,true);
  assert.equal(stalled.app.run('pendingKindJump'),null);
  assert.match(stalled.app.node('#sr-announcer').textContent,/did not advance/);
  const lost=kindHistoryFixture();
  lost.app.run('jumpToKind("captain",-1)');
  lost.respond([lost.newer],2,false);
  assert.equal(lost.app.run('pendingKindJump'),null);
  assert.match(lost.app.node('#sr-announcer').textContent,/anchor is no longer loaded/);
  const canceled=kindHistoryFixture();
  canceled.app.run('jumpToKind("captain",-1); transcriptQuery="different"; renderFeed()');
  assert.equal(canceled.app.run('pendingKindJump'),null);
  const leaving=kindHistoryFixture();
  leaving.app.run('jumpToKind("captain",-1); showView("overview")');
  assert.equal(leaving.app.run('pendingKindJump'),null);
  const failed=kindHistoryFixture();
  failed.app.run('hasLoadedLanes=true; jumpToKind("captain",-1); renderLanesError("Synthetic failure"); renderFeed()');
  assert.equal(failed.app.run('pendingKindJump'),null);
  assert.equal(failed.previous.disabled,true);
  assert.equal(failed.app.node('#message-compact-toggle').disabled,true);
  assert.match(failed.app.node('#messages').innerHTML,/Synthetic failure/);
});

test("compact mode shows timestamp/sender/kind/preview per message or lane block", () => {
  const app = ui();
  const blocks = ['alpha', 'beta'].map(name => ({projectId:name, name, text:`[fm-lane ${name}]\n${name} preview\n[end ${name}]`}));
  seed(app, [lane('alpha', [record({recordId:'one',text:'[fm-lane alpha]\nMeaningful inner preview\n[end alpha]'}), record({recordId:'mixed', mixedLaneMessage:{recordId:'mixed',text:blocks.map(b=>b.text).join('\n\n'),blocks}})])]);
  app.run('renderFeed(); changeCompactMode(true)');
  const html = app.node('#messages').innerHTML;
  assert.equal((html.match(/class="(?:mixed-lane-toggle )?message-compact-line"/g)||[]).length, 3);
  assert.equal((html.match(/class="compact-clock"/g)||[]).length, 3);
  assert.match(html, /compact-sender[^>]*>Firstmate/);
  assert.match(html, /compact-kind[^>]*>Reply/);
  assert.match(html, /compact-lane">beta/);
  assert.match(html, /compact-line-preview">Meaningful inner preview/);
  assert.equal(app.run("compactPreview('[fm-lane alpha]\\nUnmatched envelope\\n[end beta]')"), '[fm-lane alpha] Unmatched envelope [end beta]');
  assert.doesNotMatch(html, /message-day/);
  assert.equal(app.node('#message-compact-toggle').getAttribute('aria-pressed'), 'true');
  assert.match(app.run("compactMetadata({author:'Unknown',kind:'tools',occurredAt:'invalid',time:'Time unknown'})"), /Time unknown/);
});

test("compact expansion marks exactly its message until an outside click, and survives refresh", () => {
  const app=ui(), feed=app.node('#messages'), target=app.node('#boxed-message');
  seed(app,[lane('alpha',[record({recordId:'boxed'})])]);
  target.dataset={recordKey:'boxed',recordIndex:'0'};
  target.closest=()=>target;
  feed.querySelectorAll=selector=>selector==='article.message' || selector==='.compact-expansion-target' && target.classList.contains('compact-expansion-target')?[target]:[];
  app.run('renderFeed(); changeCompactMode(true)');
  app.node('#messages').dispatchEvent({type:'click',target:{closest:selector=>selector==='button.message-compact-line'?{dataset:{},closest:()=>target,getBoundingClientRect:()=>({top:0})}:null}});
  assert.equal(target.classList.contains('compact-expansion-target'),true);
  app.run('renderFeed()');
  assert.equal(target.classList.contains('compact-expansion-target'),true);
  app.run('document.dispatchEvent({type:"click",target:document.querySelector("#boxed-message")})');
  assert.equal(target.classList.contains('compact-expansion-target'),true);
  app.run('document.dispatchEvent({type:"click",target:{closest:()=>null}})');
  assert.equal(target.classList.contains('compact-expansion-target'),false);
  assert.equal(app.run('expandedMessageTarget'),null);
});

test("compact choices persist through reload, filters and pages without changing record counts", () => {
  const storage = new Map(), app = ui({storage});
  seed(app,[lane('alpha',Array.from({length:451},(_,i)=>record({recordId:`r${i}`})))]);
  app.run('renderFeed(); changeCompactMode(true)');
  const scope=app.run('renderedReadingScope');
  assert.equal(ui({storage}).run(`compactViews.has(${JSON.stringify(scope)})`),true);
  app.node('#transcript-older').dispatchEvent({type:'click'});
  assert.equal(app.node('#messages').classList.contains('is-compact'),true);
  assert.equal((app.node('#messages').innerHTML.match(/<article /g)||[]).length,200);
  app.run("transcriptQuery='Readable'; renderFeed()");
  assert.equal(app.node('#messages').classList.contains('is-compact'),false);
  app.run("transcriptQuery=''; renderFeed()");
  assert.equal(app.node('#messages').classList.contains('is-compact'),true);
  app.run('changeCompactMode(false)');
  assert.equal(app.run('compactViews.has(renderedReadingScope)'),false);
});

test("compact choices bound retention, tolerate denied storage and expand tools on line activation", () => {
  const app=ui({storage:new Map([['fm-agentos-compact-views.v1','[null,7,"view"]']])});
  assert.equal(app.run('compactViews.size'),1);
  app.run("for(let i=0;i<80;i++) compactViews.add('scope-'+i); renderFeed(); changeCompactMode(true)");
  assert.equal(app.run('compactViews.size'),60);
  const denied=ui({storage:{get(){throw Error('denied');},set(){throw Error('denied');}}});
  seed(denied,[lane('alpha',[record({recordId:'tool',kind:'tools'})])]);
  denied.run("selectedMessageTypes.add('tools'); renderFeed(); changeCompactMode(true); changeCompactMode(false,{closest:()=>null,getBoundingClientRect:()=>({top:0})})");
  assert.match(denied.node('#messages').innerHTML, /<details open>/);
});

test("last viewed checkpoints use visible durable keys, survive reload, and stay scoped to filters", () => {
  const storage = new Map();
  const app = ui({ storage });
  seed(app, [lane("alpha", Array.from({ length: 4 }, (_, i) => record({ recordId: `r${i}`, text: `Reply ${i}` })))]);
  app.run("renderFeed()");
  app.node("#conversations-view").classList.add("active");
  const feed = app.node("#messages");
  let rows = [
    { dataset: { recordKey: 'r0', recordIndex: '0' }, getBoundingClientRect: () => ({ top: -10, bottom: 20, height: 30 }) },
    { dataset: { recordKey: 'r1', recordIndex: '1' }, getBoundingClientRect: () => ({ top: 25, bottom: 60, height: 35 }) },
    { dataset: { recordKey: 'r2', recordIndex: '2' }, getBoundingClientRect: () => ({ top: 65, bottom: 110, height: 45 }) },
  ];
  feed.querySelectorAll = (selector) => selector === 'article.message' ? rows : [];
  app.windowEvent('blur');
  assert.equal(app.run('lastViewed.get(renderedReadingScope)'), 'r1', 'last fully visible, not clipped later reply');
  const originalScope = app.run('renderedReadingScope');
  assert.equal(storage.has('fm-agentos-last-viewed.v1'), true);
  rows = [rows[2]];
  app.run('renderFeed()');
  assert.equal(app.run('lastViewed.get(renderedReadingScope)'), 'r1', 'refresh must not move the checkpoint');
  assert.equal(app.node('#jump-to-last-viewed').disabled, false);
  app.run("transcriptQuery = 'Reply'; renderFeed()");
  assert.equal(app.run(`lastViewed.get(${JSON.stringify(originalScope)})`), 'r2', 'leaving a filter view saves its rendered position');
  assert.equal(app.run('lastViewedIndex'), -1, 'search has its own checkpoint');
  assert.equal(app.node('#jump-to-last-viewed').disabled, true);
  const reload = ui({ storage });
  assert.equal(reload.run(`lastViewed.get(${JSON.stringify(originalScope)})`), 'r2');
  assert.equal(app.run("readingScope() === (selectedMessageTypes = new Set([...selectedMessageTypes].reverse()), readingScope())"), true, 'kind ordering is not a different view');
  app.run("lastViewed.set(readingScope(), 'missing'); renderFeed()");
  assert.equal(app.node('#jump-to-last-viewed').disabled, true, 'unloaded or filtered-out records are not invented');
});

test("last viewed selects the saved loaded page and anchors it rather than following latest", () => {
  const app = ui();
  seed(app, [lane('alpha', Array.from({ length: 451 }, (_, i) => record({ recordId: `r${i}` })))]);
  app.run('renderFeed(); lastViewed.set(renderedReadingScope, "r5"); renderFeed()');
  const feed = app.node('#messages');
  feed.scrollHeight = 1000; feed.clientHeight = 100; feed.scrollTop = 900;
  const target = app.node('#synthetic-target');
  target.dataset = { recordKey: 'r5', recordIndex: '5' };
  target.getBoundingClientRect = () => ({ top: 500 - feed.scrollTop, bottom: 540 - feed.scrollTop, height: 40 });
  const latest = { dataset: { recordKey: 'r400', recordIndex: '400' }, getBoundingClientRect: () => ({ top: 0, bottom: 40, height: 40 }) };
  feed.querySelectorAll = (selector) => selector === 'article.message' ? (app.run('transcriptPage') === 0 ? [target] : [latest]) : [];
  app.run('updateLastViewedControl()');
  assert.equal(app.node('#jump-to-last-viewed').disabled, false);
  app.node('#jump-to-last-viewed').dispatchEvent({ type: 'click' });
  assert.equal(app.run('transcriptPage'), 0);
  assert.equal(target.getBoundingClientRect().top, 12);
  assert.equal(target.classList.contains('last-viewed-highlight'), true);
  assert.equal(target.getAttribute('tabindex'), '-1');
  assert.equal(app.node('#jump-to-last-viewed').disabled, true);
  assert.equal(app.node('#sr-announcer').textContent, 'Returned to your last viewed message.');
  app.run('clearTimeout(lastViewedHighlightTimer)');
});

test("last viewed tolerates tall replies, empty panes, unavailable storage, and caps retention", () => {
  const storage = { get() { throw new Error('storage denied'); }, set() { throw new Error('storage denied'); } };
  const app = ui({ storage });
  seed(app, [lane('alpha', [record({ recordId: 'tall' })])]);
  app.run('renderFeed()');
  app.node('#conversations-view').classList.add('active');
  const feed = app.node('#messages');
  feed.querySelectorAll = (selector) => selector === 'article.message' ? [{ dataset: { recordKey: 'tall', recordIndex: '0' }, getBoundingClientRect: () => ({ top: -50, bottom: 250, height: 300 }) }] : [];
  app.windowEvent('pagehide');
  assert.equal(app.run('lastViewed.get(renderedReadingScope)'), 'tall');
  app.run("for (let i=0;i<80;i++) { renderedReadingScope = 'scope-' + i; captureLastViewed(); }");
  assert.equal(app.run('lastViewed.size'), 60);
  assert.equal(app.run("lastViewed.has('scope-0')"), false);
  feed.querySelectorAll = () => [];
  app.run("renderedReadingScope = 'empty'; captureLastViewed()");
  assert.equal(app.run("lastViewed.has('empty')"), false);
  app.node('#conversations-view').classList.remove('active');
  app.run("renderedReadingScope = 'inactive'; captureLastViewed()");
  assert.equal(app.run("lastViewed.has('inactive')"), false);
});

test("send-time chat snapshot keeps checked lanes and only viewport-visible old history", () => {
  const app = ui();
  seed(app, [lane("general", [record({ recordId: "old", text: "private old body", occurredAt: "2026-01-01T00:00:00.000Z" }),
    record({ recordId: "new", text: "private new body", occurredAt: "2026-02-01T00:00:00.000Z" })]),
  lane("alpha", [record({ recordId: "alpha", text: "hidden body" })])]);
  app.run('selectedLaneIds = new Set(["general"]); allLanesSelected = false; transcriptQuery = ""; transcriptPage = 0;');
  app.node("#conversations-view").classList.add("active");
  const feed = app.node("#messages");
  feed.querySelectorAll = () => [
    { dataset: { recordIndex: "0" }, getBoundingClientRect: () => ({ top: 0, bottom: 50, height: 50 }) },
    { dataset: { recordIndex: "1" }, getBoundingClientRect: () => ({ top: 120, bottom: 140, height: 20 }) },
  ];
  const snapshot = () => JSON.parse(app.run('JSON.stringify(window.fmChatViewContext({branch:"uat",commit:"' + 'a'.repeat(40) + '"}))'));
  const one = snapshot();
  assert.deepEqual(one.lanes.map((item) => item.id), ["general"]);
  assert.equal(one.visible.first.id, "old"); assert.equal(one.visible.last.id, "old");
  assert.doesNotMatch(JSON.stringify(one), /private|new body/);
  app.run('selectedLaneIds.add("alpha")');
  assert.deepEqual(snapshot().lanes.map((item) => item.id), ["general", "alpha"]);
  app.run('selectedLaneIds.clear()');
  assert.deepEqual(snapshot().lanes, []);
  app.run('window.location.hash = "#overview"');
  assert.deepEqual(snapshot().lanes, []); assert.equal(snapshot().visible.first, null);
});

test("own hashchanges cannot overwrite submit-time empty or multi-lane filters", () => {
  const app = ui();
  seed(app, [lane("general", []), lane("alpha", [record({ recordId: "old", text: "Old anchor" })]), lane("beta", [])]);
  app.run('navigateToLane("alpha")');
  app.hashchange("#lanes/alpha");
  app.run('applyLaneFilter({ matches: () => false, dataset: { filterLane: "beta" }, checked: true })');
  app.hashchange("#lanes");
  assert.deepEqual([...app.run('selectedLanes().map(lane => lane.id)')], ["alpha", "beta"]);
  app.run('applyLaneFilter({ matches: () => false, dataset: { filterLane: "alpha" }, checked: false })');
  app.hashchange("#lanes/beta");
  app.run('applyLaneFilter({ matches: () => false, dataset: { filterLane: "beta" }, checked: false })');
  app.hashchange("#lanes");
  assert.deepEqual([...app.run('selectedLanes().map(lane => lane.id)')], []);
  app.node("#conversations-view").classList.add("active");
  const empty = JSON.parse(app.run('JSON.stringify(window.fmChatViewContext({ branch: "uat", commit: "' + 'a'.repeat(40) + '" }))'));
  assert.deepEqual(empty.lanes, []); assert.equal(empty.visible.first, null);
  app.run('applyLaneFilter({ matches: () => false, dataset: { filterLane: "alpha" }, checked: true })');
  app.hashchange("#lanes/alpha");
  app.run('transcriptQuery = "Old anchor"; renderFeed()');
  const old = JSON.parse(app.run('JSON.stringify(window.fmChatViewContext({ branch: "uat", commit: "' + 'a'.repeat(40) + '" }))'));
  assert.deepEqual(old.lanes.map((item) => item.id), ["alpha"]);
  assert.equal(old.filters.search, "Old anchor");
});

test("work split renders separate escaped counts and explicit project waits", () => {
  const app = ui();
  app.run(`renderWorkSplit(${JSON.stringify({ tight: {
    backlog: { count: 1, items: [{ id: "task-a", name: "Fix <unsafe>" }] },
    inProgress: { count: 0, items: [] }, justLanded: { count: 0, items: [] },
  }, large: { count: 1, projects: [{ id: "project-a", name: "Capability", stage: "Discovery", waitingOn: "Captain input" }] } })})`);
  assert.match(app.node("#tight-work").innerHTML, /Fix &lt;unsafe&gt;/);
  assert.match(app.node("#tight-work").innerHTML, /Just landed <strong>0/);
  assert.equal(app.node("#large-count").textContent, "· 1");
  assert.match(app.node("#large-work").innerHTML, /Waiting on:<\/b> Captain input/);
  assert.equal(app.run('parseRoute("#work").view'), "work");
});

test("work grouping keeps tight and large separate, composes filters, and never invents themes", () => {
  const app = ui();
  const item = (id, repository, workGroup = null) => ({ id, name: id, repository, workGroup });
  const split = { tight: {
    backlog: { count: 4, items: [item("a", "Alpha", { kind: "epic", name: "Checkout <safe>" }), item("b", "Beta", { kind: "theme", name: "Reliability" }), item("c", "Alpha"), item("d", null)] },
    inProgress: { count: 1, items: [item("e", "Alpha", { kind: "epic", name: "Checkout <safe>" })] },
    justLanded: { count: 0, items: [] },
  }, large: { count: 2, projects: [
    { ...item("f", "Beta", { kind: "theme", name: "Reliability" }), phase: "inProgress", stage: "Discovery", waitingOn: "Nothing recorded" },
    { ...item("g", "Alpha"), phase: "backlog", stage: "Backlog", waitingOn: "Review" },
  ] } };
  app.run(`renderWorkSplit(${JSON.stringify(split)})`);
  let html = app.node("#tight-work").innerHTML;
  assert.ok(html.indexOf("Alpha <span>2") < html.indexOf("Beta <span>1"));
  assert.match(html, /Repository unassigned <span>1/);
  assert.match(app.node("#large-work").innerHTML, /Beta <span>1/);
  assert.equal(app.node("#large-count").textContent, "· 2");
  app.node("#work-group-by").dispatchEvent({ type: "change", target: { value: "theme" } });
  html = app.node("#tight-work").innerHTML;
  assert.match(html, /Epic: Checkout &lt;safe&gt; <span>1/);
  assert.match(html, /Voyage: Reliability <span>1/);
  assert.match(html, /Voyage \/ epic unassigned <span>2/);
  assert.doesNotMatch(html, /Epic: Fix reliability/);
  app.node("#work-repository").dispatchEvent({ type: "change", target: { value: "repo:Alpha" } });
  app.node("#work-phase").dispatchEvent({ type: "change", target: { value: "backlog" } });
  html = app.node("#tight-work").innerHTML;
  assert.match(html, /Backlog <strong>2/);
  assert.doesNotMatch(html, /Voyage: Reliability|>b<|>d<|>e<|Just landed/);
  assert.match(app.node("#large-work").innerHTML, /g<\/h3>/);
  assert.doesNotMatch(app.node("#large-work").innerHTML, /f<\/h3>/);
  assert.equal(app.node("#large-count").textContent, "· 1");
  app.node("#work-phase").dispatchEvent({ type: "change", target: { value: "justLanded" } });
  assert.doesNotMatch(app.node("#tight-work").innerHTML, /work-group/);
  assert.doesNotMatch(app.node("#large-work").innerHTML, /work-group/);
  assert.equal(app.node("#large-count").textContent, "· 0");
  app.run(`renderWorkSplit(${JSON.stringify(split)})`);
  assert.equal(app.node("#work-repository").value, "repo:Alpha");
  assert.equal(app.node("#work-phase").value, "justLanded");
});

test("unchanged refresh skips feed replacement and a newly full page follows latest", () => {
  const app = ui();
  seed(app, [lane("alpha", Array.from({ length: 200 }, (_, i) => record({ recordId: `r${i}`, text: `Turn ${i}` })))]);
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["alpha"]); renderFeed()');
  const feed = app.node("#messages");
  feed.innerHTML = "preserved disclosure and annotation DOM";
  app.run("renderFeed()");
  assert.equal(feed.innerHTML, "preserved disclosure and annotation DOM");
  feed.innerHTML = "";
  feed.clientHeight = 100; feed.scrollHeight = 100; feed.scrollTop = 0;
  app.run('lanes[0].messages.push({...lanes[0].messages[0], recordId:"new", text:"Newest turn", occurredAt:"2026-03-01T00:00:00.000Z"}); renderFeed()');
  assert.equal(app.run("transcriptPage"), 1);
  assert.match(feed.innerHTML, /Newest turn/);
});

test("older session request supersedes an in-flight refresh without erasing selection or draft", async () => {
  const calls = [];
  const app = ui({ fetchImpl(url) {
    if (!url.startsWith("/api/lanes")) return new Promise(() => {});
    return new Promise((resolve) => calls.push({ url, resolve: (data) => resolve({ ok: true, json: async () => data }) }));
  } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  app.run('taskOlderPages = 1; selectedSessionId = "old"; requestLanes()');
  assert.equal(calls.length, 1);
  calls[0].resolve({ lanes: [lane("alpha", [record({ text: "stale" })])], source: "old", transcript: { sessions: [], warnings: [] } });
  await flush();
  assert.equal(calls.length, 2);
  assert.match(calls[1].url, /older=1/);
  assert.match(calls[1].url, /session=old/);
  assert.equal(app.node("#messages").innerHTML.includes("stale"), false);
  calls[1].resolve({ lanes: [{ ...lane("alpha", [record({ text: "fresh", taskId: "old" })]), sessions: [{ id: "old", state: "done", loaded: true }] }], source: "new", transcript: { sessions: [], warnings: [] } });
  await flush();
  assert.equal(app.run('selectedSessionId'), "old");
  assert.equal(app.run('lanes[0].messages[0].text'), "fresh");
});

test("slow large lane response cannot block Overview or Quota, and refreshes do not overlap", async () => {
  const calls = { dashboard: [], lanes: [], quota: [], preferences: [] };
  const app = ui({ fetchImpl(url) {
    const name = new URL(url, "http://localhost").pathname.split("/").at(-1);
    return new Promise((resolve, reject) => calls[name].push({
      resolve: (value) => resolve({ ok: true, json: async () => value }), reject,
    }));
  } });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.lanes.length, 1);
  app.run("loadDashboard(); loadDashboard();");
  assert.equal(calls.dashboard.length, 1);
  assert.equal(calls.quota.length, 1);
  assert.equal(calls.lanes.length, 1);
  calls.dashboard[0].resolve({ fleet: { summary: { activeAgents: 2 }, projects: [] }, expenses: { entries: [], projects: [], categories: [], overall: [], entryCount: 0 }, refreshMs: 0 });
  calls.quota[0].resolve({ providers: [], readAt: new Date().toISOString(), stale: false });
  await flush();
  assert.match(app.node("#summary").innerHTML, /Active agents/);
  assert.match(app.node("#quota-state").textContent, /Quota source last read/);
  assert.equal(app.run("freshness.dashboard.refreshing"), false);
  assert.equal(app.run("freshness.lanes.refreshing"), true);
  app.run('showView("quota"); renderFreshness()');
  assert.match(app.node("#view-freshness").title, /^Quota · fresh · Last success/);
  app.run('showView("conversations"); loadDashboard();');
  assert.equal(calls.lanes.length, 1, "manual and automatic refresh must skip in-flight history");
  assert.equal(calls.dashboard.length, 2, "Overview can update while lanes are slow");
  calls.lanes[0].resolve({ lanes: [lane("general", Array.from({ length: 1000 }, (_, i) => record({ text: `History ${i}` })))], source: "synthetic", transcript: { sessions: [], warnings: [], note: "" } });
  await flush();
  assert.match(app.node("#view-freshness").title, /^Fleet Chats · fresh · Last success/);
  assert.equal(app.run("messagesForSelection().length"), 1000);
  assert.equal((app.node("#messages").innerHTML.match(/<article/g) || []).length, 200);
  calls.dashboard[1].resolve({ fleet: { summary: { activeAgents: 3 }, projects: [] }, expenses: { entries: [], projects: [], categories: [], overall: [], entryCount: 0 }, refreshMs: 0 });
  calls.quota[1].resolve({ providers: [], readAt: null, stale: true, error: "source unavailable" });
  await flush();
  app.run('showView("quota")');
  assert.match(app.node("#view-freshness").title, /^Quota · disconnected · Last success.*source unavailable/);
  app.run('showView("overview")');
  assert.match(app.node("#view-freshness").title, /^Captain's Call · waiting · No successful reading/);
});

test("preference density, sorting and expansion persist through rendering", () => {
  const app = ui();
  const entries = [
    { title: "Old", content: "Old details", rationale: "Old reason", date: "2025-01-01", addedAt: null, source: "data/captain.md:1-3" },
    { title: "New", content: "New details", rationale: "New reason", date: "2026-01-01", addedAt: "2026-02-02", source: "data/captain.md:4-6" },
    { title: "Unknown", content: "Unknown details", rationale: null, date: null, source: "data/captain.md:7-9" },
  ];
  app.run(`renderPreferences(${JSON.stringify({ entries, source: "data/captain.md" })})`);
  app.run('preferenceSort = "newest"; preferenceDensity = "reasons"; renderPreferenceList()');
  const html = app.node("#preferences-list").innerHTML;
  assert.ok(html.indexOf("New</h2>") < html.indexOf("Old</h2>"));
  assert.ok(html.indexOf("Old</h2>") < html.indexOf("Unknown</h2>"));
  assert.match(html, /Date added: 2026-02-02/);
  assert.match(app.node("#preferences-list").className, /density-reasons/);
  app.node("#preferences-collapse").dispatchEvent({ type: "click" });
  assert.doesNotMatch(app.node("#preferences-list").innerHTML, /<details[^>]+ open>/);
  app.node("#preferences-expand").dispatchEvent({ type: "click" });
  assert.equal((app.node("#preferences-list").innerHTML.match(/<details[^>]+ open>/g) || []).length, 3);
  assert.match(css, /\.density-reasons \.preference-content[^}]+display: none/);
});

test("phone source-window controls move as one stateful item into Fleet Chat options", async () => {
  const shell = await readFile(new URL('../public/shell-panel.js', import.meta.url), 'utf8');
  const shellCss = await readFile(new URL('../public/shell-panel.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.equal(shell.split('moveControl(document.querySelector("#transcript-window-status"), chatTools);').length - 1, 2, 'rehome on phone setup and immediately before opening options');
  assert.match(shell, /anchor\.replaceWith\(node\)/, 'desktop restores the original node');
  assert.match(shellCss, /\.mobile-chat-tools \.transcript-window-status button \{ min-height: 44px; width: 100%; \}/);
  assert.match(html, /id="transcript-load-more"[^>]*aria-describedby="transcript-window-hint"/);
  assert.equal(html.split('id="transcript-load-more"').length - 1, 1, 'no duplicated stateful button');
});

test("full history is retained across bounded pages and disk-session selection", () => {
  const app = ui();
  const messages = Array.from({ length: 451 }, (_, i) => record({ text: `Turn ${i}`, recordId: `session:${i}`, transcriptSessionId: i < 250 ? "old.jsonl" : "new.jsonl" }));
  seed(app, [lane("general", messages), lane("alpha", messages)]);
  app.run("renderFeed()");
  assert.equal(app.run("messagesForSelection().length"), 451, "cross-lane duplicates collapse, not genuine repeated turns");
  assert.match(app.node("#transcript-page").textContent, /401–451 of 451/);
  assert.equal((app.node("#messages").innerHTML.match(/<article/g) || []).length, 51);
  app.run("transcriptPage = 0; renderFeed()");
  assert.match(app.node("#messages").innerHTML, /Turn 0</);
  assert.equal((app.node("#messages").innerHTML.match(/<article/g) || []).length, 200);
  app.run('selectedTranscriptSession = "old.jsonl"; renderFeed()');
  assert.equal(app.run("messagesForSelection().length"), 250);
  assert.match(app.node("#messages").innerHTML, /Session · old.jsonl/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /Turn 250</);
});

test("review notes show prompts with accessible native metadata chips and prompt compact previews", () => {
  const app = ui();
  const review = { batch: "123e4567-e89b-12d3-a456-426614174000", route: "#lanes/alpha", end: false, version: "a".repeat(40), preview: "uat", prompts: [{ prompt: "Fix the value", tag: "span", selector: "#secret-selector", text: "target" }, { prompt: "Looks good", tag: "message", selector: "", text: "" }] };
  seed(app, [lane("alpha", [record({ role: "captain", text: "Quarterdeck review: raw metadata", review })])]);
  app.run("renderFeed()");
  const html = app.node("#messages").innerHTML;
  assert.match(html, /Fix the value/);
  assert.match(html, /Looks good/);
  assert.match(html, /<details class="review-meta" data-review-chip="batch"/);
  assert.match(html, /aria-label="Review batch information"/);
  assert.match(html, /aria-label="Annotation target for note 1:/);
  assert.doesNotMatch(html, /Annotation target for note 2:/);
  assert.doesNotMatch(html, /Quarterdeck review: raw metadata/);
  app.run('compactViews.add(renderedReadingScope); renderFeed()');
  assert.match(app.node("#messages").innerHTML, /compact-line-preview[^]*Fix the value; Looks good/);
  app.run('messageFormat = "raw"; renderFeed()');
  assert.match(app.node("#messages").innerHTML, /Quarterdeck review: raw metadata/);
});

test("Lane Chat renders original IDs and exact quote snapshots without fabricating identities", () => {
  const app = ui();
  const one = record({ recordId: "main-pi-session/a.jsonl:12:0", text: "First message" });
  const two = record({ recordId: "main-pi-session/a.jsonl:13:0", text: "Second message" });
  const noId = record({ text: "working: repeated" });
  seed(app, [lane("alpha", [one, two, noId, noId]), lane("general", [one, two, noId, noId])]);
  app.run("renderFeed()");
  const targets = JSON.parse(app.run("JSON.stringify(window.quarterdeckMessageTargets)"));
  assert.deepEqual(targets.slice(0, 2), [
    { type: "record", recordId: one.recordId }, { type: "record", recordId: two.recordId },
  ]);
  assert.equal(targets.length, 4, "identical no-ID events in one lane remain separate rows");
  assert.deepEqual(targets.slice(2), Array(2).fill({ source: "state/alpha.status", occurredAt: "2026-02-01T12:00:00.000Z", text: "working: repeated", lanes: ["alpha", "general"] }));
  assert.match(app.node("#messages").innerHTML, /data-lane-message-index="3"/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /data-review-id="record:/);
});

test("a selected sibling lane renders only its projected block, not the unchecked lane or General copy", () => {
  const app = ui();
  const store = record({ text: "[fm-lane Example Store]\nSynthetic store update.\n[end Example Store]", recordId: "part:0" });
  const agent = record({ text: "[fm-lane fm-quarterdeck]\nSynthetic Quarterdeck update.\n[end fm-quarterdeck]", recordId: "part:1" });
  seed(app, [lane("example-store", [store]), lane("fm-quarterdeck", [agent]), lane("general", [])]);
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["fm-quarterdeck", "general"]); renderFeed()');
  const html = app.node("#messages").innerHTML;
  assert.match(html, /Synthetic Quarterdeck update/);
  assert.match(html, /class="message-lane">fm-quarterdeck<\/span>/);
  assert.doesNotMatch(html, /Synthetic store update|class="message-lane">General<\/span>/);
});

test("mixed lane replies preserve context with selected sections expanded and unchecked sections collapsed", () => {
  const app = ui();
  const blocks = ["general", "alpha", "beta"].map((projectId) => ({ projectId, name: `${projectId}-UI`,
    text: `[fm-lane ${projectId}-UI]\n${projectId} context <img src=x>\nSecond line\n[end ${projectId}-UI]` }));
  const mixedLaneMessage = { recordId: "original:1", text: blocks.map(({ text }) => text).join("\n\n"), blocks };
  seed(app, blocks.map((block, index) => lane(block.projectId, [record({ recordId: `original:1:block:${index}`, text: block.text, mixedLaneMessage })])));
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["alpha"]); renderFeed()');
  const html = app.node("#messages").innerHTML;
  assert.equal((html.match(/<article /g) || []).length, 1);
  assert.equal((html.match(/class="mixed-lane-toggle"[^>]*aria-expanded="false"/g) || []).length, 2);
  assert.equal((html.match(/class="mixed-lane-toggle"[^>]*aria-expanded="true"/g) || []).length, 1);
  assert.match(html, /\[fm-lane <strong>alpha-UI<\/strong>\]<\/button>/);
  assert.equal((html.match(/\[fm-lane /g) || []).length, 3, "each marker is the toggle, not repeated in its body");
  assert.match(html, /2 lines/);
  assert.doesNotMatch(html, /<img /);
  assert.match(html, /&lt;img src=x&gt;/);
  assert.equal(app.run('window.quarterdeckMessageTargets[0].recordId'), "original:1");
  app.run('allLanesSelected = true; renderFeed()');
  assert.equal((app.node("#messages").innerHTML.match(/class="mixed-lane-toggle"[^>]*aria-expanded="true"/g) || []).length, 3);
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["alpha", "beta"]); renderFeed()');
  assert.equal((app.node("#messages").innerHTML.match(/class="mixed-lane-toggle"[^>]*aria-expanded="true"/g) || []).length, 2);
  app.run('messageFormat = "raw"; renderFeed()');
  assert.match(app.node("#messages").innerHTML, /mixed-lane-content" hidden/);
});

test("record search narrows the loaded history without changing lane or kind filters", () => {
  const app = ui();
  seed(app, [lane("alpha", [
    record({ text: "Deploy the transcript search", author: "Captain" }),
    record({ text: "Unrelated status", source: "state/other.status" }),
  ]), lane("beta", [record({ text: "Alpha lane context" })])]);
  app.run('transcriptQuery = "deploy"; renderFeed();');
  assert.equal(app.run("messagesForSelection().length"), 1);
  assert.match(app.node("#messages").innerHTML, /<mark>Deploy<\/mark> the transcript search/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /Unrelated status/);
  app.run('transcriptQuery = "state\\/other"; renderFeed();');
  assert.equal(app.run("messagesForSelection().length"), 1);
  assert.match(app.node("#messages").innerHTML, /Unrelated status/);
});

test("redesigned feed retains default visibility, live-lane safety and causal ordering", () => {
  const app = ui();
  seed(app, [lane("alpha", [
    record(),
    record({ role: "crew", kind: "crew", text: "Crew status" }),
    record({ kind: "thinking", text: "Thinking record" }),
    record({ role: "captain", author: "Captain", text: "Driving prompt" }),
  ]), lane("archive", [record({ text: "Closed record" })], true)]);
  assert.equal(app.run("Array.from(selectedMessageTypes).join(',')"), "captain,conversation,supervision");
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('|')"), "Driving prompt|Readable response");
  app.run('selectedMessageTypes = new Set(MESSAGE_TYPES.map(type => type.id)); renderFeed();');
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('|')"), "Driving prompt|Thinking record|Readable response|Crew status");
  assert.doesNotMatch(app.node("#messages").innerHTML, /Closed record/);
  assert.match(app.node("#messages").innerHTML, /kind-thinking/);
  assert.match(app.node("#messages").innerHTML, /kind-crew/);
  assert.match(app.node("#messages").innerHTML, /origin-captain">captain</);
  assert.match(app.node("#messages").innerHTML, /origin-thinking">thinking</);
  assert.match(app.node("#messages").innerHTML, /origin-conversation">Firstmate replies</);
  assert.match(app.node("#messages").innerHTML, /origin-crew">crew status</);
  assert.equal(app.node("#messages").scrollTop, 100);
});

test("individual lanes, All override and explicit closed history remain independent", () => {
  const app = ui();
  seed(app, [lane("alpha", [record()]), lane("beta", [record({ text: "Beta response" })]), lane("archive", [record({ text: "History" })], true)]);
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["beta"]); renderFeed();');
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('|')"), "Beta response");
  app.run('allLanesSelected = true; renderFeed();');
  assert.equal(app.run("selectedLanes().map(l => l.id).join(',')"), "alpha,beta");
  app.run('showView("conversations", "archive"); renderFeed();');
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('|')"), "History");
  app.run('showView("conversations"); renderFeed();');
  assert.doesNotMatch(app.node("#messages").innerHTML, /History/);
});

test("pinned collapsed All control restores all live lanes without selecting closed history or changing status/kind filters", () => {
  const app = ui();
  seed(app, [lane("alpha", [record()]), lane("beta", [record({ text: "Beta response" })]), lane("archive", [record({ text: "History" })], true)]);
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["beta"]); laneStatusFilter = "all"; renderFeed();');
  const beforeKinds = app.run('Array.from(selectedMessageTypes).join(",")');
  app.node("#lane-collapsed-rail").dispatchEvent({ type: "click", target: {
    closest: () => ({ dataset: { filterAll: "true" } }),
  } });
  assert.equal(app.run("allLanesSelected"), true);
  assert.equal(app.run("selectedLanes().map(l => l.id).join(',')"), "alpha,beta");
  assert.equal(app.run("laneStatusFilter"), "all");
  assert.equal(app.run('Array.from(selectedMessageTypes).join(",")'), beforeKinds);
  assert.doesNotMatch(app.node("#messages").innerHTML, /History/);
  assert.equal(app.run("laneSelection().routeId"), "");
});

test("message filters use stock labels in signal order and expose Select all/Clear smart toggle", () => {
  const app = ui();
  app.run("renderMessageTypeFilters();");
  const html = app.node("#message-type-filters").innerHTML;
  for (const label of ["captain", "Firstmate replies", "supervision outcomes", "thinking", "steers", "crew status", "crew replies", "tools", "harness"]) {
    assert.match(html, new RegExp(label));
  }
  assert.ok(html.indexOf("captain") < html.indexOf("Firstmate replies"));
  assert.ok(html.indexOf("Firstmate replies") < html.indexOf("supervision outcomes"));
  assert.ok(html.indexOf("supervision outcomes") < html.indexOf("thinking"));
  // Default preference is partial (crew hidden) → Select all mode.
  assert.equal(app.node("#kinds-bulk-toggle").dataset.mode, "select");
  assert.equal(app.node("#kinds-bulk-toggle").textContent, "Select all");
  app.run('selectedMessageTypes = new Set(MESSAGE_TYPES.map(type => type.id)); renderMessageTypeFilters();');
  assert.equal(app.node("#kinds-bulk-toggle").dataset.mode, "clear");
  assert.equal(app.node("#kinds-bulk-toggle").textContent, "Clear");
  app.run("selectedMessageTypes.clear(); renderMessageTypeFilters();");
  assert.equal(app.node("#kinds-bulk-toggle").dataset.mode, "select");
  assert.match(css, /\.message-type-option[^}]+height: 44px[^}]+white-space: nowrap/s);
  assert.match(css, /\.bulk-toggle/);
});

test("lane chat stream context shows the selected crews' durable task intents", () => {
  const app = ui();
  const alpha = lane("alpha", [record()]);
  alpha.items = [
    { title: "alpha-worker", state: "working", isLive: true, taskIntent: "Implement Alpha's current command summary" },
    { title: "unrecorded-worker", state: "working", isLive: true },
  ];
  seed(app, [alpha]);
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["alpha"]); renderFeed();');
  const html = app.node("#context-items").innerHTML;
  assert.match(html, /alpha-worker/);
  assert.match(html, /Implement Alpha&#039;s current command summary/);
  assert.match(html, /Task intent not recorded\./);
  assert.doesNotMatch(html, /Firstmate|Readable response/);
  assert.match(css, /\.context-task-intent[^}]+font-size: var\(--text-small\)/s);
});

test("fresh thinking default follows actual native content, without creating messages", () => {
  const app = ui();
  const data = { lanes: [lane("general", [record({ kind: "thinking", text: "Native reasoning" })])], source: "Test" };
  app.run(`renderLanes(${JSON.stringify(data)})`);
  assert.equal(app.run('selectedMessageTypes.has("thinking")'), true);
  assert.equal(app.run("messagesForSelection().length"), 1);
  app.run(`renderLanes(${JSON.stringify({ ...data, lanes: [lane("general", [])] })})`);
  assert.equal(app.run('selectedMessageTypes.has("thinking")'), false);
  assert.equal(app.run("messagesForSelection().length"), 0);
});

test("fleet notes are default-on, captain has its own toggle, and steers stay internal", () => {
  const app = ui();
  seed(app, [lane("general", [record({ role: "captain", text: "Captain chat" }), record({ kind: "supervision", text: "Real fleet note" }), record({ kind: "steer", text: "Captain clarification (must follow): internal steer" })])]);
  app.run("renderFeed()");
  assert.match(app.node("#messages").innerHTML, /Real fleet note/);
  assert.match(app.node("#messages").innerHTML, /kind-supervision[\s\S]*?message-kind-svg/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /internal steer/);
  app.run('selectedMessageTypes.delete("captain"); selectedMessageTypes.add("steer"); renderFeed()');
  assert.doesNotMatch(app.node("#messages").innerHTML, /Captain chat/);
  assert.match(app.node("#messages").innerHTML, /origin-steer/);
});

test("message metadata and safe Markdown/raw views preserve readable source text", () => {
  const app = ui();
  seed(app, [lane("alpha", [record({ text: '# Heading\n**bold** [fm-lane Alpha]\n<script>alert("x")</script>', source: 'state/<private>.status' })])]);
  app.run("renderFeed();");
  let html = app.node("#messages").innerHTML;
  assert.match(html, /<time datetime="2026-02-01T12:00:00.000Z">12:00<\/time>/);
  assert.match(html, /<small class="message-source">state\/&lt;private&gt;.status<\/small>/);
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<strong>bold<\/strong> \[fm-lane Alpha\]/);
  assert.doesNotMatch(html, /<script>|<private>/);
  app.run('messageFormat = "raw"; renderFeed();');
  html = app.node("#messages").innerHTML;
  assert.match(html, /message-content raw/);
  assert.match(html, /# Heading/);
  assert.doesNotMatch(html, /<h1>|<script>/);
  app.run("selectedMessageTypes.clear(); renderFeed();");
  assert.match(app.node("#messages").innerHTML, /message kind below/);
});

test("Fleet Chats default and explicit hash routes restore views and sessions", () => {
  assert.match(script, /if \(!window\.location\.hash\) window\.location\.hash = "#lanes";/);
  const app = ui();
  assert.equal(app.run('parseRoute("#lanes").view'), "conversations");
  assert.equal(app.run('parseRoute("#quota").view'), "quota");
  const alpha = lane("alpha lane", [record({ taskId: "alpha-task", text: "Scoped task record" })]);
  alpha.sessions = [{ id: "alpha-task", state: "working" }];
  seed(app, [alpha]);

  app.run('window.location.hash = "#expenses"; applyRoute();');
  assert.equal(app.node(".workspace").dataset.view, "expenses");
  app.run('window.location.hash = "#lanes/alpha%20lane/session/alpha-task"; applyRoute();');
  assert.equal(app.node(".workspace").dataset.view, "conversations");
  assert.equal(app.run("selectedSessionId"), "alpha-task");
  assert.equal(app.run("selectedLanes()[0].id"), "alpha lane");
  assert.match(app.node("#messages").innerHTML, /Scoped task record/);
  assert.equal(app.run('conversationRoute("alpha lane", "alpha-task")'), "#lanes/alpha%20lane/session/alpha-task");
});

test("feed avatars use semantic symbols and tool output stays escaped literal text", () => {
  const app = ui();
  const kinds = ["tools", "thinking", "steer", "branch", "harness", "conversation"];
  seed(app, [lane("alpha", kinds.map((kind, i) => record({ kind, recordId: String(i), text: kind === "tools" ? '- removed\n# comment\n<script>unsafe</script>' : kind })))]);
  app.run('selectedMessageTypes = new Set(MESSAGE_TYPES.map(type => type.id)); renderFeed();');
  const html = app.node("#messages").innerHTML;
  for (const kind of kinds) {
    assert.match(html, new RegExp(`kind-${kind}[^]*?<div class="avatar" aria-hidden="true"><svg class="message-kind-svg"`));
  }
  assert.match(html, /message-content raw">- removed\n# comment\n&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<li>removed|<h1>comment|<script>/);
  app.run('messageFormat = "raw"; renderFeed();');
  assert.match(app.node("#messages").innerHTML, /kind-tools[^]*?message-content raw">- removed/);
});

test("thinking and tool records use compact native disclosure controls", () => {
  const app = ui();
  seed(app, [lane("alpha", [
    record({ kind: "thinking", text: "Reason through the next structural move" }),
    record({ kind: "tools", text: "functions.read report.md" }),
  ])]);
  app.run('selectedMessageTypes = new Set(["thinking", "tools"]); renderFeed();');
  const html = app.node("#messages").innerHTML;
  assert.equal((html.match(/class="message compact-record/g) || []).length, 2);
  assert.match(html, /<details><summary>/);
  assert.doesNotMatch(html, /<details open/);
  assert.match(html, /compact-preview/);
  assert.match(css, /\.compact-record \.message-body summary[^}]+min-height: 44px/s);
});

test("Phase 2.6 compact rows, bounded tools, and two-row mobile controls", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(css, /\.compact-record \+ \.compact-record \{ margin-top: calc\(12px - var\(--space-5\)\); \}/);
  assert.match(css, /\.message\.kind-tools \.message-content \{ max-height: 440px; overflow-y: auto;/);
  // D3.1 moved feed-actions into conversation-head ahead of transcript diagnostics.
  const actions = html.slice(html.indexOf('<div class="feed-actions"'), html.indexOf('<div class="conversation-head-actions"'));
  const diagnostics = html.slice(html.indexOf('id="transcript-details"'), html.indexOf('<div class="conversation-body"'));
  assert.doesNotMatch(actions, /id="transcript-session"/);
  assert.match(diagnostics, /id="transcript-session"/);
  const mobile = css.slice(css.indexOf('@media (max-width: 720px)'));
  assert.match(mobile, /\.feed-actions \.transcript-search \{ flex: 1 1 0; min-width: 0;/);
  assert.match(mobile, /\.feed-pagination \{ width: 100%;/);
  assert.match(mobile, /\.kind-filter-popover \{ right: 0; left: auto;/);
  assert.doesNotMatch(mobile, /right: -48px/);
  assert.match(mobile, /\.task-filter-chip button \{ width: 40px; height: 40px;/);
  assert.match(mobile, /\.lane-chats-row \{[^}]+grid-template-columns: minmax\(0, 1fr\) 48px 104px/s);
  assert.match(mobile, /grid-template-columns: repeat\(5, minmax\(0, 1fr\)\)/);
  assert.match(mobile, /\.primary-nav > \.primary-tab\[data-view="work"\] \{ grid-column: 2; grid-row: 2; \}/);
});

test("responsive context is an accessible escape-dismissable drawer, never below the feed", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="context-toggle"[^>]+aria-controls="context-rail"[^>]+aria-expanded="false"/);
  assert.match(html, /id="context-close"[^>]+aria-label="Close conversation context"/);
  assert.match(css, /@media \(max-width: 1200px\)[\s\S]+\.context-rail \{ position: fixed;/);
  assert.doesNotMatch(css, /\.context-rail \{ grid-column: 2/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]+\.lane-list \{ position: fixed;[^}]+inset: auto 0 0;/);
  assert.match(css, /\.conversation \{ height: 100%; min-height: 0; \}/);

  const app = ui();
  app.run("setContextDrawer(true)");
  assert.equal(app.node("#context-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(app.node("#context-rail").getAttribute("aria-hidden"), "false");
  assert.equal(app.node(".workspace").classList.contains("context-open"), true);
  app.run('document.dispatchEvent({ type: "keydown", key: "Escape" })');
  assert.equal(app.node("#context-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(app.node("#context-rail").getAttribute("aria-hidden"), "true");
});

test("feed actions are consolidated above the feed and lane reorder machinery is absent", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const actions = html.indexOf('class="feed-actions"');
  const messages = html.indexOf('id="messages"');
  assert.ok(actions > 0 && actions < messages);
  assert.doesNotMatch(html, /class="feed-meta"|draggable=/);
  assert.doesNotMatch(script, /LANE_ORDER_KEY|dragstart|dragover|dragend|saveLaneOrder/);
});

function luminance(hex) {
  const rgb = hex.match(/[\da-f]{2}/gi).map((part) => {
    const value = parseInt(part, 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (light + .05) / (dark + .05);
}
const color = (name) => css.match(new RegExp(`--${name}: (#[\\da-f]{6})`))[1];

test("visual tokens meet AA text contrast across the reading surfaces", () => {
  for (const foreground of ["text", "muted", "accent"]) {
    for (const background of ["canvas", "surface", "sidebar", "surface-soft", "accent-soft"]) {
      const ratio = contrast(color(foreground), color(background));
      assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrast("#ffffff", color("accent")) >= 4.5);
  assert.ok(contrast(color("control-line"), color("surface")) >= 3);
  assert.ok(contrast(color("focus"), color("canvas")) >= 3);
});

test("reading scale and offline font stack are explicit design constraints", () => {
  assert.match(css, /--text-body: 16px/);
  assert.match(css, /--text-ui: 14px/);
  assert.doesNotMatch(css, /@import|fonts\.googleapis/);
  assert.match(css, /prefers-reduced-motion/);
  assert.match(css, /forced-colors/);
});

test("desktop filtering belongs to Lane Chat columns, not the app shell", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const shell = html.slice(0, html.indexOf('<div class="main-stage">'));
  const chat = html.slice(html.indexOf('<section id="conversations-view"'), html.indexOf('<section id="overview-view"'));
  assert.doesNotMatch(shell, /id="lane-options"|id="lane-status"|id="message-type-filters"/);
  assert.match(chat, /class="conversation-body"[\s\S]*id="lane-options"[\s\S]*class="conversation-feed"[\s\S]*id="conversation-kind-panel"/);
  assert.match(chat, /id="kind-filter-menu"[\s\S]*id="message-type-filters"/);
  assert.match(css, /\.conversation-body \{[^}]*grid-template-columns: minmax\(180px, 215px\) minmax\(0, 1fr\) minmax\(175px, 205px\)/);
  assert.match(css, /\.conversation-kind-panel \.kind-filter-popover \{ position: static/);
  assert.match(css, /@media \(max-width: 1200px\) \{[\s\S]*\.conversation-kind-panel \{ display: none; \}/);
});

test("desktop filter panels collapse independently without changing filter selection or mobile disclosure", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="lane-panel-toggle"[^>]*aria-controls="lane-filter-controls"[^>]*aria-expanded="true"/);
  assert.match(html, /id="kind-panel-toggle"[^>]*aria-controls="kind-filter-menu"[^>]*aria-expanded="true"/);
  assert.match(css, /#lane-options\[data-collapsed="true"\] \.lane-collapsed-rail/);
  assert.match(css, /#lane-options\[data-collapsed="true"\] \.lane-rail-item/);
  assert.match(css, /#conversation-kind-panel\[data-collapsed="true"\]:is\(:hover, :focus-within\) \.kind-filter-menu/);
  assert.match(css, /#conversation-kind-panel\[data-collapsed="true"\] \.message-kind-label[\s\S]*?\.message-types-actions \{ display: none/);
  const header=element('header',['conversation-head']);
  const tracks=element('div',['conversation-header-controls'],{},header);
  assert.equal(computed(parseCss(css),tracks,1600).display,'grid');
  assert.equal(computed(parseCss(css),tracks,1600).overflow,'visible');
  const app = ui({ compact: false });
  app.run('selectedMessageTypes = new Set(["captain"]); selectedLaneIds = new Set(["general"]);');
  app.node("#lane-panel-toggle").dispatchEvent({ type: "click" });
  assert.equal(app.node("#conversation-filter-shortcut").getAttribute("aria-expanded"), "false");
  app.node("#kind-panel-toggle").dispatchEvent({ type: "click" });
  assert.equal(app.node("#lane-panel-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(app.node("#kind-panel-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(app.node("#lane-options").dataset.collapsed, "true");
  assert.equal(app.node("#conversation-kind-panel").dataset.collapsed, "true");
  assert.equal(app.run('selectedMessageTypes.has("captain") && selectedLaneIds.has("general")'), true);
  app.node("#lane-panel-toggle").dispatchEvent({ type: "click" });
  assert.equal(app.node("#lane-options").dataset.collapsed, "false");
  assert.equal(app.node("#conversation-kind-panel").dataset.collapsed, "true");
  assert.equal(app.node("#lane-filter-toggle").getAttribute("aria-expanded"), "true");
  app.node("#conversation-filter-shortcut").dispatchEvent({ type: "click" });
  assert.equal(app.node("#lane-options").dataset.collapsed, "true");
  assert.equal(app.node("#conversation-filter-shortcut").getAttribute("aria-expanded"), "false");
  app.run('renderMessageTypeFilters()');
  assert.match(app.node("#message-type-filters").innerHTML, /aria-label="captain"[\s\S]*message-kind-glyph[\s\S]*message-kind-svg/);
  assert.match(app.node("#message-type-filters").innerHTML, /title="tools"[\s\S]*aria-label="tools"/);
});

test("message-kind filters keep authoritative labels without shell class collisions", () => {
  const app = ui({ compact: false });
  app.run('renderMessageTypeFilters()');
  const filters = app.node('#message-type-filters').innerHTML;
  for (const [id, label] of [['captain', 'captain'], ['conversation', 'Firstmate replies'], ['supervision', 'supervision outcomes'], ['thinking', 'thinking']]) {
    assert.match(filters, new RegExp(`class="message-type-option" title="${label}"[\\s\\S]*?value="${id}" aria-label="${label}"[\\s\\S]*?class="message-kind-label">${label}<`));
  }
  assert.doesNotMatch(filters, /class="message-type-option conversation"/);
  assert.match(css, /\.conversation \{[^}]*flex-direction: column/); // The former class collision stacked the checkbox, icon and label.
});

test("reported lane status filtering never invents stale options or per-user pin/unread data", () => {
  const app = ui();
  seed(app, [lane("alpha", [record({ text: "Alpha" })]), lane("beta", [record({ text: "Beta" })])]);
  app.run('lanes[0].status = "working"; lanes[1].status = "working"; laneStatusFilter = "working"; renderLaneFilters();');
  assert.match(app.node("#lane-status").innerHTML, /value="working"/);
  assert.doesNotMatch(app.node("#lane-status").innerHTML, /value="active"|value="unread"|value="pinned"/);
  assert.equal(app.run("selectedLanes().length"), 2);
  app.run('lanes[0].status = "done"; lanes[1].status = "done"; renderLaneFilters();');
  assert.equal(app.run("laneStatusFilter"), "all");
  assert.doesNotMatch(app.node("#lane-status").innerHTML, /value="working"/);
  assert.equal(app.run("selectedLanes().length"), 2);
});

test("lane filter All uncheck clears selection and individual lane toggle synchronizes All state", () => {
  const app = ui();
  seed(app, [
    lane("alpha", [record({ text: "Alpha message" })]),
    lane("beta", [record({ text: "Beta message" })]),
  ]);
  app.run("hasLoadedLanes = true; allLanesSelected = true; renderFeed();");
  assert.equal(app.run("allLanesSelected"), true);
  assert.equal(app.run("selectedLanes().length"), 2);

  // Unchecking "All" clears selected lanes
  app.run('applyLaneFilter({ matches: (s) => s === "[data-filter-all]", checked: false });');
  assert.equal(app.run("allLanesSelected"), false);
  assert.equal(app.run("selectedLaneIds.size"), 0);
  assert.equal(app.run("messagesForSelection().length"), 0);
  assert.match(app.node("#messages").innerHTML, /Choose at least one fleet to show its records/);

  // Checking one lane selects only that lane and does not mark allLanesSelected
  app.run('applyLaneFilter({ matches: () => false, dataset: { filterLane: "alpha" }, checked: true });');
  assert.equal(app.run("allLanesSelected"), false);
  assert.equal(app.run("selectedLaneIds.has('alpha')"), true);
  assert.equal(app.run("selectedLaneIds.has('beta')"), false);
  assert.equal(app.run("selectedLanes().length"), 1);
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('')"), "Alpha message");

  // Checking the remaining lane automatically restores allLanesSelected
  app.run('applyLaneFilter({ matches: () => false, dataset: { filterLane: "beta" }, checked: true });');
  assert.equal(app.run("allLanesSelected"), true);
  assert.equal(app.run("selectedLanes().length"), 2);
  assert.equal(app.node("#lane-bulk-toggle").dataset.mode, "clear");
  assert.equal(app.node("#lane-bulk-toggle").textContent, "Clear");
});

test("checked IDs survive status intersection, refresh, hash and closed-history override", () => {
  const app = ui();
  seed(app, [lane("alpha", [record({ text: "Alpha" })]), { ...lane("beta", [record({ text: "Beta" })]), status: "idle" },
    lane("archived", [record({ text: "Archive" })], true)]);
  app.run('hasLoadedLanes = true; selectedLaneIds = new Set(["alpha", "beta"]); allLanesSelected = true; renderLaneFilters();');
  app.node("#conversations-view").classList.add("active");
  app.node("#lane-status").dispatchEvent({ type: "change", target: { value: "idle" } });
  assert.equal(app.run("allLanesSelected"), true);
  assert.equal(app.node("#lane-bulk-toggle").dataset.mode, "clear");
  assert.match(app.node("#lane-filter-rows").innerHTML, /data-filter-lane="alpha" checked/);
  assert.equal(app.run("window.location.hash"), "#lanes");
  assert.equal(app.run('messagesForSelection().map(m => m.text).join("")'), "Beta");
  assert.deepEqual(JSON.parse(app.run('JSON.stringify(window.fmChatViewContext({branch:"uat",commit:"' + 'a'.repeat(40) + '"}))')).lanes.map(({ id }) => id), ["beta"]);
  app.run('selectedLaneIds.delete("beta"); allLanesSelected = false; renderLaneFilters(); renderFeed();');
  assert.match(app.node("#messages").innerHTML, /No checked fleets match this reported status/);
  assert.equal(app.run('laneSelection().routeId'), "alpha");
  app.run('renderLanes({source:"fixture",lanes,transcript:{sessions:[],warnings:[],note:"fixture"}})');
  assert.equal(app.run('selectedLaneIds.has("beta")'), false);
  assert.equal(app.run('laneStatusFilter'), "idle");
  app.run('navigateToLane("archived")');
  assert.equal(app.run('selectedLanes()[0].id'), "archived");
  app.run('feedLaneOverrideId = null; renderFeed()');
  assert.equal(app.run('selectedLanes().length'), 0);
});

test("lane filter disclosure closes with Escape and restores trigger focus", () => {
  const app = ui();
  app.node("#lane-filter-toggle").dispatchEvent({ type: "click" });
  assert.equal(app.node("#lane-filter-toggle").getAttribute("aria-expanded"), "true");
  assert.equal(app.node("#lane-options").hidden, false);
  app.run('document.dispatchEvent({ type: "keydown", key: "Escape" });');
  assert.equal(app.node("#lane-filter-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(app.node("#lane-options").hidden, true);
  app.node("#lane-filter-toggle").dispatchEvent({ type: "click" });
  app.node("#lane-filter-close").dispatchEvent({ type: "click" });
  assert.equal(app.node("#lane-filter-toggle").getAttribute("aria-expanded"), "false");
});

test("soloLane exclusively selects single lane and updates feed context", () => {
  const app = ui();
  seed(app, [
    lane("alpha", [record({ text: "Alpha message" })]),
    lane("beta", [record({ text: "Beta message" })]),
  ]);
  app.run("hasLoadedLanes = true; allLanesSelected = true; renderFeed();");
  assert.equal(app.run("allLanesSelected"), true);

  app.run('soloLane("beta");');
  assert.equal(app.run("allLanesSelected"), false);
  assert.equal(app.run("selectedLaneIds.size"), 1);
  assert.equal(app.run("selectedLaneIds.has('beta')"), true);
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('')"), "Beta message");
  assert.equal(app.node("#conversation-title").textContent, "beta");
  assert.equal(app.node("#context-eyebrow").textContent, "FLEET CONTEXT");
});

test("transcript diagnostics are demoted into header details popover", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // Verify transcript-details is inside conversation-head
  const headMatch = html.match(/<header class="conversation-head">([\s\S]*?)<\/header>/);
  assert.ok(headMatch, "conversation-head must exist");
  assert.match(headMatch[1], /id="transcript-details"/);
  assert.match(headMatch[1], /class="transcript-info-trigger"/);
  assert.match(headMatch[1], /class="transcript-coverage-popover"/);
  assert.match(headMatch[1], /id="transcript-summary"/);
  assert.match(headMatch[1], /id="transcript-note"/);
  assert.match(headMatch[1], /id="transcript-sources"/);

  // Verify details and note are no longer loose in main-stage above the controls
  const convHeadStart = html.indexOf('class="conversation-head"');
  const convHeadEnd = html.indexOf('</header>', convHeadStart) + 9;
  const controlsIdx = html.indexOf('class="transcript-controls"');
  const betweenHeadAndControls = html.slice(convHeadEnd, controlsIdx);
  assert.doesNotMatch(betweenHeadAndControls, /id="transcript-details"/);
  assert.doesNotMatch(betweenHeadAndControls, /id="transcript-note"/);
});

test("reading position is preserved during feed updates when scrolled up with jump-to-latest offered", () => {
  const app = ui();
  seed(app, [lane("alpha", [record({ text: "Message 1" }), record({ text: "Message 2" })])]);

  // Initial render scrolls to bottom
  app.run("renderFeed();");
  const messagesNode = app.node("#messages");
  const jumpBtn = app.node("#jump-to-latest");
  assert.equal(messagesNode.scrollTop, 100);
  assert.equal(jumpBtn.disabled, true);

  // User scrolls up (clientHeight=50, scrollHeight=200, scrollTop=20 -> distance = 200-20-50 = 130 >= 60)
  messagesNode.clientHeight = 50;
  messagesNode.scrollHeight = 200;
  messagesNode.scrollTop = 20;

  // Re-rendering feed (e.g. background refresh) preserves reading position and displays jump-to-latest button
  app.run("renderFeed();");
  assert.equal(messagesNode.scrollTop, 20);
  assert.equal(jumpBtn.disabled, false);

  // Clicking jump-to-latest scrolls to bottom and hides the button
  jumpBtn.dispatchEvent({ type: "click" });
  assert.equal(messagesNode.scrollTop, 200);
  assert.equal(jumpBtn.disabled, true);
});

test("search debounces input and highlights matches safely across markdown and raw text", async () => {
  const app = ui();
  seed(app, [
    lane("alpha", [
      record({ text: "Search for `[special-term]` with <script>alert(1)</script> and class code." }),
    ]),
  ]);
  app.run("renderFeed();");

  // Debouncing: typing in search does not update immediately until timeout
  const searchInput = app.node("#transcript-search");
  searchInput.dispatchEvent({ type: "input", target: { value: "special" } });
  assert.equal(app.run("transcriptQuery"), "special");

  // Wait for 250ms debounce
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.match(app.node("#messages").innerHTML, /<mark>special<\/mark>/);

  // Safe regex character highlighting (brackets, asterisks, etc.)
  app.run('transcriptQuery = "[special-term]"; renderFeed();');
  assert.match(app.node("#messages").innerHTML, /<mark>\[special-term\]<\/mark>/);

  // Safe HTML entity handling (<script> escaped and highlighted, not executed)
  app.run('transcriptQuery = "<script>"; renderFeed();');
  assert.match(app.node("#messages").innerHTML, /<mark>&lt;script&gt;<\/mark>alert/);

  // HTML tag and attribute preservation: searching for "code" or "class" marks text without breaking tags
  app.run('transcriptQuery = "code"; renderFeed();');
  const codeHtml = app.node("#messages").innerHTML;
  assert.match(codeHtml, /<code>/);
  assert.match(codeHtml, /<\/code>/);
  assert.match(codeHtml, /<mark>code<\/mark>/);

  // Clear search immediately resets query and clears mark tags
  const clearBtn = app.node("#transcript-search-clear");
  clearBtn.dispatchEvent({ type: "click" });
  assert.equal(app.run("transcriptQuery"), "");
  assert.doesNotMatch(app.node("#messages").innerHTML, /<mark>/);
});

test("screen reader live regions prevent flood and announce status concisely", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // Verify aria-live is removed from #messages
  assert.match(html, /<div id="messages" class="messages" aria-label="Conversation feed, oldest to newest" aria-busy="true">/);
  assert.doesNotMatch(html, /id="messages"[^>]*aria-live/);

  // Verify dedicated announcer exists
  assert.match(html, /<div id="sr-announcer" class="sr-only" aria-live="polite" aria-atomic="true"><\/div>/);

  // Verify app announces concise feed summary to #sr-announcer on render
  const app = ui();
  seed(app, [lane("alpha", [record({ text: "First record" })])]);
  app.run("renderFeed();");
  assert.match(app.node("#sr-announcer").textContent, /1–1 of 1 matching records/);
});

test("multi-lane filter selection is preserved across background and manual data refreshes", () => {
  const app = ui();
  const alpha = lane("alpha", [record({ text: "Alpha message" })]);
  const beta = lane("beta", [record({ text: "Beta message" })]);
  const gamma = lane("gamma", [record({ text: "Gamma message" })]);

  // Initial load
  app.run(`renderLanes(${JSON.stringify({ lanes: [alpha, beta, gamma] })});`);
  assert.equal(app.run("allLanesSelected"), true);
  assert.equal(app.run("selectedLaneIds.size"), 3);

  // User deselects gamma and alpha, keeping only beta
  app.run('allLanesSelected = false; selectedLaneIds = new Set(["beta"]); renderFeed();');
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('')"), "Beta message");

  // A background poll or manual refresh occurs (renderLanes called again with new lane data)
  app.run(`renderLanes(${JSON.stringify({ lanes: [alpha, beta, gamma] })});`);

  // Verify selection was NOT wiped back to All
  assert.equal(app.run("allLanesSelected"), false, "allLanesSelected should remain false");
  assert.equal(app.run("selectedLaneIds.has('beta')"), true, "beta should remain selected");
  assert.equal(app.run("selectedLaneIds.size"), 1, "only beta should be selected");
  assert.equal(app.run("messagesForSelection().map(m => m.text).join('')"), "Beta message");
});

test("task history deep links from All to its owning lane and restores breadcrumb and history on reload", () => {
  const app = ui();
  const alpha = lane("alpha", [record({ taskId: "alpha-task", text: "Alpha task" })]);
  const beta = lane("beta", [record({ taskId: "beta-task", text: "Beta task" })]);
  alpha.name = "Alpha Project";
  beta.name = "Beta Project";
  alpha.sessions = [{ id: "alpha-task", state: "working" }];
  beta.sessions = [{ id: "beta-task", state: "working" }];
  seed(app, [alpha, beta]);
  app.run("renderFeed()");
  assert.match(app.node("#session-history-list").innerHTML, /data-session-id="beta-task" data-lane-id="beta"/);
  assert.equal(app.node(".session-history").open, false);
  app.node("#session-history-list").dispatchEvent({ type: "click", target: {
    closest: (selector) => selector === "[data-session-id]" ? { dataset: { sessionId: "beta-task", laneId: "beta" } } : null,
  } });
  assert.equal(app.run("window.location.hash"), "#lanes/beta/session/beta-task");
  assert.equal(app.node("#conversation-title").textContent, "Beta Project");
  assert.equal(app.node("#task-filter-id").textContent, "beta-task");
  assert.equal(app.node("#conversation-status").textContent, "active");
  assert.equal(app.node(".session-history").open, true);
  app.run("selectedSessionId = null; allLanesSelected = true; applyRoute();");
  assert.equal(app.run("selectedSessionId"), "beta-task");
  assert.equal(app.run("selectedLanes()[0].id"), "beta");
  app.node(".session-history").open = false;
  app.run("renderFeed()");
  assert.equal(app.node(".session-history").open, false, "user collapse persists through rerenders");
  app.run('navigateToLane("alpha")');
  assert.equal(app.node(".session-history").open, true, "new lane opens its task history by default");
  app.run('navigateToLane("beta", "beta-task")');
  app.node("#transcript-session").dispatchEvent({ type: "change", target: { value: "disk.jsonl" } });
  assert.equal(app.run("window.location.hash"), "#lanes/beta", "clearing task via disk picker removes stale task hash");
});

test("task-session scope displays in-feed filter chip, can be dismissed, and resets on Fleet Chats tab click", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /id="task-filter-chip"/);
  assert.match(html, /id="task-filter-id"/);
  assert.match(html, /id="task-filter-clear"/);

  const app = ui();
  const alpha = lane("alpha", [
    record({ taskId: "worker-task-1", text: "Scoped worker turn" }),
    record({ text: "Unscoped turn" }),
  ]);
  alpha.sessions = [{ id: "worker-task-1", state: "working" }];
  seed(app, [alpha]);

  // When routed into a task session
  app.run('selectedSessionId = "worker-task-1"; renderFeed();');
  assert.equal(app.node("#task-filter-chip").hidden, false);
  assert.equal(app.node("#task-filter-id").textContent, "worker-task-1");
  assert.equal(app.run("messagesForSelection().length"), 1);
  assert.match(app.node("#messages").innerHTML, /Scoped worker turn/);
  assert.doesNotMatch(app.node("#messages").innerHTML, /Unscoped turn/);

  // Clicking #task-filter-clear clears the session scope
  app.node("#task-filter-clear").dispatchEvent({ type: "click" });
  assert.equal(app.run("selectedSessionId"), null);
  assert.equal(app.node("#task-filter-chip").hidden, true);
  assert.equal(app.run("messagesForSelection().length"), 2);
  assert.equal(app.run("window.location.hash"), "#lanes/alpha");

  // Task history uses the same clear action as the responsive chip.
  app.run('selectedSessionId = "worker-task-1"; renderFeed();');
  app.node("#session-history-list").dispatchEvent({ type: "click", target: {
    closest: (selector) => selector === ".session-clear" ? {} : null,
  } });
  assert.equal(app.run("selectedSessionId"), null);
  assert.equal(app.run("window.location.hash"), "#lanes/alpha");

  // Re-enter task session
  app.run('selectedSessionId = "worker-task-1"; renderFeed();');
  assert.equal(app.node("#task-filter-chip").hidden, false);

  // Clicking the primary Fleet Chats navigation tab also clears task session trap
  app.node(".primary-nav").dispatchEvent({
    type: "click",
    target: { closest: (selector) => selector === ".primary-tab" ? { dataset: { view: "conversations" } } : null },
  });
  assert.equal(app.run("selectedSessionId"), null);
  assert.equal(app.node("#task-filter-chip").hidden, true);
});

test("search zero-match renders actionable empty state with working clear button", () => {
  const app = ui();
  seed(app, [lane("alpha", [record({ text: "Known content in lane" })])]);
  app.run("renderFeed();");
  assert.match(app.node("#messages").innerHTML, /Known content in lane/);

  // Query with no matches
  app.run('transcriptQuery = "nonexistent-query"; renderFeed();');
  assert.equal(app.run("messagesForSelection().length"), 0);
  assert.match(app.node("#messages").innerHTML, /No records match [“"]nonexistent-query[”"]/);
  assert.match(app.node("#messages").innerHTML, /id="search-empty-clear"/);

  // Clicking #search-empty-clear resets query and restores matching records
  app.node("#messages").dispatchEvent({
    type: "click",
    target: { id: "search-empty-clear" },
  });
  assert.equal(app.run("transcriptQuery"), "");
  assert.equal(app.node("#transcript-search-clear").hidden, true);
  assert.match(app.node("#messages").innerHTML, /Known content in lane/);
});

test("open header details popovers dismiss on Escape and outside click", () => {
  const app = ui();
  const transcriptDetails = app.node("#transcript-details");
  const kindFilterMenu = app.node(".kind-filter-menu");

  // Simulate transcript-details opened
  transcriptDetails.setAttribute("open", "");
  assert.equal(transcriptDetails.getAttribute("open"), "");

  // Pressing Escape closes open popovers
  app.run('document.dispatchEvent({ type: "keydown", key: "Escape" });');
  assert.equal(transcriptDetails.getAttribute("open"), null);

  // Simulate kind-filter-menu opened
  kindFilterMenu.setAttribute("open", "");
  assert.equal(kindFilterMenu.getAttribute("open"), "");

  // Clicking outside details closes open popovers
  app.run('document.dispatchEvent({ type: "click", target: { closest: () => null } });');
  assert.equal(kindFilterMenu.getAttribute("open"), null);
});

test("Phase 2.5 responsive, typography, and accessibility polish constraints", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

  // Overview KPI summary does not have live-region attributes
  assert.doesNotMatch(html, /id="summary"[^>]*aria-live/);
  assert.doesNotMatch(html, /id="call-cards"[^>]*aria-live/);

  // Terminology disambiguation: transcript picker refers to disk transcript files, context rail refers to task history
  assert.match(html, /Disk transcript file/);
  assert.match(html, /Task history/);
  assert.doesNotMatch(html, /Session history/);

  // Search input suppresses native webkit cancel/decoration buttons
  assert.match(css, /::-webkit-search-cancel-button[\s\S]+-webkit-appearance: none/);

  // Jump to latest stays within the feed rather than overlapping mobile navigation.
  assert.match(css, /\.feed-jump-controls \{ flex: 0 0 auto; display: flex;/);
  assert.match(css, /\.jump-to-latest \{[^}]*min-height: 44px;/);

  // Laptop view avoids dual scrollbars by keeping body and workspace overflow hidden
  assert.match(css, /@media \(max-width: 1200px\)[\s\S]+body \{ overflow: hidden; \}/);
  assert.match(css, /@media \(max-width: 1200px\)[\s\S]+\.workspace \{ height: 100vh;[^}]+overflow: hidden; \}/);

  // Mobile pagination text unconstrained without 150px clamp
  assert.match(css, /@media \(max-width: 720px\)[\s\S]+\.feed-pagination span \{ max-width: none;/);
});


test("Preferences route renders escaped read-only records with honest date and reason labels", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /data-view="preferences"/);
  assert.match(html, /id="preferences-view"/);
  const app = ui();
  assert.equal(app.run('parseRoute("#preferences").view'), "preferences");
  app.run(`renderPreferences(${JSON.stringify({ source: "data/captain.md", withheld: 0, entries: [
    { title: "Keep <safe>", content: "First line.\n\nDo not cross boundary. <script>", date: "2026-09-23", dateBasis: "Dated section heading", rationale: "Because context matters", rationaleBasis: "Explicit wording in section", source: "data/captain.md:4-9" },
    { title: "Undated", content: "Another entry", date: null, dateBasis: null, rationale: null, rationaleBasis: null, source: "data/captain.md:10-12" },
  ] })})`);
  const cards = app.node("#preferences-list").innerHTML;
  assert.match(cards, /Keep &lt;safe&gt;/);
  assert.match(cards, /First line\.\n\nDo not cross boundary\. &lt;script&gt;/);
  assert.doesNotMatch(cards, /<script>/);
  assert.match(cards, /2026-09-23 · Dated section heading/);
  assert.match(cards, /Because context matters/);
  assert.match(cards, /Evidence: Unknown<br>Date added: Unknown/);
  assert.match(cards, /Not separately stated in this record/);
  assert.match(cards, /Source: data\/captain\.md:4-9/);
  assert.doesNotMatch(html, /id="(?:edit-preferences|save-preferences)"/);
});

test("Quota route renders known, partial and unknown without inventing zero or leaking raw fields", async () => {
  const app = ui();
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /data-view="quota"/);
  assert.match(html, /id="quota-state"[^>]+aria-live="polite"/);
  app.run('window.location.hash = "#quota"; applyRoute();');
  assert.equal(app.node(".workspace").dataset.view, "quota");
  app.run(`renderQuota(${JSON.stringify({ providers: [{ provider: "codex", status: "fresh", quotaStatus: "partial", stale: false, scopes: [{ scope: "all_models", status: "known", percentRemaining: 42, runway: { status: "unknown" } }, { scope: "model:sample", status: "unknown", percentRemaining: null, runway: null }], windows: [{ label: "session", kind: "session", percentRemaining: 42, resetsAt: "2030-01-01T00:00:00.000Z", pace: null }, { label: "week", kind: "weekly", percentRemaining: null, resetsAt: null, pace: null }] }], readAt: "2030-01-01T00:00:00.000Z", ageMs: 2000, stale: true, error: "Quota refresh unavailable" })})`);
  const cards = app.node("#quota-providers").innerHTML;
  assert.match(cards, /42% remaining/);
  assert.match(cards, /Remaining unknown/);
  assert.match(cards, /Reset unknown/);
  assert.match(cards, /Runway: Unknown/);
  assert.match(cards, /role="progressbar"/);
  assert.doesNotMatch(cards, /0% remaining/);
  assert.match(app.node("#quota-state").textContent, /Stale last successful reading.*Quota source last read.*Quota refresh unavailable/);
});

test("quota page summarizes source evidence, renders unsupported counts and suppresses stale winners", () => {
  const app = ui();
  const reading = { providers: [{ provider: "grok", status: "fresh", scopes: [{ scope: "all", percentRemaining: 12, runway: { status: "through_reset" } }], windows: [] }], unsupportedProviders: 2 };
  app.run(`renderQuota(${JSON.stringify(reading)})`);
  assert.equal(app.node("#quota-summary").querySelectorAll(".quota-summary-tile").length, 4);
  assert.match(app.node("#quota-summary").textContent, /12%/);
  assert.match(app.node("#quota-providers").textContent, /2 provider entries not shown because the format is unsupported/);
  const stateText = app.node("#quota-state").textContent;
  app.run(`renderQuota(${JSON.stringify(reading)})`);
  assert.equal(app.node("#quota-state").textContent, stateText, "countdown updates do not change the live region");
  app.run(`renderQuota(${JSON.stringify({ ...reading, stale: true })})`);
  const tightest = app.node("#quota-summary").querySelector('[data-quota-key="tightest"]');
  assert.match(tightest.textContent, /—.*unknown \(stale\)/);
  assert.doesNotMatch(tightest.textContent, /\d+%/);
  app.run('renderQuota({ providers: [], unsupportedProviders: 2 })');
  assert.match(app.node("#quota-providers").textContent, /No subscriptions reported.*2 provider entries not shown/);
});

test("page sort has one bidirectional key each and shares every stored mode with the sidebar", () => {
  const app = ui();
  const stored = () => app.run('sidebarQuotaSort');
  const click = key => app.node("#quota-sort-" + key).dispatchEvent({ type: "click" });
  assert.equal(stored(), "highest");
  click("left"); assert.equal(stored(), "lowest");
  click("left"); assert.equal(stored(), "highest");
  click("runway"); assert.equal(stored(), "runway");
  click("runway"); assert.equal(stored(), "runway-lowest");
  click("az"); assert.equal(stored(), "az");
  click("az"); assert.equal(stored(), "za");
  click("runway"); assert.equal(stored(), "runway-lowest", "returning to a key keeps its direction");
  click("left"); assert.equal(stored(), "highest");
  assert.equal(app.node("#quota-sort-left").getAttribute("aria-pressed"), "true");
  assert.equal(app.node("#quota-sort-runway").getAttribute("aria-pressed"), "false");
});

test("compact quota family output is byte-identical to the sidebar batch baseline", () => {
  const app = ui();
  const family = { provider: "grok", name: "grok", scope: null, status: "fresh", windows: [{ id: "credits", label: "week", percentRemaining: 12, isLimiting: true }, { id: "chat", label: "Chat", percentRemaining: null }] };
  const output = app.run(`quotaFamilyBox(${JSON.stringify(family)}, null, { compact: true })`);
  // SHA-256 snapshot of the exact 3bb5fbf renderer for this synthetic fixture.
  assert.equal(createHash("sha256").update(output).digest("hex"), "8fee7376db5b0037eb3e9314dc10195bdf819fee171ab2aeef8117f16b5f69c3");
  assert.doesNotMatch(output, /quota-family-band|quota-family-meta|LIMIT/);
});

test("quota window annotations are shown for every subscription, including unknown text", () => {
  const app = ui();
  app.run(`renderQuota(${JSON.stringify({ providers: ["codex", "agy"].map((provider) => ({ provider, status: "fresh", quotaStatus: "known", stale: false, scopes: [], windows: [
    { id: "weekly", label: "week", kind: "weekly", annotation: { category: "Partial usage", meaning: "Some of the weekly limit has been used. Full refresh in 5 days." } },
    { id: "other", label: "other", kind: "weekly", annotation: { category: "Unknown", meaning: "Subscription note could not be interpreted." } },
  ] })) })})`);
  const html = app.node("#quota-providers").innerHTML;
  assert.equal((html.match(/Note: Partial Usage/g) || []).length, 2);
  assert.equal((html.match(/Note: Unknown/g) || []).length, 2);
  assert.doesNotMatch(html, /undefined|resetText/);
});

test("tiny quota strip reuses page reading and retains source pace/runway in accessible details", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /<section id="sidebar-quota" class="sidebar-quota" aria-label="Subscription quota snapshot">/);
  assert.match(css, /\.sidebar-quota \{[^}]+border-top: 1px solid var\(--line\);/);
  assert.match(html, /id="quota-resize" class="panel-divider quota-divider" role="separator" tabindex="0" aria-orientation="horizontal" aria-controls="sidebar-quota" aria-label="Resize quota limits/);
  assert.match(html, /id="review-resize" class="panel-divider review-divider" role="separator" tabindex="0" aria-orientation="vertical" aria-controls="review-panel" aria-label="Resize review conversation/);
  assert.doesNotMatch(html, /id="(?:quota|review)-reset"|class="panel-resize-handle"/);
  assert.match(css, /\.quota-divider \{[^}]+width: 100%; height: 16px; cursor: ns-resize;/);
  assert.match(css, /\.review-divider \{[^}]+width: 16px; cursor: ew-resize;/);
  assert.match(css, /@media \(max-width: 720\.01px\) \{ \.panel-divider \{ display: none; \} \}/);
  assert.match(css, /\.sidebar-quota \{[^}]+flex: 0 1 auto; height: var\(--quota-height, auto\)/);
  assert.doesNotMatch(css, /\.quota-strip \{[^}]+resize: vertical;/);
  assert.ok(html.indexOf('<section id="sidebar-quota"') < html.indexOf('<footer class="source-status"'));
  assert.match(css, /\.sidebar-quota \{ display: none; \}/);
  assert.match(css, /\.primary-nav \{[^}]+grid-template-rows: 48px 48px/);
  // Native header button covers non-control space; narrow panes hide the reading time.
  assert.match(css, /\.sidebar-quota-head \{ position: relative; display: flex;/);
  assert.match(css, /@container sidebar-quota \(max-width: 219\.98px\) \{ \.sidebar-quota-freshness \{ display: none; \} \}/);
  assert.match(html, /id="sidebar-quota-toggle"[^>]+aria-expanded="true"[^>]+><span>Quota<\/span>/);
  assert.doesNotMatch(html, /class="sidebar-quota-link"/);
  assert.match(html, /<div id="sidebar-quota-sort" class="sidebar-quota-sort" role="group" aria-label="Sort quota limits">/);
  assert.match(html, /data-sort="left" aria-pressed="true"[^>]*>Left<span class="sidebar-quota-sort-direction" aria-hidden="true">↓<\/span><\/button><button type="button" class="sidebar-quota-sort-option" data-sort="runway" aria-pressed="false" aria-label="Runway"[^>]*>Run<span class="sidebar-quota-sort-long">way<\/span>/);

  const app = ui();
  const statuses = ["ahead", "on_pace", "behind", "mixed", "through_reset", "projected_exhaustion", "exhausted_now", "unknown"];
  const data = { providers: statuses.map((status, i) => ({ provider: `p${i}`, status: "fresh", quotaStatus: "known", stale: false,
    scopes: [{ scope: "all", status: "known", percentRemaining: 12, pace: { status }, runway: { status } }], windows: [] })), readAt: null, stale: false, error: null };
  app.run(`renderQuota(${JSON.stringify(data)})`);
  const strip = app.node("#quota-strip").innerHTML;
  for (const status of statuses) {
    assert.match(strip, new RegExp(`Pace: ${status}`));
    assert.match(strip, new RegExp(`Runway: ${status}`));
  }
  assert.equal((strip.match(/href="#quota"/g) || []).length, statuses.length);
  assert.match(strip, /12% remaining/);
  assert.match(strip, /class="quota-badge"/);
  assert.match(strip, /class="quota-family-track"/);
  assert.match(strip, /role="progressbar"/);
  assert.doesNotMatch(strip, /aria-valuenow="0"/);
});

test("all providers use neutral escaped text monograms, not artwork or brand-color masks", () => {
  const app = ui();
  for (const label of ["Grok", "OpenAI", "Gemini", "Anthropic", "codex", "agy", "Unknown", "<script>"]) {
    const mark = app.run(`providerLogoHtml(${JSON.stringify(label)})`);
    assert.match(mark, /class="provider-monogram"/);
    assert.match(mark, /aria-hidden="true"/);
    assert.doesNotMatch(mark, /<img|<svg|data-provider=|provider-logo--color|<script>/);
  }
  assert.doesNotMatch(css, /assets\/providers\/.*\.svg|--provider-mask|provider-logo--color/);
});

test("grouped quota cards keep two compact rows, truthful remaining and timing unknown without inventing logos", () => {
  const app = ui();
  const data = { readAt: "2030-01-01T02:30:00Z", stale: false, providers: [{ provider: "agy", status: "fresh", quotaStatus: "known", windows: [
    { id: "a", label: "Gemini 5-hour", percentRemaining: 0, startsAt: "2030-01-01T00:00:00Z", durationSeconds: 18000, resetsAt: "2030-01-01T05:00:00Z" },
    { id: "b", label: "Gemini weekly", percentRemaining: 69, resetsAt: "2030-01-08T00:00:00Z" },
    { id: "c", label: "Other", percentRemaining: null }
  ], scopes: [{ scope: "gemini", boundedBy: ["a", "b"] }] }] };
  app.run(`renderQuota(${JSON.stringify(data)})`);
  const strip = app.node("#quota-strip").innerHTML;
  const page = app.node("#quota-providers").innerHTML;
  for (const html of [strip, page]) {
    assert.match(html, /Gemini 5-hour/);
    assert.match(html, /class="quota-family-label"[^>]*>5h/);
    assert.match(html, /aria-valuenow="0"/);
    assert.match(html, /width:0%/);
    assert.match(html, /--remaining:50%/);
    assert.match(html, /50\.0% of reset window remaining at source capture/);
    assert.match(html, /Reset-window position unknown/);
    assert.doesNotMatch(html, /time \?/);
    assert.match(html, /provider-monogram/);
    assert.match(html, html === strip ? /<b class="provider-name">AGY/ : /<h2[^>]*>AGY<\/h2>/);
    assert.doesNotMatch(html, /<span class="provider-name">/);
    assert.equal((html.match(/class="quota-family-notch"/g) || []).length, 1);
    assert.ok(html.includes("2030-01-08"));
  }
  assert.equal((strip.match(/class="quota-family-row/g) || []).length, 3, "extra unknown window remains in its own unproven group");
  assert.equal((page.split("</summary>")[0].match(/class="quota-family-row/g) || []).length, 3);
});

test("quota freshness stays accessible with compact single-line text", () => {
  const app = ui();
  app.run(`renderQuota(${JSON.stringify({ providers: [{ provider: "agy", stale: true, status: "stale", refreshedAt: "2030-01-01T00:00:00Z", windows: [{ id: "w", label: "week", kind: "weekly", percentRemaining: 50 }], scopes: [] }] })})`);
  for (const html of [app.node("#quota-strip").innerHTML, app.node("#quota-providers").innerHTML]) {
    assert.match(html, /class="quota-staleness" title="stale · 0s" aria-label="stale · 0s"/);
    assert.match(html, /class="quota-age">stale 0s/);
    assert.match(html, /AGY/);
  }
});

test("compact desktop and phone quota previews keep both horizons, reset ticker, and honest marker", () => {
  const app = ui();
  const data = { readAt: "2030-01-01T02:30:00Z", capturedAt: "2030-01-01T02:30:00Z", providers: [{ provider: "agy", status: "fresh", quotaStatus: "known", scopes: [{ scope: "gemini", boundedBy: ["five", "week"] }], windows: [
    { id: "five", label: "Gemini 5-hour", percentRemaining: 24, startsAt: "2030-01-01T00:00:00Z", durationSeconds: 18000, resetsAt: "2030-01-01T05:00:00Z" },
    { id: "week", label: "Gemini weekly", percentRemaining: 70, resetsAt: "2030-01-08T02:30:00Z" }
  ] }] };
  app.run(`renderQuota(${JSON.stringify(data)})`);
  for (const id of ["#quota-strip", "#mobile-quota-sheet-content"]) {
    const preview = app.node(id).innerHTML;
    assert.match(preview, />5h/);
    assert.match(preview, />7d/);
    assert.match(preview, /title="Gemini weekly"/);
    assert.match(preview, /24%/);
    assert.match(preview, /70%/);
    assert.match(preview, / · <span class="quota-reset-full">[0-9]+[dhm]/);
    assert.match(preview, /class="quota-reset-short"/);
    assert.doesNotMatch(preview, /tick marks time left|time left at source read|quota-family-reset/);
    assert.match(preview, /--remaining:50%/);
    assert.equal((preview.match(/class="quota-family-notch"/g) || []).length, 1, "no invented weekly position");
    assert.match(preview, /Reset-window position unknown/);
  }
  const page = app.node("#quota-providers").innerHTML;
  assert.doesNotMatch(page, /class="quota-family-reset"/, "full page layout unchanged");
  data.providers[0].windows[0].resetsAt = "2020-12-31T00:00:00Z";
  data.providers[0].windows[1].resetsAt = null;
  app.run(`renderQuota(${JSON.stringify(data)})`);
  for (const id of ["#quota-strip", "#mobile-quota-sheet-content"]) {
    const preview = app.node(id).innerHTML;
    assert.match(preview, /reset passed/);
    assert.match(preview, /reset unknown/);
    assert.doesNotMatch(preview, /class="quota-family-notch"/);
  }
});

test("snapshot groups window bars by subscription and hides unlinked sources", () => {
  const app = ui();
  app.run(`renderQuotaStrip(${JSON.stringify({ providers: [
    { provider: "codex", status: "fresh", authStatus: "usable", windows: [{ label: "5h", percentRemaining: 35 }, { label: "7d", percentRemaining: 70 }], scopes: [] },
    { provider: "agy", status: "fresh", authStatus: "usable", windows: [{ label: "Claude/GPT 5h", percentRemaining: 40 }, { label: "Claude/GPT 7d", percentRemaining: 60 }, { label: "Other models 5h", percentRemaining: 10 }, { label: "Other models 7d", percentRemaining: 20 }], scopes: [] },
    { provider: "unlinked", status: "auth_required", windows: [{ label: "5h", percentRemaining: 99 }] },
    { provider: "unknown-auth", status: "fresh", authStatus: "unknown", windows: [{ label: "5h", percentRemaining: 99 }] },
    { provider: "no-reading", status: "fresh", windows: [{ label: "5h", percentRemaining: null }] }
  ] })})`);
  const strip = app.node("#quota-strip").innerHTML;
  assert.equal((strip.match(/class="quota-badge"/g) || []).length, 2, "unscoped AGY windows remain one provider box");
  assert.equal((strip.match(/role="progressbar"/g) || []).length, 6);
  assert.match(strip, /codex[\s\S]*5h[\s\S]*7d/);
  assert.match(strip, /agy[\s\S]*Other models 5h/);
  assert.doesNotMatch(strip, /unlinked|unknown-auth|no-reading/);
});

test("Quota controls sort known effective remaining, keep unknown last, and hide only inactive", () => {
  const app = ui();
  const providers = [
    { provider: "unknown", status: "partial", quotaStatus: "unknown", scopes: [{ scope: "all", status: "unknown", percentRemaining: null }], windows: [] },
    { provider: "low", status: "fresh", quotaStatus: "known", scopes: [{ scope: "all", status: "known", percentRemaining: 12 }], windows: [] },
    { provider: "inactive", status: "unavailable", quotaStatus: "unknown", scopes: [], windows: [] },
    { provider: "high", status: "fresh", quotaStatus: "known", scopes: [{ scope: "all", status: "known", percentRemaining: 82 }], windows: [] },
  ];
  app.run(`renderQuota(${JSON.stringify({ providers, readAt: null, stale: false, error: null })})`);
  let cards = app.node("#quota-providers").innerHTML;
  assert.ok(cards.indexOf("High</h2>") < cards.indexOf("Low</h2>"));
  assert.ok(cards.indexOf("Low</h2>") < cards.indexOf("Unknown</h2>"));
  assert.match(cards, /inactive/);
  app.node("#quota-sort-left").dispatchEvent({ type: "click" });
  cards = app.node("#quota-providers").innerHTML;
  assert.ok(cards.indexOf("Low</h2>") < cards.indexOf("High</h2>"));
  assert.ok(cards.indexOf("High</h2>") < cards.indexOf("Unknown</h2>"));
  app.node("#quota-hide-inactive").dispatchEvent({ type: "change", target: { checked: true } });
  cards = app.node("#quota-providers").innerHTML;
  assert.doesNotMatch(cards, /inactive/);
  assert.match(cards, /Remaining unknown/);
  assert.doesNotMatch(app.node("#quota-strip").innerHTML, /inactive/);
});

test("Fleet Chats ergonomics: compact 48px header, single-line pagination, compact popover, and tab-first row", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const rowHtml = html.slice(html.indexOf('<div class="lane-chats-row">'), html.indexOf('<section id="lane-options"'));
  // Fleet Chats tab must come before toggle button; parallel sidebar All checkbox retired
  assert.ok(rowHtml.indexOf('class="primary-tab lane-chats-tab"') < rowHtml.indexOf('id="lane-filter-toggle"'));
  assert.doesNotMatch(rowHtml, /id="lane-select-all"/);

  // CSS constraints
  assert.match(css, /\.conversation-head \{[^}]+min-height: 48px/);
  assert.match(css, /\.conversation-head-identity \{[^}]+display: flex; align-items: center;/);
  assert.match(css, /\.conversation-head-identity \{[^}]+flex-wrap: nowrap/);
  assert.match(css, /conversation-subtext/);
  assert.doesNotMatch(css, /@container lane-chat \(max-width: 1100px\)/);
  assert.match(css, /\.lane-chats-row \{ grid-column: 1 \/ -1; grid-row: 1;/);
  assert.match(css, /\.feed-pagination span \{[^}]+white-space: nowrap/);
  assert.match(css, /\.kind-filter-popover \{[^}]+width: min\(320px/);

  // Pagination text summary format
  const app = ui();
  seed(app, [lane("alpha", [record({ text: "Turn 1" }), record({ text: "Turn 2" })])]);
  app.run("renderFeed();");
  assert.match(app.node("#transcript-page").textContent, /1–2 of 2 matching records/);
  assert.doesNotMatch(app.node("#transcript-page").textContent, /full history loaded/);
});

test("Quota density: unconfigured providers are grouped in compact tray, and refresh avoids DOM clobbering", () => {
  const app = ui();
  const sampleData = {
    providers: [
      { provider: "active-provider", status: "fresh", quotaStatus: "known", stale: false, scopes: [{ scope: "all", status: "known", percentRemaining: 80, runway: null }], windows: [{ label: "day", kind: "daily", percentRemaining: 80, resetsAt: "2030-01-01T00:00:00.000Z", pace: null }] },
      { provider: "empty-provider-1", status: "unavailable", quotaStatus: "unavailable", stale: false, scopes: [], windows: [] },
      { provider: "empty-provider-2", status: "error", quotaStatus: "unknown", stale: false, scopes: [], windows: [] },
    ],
    readAt: "2030-01-01T00:00:00.000Z",
    stale: false,
    error: null,
  };

  app.run(`renderQuota(${JSON.stringify(sampleData)})`);
  const initialHtml = app.node("#quota-providers").innerHTML;

  // Active provider rendered with full scope/window
  assert.match(initialHtml, /active-provider/);
  assert.match(initialHtml, /80% remaining/);

  // Empty providers grouped into compact unconfigured tray
  assert.match(initialHtml, /quota-unconfigured-tray/);
  assert.match(initialHtml, /quota-unconfigured-chip/);
  assert.match(initialHtml, /empty-provider-1/);
  assert.match(initialHtml, /empty-provider-2/);

  // Focus and selection safe: re-render with identical data preserves existing DOM without rewriting
  app.run(`renderQuota(${JSON.stringify(sampleData)})`);
  assert.equal(app.node("#quota-providers").innerHTML, initialHtml);
});

test("Preferences alignment, quiet count, and truthful source links", () => {
  // Control and status line alignment in CSS
  assert.match(css, /#preferences-view > \* \{[^}]+max-width: 1000px; margin-left: auto; margin-right: auto;/);
  assert.match(css, /\.scan-controls select \{[^}]+min-height: 36px; height: 36px/);
  assert.match(css, /\.scan-controls button \{[^}]+min-height: 36px; height: 36px/);
  assert.match(css, /#preferences-state\.notice \{[^}]+margin: var\(--space-2\) auto var\(--space-3\); max-width: 1000px;[^}]+border: 1px solid var\(--line\);[^}]+color: var\(--muted\)/);
  assert.match(css, /#preferences-view \.scan-controls \{ margin: var\(--space-3\) auto var\(--space-4\); max-width: 1000px; \}/);
  assert.match(css, /\.preference-source-link \{[^}]+border-bottom: 1px dotted/);

  // Truthful source link rendered in HTML
  const app = ui();
  app.run(`renderPreferences(${JSON.stringify({
    source: "data/captain.md",
    withheld: 0,
    entries: [
      { title: "Safe behavior", content: "Details here", date: "2026-09-23", dateBasis: "Dated heading", rationale: "Because safety", rationaleBasis: "Explicit wording", source: "data/captain.md:12-25" },
    ],
  })})`);
  const listHtml = app.node("#preferences-list").innerHTML;
  assert.match(listHtml, /class="preference-source-link"/);
  assert.match(listHtml, /Source: data\/captain\.md:12-25/);
});

test("sidebar quota strip displays all active subscriptions including Grok, Codex, and AGY without masking", () => {
  const app = ui();
  const data = {
    readAt: "2026-09-25T04:50:00.000Z",
    stale: false,
    error: null,
    providers: [
      {
        provider: "codex",
        status: "fresh",
        authStatus: null,
        stale: false,
        quotaStatus: "known",
        scopes: [{ scope: "all_models", status: "known", percentRemaining: 19, limitingWindowIds: ["weekly"], boundedBy: ["weekly"], pace: { status: "ahead", reservePercentPoints: -6.45 } }],
        windows: [{ id: "weekly", label: "weekly", kind: "weekly", percentRemaining: 19, resetsAt: "2026-09-26T23:37:29.000Z", pace: { status: "ahead", reservePercentPoints: -6.45 } }]
      },
      {
        provider: "grok",
        status: "fresh",
        authStatus: "usable",
        stale: false,
        quotaStatus: "known",
        scopes: [{ scope: "all_products", status: "known", percentRemaining: 12, limitingWindowIds: ["credits"], boundedBy: ["credits", "build"], pace: { status: "ahead", reservePercentPoints: -70.15 } }],
        windows: [
          { id: "credits", label: "Credits", kind: "weekly", percentRemaining: 12, resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "ahead", reservePercentPoints: -70.15 } },
          { id: "build", label: "Grok Build", kind: "weekly", percentRemaining: 12, resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "ahead", reservePercentPoints: -70.15 } }
        ]
      },
      {
        provider: "agy",
        status: "fresh",
        authStatus: null,
        stale: false,
        quotaStatus: "known",
        scopes: [
          { scope: "gemini", status: "known", percentRemaining: 68, limitingWindowIds: ["gemini_5h"], boundedBy: ["gemini_5h", "gemini_weekly"], pace: { status: "unknown" } },
          { scope: "claude_gpt", status: "known", percentRemaining: 100, limitingWindowIds: ["claude_gpt_5h"], boundedBy: ["claude_gpt_5h", "claude_gpt_weekly"], pace: { status: "unknown" } }
        ],
        windows: [
          { id: "gemini_5h", label: "Gemini 5-hour", kind: "session", percentRemaining: 68, resetsAt: "2026-09-25T05:56:31.000Z", pace: { status: "unknown" } },
          { id: "gemini_weekly", label: "Gemini weekly", kind: "weekly", percentRemaining: 78, resetsAt: "2026-09-30T03:37:19.000Z", pace: { status: "unknown" } },
          { id: "claude_gpt_5h", label: "Claude/GPT 5-hour", kind: "session", percentRemaining: 100, resetsAt: "2026-09-25T09:51:35.000Z", pace: { status: "unknown" } },
          { id: "claude_gpt_weekly", label: "Claude/GPT weekly", kind: "weekly", percentRemaining: 100, resetsAt: "2026-10-02T04:51:35.000Z", pace: { status: "unknown" } }
        ]
      },
      { provider: "claude", status: "auth_required", authStatus: null, scopes: [], windows: [] },
      { provider: "commandcode", status: "auth_required", authStatus: "unusable", scopes: [], windows: [] },
      { provider: "cursor", status: "error", authStatus: null, scopes: [], windows: [] },
    ]
  };

  app.run(`renderQuota(${JSON.stringify(data)})`);
  const strip = app.node("#quota-strip").innerHTML;

  // Grok-only bug regression: Grok, Codex, and AGY must all be present in the sidebar strip
  assert.match(strip, /codex/);
  assert.match(strip, /grok/);
  assert.match(strip, /agy/);
  assert.doesNotMatch(strip, /commandcode|cursor|aria-label="claude subscription/);

  // Multiple windows for a provider are shown, none dropped
  assert.match(strip, /Gemini 5-hour/);
  assert.match(strip, /Gemini weekly/);
  assert.match(strip, /Claude\/GPT 5-hour/);
  assert.match(strip, /Claude\/GPT weekly/);
  assert.match(strip, /Grok Build/);

  // Meter bars present for each window
  const meterCount = (strip.match(/role="progressbar"/g) || []).length;
  assert.equal(meterCount, 7); // 1 codex + 2 grok + 4 agy

  // Truthful direction: 19% remaining has width 19%
  assert.match(strip, /width:19%/);
  assert.match(strip, /aria-valuenow="19"/);

  // Limiting indicators in strip
  assert.match(strip, /quota-summary-window-limiting/);

  // Freshness timestamp updated
  const freshness = app.node("#sidebar-quota-freshness").textContent;
  assert.ok(freshness.length > 0);
});

test("Quota summary retains every reported window and only source-named binding limits", () => {
  const app = ui();
  app.run(`renderQuota(${JSON.stringify({ readAt: "2030-01-01T00:00:00Z", providers: [
    { provider: "sample", status: "fresh", quotaStatus: "known", scopes: [{ scope: "all", status: "known", percentRemaining: 12, limitingWindowIds: ["week"], boundedBy: ["day", "week"] }], windows: [
      { id: "day", label: "Day", kind: "daily", percentRemaining: 12, resetsAt: "2030-01-02T00:00:00Z", pace: { status: "ahead", reservePercentPoints: 12.3456789 } },
      { id: "week", label: "Week", kind: "weekly", percentRemaining: 12, resetsAt: "2030-01-08T00:00:00Z", pace: { status: "ahead", reservePercentPoints: -5 } }
    ] }
  ] })})`);
  const html = app.node("#quota-providers").innerHTML;
  const summary = html.split("</summary>")[0];
  assert.match(summary, /limit 7d/);
  assert.match(summary, /Day/);
  assert.equal((summary.match(/quota-summary-window-limiting/g) || []).length, 1);
  assert.doesNotMatch(summary, /reported windows|elapsed-time marker unavailable|Limiting constraint/);
  assert.match(summary, /aria-label="Week: 12% remaining[^>]+aria-valuenow="12"/);
  assert.match(html, /2030-01-08/);
  assert.match(html, /-5\.00% reserve/);
  assert.match(html, /\+12\.35% reserve/);
  assert.doesNotMatch(html, /percentage points reserve|12\.3456789/);
});

test("Quota with incomplete relationships or values never invents binding, elapsed time, scope or forecast", () => {
  const app = ui();
  app.run(`renderQuota(${JSON.stringify({ providers: [
    { provider: "sample", status: "partial", quotaStatus: "unknown", scopes: [], windows: [
      { id: "a", label: "Only reported", kind: "session", percentRemaining: 3, resetsAt: null, pace: null },
      { id: "b", label: "Unmeasured", kind: "weekly", percentRemaining: null, resetsAt: null, pace: { status: "unknown" } }
    ] }
  ] })})`);
  const html = app.node("#quota-providers").innerHTML;
  assert.match(html, /Binding limit unknown/);
  assert.match(html, /no effective scope reported/);
  assert.doesNotMatch(html, /quota-summary-window-limiting/);
  assert.match(html, /Remaining unknown/);
  assert.match(html, /Reset unknown/);
  assert.match(html, /Pace unknown/);
  assert.doesNotMatch(html, /Projected exhaustion:|aria-valuenow="0"|model:|all_models|elapsed-time marker"/);
  assert.equal((html.split("</summary>")[0].match(/class="quota-family-row/g) || []).length, 2);
});

test("Quota Expand all updates native disclosures even before a tapped toggle event synchronizes the cache", () => {
  const app = ui();
  app.run(`renderQuota(${JSON.stringify({ providers: [{ provider: "codex", status: "fresh", scopes: [], windows: [{ id: "w", label: "week", kind: "weekly", percentRemaining: 8 }] }] })})`);
  // Simulate the live DOM immediately after a tap closes a details element:
  // native open changed, but the asynchronous toggle listener has not run.
  const disclosure = { dataset: { provider: "codex" }, open: false };
  const list = app.node("#quota-providers");
  list.querySelectorAll = () => [disclosure];
  app.node("#quota-details-toggle").dispatchEvent({ type: "click" });
  assert.equal(disclosure.open, true);
  disclosure.open = false; // User closes it before the native toggle event.
  app.node("#quota-details-toggle").dispatchEvent({ type: "click" });
  assert.equal(disclosure.open, true, "reads live native state rather than a stale all-open label");
  app.node("#quota-details-toggle").dispatchEvent({ type: "click" });
  assert.equal(disclosure.open, false);
});

test("Quota detailed view adapts provider accordion, critical constraint, pacing bars, reset times, and truthful used/remaining direction", () => {
  const app = ui();
  const data = {
    readAt: "2026-09-25T04:50:00.000Z",
    stale: false,
    error: null,
    providers: [
      {
        provider: "codex",
        status: "fresh",
        authStatus: null,
        stale: false,
        quotaStatus: "known",
        scopes: [{ scope: "all_models", status: "known", percentRemaining: 19, limitingWindowIds: ["weekly"], boundedBy: ["weekly"], pace: { status: "ahead", reservePercentPoints: -6.45 } }],
        windows: [{ id: "weekly", label: "weekly", kind: "weekly", percentRemaining: 19, resetsAt: "2026-09-26T23:37:29.000Z", pace: { status: "ahead", reservePercentPoints: -6.45 } }]
      },
      {
        provider: "grok",
        status: "fresh",
        authStatus: "usable",
        stale: true,
        quotaStatus: "known",
        scopes: [{ scope: "all_products", status: "known", percentRemaining: 12, limitingWindowIds: ["credits"], boundedBy: ["credits", "build"], pace: { status: "ahead", reservePercentPoints: -70.15 } }],
        windows: [
          { id: "credits", label: "Credits", kind: "weekly", percentRemaining: 12, resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "ahead", reservePercentPoints: -70.15 } },
          { id: "build", label: "Grok Build", kind: "weekly", percentRemaining: 12, resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: "ahead", reservePercentPoints: -70.15 } }
        ]
      },
      {
        provider: "agy",
        status: "fresh",
        authStatus: null,
        stale: false,
        quotaStatus: "known",
        scopes: [
          { scope: "gemini", status: "known", percentRemaining: 68, limitingWindowIds: ["gemini_5h"], boundedBy: ["gemini_5h", "gemini_weekly"], pace: { status: "unknown" } },
          { scope: "claude_gpt", status: "known", percentRemaining: 100, limitingWindowIds: ["claude_gpt_5h"], boundedBy: ["claude_gpt_5h", "claude_gpt_weekly"], pace: { status: "unknown" } }
        ],
        windows: [
          { id: "gemini_5h", label: "Gemini 5-hour", kind: "session", percentRemaining: 68, resetsAt: "2026-09-25T05:56:31.000Z", pace: { status: "unknown" } },
          { id: "gemini_weekly", label: "Gemini weekly", kind: "weekly", percentRemaining: 78, resetsAt: "2026-09-30T03:37:19.000Z", pace: { status: "unknown" } },
          { id: "claude_gpt_5h", label: "Claude/GPT 5-hour", kind: "session", percentRemaining: 100, resetsAt: "2026-09-25T09:51:35.000Z", pace: { status: "unknown" } },
          { id: "claude_gpt_weekly", label: "Claude/GPT weekly", kind: "weekly", percentRemaining: 100, resetsAt: "2026-10-02T04:51:35.000Z", pace: { status: "unknown" } }
        ]
      },
      { provider: "claude", status: "auth_required", authStatus: null, scopes: [], windows: [] },
      { provider: "commandcode", status: "auth_required", authStatus: "unusable", scopes: [], windows: [] },
    ]
  };

  app.run(`renderQuota(${JSON.stringify(data)})`);
  const cards = app.node("#quota-providers").innerHTML;

  // Accordion details and summary markup
  const accordions = app.node("#quota-providers").querySelectorAll("details.quota-more");
  assert.equal(accordions.length, 3);
  assert.ok(accordions.every(details => !details.open));
  assert.equal(app.node("#quota-providers").querySelectorAll("article.quota-card").length, 3);

  // Source-named limiting windows remain visible on the meter rows.
  assert.match(cards, /Source-reported limiting window/);
  assert.match(cards, /Gemini 5-hour/);

  // Truthful pacing comparisons
  assert.match(cards, /Consuming faster than elapsed-time pacing/);
  assert.match(cards, /Pace unknown: cycle or elapsed baseline unmeasured/);

  // Truthful remaining bar direction (width 19% for 19% remaining)
  assert.match(cards, /aria-valuenow="19"/);
  assert.match(cards, /style="width:19%"/);

  // Stale provider indicator preserved
  assert.match(cards, /stale · age unknown/);

  // Inactive providers kept separated in compact unconfigured tray
  assert.match(cards, /quota-unconfigured-tray/);
  assert.match(cards, /claude/);
  assert.match(cards, /commandcode/);

  // Expand all and collapse all controls toggle state
  app.node("#quota-details-toggle").dispatchEvent({ type: "click" });
  assert.ok(accordions.every((details) => details.open));
  app.node("#quota-details-toggle").dispatchEvent({ type: "click" });
  assert.ok(accordions.every((details) => !details.open));
});

test("compact reset labels use only days/hours/minutes with deterministic short fallbacks", () => {
  const app = ui(); const now = Date.parse("2030-01-01T00:00:00Z");
  const format = (minutes, short = false) => app.run(`compactQuotaReset(${JSON.stringify(new Date(now + minutes * 60000).toISOString())}, ${now}, ${short})`);
  assert.equal(format(500), "8h 20m"); assert.equal(format(500, true), "8.3h");
  assert.equal(format(35), "35m"); assert.equal(format(0.1), "1m");
  assert.equal(format(3 * 1440 + 240), "3d 4h"); assert.equal(format(3 * 1440 + 240, true), "3.2d");
  assert.equal(format(-1), "reset passed"); assert.equal(app.run(`compactQuotaReset(null, ${now})`), "reset unknown");
});

test("emitted taxonomy task links select the exact task through the canonical router on desktop and phone, including reload and closed lanes", () => {
  for (const compact of [false, true]) for (const closed of [false, true]) {
    const app = ui({ compact });
    const laneId = "fixture lane";
    const taskId = "ready-task-with-a-long-outcome-name";
    const fixtureLane = lane(laneId, [record({ taskId, text: "Exact ready task" }), record({ taskId: "other", text: "Other task" })], closed);
    fixtureLane.sessions = [{ id: taskId, state: "done", loaded: true }, { id: "other", state: "done", loaded: true }];
    seed(app, [fixtureLane]);
    const item = { id: taskId, name: "Ready for review", taskFingerprint: "a".repeat(64), repositoryId: "repo", repository: "Fixture repository",
      lane: { id: "ui", name: "UI workstream" }, theme: { id: "review", name: "Review", kind: "iteration" },
      sourceState: "done", status: "newly-done", taskIntent: "Recorded intent", chatLaneId: laneId,
      completionFingerprint: "b".repeat(64), completionAttention: "newly-done", evidence: [], taxonomyOptions: [] };
    app.run(`renderWorkSplit(${JSON.stringify({ items: [item] })})`);
    for (const root of ["#tight-work"]) {
      const href = /<a href="([^"]+)" class="crew-task"/.exec(app.node(root).innerHTML)?.[1];
      assert.ok(href, "the actual rendered task anchor exists");
      app.run(`window.location.hash = ${JSON.stringify(href)}; applyRoute();`);
      assert.equal(app.run("selectedSessionId"), taskId, "native hash navigation must select the task, not merely its lane");
      assert.equal(app.run("selectedLanes()[0].id"), laneId);
      assert.equal(app.run("messagesForSelection().map(message => message.text).join('|')"), "Exact ready task");
      assert.equal(app.node("#task-filter-id").textContent, taskId);
      assert.equal(app.node("#task-filter-chip").hidden, !compact);
      assert.ok(app.node("#conversation-subtext").textContent.endsWith(taskId.slice(0, 24)), "desktop breadcrumb is intentionally shortened");
      assert.equal(href, `#lanes/${encodeURIComponent(laneId)}/session/${encodeURIComponent(taskId)}`);
      app.run("selectedSessionId = null; allLanesSelected = true; applyRoute();");
      assert.equal(app.run("selectedSessionId"), taskId, "the same emitted route restores exact scope on reload");
    }
  }
});

test("Work Split omits singleton taxonomy wrappers, preserves filters, completion attention and direct links once", () => {
  const app = ui();
  const item = (id, status, extras = {}) => ({ id, name: id, taskFingerprint: id.repeat(64).slice(0, 64), repositoryId: "repo", repository: "Repository", lane: { id: "ui", name: "UI workstream" }, theme: { id: "iteration", name: "Review iteration", kind: "iteration" }, sourceState: status, status, taskIntent: "Recorded intent", chatLaneId: "legacy-project", completionFingerprint: status.includes("done") ? "c".repeat(64) : null, completionSourceFingerprint: "f".repeat(64), completionAttention: status.includes("done") ? status : null, evidence: [], taxonomyOptions: [], ...extras });
  const data = { items: [item("a", "active"), item("b", "waiting"), item("c", "newly-done"), item("d", "previously-done", { evidence: [{ badge: "remote Main", commit: "a".repeat(40) }], delivery: "Ready for review · deployment unknown" }), item("e", "cleanup", { completionAttention: "newly-done", completionFingerprint: "e".repeat(64), retained: true })] };
  app.run(`renderWorkSplit(${JSON.stringify(data)})`);
  for (const selector of ["#tight-work"]) {
    const html = app.node(selector).innerHTML;
    assert.match(html, /taxonomy-repository/);
    assert.doesNotMatch(html, /taxonomy-lane|taxonomy-theme/);
    assert.equal((html.match(/data-task-fingerprint=/g) || []).length, 5);
    assert.equal((html.match(/data-ack-task=/g) || []).length, 2, "retained completed slice can be acknowledged without clearing cleanup");
    assert.match(html, /#lanes\/legacy-project\/session\/c/);
    assert.match(html, /remote Main/); assert.match(html, /deployment unknown/);
    assert.match(html, /data-review-id="(?:work|overview):task:/);
  }
  app.run("workPhase='active'; renderWorkSplit()");
  assert.equal((app.node("#tight-work").innerHTML.match(/data-task-fingerprint=/g) || []).length, 1);
  app.run("workPhase='newly-done'; renderWorkSplit()");
  assert.equal((app.node("#tight-work").innerHTML.match(/data-task-fingerprint=/g) || []).length, 2);
  app.run("workPhase='all'; hierarchyOpen.set('work:repo', false); renderWorkSplit()");
  assert.match(app.node("#tight-work").innerHTML, /data-tree-key="work:repo"[^>]*>\s*<summary>/);
  assert.doesNotMatch(app.node("#tight-work").innerHTML.split("<summary>")[0], / open/);
  app.run(`renderSummary({activeAgents:1,workCounts:{active:9,'captain-action':2,'newly-done':3,'previously-done':4}})`);
  assert.equal((app.node("#summary").innerHTML.match(/metric-card/g) || []).length, 3);
  assert.match(app.node("#summary").innerHTML, /<strong>1<\/strong>[\s\S]*Verified workers/);
});

test("visible taxonomy siblings independently control lane and theme wrappers without changing groups or saved state", () => {
  const app = ui();
  const item = (id, laneId, themeId, status = "active", repositoryId = "repo") => ({ id, name: id, taskFingerprint: id, repositoryId, repository: repositoryId, lane: { id: laneId, name: laneId }, theme: { id: themeId, name: themeId, kind: "theme" }, status, evidence: [], taxonomyOptions: [], chatLaneId: "linked-lane" });
  const a = item("a", "one", "first"), b = item("b", "two", "first", "waiting"), c = item("c", "one", "second", "waiting");
  const render = (items) => app.run(`hierarchyHtml(${JSON.stringify(items)}, 'work')`);
  const counts = (html) => ["lane", "theme"].map((level) => (html.match(new RegExp(`taxonomy-${level} panel`, "g")) || []).length);
  assert.deepEqual(counts(render([a])), [0, 0], "one lane / one theme");
  assert.deepEqual(counts(render([a, b])), [2, 0], "many lanes, one theme per effective parent");
  assert.deepEqual(counts(render([a, c])), [0, 2], "one lane, many themes");
  assert.deepEqual(counts(render([a, b, c])), [2, 2], "multiple siblings at both levels");
  assert.deepEqual(counts(render([a, item("d", "other", "other", "active", "second-repo")])), [0, 0], "count lanes within each repository, not globally");
  const groups = app.run(`groupHierarchy(${JSON.stringify([a, b, c])})`);
  assert.equal(groups[0].lanes.size, 2);
  assert.equal(groups[0].lanes.get("one").themes.size, 2, "data hierarchy remains intact");
  for (const scope of ["work"]) {
    app.run(`hierarchyOpen.set('${scope}:repo:one', false); hierarchyOpen.set('${scope}:repo:one:first', false); renderWorkSplit(${JSON.stringify({ items: [a, b, c] })})`);
    const selector = "#tight-work";
    app.run("workPhase='active'; renderWorkSplit()");
    const filtered = app.node(selector).innerHTML;
    assert.deepEqual(counts(filtered), [0, 0]);
    assert.match(filtered, /data-task-fingerprint="a"/);
    assert.match(filtered, /#lanes\/linked-lane\/session\/a/);
    assert.doesNotMatch(filtered, /data-task-fingerprint="[bc]"/);
    assert.equal(app.run(`hierarchyOpen.get('${scope}:repo:one')`), false);
    app.run("workPhase='all'; renderWorkSplit()");
    const restored = app.node(selector).innerHTML;
    assert.deepEqual(counts(restored), [2, 2]);
    for (const key of [`${scope}:repo:one`, `${scope}:repo:one:first`]) {
      const tag = restored.match(new RegExp(`<details[^>]*data-tree-key="${key}"[^>]*>`))[0];
      assert.doesNotMatch(tag, / open/);
    }
  }
  assert.equal(render([]), '<p class="empty panel">No work matches these filters.</p>');
});

test("Work Split visual organization: horizontal repository scrolling, clear hierarchy, card item separation, and responsive containment", () => {
  // Horizontal repository scrolling deck on desktop/tablet
  assert.match(css, /#tight-work:has\(\.taxonomy-node\) \{[\s\S]*?display: flex;/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?#tight-work:has\(\.taxonomy-node\) \{[\s\S]*?flex-direction: row;[\s\S]*?overflow-x: auto;[\s\S]*?scroll-snap-type: x proximity;/);
  assert.match(css, /\.taxonomy-node\.taxonomy-repository \{[\s\S]*?clamp\(360px, 42vw, 560px\)[\s\S]*?scroll-snap-align: start;/);
  assert.match(css, /\.taxonomy-node\.taxonomy-repository:only-child \{[\s\S]*?max-width: 100%;/);

  // 3-tier visual hierarchy
  assert.match(css, /\.taxonomy-node\.taxonomy-repository \{[\s\S]*?border: 1px solid var\(--line-strong\);[\s\S]*?background: var\(--surface\);/);
  assert.match(css, /\.taxonomy-node\.taxonomy-lane \{[\s\S]*?border-left: 4px solid var\(--accent\);/);
  assert.match(css, /\.taxonomy-node\.taxonomy-theme \{[\s\S]*?background: var\(--surface-soft\);/);

  // Card-based item separation
  assert.match(css, /\.work-slice \{[\s\S]*?border: 1px solid var\(--line\);[\s\S]*?border-radius: 8px;[\s\S]*?box-shadow: 0 1px 2px rgba\(0, 0, 0, 0\.03\);/);
  assert.match(css, /\.work-slice:hover \{[\s\S]*?border-color: var\(--line-strong\);[\s\S]*?box-shadow: 0 2px 6px rgba\(0, 0, 0, 0\.06\);/);

  // Status chip scannability
  assert.match(css, /\.state-chip\[data-count-status="active"\],[\s\S]*?\.work-slice\[data-status="active"\]/);
  assert.match(css, /\.state-chip\[data-count-status="waiting"\],[\s\S]*?\.work-slice\[data-status="waiting"\]/);
  assert.match(css, /\.state-chip\[data-count-status="newly-done"\],[\s\S]*?\.work-slice\[data-status="newly-done"\]/);

  // High-contrast title blocks
  assert.match(css, /\.taxonomy-node\.taxonomy-repository > summary \{[\s\S]*?background: var\(--surface-soft\);[\s\S]*?color: var\(--text\);/);
  assert.match(css, /\.taxonomy-node\.taxonomy-lane > summary \{[\s\S]*?color: var\(--text\);/);
  assert.match(css, /\.taxonomy-node\.taxonomy-theme > summary strong \{[\s\S]*?color: var\(--text\);/);

  // Horizontal repository collapse with top-aligned vertical label and counts on desktop/tablet
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) \{[\s\S]*?flex: 0 0 54px;[\s\S]*?max-width: 54px;[\s\S]*?width: 54px;/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \{[\s\S]*?justify-content: flex-start;[\s\S]*?writing-mode: horizontal-tb;/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary strong \{[\s\S]*?writing-mode: vertical-rl;[\s\S]*?transform: rotate\(180deg\);[\s\S]*?margin: 4px 0 0;/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \.taxonomy-counts \{[\s\S]*?margin-top: 8px;/);

  // Compact closed spines keep the existing width without inheriting sibling height.
  const spine = css.match(/\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) \{([^}]+)\}/)[1];
  assert.match(spine, /height: 300px;/);
  assert.match(spine, /align-self: flex-start;/);
  const spineSummary = css.match(/\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \{([^}]+)\}/)[1];
  assert.match(spineSummary, /height: 100%;/);
  assert.match(spineSummary, /min-height: 0;/);
  assert.match(css, /\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary strong \{[^}]*min-height: 0;/);
  assert.match(css, /\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \.taxonomy-counts \{[^}]*flex-shrink: 0;/);

  // Mobile responsive containment
  assert.match(css, /@media \(width <= 720px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository \{ margin-bottom: 8px; \}/);
  assert.match(css, /@media \(width <= 720px\) \{[\s\S]*?\.work-slice \{ padding: 10px 12px; \}/);
});

test("Status badges in collapsed mode: 1-character abbreviations, left alignment, and accessible tooltips/labels", () => {
  const app = ui();
  const { statusLabels, statusAbbreviations } = app.run("window.workHierarchy") || {};
  assert.ok(statusAbbreviations, "statusAbbreviations must be exported by workHierarchy");
  const labelKeys = Object.keys(statusLabels);
  assert.equal(Object.keys(statusAbbreviations).length, labelKeys.length, "All status categories must have abbreviations");
  for (const key of labelKeys) {
    const abbr = statusAbbreviations[key];
    assert.equal(typeof abbr, "string");
    assert.equal(abbr.length, 1, `Status ${key} must have exactly 1-character abbreviation`);
    assert.match(abbr, /^[A-Z]$/, `Status ${key} abbreviation must be single uppercase ASCII character`);
  }
  assert.equal(new Set(Object.values(statusAbbreviations)).size, labelKeys.length, "All status abbreviations must be strictly unique and unambiguous");
  assert.equal(statusAbbreviations.active, "A");
  assert.equal(statusAbbreviations.waiting, "W");
  assert.equal(statusAbbreviations["captain-action"], "C");
  assert.equal(statusAbbreviations.cleanup, "R");
  assert.equal(statusAbbreviations.unknown, "U");
  assert.equal(statusAbbreviations.backlog, "B");
  assert.equal(statusAbbreviations["newly-done"], "N");
  assert.equal(statusAbbreviations["previously-done"], "P");

  // CSS rules: badge labels toggle between full and abbreviation
  assert.match(css, /\.badge-label-full \{ display: inline; \}/);
  assert.match(css, /\.badge-label-abbr \{ display: none; \}/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \.badge-label-full \{[\s\S]*?display: none;/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \.badge-label-abbr \{[\s\S]*?display: inline;/);

  // Left alignment in collapsed spine
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \.taxonomy-counts \{[\s\S]*?align-items: flex-start;/);
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?\.taxonomy-node\.taxonomy-repository:not\(\[open\]\) > summary \.state-chip \{[\s\S]*?text-align: left;/);
});

test("Visible status button filters: replace dropdown reliance with accessible button group", () => {
  // CSS rules for status buttons
  assert.match(css, /\.status-button-filter \{ display: inline-flex; flex-wrap: wrap; align-items: center; gap: 4px; \}/);
  assert.match(css, /\.status-filter-btn \{ display: inline-flex; align-items: center;/);
  assert.match(css, /\.status-filter-btn \.status-btn-label,\s*\.status-filter-btn \.filter-label \{ position: static; width: auto; height: auto; overflow: visible; clip-path: none; white-space: nowrap; display: inline;/);
  assert.match(css, /\.status-filter-btn\.active,\s*\.status-filter-btn\[aria-pressed="true"\] \{ background: var\(--accent\);/);
  assert.match(css, /\.sr-only-select \{ position: absolute; width: 1px; height: 1px;/);

  const app = ui();
  const sampleItems = [
    { taskFingerprint: "t1", id: "t-1", name: "Task 1", repositoryId: "r1", repository: "Repo 1", lane: { id: "l1", name: "Lane 1" }, theme: { id: "th1", name: "Theme 1", kind: "theme" }, status: "active", evidence: [], taxonomyOptions: [] },
    { taskFingerprint: "t2", id: "t-2", name: "Task 2", repositoryId: "r1", repository: "Repo 1", lane: { id: "l1", name: "Lane 1" }, theme: { id: "th1", name: "Theme 1", kind: "theme" }, status: "waiting", evidence: [], taxonomyOptions: [] },
  ];
  app.run(`workSplitData = { items: ${JSON.stringify(sampleItems)} }; renderWorkSplit();`);

  // Work Split status buttons rendered (Overview has Captain's Call instead).
  const overviewBtnsHtml = app.node("#work-phase-buttons").innerHTML;
  assert.match(overviewBtnsHtml, /data-status-value="all"/);
  assert.match(overviewBtnsHtml, /data-status-value="active"/);
  assert.match(overviewBtnsHtml, /data-status-value="waiting"/);
  assert.match(overviewBtnsHtml, /class="status-filter-btn active"/);
  assert.match(overviewBtnsHtml, /aria-pressed="true"/);

  // Concise readable visible labels alongside count chips
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">All<\/span> <span class="filter-count">2<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Active<\/span> <span class="filter-count">1<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Waiting<\/span> <span class="filter-count">1<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Captain action<\/span> <span class="filter-count">0<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Cleanup<\/span> <span class="filter-count">0<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Unknown<\/span> <span class="filter-count">0<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Backlog<\/span> <span class="filter-count">0<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Newly done<\/span> <span class="filter-count">0<\/span>/);
  assert.match(overviewBtnsHtml, /<span class="status-btn-label">Previously done<\/span> <span class="filter-count">0<\/span>/);

  // Full accessible names in title and aria-label
  assert.match(overviewBtnsHtml, /title="All phases: 2" aria-label="All phases: 2"/);
  assert.match(overviewBtnsHtml, /title="Active: 1" aria-label="Active: 1"/);
  assert.match(overviewBtnsHtml, /title="Waiting \/ external delay: 1" aria-label="Waiting \/ external delay: 1"/);
  assert.match(overviewBtnsHtml, /title="Retained \/ cleanup: 0" aria-label="Retained \/ cleanup: 0"/);

  // Every button must contain non-empty readable text, never numbers only
  for (const m of overviewBtnsHtml.matchAll(/class="status-filter-btn[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) {
    const btnInner = m[1];
    const labelMatch = btnInner.match(/<span class="status-btn-label">([^<]+)<\/span>/);
    assert.ok(labelMatch, "Button must have a status-btn-label span");
    assert.ok(labelMatch[1].trim().length > 0, "Button label must be non-empty readable text, not numbers only");
  }

  // Work phase buttons rendered
  const workBtnsHtml = app.node("#work-phase-buttons").innerHTML;
  assert.match(workBtnsHtml, /data-status-value="all"/);
  assert.match(workBtnsHtml, /data-status-value="active"/);
  assert.match(workBtnsHtml, /aria-pressed="true"/);
  assert.match(workBtnsHtml, /<span class="status-btn-label">All<\/span> <span class="filter-count">2<\/span>/);
  assert.match(workBtnsHtml, /<span class="status-btn-label">Active<\/span> <span class="filter-count">1<\/span>/);
  assert.match(workBtnsHtml, /<span class="status-btn-label">Waiting<\/span> <span class="filter-count">1<\/span>/);
  assert.match(workBtnsHtml, /title="All phases: 2" aria-label="All phases: 2"/);
  assert.match(workBtnsHtml, /title="Waiting \/ external delay: 1" aria-label="Waiting \/ external delay: 1"/);

  for (const m of workBtnsHtml.matchAll(/class="status-filter-btn[^"]*"[^>]*>([\s\S]*?)<\/button>/g)) {
    const btnInner = m[1];
    const labelMatch = btnInner.match(/<span class="status-btn-label">([^<]+)<\/span>/);
    assert.ok(labelMatch, "Button must have a status-btn-label span");
    assert.ok(labelMatch[1].trim().length > 0, "Button label must be non-empty readable text, not numbers only");
  }

  // Synchronized update from Work Split phase change
  app.run(`workPhase = "active"; renderWorkSplit();`);
  assert.equal(app.node("#work-phase").value, "active");
  assert.match(app.node("#work-phase-buttons").innerHTML, /class="status-filter-btn active"[^>]*data-status-value="active"[^>]*aria-pressed="true"/);

  // Synchronized update from workPhase change
  app.run(`workPhase = "waiting"; renderWorkSplit();`);
  assert.equal(app.node("#work-phase").value, "waiting");
  assert.match(app.node("#work-phase-buttons").innerHTML, /class="status-filter-btn active"[^>]*data-status-value="waiting"[^>]*aria-pressed="true"/);
});

test("Overview and Work Split wide-screen viewport utilization: scoped width expansion without indiscriminate sprawl", () => {
  // Scoped width expansion rules
  assert.match(css, /#overview-view > \*,\s*#work-view > \* \{[\s\S]*?max-width:\s*100%;/);
  assert.match(css, /\.overview-columns \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); gap: 22px; align-items: start; \}/);
  assert.match(css, /@media \(max-width: 720\.005px\) \{[\s\S]*?\.overview-columns \{ grid-template-columns: 1fr; \}/);
  assert.match(css, /\.overview-section-tabs \{ display: none; \}/);
  assert.match(css, /@media \(max-width: 720\.005px\) \{\n  \.call-card \{ padding: 14px 12px 12px; \}[\s\S]*?\.overview-section-tabs \{ display: flex; /);
  assert.doesNotMatch(css, /#overview-secondary \{ display: none; \}/);
  assert.match(css, /\.call-card \.call-head-pill\.landed-ack \{ min-height: 44px; \}/);
  assert.match(css, /#landed-ack-toggle \{ min-height: 44px;/);
  assert.match(css, /#work-view section \{[\s\S]*?width:\s*100%;[\s\S]*?max-width:\s*100%;/);
  assert.match(css, /#work-view section > p\.muted \{[\s\S]*?max-width:\s*80ch;/);

  // Scoped desktop/tablet padding
  assert.match(css, /@media \(min-width: 721px\) \{[\s\S]*?#overview-view\.feature-view,\s*#work-view\.feature-view \{[\s\S]*?padding-left:\s*clamp\(16px,\s*2vw,\s*32px\);/);

  // Default feature-view retains 1200px max-width for other pages
  assert.match(css, /\.feature-view > \* \{ max-width: 1200px;/);
});

test("quota cards distinguish reused and stale readings and suppress stale projections", () => {
  const app = ui();
  const baseProvider = {
    provider: "codex", status: "fresh", stale: false, quotaStatus: "known", authStatus: "usable",
    scopes: [{ scope: "all_models", status: "known", percentRemaining: 42, boundedBy: ["session"], limitingWindowIds: ["session"],
      pace: { status: "ahead", reservePercentPoints: -4 }, runway: { status: "projected_exhaustion", seconds: 600, exhaustedAt: "2030-01-01T00:15:00Z" } }],
    windows: [{ id: "session", label: "Session", kind: "session", percentRemaining: 42, pace: { status: "ahead" } }]
  };
  const reusedAt = new Date(Date.now() - 42000).toISOString();
  app.run(`renderQuota(${JSON.stringify({ maxAgeMs: 300000, readAt: reusedAt, providers: [{ ...baseProvider, reused: true, refreshedAt: reusedAt }] })})`);
  let cards = app.node("#quota-providers").innerHTML;
  assert.match(cards, /class="quota-reused" title="reused 42s" aria-label="reused 42s"><span class="quota-age">reused 42s/);

  const staleAt = new Date(Date.now() - 1000).toISOString();
  app.run(`renderQuota(${JSON.stringify({ maxAgeMs: 300000, readAt: staleAt, providers: [{ ...baseProvider, status: "stale", stale: true, refreshedAt: staleAt }] })})`);
  cards = app.node("#quota-providers").innerHTML;
  assert.match(cards, /quota-card-stale/);
  assert.match(cards, /quota-stale-marker/);
  assert.match(cards, /stale · 1s/);
  assert.match(cards, /Effective availability unknown/);
  assert.match(cards, /Runway: Unknown/);
  assert.doesNotMatch(cards, /Projected exhaustion/);
});

test("quota age timer updates stale details while preserving unrelated focus and selection", () => {
  for (const interaction of ["TEXTAREA", "INPUT", "SELECT", "selection"]) {
    const app = ui();
    app.run(`
      let quotaNow = Date.parse("2030-01-01T00:00:00Z");
      Date.now = () => quotaNow;
      const quotaTicks = [];
      window.setInterval = (callback) => { quotaTicks.push(callback); return quotaTicks.length; };
    `);
    const refreshedAt = new Date(app.run("quotaNow") - 290000).toISOString();
    const reading = {
      maxAgeMs: 300000, readAt: refreshedAt,
      providers: [{
        provider: "codex", status: "fresh", quotaStatus: "known", authStatus: "usable", refreshedAt,
        scopes: [{ scope: "all_models", status: "known", percentRemaining: 42, boundedBy: ["session"], limitingWindowIds: ["session"],
          pace: { status: "ahead", reservePercentPoints: -4 },
          runway: { status: "projected_exhaustion", seconds: 600, exhaustedAt: "2030-01-01T00:15:00Z" } }],
        windows: [{ id: "session", label: "Session", kind: "session", percentRemaining: 42, pace: { status: "ahead" } }]
      }]
    };
    app.run(`renderQuota(${JSON.stringify(reading)})`);
    const freshCards = app.node("#quota-providers").innerHTML;
    assert.doesNotMatch(freshCards, /quota-card-stale/);
    assert.match(freshCards, /Pace: Ahead/);
    assert.match(freshCards, /Projected exhaustion/);

    const input = app.node("#review-message");
    if (interaction === "selection") {
      app.node("#messages").textContent = "Selected fleet message";
      app.run(`
        const fleetSelection = {
          anchorNode: document.querySelector("#messages"), anchorOffset: 0,
          focusNode: document.querySelector("#messages"), focusOffset: 8,
          toString: () => "Selected"
        };
        window.getSelection = () => fleetSelection;
      `);
    } else {
      input.tagName = interaction;
      input.value = "Please review quota";
      input.selectionStart = 7;
      input.selectionEnd = 13;
      input.focus();
    }

    app.run("quotaNow += 15000; quotaTicks[0]()");
    const staleCards = app.node("#quota-providers").innerHTML;
    assert.match(staleCards, /quota-card-stale/);
    assert.match(staleCards, /quota-stale-marker/);
    assert.match(staleCards, /stale · 5m/);
    assert.match(staleCards, /effective unknown/);
    assert.match(staleCards, /Effective availability unknown/);
    assert.match(staleCards, /Remaining unknown/);
    assert.match(staleCards, /Runway: Unknown/);
    assert.match(staleCards, /Pace unknown/);
    assert.doesNotMatch(staleCards, /Pace: Ahead|Projected exhaustion|percentage points reserve/);
    for (const id of ["#quota-strip", "#mobile-quota-sheet-content"]) {
      assert.match(app.node(id).innerHTML, /stale · 5m/);
      assert.doesNotMatch(app.node(id).innerHTML, /Pace: ahead/);
    }
    assert.equal(app.run("quotaTicks.length"), 1);

    const freshAt = new Date(app.run("quotaNow")).toISOString();
    reading.readAt = freshAt;
    reading.providers[0].refreshedAt = freshAt;
    app.run(`renderQuota(${JSON.stringify(reading)})`);
    const refreshedCards = app.node("#quota-providers").innerHTML;
    assert.doesNotMatch(refreshedCards, /quota-card-stale/);
    assert.match(refreshedCards, /Pace: Ahead/);
    assert.match(refreshedCards, /Projected exhaustion/);

    if (interaction === "selection") {
      assert.equal(app.run("window.getSelection()"), app.run("fleetSelection"));
      assert.equal(app.run("window.getSelection().toString()"), "Selected");
      assert.equal(app.run("window.getSelection().anchorNode"), app.node("#messages"));
      assert.equal(app.run("window.getSelection().focusNode"), app.node("#messages"));
      assert.equal(app.run("window.getSelection().anchorOffset"), 0);
      assert.equal(app.run("window.getSelection().focusOffset"), 8);
    } else {
      assert.equal(app.run("document.activeElement"), input);
      assert.equal(input.value, "Please review quota");
      assert.equal(input.selectionStart, 7);
      assert.equal(input.selectionEnd, 13);
    }
  }
});

test("quota freshness preserves in-card and compact interactions and captured markers", () => {
  for (const interaction of ["card-selection", "backward-selection", "scope-selection", "reused-selection", "card-focus", "sidebar-selection", "sidebar-focus", "mobile-selection", "mobile-focus"]) {
    const app = ui();
    app.run(`
      let quotaNow = Date.parse("2030-01-01T02:31:55Z");
      Date.now = () => quotaNow;
      let quotaTick;
      window.setInterval = (callback) => { quotaTick = callback; return 1; };
    `);
    const reading = {
      readAt: "2030-01-01T02:30:00Z", capturedAt: "2030-01-01T02:30:00Z", maxAgeMs: 300000,
      providers: [{
        provider: "codex", status: "fresh", reused: true, refreshedAt: "2030-01-01T02:30:00Z", authStatus: "usable", quotaStatus: "known",
        scopes: [{ scope: "all_models", status: "known", percentRemaining: 82, boundedBy: ["session"], limitingWindowIds: ["session"],
          pace: { status: "ahead", reservePercentPoints: -4 }, runway: { status: "projected_exhaustion", seconds: 600, exhaustedAt: "2030-01-01T02:40:00Z" } }],
        windows: [{ id: "session", label: "Session", kind: "session", percentRemaining: 82, resetsAt: "2030-01-01T05:00:00Z", durationSeconds: 18000,
          pace: { status: "ahead", reservePercentPoints: -4, cycleBasis: "window_seconds", cycleSeconds: 18000, timeRemainingPercent: 50 } }]
      }, {
        provider: "agy", status: "fresh", refreshedAt: "2030-01-01T02:31:55Z", authStatus: "usable", quotaStatus: "known",
        scopes: [{ scope: "all_models", status: "known", percentRemaining: 42 }],
        windows: [{ id: "session", label: "Session", kind: "session", percentRemaining: 42 }]
      }]
    };
    app.run(`renderQuota(${JSON.stringify(reading)})`);
    const cards = app.node("#quota-providers");
    const card = cards.querySelector('article[data-provider="codex"]');
    const disclosure = card.querySelector("details");
    disclosure.open = true;
    const summary = disclosure.querySelector("summary");
    const strip = app.node("#quota-strip");
    const link = strip.querySelector("a");
    const mobile = app.node("#mobile-quota-sheet-content");
    const row = mobile.querySelector(".mobile-quota-sheet-row");
    const freshness = card.querySelector(".quota-reused");
    const selectedElement = interaction.startsWith("sidebar") ? link.querySelector(".quota-family-value")
      : interaction.startsWith("mobile") ? row.querySelector(".quota-family-value")
      : interaction === "scope-selection" ? card.querySelector(".quota-scope h3")
      : interaction === "reused-selection" ? freshness : card.querySelector(".quota-window h3");
    const selectedText = selectedElement.childNodes[0];
    const selectedLength = Math.min(4, selectedText.length);
    const selection = app.run("window.getSelection()");
    const backward = interaction === "backward-selection";
    const focused = interaction === "card-focus" ? summary : interaction === "sidebar-focus" ? link : app.node(".mobile-dock-quota");
    if (interaction.endsWith("focus")) focused.focus();
    else selection.setBaseAndExtent(selectedText, backward ? selectedLength : 0, selectedText, backward ? 0 : selectedLength);

    const assertInteraction = () => {
      assert.equal(cards.querySelector('article[data-provider="codex"]'), card, interaction);
      assert.equal(card.querySelector("summary"), summary, interaction);
      assert.ok([...strip.querySelectorAll("a")].includes(link), interaction);
      assert.ok([...mobile.querySelectorAll(".mobile-quota-sheet-row")].includes(row), interaction);
      if (interaction.endsWith("focus")) assert.equal(app.run("document.activeElement"), focused, interaction);
      else {
        assert.equal(selection.anchorNode, selectedText, interaction);
        assert.equal(selection.focusNode, selectedText, interaction);
        assert.equal(selection.anchorOffset, backward ? selectedLength : 0, interaction);
        assert.equal(selection.focusOffset, backward ? 0 : selectedLength, interaction);
        assert.equal(selectedText.isConnected, true, interaction);
        assert.equal(selection.toString(), selectedText.data.slice(0, selectedLength), interaction);
      }
    };

    app.run("quotaNow += 15000; quotaTick()");
    assert.equal(card.querySelector(".quota-reused"), freshness);
    assert.equal(freshness.textContent, "reused 2m");
    assertInteraction();
    if (interaction === "card-focus") disclosure.open = false;

    app.run('quotaNow = Date.parse("2030-01-01T02:34:50Z"); quotaTick()');
    assertInteraction();
    app.run("quotaNow += 15000; quotaTick()");
    assert.equal(card.classList.contains("quota-card-stale"), true);
    assert.match(card.textContent, /stale 5m/);
    assert.match(card.textContent, /Effective availability unknown/);
    assert.match(card.textContent, /Runway: Unknown/);
    assert.doesNotMatch(card.textContent, /Pace: Ahead|Projected exhaustion|percentage points reserve/);
    assert.equal(cards.querySelector("details").dataset.provider, "agy", "stale scopes sort after fresh scopes");
    assert.equal(disclosure.open, interaction !== "card-focus", "pending native toggle state survives freshness changes");
    for (const surface of [card, link, row]) {
      const notch = surface.querySelector(".quota-family-notch");
      assert.equal(notch.getAttribute("style"), "--remaining:50%");
      assert.match(notch.getAttribute("aria-label"), /50\.0% of reset window remaining at source capture/);
      assert.doesNotMatch(surface.textContent, /source window boundaries unavailable or inconsistent/);
      assert.match(surface.querySelector(".quota-family-row").getAttribute("title"), /Pace: unknown/);
    }
    assertInteraction();

    disclosure.open = false;
    disclosure.dispatchEvent({ type: "toggle" });
    reading.providers[0].refreshedAt = new Date(app.run("quotaNow")).toISOString();
    app.run(`renderQuota(${JSON.stringify(reading)})`);
    assert.equal(disclosure.open, false, "native disclosure state survives a refreshed reading");
    assert.equal(card.classList.contains("quota-card-stale"), false);
    assert.match(card.textContent, /Pace: Ahead/);
    assertInteraction();
    app.node("#quota-sort-left").dispatchEvent({ type: "click" });
    assert.equal(cards.querySelector("details").dataset.provider, "agy");
    assertInteraction();
  }
});

test("stale scope-only quota preserves compact eligibility, focus and fourth-row selection", () => {
  for (const interaction of ["sidebar-focus", "mobile-selection"]) {
    const app = ui();
    app.run(`
      let quotaNow = Date.parse("2030-01-01T00:04:50Z");
      Date.now = () => quotaNow;
      let quotaTick;
      window.setInterval = (callback) => { quotaTick = callback; return 1; };
    `);
    const refreshedAt = "2030-01-01T00:00:00Z";
    const reading = { readAt: refreshedAt, maxAgeMs: 300000, providers: [
      { provider: "grok", status: "fresh", authStatus: "usable", refreshedAt, scopes: [], windows: [{ id: "unknown", label: "Hidden source", percentRemaining: null }] },
      { provider: "codex", status: "fresh", quotaStatus: "known", authStatus: "usable", refreshedAt,
        scopes: [{ scope: "unmeasured", percentRemaining: null }, { scope: "all_models", percentRemaining: 42, pace: { status: "ahead" } }], windows: [] },
      ...["claude", "cursor", "copilot"].map((provider) => ({ provider, status: "fresh", quotaStatus: "known", authStatus: "usable", refreshedAt,
        scopes: [], windows: [{ id: "session", label: "Session", percentRemaining: 0, pace: { status: "ahead" } }] }))
    ] };
    app.run(`renderQuota(${JSON.stringify(reading)})`);
    const strip = app.node("#quota-strip");
    const mobile = app.node("#mobile-quota-sheet-content");
    const links = strip.querySelectorAll("a");
    const rows = mobile.querySelectorAll(".mobile-quota-sheet-row");
    assert.equal(links.length, 4);
    assert.equal(rows.length, 4);
    const selectedText = rows[3].querySelector(".provider-name").childNodes[0];
    const selection = app.run("window.getSelection()");
    if (interaction === "sidebar-focus") links[0].focus();
    else selection.setBaseAndExtent(selectedText, 0, selectedText, selectedText.length);

    app.run("quotaNow += 15000; quotaTick()");
    const staleLinks = strip.querySelectorAll("a");
    const staleRows = mobile.querySelectorAll(".mobile-quota-sheet-row");
    assert.equal(staleLinks.length, 4);
    assert.equal(staleRows.length, 4);
    for (let index = 0; index < 4; index++) {
      assert.equal(staleLinks[index], links[index]);
      assert.equal(staleRows[index], rows[index]);
      assert.match(staleRows[index].textContent, /stale 5m/);
    }
    for (const surface of [strip, mobile]) assert.doesNotMatch(surface.textContent, /unmeasured|Hidden source|grok/);
    if (interaction === "sidebar-focus") assert.equal(app.run("document.activeElement"), links[0]);
    else {
      assert.equal(selection.anchorNode, selectedText);
      assert.equal(selection.focusNode, selectedText);
      assert.equal(selection.anchorOffset, 0);
      assert.equal(selection.focusOffset, selectedText.length);
      assert.equal(selection.toString(), "copilot");
      assert.equal(selectedText.isConnected, true);
    }
    for (const surface of [links[0], rows[0]]) {
      assert.equal(surface.querySelector(".quota-family-value").textContent, "?");
      assert.match(surface.querySelector(".quota-family-row").getAttribute("title"), /Remaining unknown.*Pace: unknown/);
      assert.equal(surface.querySelector('[role="progressbar"]'), null);
    }
  }
});
