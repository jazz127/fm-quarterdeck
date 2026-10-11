// Exact-head mobile controls acceptance. Set CHROMIUM to an installed Chromium executable.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const chromium = process.env.CHROMIUM || "chromium";
const profile = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-mobile-chrome-"));
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const app = createServer({ FM_DEPLOYMENT_TIER: "uat" });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
assert.equal((await (await fetch(`${base}/api/review`)).json()).version, head, "serving exact integrated head");

const chrome = spawn(chromium, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws; const browserErrors = [];
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null && chrome.exitCode !== 0) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "Chromium CDP opened");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
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
  await cmd("Page.enable"); await cmd("Runtime.enable"); ws.addEventListener("message", ({data}) => { const m=JSON.parse(data); if(m.method === "Runtime.exceptionThrown") browserErrors.push(m.params); });
  await wait(500);
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
    await loaded.catch(async (error) => { console.log(await evaluate("({url:location.href,body:document.body?.innerText.slice(0,1000)})")); throw error; });
  };
  for (const [width, height] of [[320, 720], [390, 844], [720, 900], [1280, 800]]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width <= 720 });
    await navigate(`${base}/?width=${width}#overview`);
    for (let i=0; i<50; i++) { if(await evaluate('Boolean(document.querySelector(".mobile-dock"))')) break; await wait(100); }
    const mobile = width <= 720;
    await cmd("Emulation.setTouchEmulationEnabled", {enabled:mobile});
    if (!await evaluate('Boolean(document.querySelector(".mobile-dock"))')) console.log(await evaluate('document.body.innerText.slice(0, 1000)')); assert.equal(await evaluate('Boolean(document.querySelector(".mobile-dock"))'), true, 'shell initialized');
    if (mobile) {
      const chat = '.mobile-dock [data-mobile-view="conversations"]';
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).click()`);
      assert.equal(await evaluate('document.querySelector(".workspace").dataset.view'), 'conversations', 'first Chats tap navigates');
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), false, 'first tap never opens options');
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).click()`);
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), true, 'second tap opens options');
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").contains(document.activeElement)'), true, 'options receive focus');
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").contains(document.querySelector(".feed-pagination"))'), true, 'pagination belongs to Chats');
      assert.equal(await evaluate('document.querySelector("#mobile-tools").contains(document.querySelector(".feed-pagination"))'), false, 'More does not own chat actions');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#mobile-tools .lane-chats-row")).display'), 'none', 'More does not duplicate Chats navigation');
      await cmd('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
      await wait(50);
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), false, 'Escape dismisses options');
      await wait(50);
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).focus()`);
      await cmd('Input.dispatchKeyEvent', {type:'keyDown', key:' ', code:'Space', windowsVirtualKeyCode:32});
      await cmd('Input.dispatchKeyEvent', {type:'keyUp', key:' ', code:'Space', windowsVirtualKeyCode:32});
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), true, `keyboard activates options: ${JSON.stringify(await evaluate('({focused:document.activeElement?.outerHTML, view:document.querySelector(".workspace").dataset.view, hash:location.hash})'))}`);
      await evaluate('document.querySelector("#mobile-chat-options .mobile-sheet-close").click()');
      await wait(30);
      assert.equal(await evaluate('document.activeElement?.dataset.mobileView'), 'conversations', 'close restores Chats focus');
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).click()`);
      await evaluate('document.querySelector("#mobile-chat-options").dispatchEvent(new MouseEvent("click", {bubbles:true}))');
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), false, 'outside click dismisses options');
      await evaluate('location.hash="#quota"');
      await wait(50);
      assert.equal(await evaluate('document.querySelector(".workspace").dataset.view'), 'quota', 'route transition leaves Chats');
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).click()`);
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), false, 'route return navigates first');
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).click()`);
      await evaluate('location.hash="#overview"');
      await wait(50);
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), false, 'leaving Chats dismisses options');
      await evaluate(`document.querySelector(${JSON.stringify(chat)}).click()`);
      assert.equal(await evaluate('document.querySelector("#mobile-chat-options").open'), false, 'no stale open state');
      await evaluate('document.querySelector(".mobile-dock [data-mobile-view=overview]").click()');
      const metrics = await evaluate(`(() => {
        const dock = document.querySelector('.mobile-dock').getBoundingClientRect();
        const header = document.querySelector('.product-identity').getBoundingClientRect();
        return { width: innerWidth, scroll: document.documentElement.scrollWidth, dock: dock.height, header: header.height,
          controls: [...document.querySelectorAll('.mobile-dock button')].map(b => ({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })) };
      })()`);
      assert.equal(metrics.scroll, width, 'no horizontal page overflow');
      assert.ok(metrics.dock < 80 && metrics.header <= 60, 'compact chrome');
      assert.ok(metrics.controls.every(b => b.w >= 44 && b.h >= 44), 'dock touch targets');
      if (width === 390) {
        const badge = await evaluate(`(() => { const b=document.querySelector('.mobile-dock #review-awaiting'), r=b.getBoundingClientRect(), icon=document.querySelector('.mobile-dock .message-icon').getBoundingClientRect(); return {hidden:b.hidden, left:r.left, bottom:r.bottom, iconRight:icon.right, iconTop:icon.top}; })()`);
        if (!badge.hidden) assert.ok(badge.left >= badge.iconRight || badge.bottom <= badge.iconTop, `receipt badge does not cover message icon: ${JSON.stringify(badge)}`);
      }
      if (width === 390) await writeFile(path.join(os.tmpdir(), 'quarterdeck-mobile-home.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'));
      await evaluate('document.querySelector(".mobile-more").click()');
      assert.equal(await evaluate('document.querySelector("#mobile-tools").open'), true);
      assert.equal(await evaluate('document.querySelector("#mobile-tools").contains(document.activeElement)'), true, 'focus enters tools');
      assert.equal(await evaluate('document.querySelector("#mobile-tools").scrollWidth <= innerWidth'), true);
      assert.equal(await evaluate(`(() => { const input = document.querySelector('#review-toggle'), r = input.getBoundingClientRect(), row = input.closest('.review-gesture').getBoundingClientRect(); return getComputedStyle(input).opacity === '1' && r.width >= 22 && r.height >= 22 && r.top >= row.top && r.bottom <= row.bottom && row.right <= innerWidth; })()`), true, 'annotation checkbox is visible and reachable in More');
      if (width === 390) await writeFile(path.join(os.tmpdir(), 'quarterdeck-mobile-tools.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'));
      await evaluate('document.querySelector(".primary-tab[data-view=quota]").click()');
      assert.equal(await evaluate('document.querySelector("#mobile-tools").open'), false, 'navigation dismisses tools');
      assert.equal(await evaluate('document.querySelector(".workspace").dataset.view'), 'quota');
      const icon = await evaluate(`(() => { const b=document.querySelector('.mobile-dock #review-panel-toggle'); return { name:b.getAttribute('aria-label'), text:b.innerText, mail:getComputedStyle(b.querySelector('.mail-icon')).display, bubble:getComputedStyle(b.querySelector('.message-icon')).display, path:b.querySelector('.message-icon path').getAttribute('d'), expanded:b.getAttribute('aria-expanded') }; })()`);
      assert.ok(icon.name.startsWith('Messages,') && !icon.text.includes('Review') && icon.mail === 'none' && icon.bubble !== 'none' && icon.path.includes('A8') && icon.expanded === 'false', `message-only dock icon at ${width}: ${JSON.stringify(icon)}`);
      await evaluate('document.querySelector("#review-panel-toggle").click()');
      await wait(120);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), true);
      assert.equal(await evaluate('document.querySelector("#review-panel-toggle").getAttribute("aria-expanded")'), 'true');
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").matches(":modal")'), false, 'Message is nonmodal');
      assert.equal(await evaluate('document.body.style.overflow'), '', 'Message does not lock page');
      await evaluate('document.querySelector("#review-history-tab").click()');
      await wait(40);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").matches(":modal")'), true, 'Review is modal');
      assert.equal(await evaluate('document.body.style.overflow'), 'hidden', 'Review locks page');
      await evaluate('document.querySelector("#review-conversation-tab").click()');
      await wait(40);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").matches(":modal")'), false, 'Message restores interaction');
      assert.equal(await evaluate('document.body.style.overflow'), '', 'Message restores overflow');
      assert.ok(await evaluate('document.querySelector(".mobile-review-sheet").getBoundingClientRect().height < innerHeight * .62'), 'empty composer is compact');
      assert.ok(await evaluate('Math.abs(document.querySelector("#review-queue").getBoundingClientRect().top - document.querySelector("#review-send").getBoundingClientRect().top) < 2'), 'three actions share one row');
      await evaluate('document.querySelector("#review-message").value="Draft survives dismissal"; document.querySelector("#review-message").dispatchEvent(new Event("input", {bubbles:true}))');
      const fit = await evaluate(`(() => { const r = document.querySelector('#review-send').getBoundingClientRect(); return r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })()`);
      assert.ok(fit, 'all composer actions fit');
      if (width === 390) await writeFile(path.join(os.tmpdir(), 'quarterdeck-mobile-review.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'));
      await cmd('Input.dispatchKeyEvent', {type:'keyDown', key:'Escape', code:'Escape', windowsVirtualKeyCode:27});
      await wait(80);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), false, 'Escape dismisses review');
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal');
      assert.equal(await evaluate('document.activeElement.id'), 'review-panel-toggle', 'dialog close restores focus to message action');
      await evaluate('document.querySelector("#review-panel-toggle").click()');
      await wait(80);
      // Simulate reduced visible height while the keyboard is raised.
      await evaluate('document.documentElement.style.setProperty("--review-vv-height", "420px")');
      assert.ok(await evaluate('document.querySelector("#review-send").getBoundingClientRect().bottom <= 420'), 'keyboard height keeps actions visible');
      await evaluate('document.querySelector("#review-close").click()');
      await evaluate('document.querySelector(".mobile-dock [data-mobile-view=overview]").click()');
      await evaluate('document.querySelector("#review-panel-toggle").click()');
      for (let i = 0; i < 30 && !await evaluate('document.querySelector(".mobile-review-sheet").open'); i++) await wait(20);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), true, 'Review is visible before choosing a page location');
      assert.equal(await evaluate(`(() => { const ids=[...document.querySelectorAll('.review-panel header button')].filter(b=>getComputedStyle(b).display!=='none').map(b=>b.id); return ids.join(','); })()`), 'review-conversation-tab,review-history-tab,review-select-location,review-close', 'mobile header groups Message and Review left, annotation and terminal action right');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#review-annotation-tab")).display'), 'none', 'old Annotation tab is absent on phone');
      assert.equal(await evaluate('document.querySelectorAll("#review-select-location").length'), 1);
      assert.equal(await evaluate(`(() => { const left=document.querySelector('.review-tabs').getBoundingClientRect(), right=document.querySelector('.review-header-actions').getBoundingClientRect(); return left.right <= right.left && right.right <= innerWidth; })()`), true, 'left and right header groups stay separate');
      await evaluate('document.querySelector("#review-history-tab").click()');
      await cmd('Input.dispatchKeyEvent', {type:'keyDown', key:'Tab', code:'Tab', windowsVirtualKeyCode:9});
      await evaluate('document.querySelector("#review-select-location").click()');
      assert.equal(await evaluate('document.querySelector("#review-select-location").getAttribute("aria-pressed")'), 'true', 'selector enters annotation from Review');
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Annotate');
      await evaluate('document.querySelector("#review-select-location").click()');
      assert.equal(await evaluate('document.querySelector("#review-close").textContent'), 'Cancel annotation');
      assert.equal(await evaluate('document.querySelector("#review-close").getAttribute("aria-label")'), 'Cancel annotation (keep draft)');
      await evaluate('document.querySelector("#review-close").click()');
      assert.equal(await evaluate('document.querySelector("#review-close").textContent'), 'Close ×', 'armed cancel returns to Close');
      assert.equal(await evaluate('document.querySelector("#review-close").getAttribute("aria-label")'), 'Close review conversation (keep draft)');
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), true, 'armed cancel keeps composer open');
      await evaluate('document.querySelector("#review-select-location").click()');
      await wait(50);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), true, 'composer stays open while selecting');
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").matches(":modal")'), false, 'page remains scrollable');
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Select on page');
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal');
      assert.equal(await evaluate('document.body.style.overflow'), '', 'page scroll lock released');
      await evaluate('document.querySelector("#review-select-location").click()');
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Annotate', 'armed action toggles off');
      await evaluate('document.querySelector("#review-select-location").click()');
      await evaluate(`(() => { const heading = document.querySelector('#overview-view .feature-head h1');
        heading.dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, pointerType:'touch', clientX:20, clientY:200 }));
        heading.dispatchEvent(new PointerEvent('pointermove', { bubbles:true, pointerType:'touch', clientX:20, clientY:280 }));
        heading.dispatchEvent(new MouseEvent('click', { bubbles:true, cancelable:true, detail:1 })); })()`);
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Select on page', 'drag does not attach a target');
      await evaluate(`document.querySelector('#overview-view').dispatchEvent(new Event('scroll', {bubbles:true}))`);
      await evaluate('document.querySelector("#overview-view .feature-head h1").dispatchEvent(new MouseEvent("click", {bubbles:true,cancelable:true,detail:1}))');
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Select on page', 'momentum scroll does not attach a target');
      await wait(500);
      await evaluate('document.querySelector("#overview-view .feature-head h1").dispatchEvent(new MouseEvent("click", {bubbles:true,cancelable:true,detail:1}))');
      await wait(80);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), true, 'annotation returns to the same pane');
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal', 'original message survives attachment');
      assert.ok(await evaluate('document.querySelector("#review-target").textContent.startsWith("Annotating")'));
      assert.equal(await evaluate('document.querySelector("#review-select-location").getAttribute("aria-pressed")'), 'true');
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Selection ready ✓');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#review-clear-location")).display'), 'none');
      assert.equal(await evaluate(`(() => { const selector=document.querySelector('#review-select-location').getBoundingClientRect();
        const close=document.querySelector('#review-close').getBoundingClientRect();
        return selector.width >= 44 && selector.left >= 0 && selector.right <= close.left && close.right <= innerWidth; })()`), true, 'selector and Cancel annotation fit together');
      await evaluate('document.querySelector("#review-close").click()');
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Annotate', 'cancel clears the target');
      assert.equal(await evaluate('document.querySelector("#review-close").textContent'), 'Close ×');
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), true);
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal');
      assert.equal(await evaluate('document.querySelector("#review-clear-location").hidden'), true);
      await evaluate('location.hash = "#quota"');
      await wait(80);
      assert.equal(await evaluate('document.querySelector("#review-select-location").textContent'), 'Annotate', 'route change disarms selection');
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal');
      await evaluate('location.hash = "#overview"');
      await wait(80);
      await evaluate('document.querySelector("#review-select-location").click()');
      await evaluate('document.querySelector("#overview-view .feature-head h1").dispatchEvent(new MouseEvent("click", {bubbles:true,detail:1}))');
      await evaluate('document.querySelector("#review-history-tab").click()');
      assert.equal(await evaluate('document.querySelector("#review-thread").hidden'), false, 'Review exposes queue and batch history');
      assert.equal(await evaluate('getComputedStyle(document.querySelector("#review-message")).display'), 'none', 'Review hides the compose field');
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal');
      assert.ok(await evaluate('document.querySelector("#review-target").textContent.startsWith("Annotating")'), 'Review preserves the attachment');
      assert.ok(await evaluate('document.querySelector("#review-close").getBoundingClientRect().top === document.querySelector("#review-history-tab").getBoundingClientRect().top'), 'three tabs and Close fit one row');
      await evaluate('document.querySelector("#review-select-location").click()');
      assert.equal(await evaluate('document.querySelector("#review-thread").hidden'), true);
      assert.equal(await evaluate('document.querySelector(".review-pick-notice").hidden'), true, 'selection is one-shot');
      await evaluate('document.querySelector("#review-queue").click()');
      const queued = await evaluate('JSON.parse(sessionStorage.getItem("fm-agentos-review-draft-v1")).queue.at(-1)');
      assert.notEqual(queued.tag, 'message');
      assert.equal(queued.prompt, 'Draft survives dismissal');
      assert.ok(queued.region?.id, 'queued draft carries the selected page target');
      await evaluate('document.querySelector("#review-history-tab").click()');
      await evaluate('[...document.querySelectorAll("#review-thread .review-batch")].find(batch => batch.querySelector("summary").textContent.startsWith("Queued batch")).open = true');
      assert.ok(await evaluate('document.querySelector("#review-thread").innerText.includes("Draft survives dismissal")'), 'queued message is readable in Review');
      assert.equal(await evaluate('document.querySelector("#review-thread article .review-note-header button").textContent'), 'Remove', 'Remove is in the note header');
      await evaluate('document.querySelector("#review-conversation-tab").click(); document.querySelector("#review-message").value="A long note to check expansion. ".repeat(8); document.querySelector("#review-queue").click(); document.querySelector("#review-history-tab").click()');
      await evaluate('[...document.querySelectorAll("#review-thread .review-batch")].find(batch => batch.querySelector("summary").textContent.startsWith("Queued batch")).open = true');
      assert.equal(await evaluate('document.querySelector("#review-thread article:last-child .review-note-header").querySelectorAll("button").length'), 2, 'Expand and Remove share the header');
      await evaluate('document.querySelector("#review-thread article:last-child .review-note-toggle").click()');
      assert.equal(await evaluate('document.querySelector("#review-thread article:last-child details").open'), true);
      const beforeRemove = await evaluate('JSON.parse(sessionStorage.getItem("fm-agentos-review-draft-v1")).queue.length');
      await evaluate('document.querySelector("#review-thread article:last-child .review-note-header button:last-child").click()');
      assert.equal(await evaluate('JSON.parse(sessionStorage.getItem("fm-agentos-review-draft-v1")).queue.length'), beforeRemove - 1, 'Remove deletes only the chosen note');
      if (width === 390) await writeFile(path.join(os.tmpdir(), 'quarterdeck-mobile-review-history.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'));
      if (width === 390) {
        // Intercept delivery in this synthetic browser; no notes leave the test.
        await evaluate(`window.testOriginalFetch = window.fetch;
          window.fetch = async (url, options) => {
            if (url === '/api/review' && options?.method === 'POST') {
              window.testReviewPayload = JSON.parse(options.body);
              return new Response(JSON.stringify({receiptId:'fixture-receipt',delivery:'local'}), {status:200,headers:{'content-type':'application/json'}});
            }
            return window.testOriginalFetch(url, options);
          };
          document.querySelector('#review-message').value = 'Hidden unsent draft';
          document.querySelector('#review-send').click();`);
        await wait(100);
        const sent = await evaluate('window.testReviewPayload');
        assert.ok(sent.entries.length > 0);
        assert.ok(sent.entries.every(entry => entry.prompt !== 'Hidden unsent draft'), 'Review sends only queued notes');
        assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Hidden unsent draft', 'batch sending preserves hidden draft');
        await evaluate('window.fetch = window.testOriginalFetch');
      }
      await evaluate('document.querySelector("#review-message").value="Draft survives dismissal"');
      await evaluate('document.querySelector("#review-conversation-tab").click()');
      assert.equal(await evaluate('document.querySelector("#review-target").textContent'), 'Message to review conversation');
      assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Draft survives dismissal');
      await evaluate('document.querySelector("#review-close").click()');
      await wait(50);
      assert.equal(await evaluate('document.querySelector(".mobile-review-sheet").open'), false);
      assert.equal(await evaluate('document.activeElement.id'), 'review-panel-toggle', 'Close restores focus after native dialog teardown');
      await evaluate('document.querySelector(".mobile-dock [data-mobile-view=conversations]").click()');
      assert.equal(await evaluate('document.querySelector("#conversation-filter-shortcut").closest(".product-identity") !== null'), true, 'lane chooser shares the shell header');
      assert.ok(await evaluate('document.querySelector(".feed-actions").getBoundingClientRect().bottom <= 120'), 'chat chrome leaves room for records');
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".conversation-head")).display'), 'none', 'no duplicate chat heading');
      if (width === 390) await writeFile(path.join(os.tmpdir(), 'quarterdeck-mobile-chats.png'), Buffer.from((await cmd('Page.captureScreenshot')).data, 'base64'));
      await evaluate('document.querySelector("#conversation-filter-shortcut").click()');
      assert.equal(await evaluate('document.querySelector("#lane-options").hidden'), false);
      assert.equal(await evaluate('document.activeElement.id'), 'mobile-lanes-tab', 'focus enters the combined UAT filter drawer');
      await evaluate('document.querySelector("#mobile-kinds-tab").click()');
      assert.equal(await evaluate('document.querySelector("#kind-filter-menu").hidden'), false, 'message kinds remain reachable');
      await evaluate('document.querySelector("#mobile-lanes-tab").click()');
      await evaluate('document.querySelector("#lane-filter-close").click()');
      assert.equal(await evaluate('document.activeElement.id'), 'conversation-filter-shortcut', 'lane chooser regains focus');
      await evaluate('document.querySelector(".mobile-more").click()');
      await evaluate('document.querySelector("#transcript-details").open = true');
      await wait(50);
      assert.ok(await evaluate('document.querySelector(".transcript-coverage-popover").getBoundingClientRect().right <= innerWidth'), 'sources sheet fits');
      await evaluate('document.querySelector("#transcript-details .mobile-popover-close").click()');
      assert.equal(await evaluate('document.querySelector("#transcript-details").open'), false);
      await evaluate('document.querySelector("#mobile-tools .mobile-sheet-close").click()');
    } else {
      assert.equal(await evaluate('getComputedStyle(document.querySelector(".mobile-dock")).display'), 'none');
      assert.equal(await evaluate('document.querySelector(".primary-nav").closest(".lane-list") !== null'), true);
      assert.equal(await evaluate('document.querySelector("#review-form").parentElement.id'), 'desktop-review-footer');
    }
    console.log(`Mobile controls passed at ${width}×${height}`);
  }
  // Resize the same document, preserving the one composer and its draft.
  await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await wait(120);
  assert.equal(await evaluate('document.querySelectorAll("#review-form").length'), 1);
  assert.equal(await evaluate('document.querySelector(".primary-nav").closest("#mobile-tools") !== null'), true);
  await evaluate('document.querySelector("#review-message").value="Resize draft"');
  await cmd("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  await wait(120);
  assert.equal(await evaluate('document.querySelector("#review-form").parentElement.id'), 'desktop-review-footer');
  assert.equal(await evaluate('document.querySelector(".feed-pagination").closest(".feed-actions") !== null'), true, 'desktop paging restored');
  assert.equal(await evaluate('document.querySelector("#conversation-filter-shortcut").closest(".conversation-head") !== null'), true, 'desktop heading restored');
  assert.equal(await evaluate('document.querySelector("#review-message").value'), 'Resize draft');
  assert.deepEqual(browserErrors, [], 'no browser runtime exceptions');
  console.log('Screenshots: ' + os.tmpdir());
} catch (error) { console.error(error); process.exitCode = 1; } finally {
  if (ws?.readyState === 1) { ws.send(JSON.stringify({id: 999999, method: "Browser.close"})); await wait(500); } ws?.close(); chrome.kill(); app.closeAllConnections?.(); await new Promise(resolve => app.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => console.log("Browser profile retained: " + profile));
}
