// Exact-checkout phone and desktop acceptance for the UAT shell and review composer.
// Run after committing, from prototype/: node scripts/annotation-layout-browser-pass.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const chromium = process.env.CHROMIUM || "chromium";
const profile = await mkdtemp(path.join(process.cwd(), ".annotation-layout-chrome-"));
const app = createServer({ FM_DEPLOYMENT_TIER: "uat" });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const revision = (await (await fetch(`${base}/api/review`)).json()).version;
const chrome = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "Chromium CDP opened");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data);
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
  const evaluate = async (expression) => {
    const result = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cmd("Page.enable");
  const navigate = async (url) => {
    let onMessage, timer;
    const loaded = new Promise((resolve, reject) => {
      timer = setTimeout(() => { ws.removeEventListener("message", onMessage); reject(new Error(`Navigation timed out: ${url}`)); }, 10000);
      onMessage = ({ data }) => {
        if (JSON.parse(data).method !== "Page.loadEventFired") return;
        clearTimeout(timer);
        ws.removeEventListener("message", onMessage);
        resolve();
      };
      ws.addEventListener("message", onMessage);
    });
    const result = await cmd("Page.navigate", { url });
    if (!result.loaderId) { clearTimeout(timer); ws.removeEventListener("message", onMessage); return; } // Same-document hash navigation.
    await loaded;
  };
  for (const [width, height] of [[320, 720], [390, 844], [800, 800], [1280, 800]]) {
    if (width !== 320) await evaluate('sessionStorage.clear()');
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
    for (const view of ["quota", "overview"]) {
      await navigate(`${base}/?width=${width}#${view}`);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`Boolean(location.hash === "#${view}" && innerWidth === ${width} && document.querySelector("#${view}-view.active .feature-head h1") && document.querySelector(".uat-deployment-label") && [...document.styleSheets].some(s => s.href?.endsWith("/styles.css")))`)) break;
        await wait(100);
      }
      assert.ok(await evaluate(`Boolean(document.querySelector('#${view}-view'))`), JSON.stringify(await evaluate(`({ url: location.href, title: document.title, body: document.body?.textContent?.slice(0, 400) })`)));
      const feature = await evaluate(`(() => {
        const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; };
        const section = document.querySelector('#${view}-view'), header = section.querySelector('.feature-head');
        return { shell: box('.product-identity'), banner: box('.uat-deployment-label'), stage: box('.main-stage'), section: box('#${view}-view'), head: box('#${view}-view .feature-head'), eyebrow: box('#${view}-view .eyebrow'), title: box('#${view}-view h1'), padding: getComputedStyle(section).paddingTop, headMargin: getComputedStyle(header).marginTop, eyebrowMargin: getComputedStyle(header.querySelector('.eyebrow')).marginTop, scrollTop: section.scrollTop, label: document.querySelector('.uat-deployment-label').innerText };
      })()`);
      if (width < 720) console.log(`${width}x${height} #${view} layout: ${JSON.stringify(feature)}`);
      if (width < 720) {
        assert.ok(feature.banner.bottom - feature.banner.top === 0, `${view}: version moves into More instead of reserving an empty strip`);
        assert.match(feature.label, new RegExp(`UAT · local · ${revision.slice(0, 6)}[\\s\\S]*Full revision ${revision}`));
        assert.ok(Math.abs(feature.head.top - feature.shell.bottom) <= 24, `${view}: no empty space under the fixed shell at ${width}: ${JSON.stringify(feature)}`);
        assert.equal(await evaluate(`document.querySelector('#mobile-tools').contains(document.querySelector('.uat-deployment-label'))`), true);
      } else {
        assert.ok(feature.title.top - feature.stage.top >= (view === "quota" ? 40 : 65), `${view}: desktop feature spacing preserved: ${JSON.stringify(feature)}`);
        assert.equal(feature.banner.bottom - feature.banner.top, 0, 'desktop banner hidden; served version lives in sidebar');
        assert.equal(await evaluate(`(() => { const footer = document.querySelector('#desktop-review-footer'); return document.querySelector('#review-form').parentElement === footer && !footer.querySelector('.uat-deployment-label') && footer.querySelector('#review-panel-toggle') && document.querySelector('#review-message').getBoundingClientRect().height > 0; })()`), true, `one footer persists without redundant version on #${view}`);
      }
      console.log(`${width}x${height} ${revision} #${view}: ${width < 720 ? "banner" : "stage"} → title ${Math.round(feature.title.top - (width < 720 ? feature.banner.bottom : feature.stage.top))}px`);
    }
    await navigate(`${base}/?width=${width}#lanes`);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`Boolean(location.search === "?width=${width}" && innerWidth === ${width} && document.querySelector(".uat-deployment-label") && document.querySelector("#review-panel-toggle") && [...document.styleSheets].some(s => s.href?.endsWith("/styles.css")) && getComputedStyle(document.querySelector(".product-identity")).position === (innerWidth < 720 ? "fixed" : "static") && document.querySelector("#review-context").textContent.includes("Version"))`)) break;
      await wait(100);
    }
    const shell = await evaluate(`(() => {
      const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
      return { banner: box('.uat-deployment-label'), shell: box('.product-identity'), stage: box('.main-stage'), head: box('.conversation-head'), nav: box('.mobile-dock'), feed: box('#messages'), overflow: document.documentElement.scrollWidth > innerWidth, visible: getComputedStyle(document.querySelector('.conversation')).display !== 'none' };
    })()`);
    assert.equal(shell.overflow, false, `no horizontal overflow at ${width}`);
    assert.equal(shell.visible, true, `lane chat visible at ${width}`);
    if (width < 720) {
      assert.ok(shell.banner.bottom - shell.banner.top === 0, `version is in More at ${width}`);
      assert.ok(shell.feed.bottom <= shell.nav.top + 2, `messages clear of quick navigation at ${width}: ${JSON.stringify(shell)}`);
    } else assert.ok(shell.head.bottom - shell.head.top >= 88, "desktop header not compressed");
    const composer = await evaluate(`(() => {
      const footer = document.querySelector('#desktop-review-footer');
      const form = document.querySelector('#review-form');
      const toggle = document.querySelector('#review-toggle');
      const alt = document.querySelector('.alt-icon');
      const mouse = document.querySelector('.mouse-icon');
      const pick = document.querySelector('#review-pick');
      const rect = form.getBoundingClientRect();
      return { parent: form.parentElement.id, toggle: toggle.checked, footerVisible: getComputedStyle(footer).display !== 'none',
        formVisible: rect.width > 0 && rect.height > 0, footerOrder: [...footer.children].map(e => e.id),
        altOpacity: getComputedStyle(alt).opacity, mouseOpacity: getComputedStyle(mouse).opacity,
        pickVisible: getComputedStyle(pick).display !== 'none', penVisible: getComputedStyle(document.querySelector('.pen-icon')).display !== 'none' };
    })()`);
    assert.equal(composer.toggle, false, `click-to-interact default at ${width}`);
    if (width >= 721) {
      assert.equal(composer.parent, 'desktop-review-footer');
      assert.deepEqual(composer.footerOrder, ['review-form', 'review-panel-toggle']);
      assert.equal(composer.formVisible, true);
      assert.equal(composer.altOpacity, '1');
      assert.equal(composer.mouseOpacity, '1');
      assert.equal(composer.pickVisible, false);
      await evaluate(`document.querySelector('#review-toggle').click()`);
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.alt-icon')).opacity`), '0.35');
    } else {
      assert.equal(composer.parent, 'review-panel');
      assert.equal(await evaluate(`document.querySelector('#mobile-tools').contains(document.querySelector('#review-toggle'))`), true, 'annotation mode lives under More');
    }
    // The mode's label, visible Alt cue and actual click precedence must agree.
    const mode = await evaluate(`(() => {
      const target = document.querySelector('.conversation-kicker');
      const toggle = document.querySelector('#review-toggle');
      const panel = document.querySelector('#review-panel');
      const effect = (altKey) => {
        panel.hidden = true;
        const dialog = document.querySelector('#review-annotation');
        dialog.hidden = true;
        const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, button: 0, altKey });
        target.dispatchEvent(click);
        return (${width} < 721 ? !panel.hidden : panel.hidden && !dialog.hidden) && click.defaultPrevented;
      };
      toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const off = [effect(false), effect(true)];
      toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
      const on = [effect(false), effect(true)];
      return { off, on, label: toggle.getAttribute('aria-label'), cue: getComputedStyle(document.querySelector('.alt-icon')).opacity };
    })()`);
    assert.deepEqual(mode.off, [false, true], `off means ordinary click interacts and Alt annotates at ${width}`);
    assert.deepEqual(mode.on, [true, false], `on means ordinary click annotates and Alt interacts at ${width}`);
    assert.match(mode.label, /Annotation mode on: tap or click content to annotate/);
    if (width >= 721) assert.equal(mode.cue, '0.35', 'Alt annotation cue dims when Alt means interaction');
    await evaluate(`sessionStorage.removeItem('fm-agentos-review-draft-v1'); location.reload()`);
    for (let i = 0; i < 100; i++) {
      if (await evaluate(`Boolean(document.querySelector('#review-context')?.textContent.includes('Version') && document.querySelector('#review-panel-toggle'))`)) break;
      await wait(100);
    }
    await wait(300); // Module handlers must be attached after the reload, not just old DOM still present.
    await evaluate(`document.querySelector('#review-panel-toggle').click()`);
    const actions = await evaluate(`(() => {
      const box = (id) => { const e = document.querySelector(id), r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, name: e.textContent, type: e.type, disabled: e.disabled }; };
      return { row: box('.review-actions'), queue: box('#review-queue'), send: box('#review-send'), panel: box('#review-panel'), bodyWidth: document.documentElement.scrollWidth };
    })()`);
    assert.ok(actions.queue.top === actions.send.top, `one action row at ${width}: ${JSON.stringify(actions)}`);
    assert.ok(actions.queue.right <= actions.send.left && actions.send.right <= actions.row.right, `two non-overlapping columns at ${width}`);
    assert.equal(actions.queue.type, "submit");
    assert.equal(actions.send.type, "button");
    assert.equal(actions.send.disabled, true, JSON.stringify(actions));
    assert.match(actions.queue.name, /^Queue$/);
    assert.match(actions.send.name, /Send/);
    assert.ok(actions.queue.left >= (width < 721 ? actions.panel.left : 0) && actions.send.right <= (width < 721 ? actions.panel.right : width) && actions.bodyWidth <= width, `actions fit ${width < 721 ? 'panel' : 'footer'} at ${width}`);
    // Independent panel sizing on desktop; phone keeps its viewport-bounded pane and dock.
    if (width === 1280) {
      await wait(300); // Ensure the independent resize module has registered after navigation.
      const before = await evaluate(`(() => ({ quota: document.querySelector('#sidebar-quota').getBoundingClientRect().height, review: document.querySelector('#review-panel').getBoundingClientRect().width, handle: (() => { const r = document.querySelector('#review-resize').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })() }))()`);
      const { x, y } = before.handle;
      await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 80, y, button: 'left', buttons: 1 });
      await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x - 80, y, button: 'left', clickCount: 1 });
      const resized = await evaluate(`(() => ({ quota: document.querySelector('#sidebar-quota').getBoundingClientRect().height, review: document.querySelector('#review-panel').getBoundingClientRect().width, reviewStored: localStorage.getItem('fm-agentos-review-panel-width.v1') }))()`);
      assert.ok(resized.review > before.review + 50, `review pane drag changes width: ${JSON.stringify({ before, resized })}`);
      assert.ok(resized.reviewStored, 'review width persisted');
      assert.equal(resized.quota, before.quota, 'review resizing does not alter quota');
      const quotaEdge = await evaluate(`(() => { const r = document.querySelector('#quota-resize').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      await cmd('Input.dispatchMouseEvent', { type: 'mousePressed', x: quotaEdge.x, y: quotaEdge.y, button: 'left', clickCount: 1 });
      await cmd('Input.dispatchMouseEvent', { type: 'mouseMoved', x: quotaEdge.x, y: quotaEdge.y - 60, button: 'left', buttons: 1 });
      await cmd('Input.dispatchMouseEvent', { type: 'mouseReleased', x: quotaEdge.x, y: quotaEdge.y - 60, button: 'left', clickCount: 1 });
      assert.ok(await evaluate(`localStorage.getItem('fm-agentos-quota-panel-height.v1')`), 'quota drag persisted');
      const quotaAfter = await evaluate(`(() => ({ height: document.querySelector('#sidebar-quota').getBoundingClientRect().height, inline: document.querySelector('#sidebar-quota').style.getPropertyValue('--quota-height'), parent: document.querySelector('#sidebar-quota').parentElement.clientHeight, divider: document.querySelector('#quota-resize').getBoundingClientRect().toJSON() }))()`);
      assert.ok(quotaAfter.height > before.quota + 40, `quota divider drag resizes the outer panel: ${JSON.stringify({ before, quotaAfter })}`);
      await evaluate(`document.querySelector('#review-resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
      assert.equal(await evaluate(`localStorage.getItem('fm-agentos-review-panel-width.v1')`), null);
      assert.ok(await evaluate(`localStorage.getItem('fm-agentos-quota-panel-height.v1')`), 'review reset preserves quota size');
      await evaluate(`document.querySelector('#quota-resize').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))`);
      assert.equal(await evaluate(`localStorage.getItem('fm-agentos-quota-panel-height.v1')`), null);
    } else if (width < 721) {
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#review-resize')).display`), 'none');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('#quota-resize')).display`), 'none');
    }
    // Queue remains the form submit action; draft enables Send without changing identity.
    await evaluate(`(() => { const textarea = document.querySelector('#review-message'); textarea.value = 'Synthetic layout check'; textarea.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    assert.equal(await evaluate('document.querySelector("#review-send").disabled || document.querySelector("#review-send").disabled'), false);
    await evaluate('document.querySelector("#review-queue").click()');
    assert.match(await evaluate('document.querySelector("#review-thread").textContent'), /Queued batch/);
    console.log(`${width}x${height} ${revision}: banner ${shell.banner.bottom.toFixed(0)} → feed ${shell.stage.top.toFixed(0)}; three review actions in one row`);
    await evaluate(`(() => {
      document.querySelector('#review-close').click();
      const toggle = document.querySelector('#review-toggle');
      toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('.conversation-kicker').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1, button: 0, clientX: 100, clientY: 200 }));
    })()`);
    const annotation = await evaluate(`(() => {
      const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: r.height }; };
      return { paneHidden: document.querySelector('#review-panel').hidden, dialogHidden: document.querySelector('#review-annotation').hidden, formParent: document.querySelector('#review-form').parentElement.id, dialog: box('#review-annotation'), message: box('#review-message') };
    })()`);
    assert.equal(annotation.paneHidden, width >= 721, `annotation uses ${width < 721 ? 'the mobile review tab' : 'a separate desktop dialog'}`);
    assert.equal(annotation.dialogHidden, width < 721);
    assert.equal(annotation.formParent, width < 721 ? 'review-panel' : 'review-annotation');
    if (width >= 721) assert.ok(annotation.dialog.left >= 0 && annotation.dialog.right <= width && annotation.dialog.bottom <= height, `annotation bounded at ${width}: ${JSON.stringify(annotation)}`);
    const growth = await evaluate(`(() => {
      const box = (selector) => document.querySelector(selector).getBoundingClientRect().height;
      const before = { message: box('#review-message'), dialog: box('#review-annotation'), footer: box('#desktop-review-footer') };
      const message = document.querySelector('#review-message');
      message.value = Array(8).fill('A line of annotation').join('\\n');
      message.dispatchEvent(new Event('input', { bubbles: true }));
      return { before, after: { message: box('#review-message'), dialog: box('#review-annotation'), footer: box('#desktop-review-footer') } };
    })()`);
    assert.ok(growth.after.message > growth.before.message + 20, `annotation message grows with lines at ${width}: ${JSON.stringify(growth)}`);
    if (width < 721) assert.ok(growth.after.dialog <= height, `phone annotation tab stays bounded at ${width}`);
    await evaluate(`document.querySelector('#review-form-close').click()`);
    assert.equal(await evaluate(`document.querySelector('#review-panel').hidden && document.querySelector('#review-annotation').hidden`), true);
    if (width >= 721) {
      const footerGrowth = await evaluate(`(() => {
        const box = (selector) => document.querySelector(selector).getBoundingClientRect().height;
        const message = document.querySelector('#review-message');
        message.value = 'one'; message.dispatchEvent(new Event('input', { bubbles: true }));
        const before = { footer: box('#desktop-review-footer'), message: box('#review-message') };
        message.value = Array(8).fill('A footer line').join('\\n'); message.dispatchEvent(new Event('input', { bubbles: true }));
        return { before, after: { footer: box('#desktop-review-footer'), message: box('#review-message') } };
      })()`);
      assert.ok(footerGrowth.after.message > footerGrowth.before.message + 20, `footer message grows at ${width}: ${JSON.stringify(footerGrowth)}`);
      assert.equal(footerGrowth.after.footer, footerGrowth.before.footer, `only textarea grows, footer remains fixed at ${width}`);
    }
  }

  // Registered preview UAT check: launch with populated FM_PREVIEW_REGISTRY_PATH, verify compact bound, visible children, and stage offset.
  const registryFile = path.join(profile, "uat-preview-registry.json");
  await writeFile(registryFile, JSON.stringify([
    { id: "uat", commit: revision, name: "UAT", branch: "uat", remoteCheckpoint: null, validation: "accepted" },
    { id: "stg", commit: "98ab2602a5bd7d8b290ca98b8611e3e15f39c197", name: "Staging", branch: "stg", remoteCheckpoint: null, validation: "previewable" },
  ]));
  const previewApp = createServer({ FM_DEPLOYMENT_TIER: "uat", FM_PREVIEW_REGISTRY_PATH: registryFile });
  await new Promise((resolve) => previewApp.listen(0, "127.0.0.1", resolve));
  const previewBase = `http://127.0.0.1:${previewApp.address().port}`;
  try {
    for (const [width, height] of [[320, 720], [390, 844], [800, 800], [1280, 800]]) {
      await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 720 });
      await navigate(`${previewBase}/?width=${width}#overview`);
      for (let i = 0; i < 100; i++) {
        if (await evaluate(`Boolean(location.hash === "#overview" && innerWidth === ${width} && document.querySelector("#preview-details") && document.querySelector('#review-context')?.textContent.includes('Version') && [...document.styleSheets].some(s => s.href?.endsWith("/styles.css")))`)) break;
        await wait(100);
      }
      const previewLayout = await evaluate(`(() => {
        const box = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, height: r.height }; };
        const control = document.querySelector('.preview-control');
        const heading = document.querySelector('.preview-heading');
        const details = document.querySelector('#preview-details');
        const visibleChildren = [...control.children].filter((c) => getComputedStyle(c).display !== 'none');
        return {
          shell: box('.product-identity'),
          control: box('.preview-control'),
          heading: box('.preview-heading'),
          details: box('#preview-details'),
          stage: box('.main-stage'),
          head: box('#overview-view .feature-head'),
          stagePaddingTop: parseFloat(getComputedStyle(document.querySelector('.main-stage')).paddingTop),
          visibleChildCount: visibleChildren.length,
          detailsDisplay: getComputedStyle(details).display,
          detailsHidden: details.hidden,
        };
      })()`);
      assert.ok(previewLayout.visibleChildCount > 0, `preview-control must have visible children at ${width}`);
      if (width < 720) {
        assert.equal(await evaluate(`document.querySelector('#mobile-tools').contains(document.querySelector('.preview-control'))`), true, 'registered version is in More');
        assert.ok(Math.abs(previewLayout.head.top - previewLayout.shell.bottom) <= 24, `registered page begins directly below shell at ${width}`);
        assert.equal(previewLayout.detailsHidden, true, `details must be hidden when collapsed at ${width}`);
        await evaluate('document.querySelector(".mobile-more").click()');
        assert.ok(await evaluate('document.querySelector(".preview-control").getBoundingClientRect().height >= 44'), 'version is readable in More');
        await evaluate('document.querySelector("#preview-toggle").click()');
        const expanded = await evaluate(`(() => {
          const details = document.querySelector('#preview-details');
          return { display: getComputedStyle(details).display, hidden: details.hidden };
        })()`);
        assert.equal(expanded.hidden, false, `details must not be hidden when expanded at ${width}`);
        assert.equal(expanded.display, "grid", `details display must be grid when expanded at ${width}`);
        await evaluate('document.querySelector("#preview-toggle").click()');
        await evaluate('document.querySelector("#mobile-tools .mobile-sheet-close").click()');
      } else {
        assert.equal(previewLayout.detailsHidden, true, `desktop details hidden by default`);
        assert.equal(previewLayout.detailsDisplay, "none", `desktop details display none by default`);
      }
      // Exercise the actual registered host review UI, not only its shell geometry.
      // The previous viewport can restore an open Review panel from this tab's draft state.
      // An unconditional toggle would close it instead of testing the requested open state.
      if (await evaluate('document.querySelector("#review-panel").hidden')) await evaluate('document.querySelector("#review-panel-toggle").click()');
      for (let i = 0; i < 30 && !await evaluate(`!document.querySelector('#review-panel').hidden && (innerWidth >= 721 || document.querySelector('.mobile-review-sheet').open)`); i++) await wait(20);
      assert.equal(await evaluate('document.querySelector("#review-panel").hidden'), false, `Review is open at ${width}`);
      await evaluate('document.querySelector("#review-conversation-tab").click()');
      const review = await evaluate(`(() => {
        const panel = document.querySelector('#review-panel'), thread = document.querySelector('#review-thread');
        const form = document.querySelector('#review-form'), close = document.querySelector('#review-close');
        const actions = [...document.querySelectorAll('.review-actions button')];
        const rect = (node) => { const r = node.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; };
        return { panel: rect(panel), thread: rect(thread), form: rect(form), close: rect(close), actions: actions.map(rect), bodyOverflow: document.body.style.overflow,
          viewport: visualViewport?.height || innerHeight, horizontalOverflow: document.documentElement.scrollWidth > innerWidth };
      })()`);
      assert.equal(review.horizontalOverflow, false);
      assert.ok(review.panel.top >= -1 && review.panel.bottom <= height + 1, `review within ${width}x${height} viewport: ${JSON.stringify(review)}`);
      if (width < 720) {
        const density = await evaluate(`(() => { const dock = document.querySelector('.mobile-dock').getBoundingClientRect();
          const controls = [...document.querySelectorAll('.mobile-dock button')].map(n => {
            const r = n.getBoundingClientRect(); return { x: r.x, width: r.width, top: r.top, bottom: r.bottom, label: n.innerText }; });
          return { dock: { top: dock.top, bottom: dock.bottom }, controls,
            historyClosed: document.querySelector('#review-thread').hidden,
            overflow: document.documentElement.scrollWidth > innerWidth }; })()`);
        assert.equal(density.overflow, false);
        assert.ok(density.controls.every((c, i) => c.width >= 44 && c.top >= density.dock.top - 1 && c.bottom <= density.dock.bottom + 1 && (i === 0 || c.x > density.controls[i - 1].x)), `four accessible dock actions: ${JSON.stringify(density)}`);
        assert.ok(density.controls.every((c) => c.label.trim()), `dock controls carry visible labels: ${JSON.stringify(density)}`);
        assert.equal(density.historyClosed, true, 'Review tab, not message composer, exposes history');
      }
      assert.ok(review.close.bottom - review.close.top >= 44, `reachable close at ${width}: ${JSON.stringify(review)}; ${JSON.stringify(await evaluate(`({ sheetOpen: document.querySelector('.mobile-review-sheet').open, panelHidden: document.querySelector('#review-panel').hidden, active: document.activeElement?.id })`))}`);
      assert.ok(review.actions.every((r) => r.top === review.actions[0].top && r.left >= (width < 721 ? review.panel.left : 0) && r.right <= (width < 721 ? review.panel.right : width)), `three action columns fit at ${width}: ${JSON.stringify(review)}`);
      assert.ok(review.actions[2].bottom <= (width < 721 ? review.panel.bottom + 1 : height), `end reachable at ${width}`);
      if (width < 720) {
        assert.ok(review.panel.bottom - review.panel.top <= height * .62 && review.panel.top >= height * .28, `phone conversation is a compact sheet at ${width}: ${JSON.stringify(review.panel)}`);
        assert.equal(review.bodyOverflow, 'hidden');
        const history = await evaluate(`(() => { document.querySelector('#review-history-tab').click(); const t = document.querySelector('#review-thread');
          for (let i = 0; i < 40; i++) { const item = document.createElement('article'); item.textContent = 'Synthetic history entry ' + i; t.append(item); }
          t.scrollTop = t.scrollHeight; return { client: t.clientHeight, content: t.scrollHeight, scrolled: t.scrollTop,
            actionBottom: document.querySelector('#review-send').getBoundingClientRect().bottom }; })()`);
        assert.ok(history.content > history.client && history.scrolled > 0 && history.actionBottom <= review.panel.bottom + 1, `history scroll does not displace actions at ${width}: ${JSON.stringify(history)}`);
        await evaluate('document.querySelector("#review-conversation-tab").click()');
        const anchored = await evaluate(`(() => { const form = document.querySelector('#review-form'); form.classList.add('review-form-anchored');
          form.style.left = '200px'; form.style.top = '400px'; return { position: getComputedStyle(form).position,
            left: form.getBoundingClientRect().left, right: form.getBoundingClientRect().right }; })()`);
        assert.ok(anchored.position === 'static' && anchored.left >= review.panel.left && anchored.right <= review.panel.right, `annotation composer stays in pane at ${width}`);
        // Model the keyboard visual-viewport shrink via the same CSS variables used by the listener.
        const keyboard = await evaluate(`(() => { const root = document.documentElement.style;
          root.setProperty('--review-vv-height', '420px'); root.setProperty('--review-vv-top', '20px'); root.setProperty('--review-nav-space', '0px');
          const r = document.querySelector('#review-panel').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
        assert.ok(keyboard.top >= 19 && keyboard.bottom <= 441, `keyboard-sized review remains in visual viewport at ${width}: ${JSON.stringify(keyboard)}`);
        const composerReach = await evaluate(`(() => { const form = document.querySelector('#review-form'); form.scrollTop = form.scrollHeight;
          return document.querySelector('#review-send').getBoundingClientRect().bottom; })()`);
        assert.ok(composerReach <= keyboard.bottom + 1, `Send reachable with keyboard at ${width}: ${composerReach}`);
        await evaluate(`window.dispatchEvent(new Event('resize'))`);
        await evaluate(`(() => { const t = document.querySelector('#review-message'); t.value = 'Draft held on close'; t.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('#review-close').click(); })()`);
        await wait(60); // Native dialog restores focus after its close mutation is processed.
        const closed = await evaluate(`(() => ({ overflow: document.body.style.overflow, focus: document.activeElement?.id || document.activeElement?.tagName, draft: document.querySelector('#review-message').value, sheetOpen: document.querySelector('.mobile-review-sheet').open, panelHidden: document.querySelector('#review-panel').hidden, toggleParent: document.querySelector('#review-panel-toggle').parentElement?.className }))()`);
        assert.deepEqual(closed, { overflow: '', focus: 'review-panel-toggle', draft: 'Draft held on close', sheetOpen: false, panelHidden: true, toggleParent: 'mobile-dock' }, `registered phone close preserves draft and restores focus: ${JSON.stringify(closed)}`);
      } else {
        await evaluate(`(() => { document.querySelector('#review-message').focus(); document.querySelector('#review-message').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); })()`);
        assert.equal(await evaluate(`document.querySelector('#review-panel').hidden && document.activeElement?.id === 'review-panel-toggle'`), true);
      }

      // Test compact annotation dialog and Escape cancellation
      await evaluate(`(() => {
        const region = document.querySelector('.project-card .lane-intent');
        if (region) {
            region.scrollIntoView({ block: 'center' });
            const target = region.getBoundingClientRect();
            region.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, detail: 1, clientX: target.left + target.width / 2, clientY: target.top + target.height / 2, altKey: true }));
        }
      })()`);
      
      const annotationLayout = await evaluate(`(() => {
        const dialog = document.querySelector('#review-annotation');
        const header = document.querySelector('#review-annotation .review-form-header');
        return {
          hidden: dialog ? dialog.hidden : true,
          flex: header ? getComputedStyle(header).display : null,
          close: document.querySelector('#review-annotation #review-form-close')?.getBoundingClientRect().width > 0
        };
      })()`);
      if (annotationLayout.hidden === false) {
          assert.equal(annotationLayout.flex, "flex", "Header and close button should be in one row (flex)");
          assert.equal(annotationLayout.close, true, "Close button should be present and visible");
          
          await evaluate(`(() => {
            const msg = document.querySelector('#review-annotation #review-message');
            if (msg) {
              msg.focus();
              msg.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            }
          })()`);
          
          assert.equal(await evaluate(`document.querySelector('#review-annotation').hidden`), true, "Escape key should close the annotation dialog");
          console.log(`${width}x${height} verified annotation dialog compactness and Escape cancellation`);
      }

      console.log(`${width}x${height} registered UAT preview: control ${previewLayout.control.bottom.toFixed(0)} (${previewLayout.control.height.toFixed(0)}px) → stage ${previewLayout.stage.top.toFixed(0)}; review close/composer/history bounded`);

    }
  } finally {
    await cmd("Page.navigate", { url: "about:blank" }).catch(() => {});
    previewApp.closeAllConnections?.();
    await previewApp.shutdownPreviews?.();
    await new Promise((resolve) => previewApp.close(resolve));
  }
} finally {
  ws?.close();
  chrome.kill();
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => { import("node:child_process").then(cp => cp.exec(`rm -rf ${profile}`, resolve)); }); try { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {}); } catch (e) {}
}
