// Exact-head phone options / unchanged desktop acceptance; isolated listener and Chrome profile.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const profile = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-phone-options-"));
const app = createServer({ FM_DEPLOYMENT_TIER: "uat" });
await new Promise(resolve => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const revision = (await (await fetch(`${base}/api/review`)).json()).version;
assert.equal(revision, head, "isolated listener serves exact clean head");
const chrome = spawn(process.env.CHROMIUM || "chromium", [
  "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank",
], { stdio: "ignore" });
let ws;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chrome exited ${chrome.exitCode}`); await sleep(100); }
  }
  assert.ok(port, "isolated Chrome started");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages.find(page => page.type === "page").webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id;
    pending.set(next, { resolve, reject });
    ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evalPage = async expression => {
    const reply = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };
  await cmd("Page.enable");
  await cmd("Runtime.enable");
  for (const width of [375, 1280]) {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 1, mobile: width <= 720 });
    await cmd("Page.navigate", { url: `${base}/?width=${width}#overview` });
    for (let i = 0; i < 100; i++) {
      if (await evalPage('!!document.querySelector(".mobile-dock") && document.readyState === "complete"')) break;
      await sleep(100);
    }
    for (let i = 0; i < 100; i++) {
      if (await evalPage(width <= 720 ? `document.querySelector('#mobile-chat-options')?.contains(document.querySelector('#context-toggle')) && document.querySelector('#mobile-chat-options')?.contains(document.querySelector('#transcript-older'))` : `document.querySelector('#lane-panel-toggle')?.getAttribute('aria-expanded') === 'true'`)) break;
      await sleep(100);
    }
    await evalPage(width <= 720 ? `document.querySelector('.mobile-dock [data-mobile-view="conversations"]').click()` : `document.querySelector('.primary-tab[data-view="conversations"]').click()`);
    for (let i = 0; i < 50; i++) {
      if (await evalPage('document.querySelector(".workspace")?.dataset.view === "conversations"')) break;
      await sleep(100);
    }
    for (let i = 0; i < 100; i++) {
      if (await evalPage(width <= 720 ? `document.querySelector('#phone-chat-options')?.parentElement === document.querySelector('.product-identity > div')` : `document.querySelector('#phone-chat-options')?.parentElement?.classList.contains('conversation-head')`)) break;
      await sleep(100);
    }
    const state = await evalPage(`(() => { const b=document.querySelector('#phone-chat-options'), r=b.getBoundingClientRect(), title=document.querySelector('#conversation-filter-shortcut').getBoundingClientRect(), header=document.querySelector('.product-identity').getBoundingClientRect(); return {width:innerWidth,view:document.querySelector('.workspace').dataset.view,display:getComputedStyle(b).display,box:[r.x,r.y,r.width,r.height],title:[title.x,title.y,title.width,title.height],header:[header.y,header.height],parent:b.parentElement?.className,conversationHead:getComputedStyle(document.querySelector('.conversation-head')).display,label:b.getAttribute('aria-label'),expanded:b.getAttribute('aria-expanded'),overflow:document.documentElement.scrollWidth>innerWidth}; })()`);
    assert.equal(state.width, width);
    assert.equal(state.view, "conversations");
    assert.equal(state.overflow, false, `no overflow at ${width}: ${JSON.stringify(state)}`);
    if (width === 375) {
      assert.ok(["flex", "inline-flex"].includes(state.display), "Options is exposed without tapping header");
      assert.ok(state.box[2] >= 44 && state.box[3] >= 44 && state.box[0] >= 0 && state.box[0] + state.box[2] <= width, `Options is visible and reachable: ${JSON.stringify(state)}`);
      assert.equal(state.label, "Open Lane Chat options");
      assert.equal(state.parent, "", "Options shares the actual page title container");
      assert.equal(state.conversationHead, "none", "no second header row without a task chip or search");
      assert.ok(state.box[1] >= state.header[0] && state.box[1] + state.box[3] <= state.header[0] + state.header[1] && Math.abs(state.box[1] - state.title[1]) < 8, `title and Options occupy one header row: ${JSON.stringify(state)}`);
      await evalPage(`document.querySelector('#phone-chat-options').click()`);
      assert.equal(await evalPage(`document.querySelector('#mobile-chat-options').open`), true, "button opens existing dialog");
      await evalPage(`document.querySelector('#mobile-chat-options .mobile-sheet-close').click()`);
      await evalPage(`document.querySelector('#phone-chat-options').focus()`);
      await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
      await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
      assert.equal(await evalPage(`document.querySelector('#mobile-chat-options').open`), true, `keyboard opens existing dialog: ${JSON.stringify(await evalPage(`({focused:document.activeElement?.id,view:document.querySelector('.workspace').dataset.view})`))}`);
      assert.equal(await evalPage(`document.querySelector('#phone-chat-options').getAttribute('aria-expanded')`), "true");
      const toolHomes = await evalPage(`Object.fromEntries(['#context-toggle','#transcript-details','#transcript-older','#transcript-newer'].map(s=>[s,{inside:document.querySelector('#mobile-chat-options').contains(document.querySelector(s)),parents:[document.querySelector(s)?.parentElement?.className,document.querySelector(s)?.parentElement?.parentElement?.className,document.querySelector(s)?.parentElement?.parentElement?.parentElement?.className]}]))`);
      assert.ok(Object.values(toolHomes).every(home=>home.inside), `existing Context, Sources and Older/Newer controls in dialog: ${JSON.stringify(toolHomes)}; viewport ${JSON.stringify(await evalPage(`({media:matchMedia('(min-width: 721px)').matches,refresh:document.querySelector('#refresh').parentElement.className,search:!!document.querySelector('#header-search-toggle')})`))}`);
      await evalPage(`document.querySelector('#transcript-details summary').click()`);
      assert.equal(await evalPage(`document.querySelector('#transcript-details').open`), true, "Sources opens existing details");
      const olderBefore = await evalPage(`({disabled:document.querySelector('#transcript-older').disabled,page:document.querySelector('#transcript-page').textContent,source:document.querySelector('#transcript-session').value})`);
      await evalPage(`document.querySelector('#mobile-chat-options .mobile-sheet-close').click()`);
      await sleep(50); // Native dialog close event updates the opener asynchronously.
      assert.equal(await evalPage(`document.querySelector('#phone-chat-options').getAttribute('aria-expanded')`), "false");
      await evalPage(`document.querySelector('#phone-chat-options').click()`);
      assert.deepEqual(await evalPage(`({disabled:document.querySelector('#transcript-older').disabled,page:document.querySelector('#transcript-page').textContent,source:document.querySelector('#transcript-session').value})`), olderBefore, "pagination and selection preserved");
      await evalPage(`document.querySelector('#context-toggle').click()`);
      assert.equal(await evalPage(`document.querySelector('#mobile-chat-options').open`), false, "Context closes options");
      assert.equal(await evalPage(`document.querySelector('#context-toggle').getAttribute('aria-expanded')`), "true", "existing Context drawer opens");
      await evalPage(`document.querySelector('#context-toggle').click()`);
      await evalPage(`document.querySelector('.mobile-dock [data-mobile-view=conversations]').click()`);
      assert.equal(await evalPage(`document.querySelector('#lane-options').hidden`), false, "dock Lanes still opens filters");
      assert.equal(await evalPage(`document.querySelector('#mobile-chat-options').open`), false, "filter shortcut does not open Options");
      await evalPage(`document.querySelector('.mobile-dock #review-panel-toggle').click()`);
      assert.equal(await evalPage(`document.querySelector('.mobile-review-sheet #review-send').textContent`), "Send", "phone composer omits shortcut suffix");
      assert.equal(await evalPage(`getComputedStyle(document.querySelector('.mobile-review-sheet #review-send')).display !== 'none'`), true);
      console.log(`phone 375px: one page header row; visible ${state.box[2]}×${state.box[3]} Options; Context, Sources, Older, dock filters, composer label pass`);
    } else {
      assert.equal(state.display, "none", "Options hidden on desktop");
      assert.equal(state.parent, "conversation-head", "desktop Options stays in its original hidden location");
      assert.equal(await evalPage(`document.querySelector('#review-send').textContent`), "Send", "desktop label retained");
      assert.equal(await evalPage(`document.querySelector('#review-send').dataset.hint`), "Ctrl/Cmd+Enter", "desktop shortcut hint retained");
      assert.notEqual(await evalPage(`getComputedStyle(document.querySelector('.conversation-head')).display`), "none", "desktop header retained");
      assert.equal(await evalPage(`document.querySelector('#conversation-filter-shortcut').getAttribute('aria-controls')`), "lane-filter-controls", "desktop Included lanes disclosure retained");
      const before = await evalPage(`document.querySelector('#lane-panel-toggle').getAttribute('aria-expanded')`);
      await evalPage(`document.querySelector('#lane-panel-toggle').click()`);
      assert.notEqual(await evalPage(`document.querySelector('#lane-panel-toggle').getAttribute('aria-expanded')`), before, "desktop Included lanes still collapses");
      assert.equal(await evalPage(`document.querySelector('#mobile-chat-options').open`), false, "desktop never opens phone dialog");
      console.log("desktop 1280px: phone Options hidden; Included lanes disclosure unchanged");
    }
  }
  console.log(`exact head ${head}; isolated loopback ${base}; responsive pass OK`);
} finally {
  ws?.close();
  chrome.kill();
  await new Promise(resolve => chrome.once("exit", resolve));
  app.close();
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
