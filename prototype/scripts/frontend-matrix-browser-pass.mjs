// Exact clean-head standalone + registered UAT viewport matrix. No live home, shared port or credentials.
// Run from prototype/: node scripts/frontend-matrix-browser-pass.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { reviewVersion } from "../review.js";
import { sanitizeQuota } from "../quota.js";

const raw = { schemaVersion: 5, providers: [{ provider: "codex", state: { status: "fresh" },
  quotaSemantics: { status: "known", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 26, boundedBy: ["daily", "weekly"], limitingWindowIds: ["weekly"] }] },
  windows: [{ id: "daily", label: "Daily", kind: "daily", percentRemaining: 26, resetsAt: "2030-01-02T00:00:00Z" },
    { id: "weekly", label: "Weekly", kind: "weekly", percentRemaining: 68, resetsAt: "2030-01-08T00:00:00Z" }] }] };
const fixture = { providers: sanitizeQuota(raw), readAt: "2030-01-01T00:00:00Z", stale: false, error: null };
const lane = (id, status) => ({ id, name: id, status, closed: false,
  messages: [{ recordId: `fixture:${id}`, author: "Firstmate", role: "firstmate", kind: "conversation", state: status,
    text: `Fixture ${id}`, source: "fixture", time: "12:00", occurredAt: "2030-01-01T12:00:00Z" }],
  sessions: [], items: [], crew: 0, mission: "Fixture" });
const options = { quotaReader: async () => fixture, lanesReader: async () => ({ source: "fixture", lanes: [lane("general", "active"), lane("working", "working"), lane("idle", "idle")], transcript: { sessions: [], warnings: [], note: "Fixture coverage" } }) };
const entry = { id: "uat", name: "UAT", branch: "uat", commit: reviewVersion, remoteCheckpoint: reviewVersion, validation: "accepted" };
const servers = [createServer({ FM_DEPLOYMENT_TIER: "uat" }, options), createServer({ FM_DEPLOYMENT_TIER: "uat" }, { ...options, previewRegistry: [entry] })];
const profile = await mkdtemp(path.join(process.cwd(), ".frontend-matrix-chrome-"));
const chrome = spawn(process.env.CHROMIUM || "chromium",
  ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  for (const server of servers) await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port);
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
    if (!pending.has(reply.id)) return;
    const { resolve, reject } = pending.get(reply.id); pending.delete(reply.id);
    reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id; pending.set(next, { resolve, reject }); ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evalJs = async (expression) => {
    const reply = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };
  await cmd("Page.enable");
  const widths = [320, 390, 720, 721, 1200, 1201, 1440, 1600];
  for (const [mode, server] of [["standalone", servers[0]], ["registered", servers[1]]]) {
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const width of widths) {
      await cmd("Emulation.setDeviceMetricsOverride", { width, height: width === 320 ? 700 : 844, deviceScaleFactor: 1, mobile: width <= 720 });
      for (const view of ["overview", "lanes", "quota"]) {
        const route = mode === "registered" ? "/preview/uat/" : "/";
        await cmd("Page.navigate", { url: `${origin}${route}#${view}` });
        let ready = false;
        for (let i = 0; i < 100; i++) {
          ready = await evalJs(`Boolean(document.querySelector('#review-panel-toggle') && document.querySelector('#quota-providers .quota-family-row') && ${view === "lanes" ? "document.querySelector('#lane-filter-rows input') &&" : ""} ${mode === "registered" ? 'document.querySelector(".preview-chat textarea")' : 'document.querySelector(".uat-deployment-label")'})`);
          if (ready) break;
          await wait(100);
        }
        assert.ok(ready, `${mode} ${width} #${view} loaded served scripts and synthetic readings: ${JSON.stringify(await evalJs(`({ url: location.href, body: document.body?.innerText?.slice(0, 180), quota: document.querySelector('#quota-providers')?.innerText?.slice(0, 200), lanes: document.querySelector('#lane-filter-rows')?.innerText?.slice(0, 100), review: Boolean(document.querySelector('#review-panel-toggle')) })`))}`);
        assert.equal(await evalJs('document.querySelector("#review-message").placeholder'), "Message firstmate");
        const state = await evalJs(`(() => {
          const visible = (element) => { if (!element) return false; const r = element.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(element).visibility !== 'hidden'; };
          const nav = document.querySelector('.primary-nav > [data-view="quota"]');
          const review = document.querySelector('#review-panel-toggle');
          const expand = document.querySelector('#quota-expand-all');
          const chat = document.querySelector('.preview-chat textarea');
          return { width: innerWidth, route: location.pathname, hash: location.hash, commit: window.FM_SERVED_COMMIT || '',
            identity: document.querySelector('#preview-active')?.title || document.querySelector('.uat-deployment-label')?.title || '',
            overflow: document.documentElement.scrollWidth > innerWidth, nav: innerWidth <= 720 ? visible(document.querySelector('.mobile-dock .mobile-more')) : visible(nav), review: visible(review),
            expand: visible(expand), chat: Boolean(chat), placeholder: chat?.placeholder || '',
            header: innerWidth <= 720 ? visible(document.querySelector('.product-identity')) : visible(document.querySelector('${view === "lanes" ? ".conversation-head" : `#${view}-view h1`}')),
            navFits: innerWidth <= 720 ? [...document.querySelectorAll('.mobile-dock button')].every(button => button.getBoundingClientRect().width >= 44) : nav.getBoundingClientRect().width >= nav.querySelector('span').getBoundingClientRect().width,
            windows: document.querySelectorAll('#quota-providers .quota-family-row').length };
        })()`);
        assert.equal(state.width, width); assert.equal(state.hash, `#${view}`);
        assert.equal(state.route, route, `actual served path: ${mode}`);
        assert.match(state.identity, new RegExp(reviewVersion));
        if (mode === "registered") assert.equal(state.commit, reviewVersion);
        assert.equal(state.overflow, false, `${mode} ${width} ${view}: no overflow`);
        assert.ok(state.nav && state.review && state.header && state.navFits, `${mode} ${width} ${view}: controls fit ${JSON.stringify(state)}`);
        if (view === "quota") assert.ok(state.expand && state.windows === 2, `${mode} ${width}: quota windows/controls`);
        assert.equal(state.chat, mode === "registered");
        if (state.chat) {
          assert.equal(state.placeholder, "Message firstmate");
        }
        if (width > 720) {
          for (const narrow of [false, ...(width >= 1200 ? [true] : [])]) {
            const sidebar = await evalJs(`(() => {
              if (${narrow}) document.querySelector('.workspace').style.setProperty('--shell-nav-width', '220px');
              const controls = document.querySelector('.sidebar-control-row');
              const version = document.querySelector('#sidebar-version');
              const nodes = [...controls.children];
              const row = controls.getBoundingClientRect();
              const boxes = nodes.map(node => { const r = node.getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width}; });
              const lines = [...version.children].map(node => ({text:node.innerText, rect:node.getBoundingClientRect().toJSON()}));
              return { order: nodes.map(node => node.id || node.className), lines,
                label: version.getAttribute('aria-label'), icon: !!version.querySelector('svg'), hidden: version.hidden,
                decorative: !!document.querySelector('#lanes-source, #connection-state'), row:row.toJSON(), boxes,
                footerVersionClipped: document.querySelector('.preview-heading') ? getComputedStyle(document.querySelector('.preview-heading')).clipPath === 'inset(50%)' : true,
                versionParent: document.querySelector('.preview-control')?.parentElement?.id || '',
                footerBadge: !!document.querySelector('#desktop-review-footer .uat-deployment-label'), overflow:document.documentElement.scrollWidth > innerWidth,
                viewportHeight: innerHeight,
                textNodes:[...document.querySelector('.workspace').childNodes].filter(n=>n.nodeType===Node.TEXT_NODE && n.textContent.trim()).map(n=>n.textContent.trim()),
                shellBottom: document.querySelector('.lane-list').getBoundingClientRect().bottom,
                footerLeft: document.querySelector('#desktop-review-footer').getBoundingClientRect().left,
                mainLeft: document.querySelector('.main-stage').getBoundingClientRect().left,
                footerBottom: document.querySelector('#desktop-review-footer').getBoundingClientRect().bottom };
            })()`);
            assert.deepEqual(sidebar.order, ['refresh', 'sidebar-version', 'review-gesture']);
            assert.equal(sidebar.decorative, false);
            assert.equal(sidebar.hidden, false);
            assert.equal(sidebar.icon, true);
            assert.equal(sidebar.lines[0].text, 'UAT');
            assert.equal(sidebar.lines[1].text, '', 'publication icon has no visible copy');
            assert.equal(sidebar.lines[2].text, reviewVersion.slice(0, 6));
            assert.match(sidebar.label, new RegExp(`UAT, local, ${mode === 'standalone' ? 'unpublished' : 'published'}, full revision ${reviewVersion}`));
            assert.equal(sidebar.footerVersionClipped, true, `registered footer identity visually hidden behind sidebar control: ${JSON.stringify(sidebar)}`);
            assert.equal(sidebar.footerBadge, false, 'no standalone deployment badge in footer');
            assert.deepEqual(sidebar.textNodes, [], 'missing standalone banner must not append literal null grid items');
            assert.ok(Math.abs(sidebar.shellBottom - sidebar.viewportHeight) <= 1 && Math.abs(sidebar.footerBottom - sidebar.viewportHeight) <= 1, `sidebar and footer reach viewport bottom: ${JSON.stringify(sidebar)}`);
            assert.ok(Math.abs(sidebar.footerLeft - sidebar.mainLeft) <= 1, 'footer starts at main-content boundary');
            assert.equal(sidebar.overflow, false);
            assert.ok(sidebar.boxes.every(box => box.width > 0 && box.top >= sidebar.row.top && box.bottom <= sidebar.row.bottom && box.left >= sidebar.row.left - 1 && box.right <= sidebar.row.right + 1), `${mode} ${width} ${view} narrow=${narrow}: controls inside one row ${JSON.stringify(sidebar)}`);
            assert.ok(sidebar.boxes[0].right <= sidebar.boxes[1].left && sidebar.boxes[1].right <= sidebar.boxes[2].left, 'three columns do not overlap');
            assert.ok(sidebar.lines[0].rect.top < sidebar.lines[1].rect.bottom && sidebar.lines[1].rect.top < sidebar.lines[0].rect.bottom, 'UAT and cloud share first line');
            assert.ok(sidebar.lines[2].rect.top >= Math.max(sidebar.lines[0].rect.bottom, sidebar.lines[1].rect.bottom), 'hash occupies second line');
            assert.ok(sidebar.boxes.slice(1).every((box, i) => Math.abs(box.width - sidebar.boxes[i].width) <= 1), 'three controls use equal columns');
            if (view === 'overview' && width === 1200 && narrow === false) {
              const disclosed = await evalJs(`(() => { const version = document.querySelector('#sidebar-version'); version.click();
                const open = ${mode === 'standalone' ? "!document.querySelector('#sidebar-version-detail').hidden && document.querySelector('#sidebar-version-detail').textContent.includes('full revision')" : "!document.querySelector('#preview-details').hidden"};
                version.click(); return {open, closed: ${mode === 'standalone' ? "document.querySelector('#sidebar-version-detail').hidden" : "document.querySelector('#preview-details').hidden"}}; })()`);
              assert.deepEqual(disclosed, {open:true, closed:true}, `${mode} sidebar version disclosure remains useful`);
            }
          }
        }
        assert.equal(await evalJs(`[...performance.getEntriesByType('resource')].some(r => r.name.endsWith('/quota-view-model.js'))`), true, 'model loaded from actual served path');
        if (view === "lanes") {
          const intersected = await evalJs(`(() => {
            const status = document.querySelector('#lane-status'); status.value = 'idle'; status.dispatchEvent(new Event('change', { bubbles: true }));
            return { hash: location.hash, all: document.querySelector('#lane-select-all').checked,
              checked: [...document.querySelectorAll('#lane-filter-rows input:checked')].map(input => input.dataset.filterLane),
              feed: document.querySelector('#messages').innerText,
              context: window.fmChatViewContext({ branch: 'uat', commit: window.FM_SERVED_COMMIT || '${reviewVersion}' }).lanes.map(lane => lane.id) };
          })()`);
          assert.equal(intersected.hash, '#lanes');
          assert.equal(intersected.all, true);
          assert.deepEqual(intersected.checked, ['general', 'working', 'idle']);
          assert.match(intersected.feed, /Fixture idle/);
          assert.doesNotMatch(intersected.feed, /Fixture working/);
          assert.deepEqual(intersected.context, ['idle']);
        }
        if (await evalJs('document.querySelector("#review-panel").hidden')) {
          const point = await evalJs(`(() => { const r = document.querySelector('#review-panel-toggle').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
          assert.equal(await evalJs(`document.elementFromPoint(${point.x}, ${point.y})?.closest('#review-panel-toggle') !== null`), true, `${mode} ${width} ${view}: review toggle hit target`);
          await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
          await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
        }
        assert.equal(await evalJs('!document.querySelector("#review-panel").hidden && document.querySelector("#review-message").getBoundingClientRect().width > 0'), true, `${mode} ${width} ${view}: review pane opens`);
        console.log(`${mode} ${width} #${view}: ${state.route} ${reviewVersion.slice(0, 12)} controls/overflow/review PASS`);
      }
    }
  }
  console.log(`Frontend matrix PASS: ${widths.length * 3 * 2} rendered viewports, exact ${reviewVersion}`);
} finally {
  ws?.close(); chrome.kill("SIGKILL");
  await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
