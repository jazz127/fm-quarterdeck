// Package-free exact-head shell acceptance: desktop resize, tablet continuity, 390/320 phone dock.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createServer } from "../server.js";

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const profile = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-shell-"));
const app = createServer({ FM_DEPLOYMENT_TIER: "uat" });
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${app.address().port}`;
const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
try {
  let port;
  for (let n = 0; n < 100; n++) {
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
    const { resolve, reject } = pending.get(reply.id);
    pending.delete(reply.id);
    reply.error ? reject(new Error(JSON.stringify(reply.error))) : resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const key = ++id; pending.set(key, { resolve, reject }); ws.send(JSON.stringify({ id: key, method, params }));
  });
  const evaluate = async (expression) => {
    const result = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await cmd("Page.enable");
  let navigation = 0;
  const navigate = async () => {
    const loaded = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.removeEventListener("message", onMessage); reject(new Error("Navigation timed out")); }, 10000);
      const onMessage = ({ data }) => { if (JSON.parse(data).method !== "Page.loadEventFired") return; clearTimeout(timer); ws.removeEventListener("message", onMessage); resolve(); };
      ws.addEventListener("message", onMessage);
    });
    await cmd("Page.navigate", { url: `${base}/?shell=${++navigation}#lanes` }); await loaded;
    for (let n = 0; n < 100; n++) { if (await evaluate('Boolean(document.querySelector("#shell-panel-toggle") && document.querySelector("#shell-panel-resize") && document.querySelector(".main-stage").clientWidth)')) return; await wait(50); }
    throw new Error("Shell failed to load");
  };
  const metrics = async (width, touch = false) => {
    await cmd("Emulation.setDeviceMetricsOverride", { width, height: 850, deviceScaleFactor: 1, mobile: false });
    await cmd("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
    await cmd("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: touch ? "coarse" : "fine" }, { name: "hover", value: touch ? "none" : "hover" }] });
    await wait(60);
  };
  const state = () => evaluate(`(() => {
    const q = s => document.querySelector(s), t=q('#shell-panel-toggle'), d=q('#shell-panel-resize'), n=q('#review-sidebar-region'), m=q('.main-stage');
    const nr=n.getBoundingClientRect(), mr=m.getBoundingClientRect(), tr=t.getBoundingClientRect(), r=q('#refresh').getBoundingClientRect();
    return { revision: window.FM_SERVED_COMMIT, route:location.hash, expanded:t.getAttribute('aria-expanded'), label:t.getAttribute('aria-label'), controls:t.getAttribute('aria-controls'), outline:getComputedStyle(t).outlineStyle, toggleVisible:!t.hidden && tr.width >=40 && tr.left>=0 && tr.right<=innerWidth, toggleReachable:t.contains(document.elementFromPoint(tr.x+tr.width/2,tr.y+tr.height/2)), refreshReachable:q('#refresh').contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)), divider:!d.hidden && getComputedStyle(d).display!=='none', cursor:getComputedStyle(d).cursor, fine:matchMedia('(pointer: fine)').matches, coarse:matchMedia('(pointer: coarse)').matches, min:+d.getAttribute('aria-valuemin'), max:+d.getAttribute('aria-valuemax'), now:+d.getAttribute('aria-valuenow'), nav:nr.width, main:mr.width, rail:q('.context-rail').getBoundingClientRect().width, stageBottom:mr.bottom, pen:q('#review-toggle').disabled, inert:n.inert, focused:document.activeElement.id, overflow:document.documentElement.scrollWidth > innerWidth+1, stored:localStorage.getItem('fm-agentos-shell-panel-width.v1'), dock:getComputedStyle(q('.primary-nav')).display, title:!!q('#conversations-view.active'), draft:q('#transcript-search').value };
  })()`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const key = async (name) => { await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: name, code: name, windowsVirtualKeyCode: ({ ArrowLeft:37, ArrowRight:39, Escape:27 })[name] }); await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: name, code: name, windowsVirtualKeyCode: ({ ArrowLeft:37, ArrowRight:39, Escape:27 })[name] }); };
  const dragStart = async (to) => {
    const r = await evaluate('document.querySelector("#shell-panel-resize").getBoundingClientRect().toJSON()');
    const x = r.x + r.width/2, y = r.y + r.height/2;
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await cmd("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cmd("Input.dispatchMouseEvent", { type: "mouseMoved", x: x+to, y, button: "left", buttons: 1 });
    return { x: x+to, y };
  };
  const dragEnd = ({ x, y }) => cmd("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  const drag = async (to) => dragEnd(await dragStart(to));
  assert.equal((await (await fetch(`${base}/api/review`)).json()).version, head);
  await metrics(1600); await navigate();
  await evaluate('document.querySelector("#transcript-search").value="preserved"; document.querySelector(".primary-tab.active").focus()');
  let s = await state();
  assert.ok(s.toggleVisible && s.divider && !s.overflow && s.now === 252 && s.main >= 480 && s.title, JSON.stringify(s));
  await click("#shell-panel-toggle"); s = await state();
  assert.ok(s.expanded === "false" && s.label === "Expand navigation panel" && s.controls === "review-sidebar-region" && s.inert && !s.divider && s.toggleVisible && s.main >= 1000 && s.rail >= 280 && s.main + s.rail >= 1598 && s.route === "#lanes" && s.draft === "preserved" && !s.overflow, JSON.stringify(s));
  await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await cmd("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9 });
  await evaluate('document.querySelector("#shell-panel-toggle").focus()');
  assert.notEqual((await state()).outline, "none");
  await click("#shell-panel-toggle"); s = await state();
  assert.ok(s.expanded === "true" && !s.inert && s.divider && s.focused === "", JSON.stringify(s)); // Restore focused section tab (no id).
  await drag(170); s = await state();
  assert.ok(s.now > 400 && s.now <= 440 && s.stored === String(s.now) && s.main >= 480 && !s.overflow, JSON.stringify(s));
  await drag(1000); s = await state(); assert.equal(s.now, 440);
  await drag(-1000); s = await state(); assert.equal(s.now, 220);
  await evaluate('document.querySelector("#shell-panel-resize").focus()');
  await key("ArrowRight"); s = await state(); assert.ok(s.now === 240 && s.focused === "shell-panel-resize" && s.min === 220 && s.max === 440, JSON.stringify(s));
  await key("ArrowLeft"); s = await state(); assert.equal(s.now, 220);
  let end = await dragStart(70); s = await state(); assert.ok(s.now > 220, JSON.stringify(s));
  await evaluate('document.querySelector("#shell-panel-resize").focus()');
  await key("Escape"); await dragEnd(end); s = await state(); assert.ok(s.now === 220 && s.stored === "220", JSON.stringify(s));
  end = await dragStart(70); s = await state(); assert.ok(s.now > 220, JSON.stringify(s));
  await evaluate('document.querySelector("#shell-panel-resize").dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true }))');
  await dragEnd(end); s = await state(); assert.ok(s.now === 220 && s.stored === "220", JSON.stringify(s));
  assert.notEqual(await evaluate('getComputedStyle(document.querySelector("#shell-panel-resize")).outlineStyle'), "none");
  await metrics(800); s = await state(); assert.ok(s.divider && s.max === 320 && s.main >= 480 && !s.overflow, JSON.stringify(s));
  await drag(1000); s = await state(); assert.equal(s.now, 320);
  await metrics(1600); s = await state(); assert.equal(s.now, 320);
  await metrics(834, true); s = await state(); assert.ok(!s.divider && s.expanded === "true" && s.nav >= 240 && !s.overflow, JSON.stringify(s));
  await click("#shell-panel-toggle"); s = await state(); assert.ok(s.expanded === "false" && s.inert && s.main >= 832 && !s.overflow, JSON.stringify(s));
  await metrics(390, true); s = await state(); assert.ok(s.expanded === "false" && s.toggleVisible && s.toggleReachable && s.refreshReachable && !s.divider && !s.inert && !s.overflow, JSON.stringify(s));
  assert.equal(await evaluate('getComputedStyle(document.querySelector(".mobile-dock")).display'), 'grid', 'phone quick navigation stays visible');
  await click("#shell-panel-toggle"); s = await state(); assert.ok(s.expanded === "true" && s.dock === "grid" && !s.inert && s.draft === "preserved", JSON.stringify(s));
  await evaluate('document.querySelector("#review-toggle").focus()');
  assert.equal((await state()).focused, "review-toggle", "annotation mode remains focusable in More");
  await click(".mobile-sheet-close");
  await metrics(320, true); s = await state(); assert.ok(s.toggleVisible && s.toggleReachable && s.refreshReachable && !s.divider && !s.overflow, JSON.stringify(s));
  await click("#shell-panel-toggle"); s = await state(); assert.ok(s.expanded === "true" && s.dock === "grid" && !s.inert && !s.overflow, JSON.stringify(s));
  await click(".mobile-sheet-close"); await wait(60); s = await state(); assert.ok(s.expanded === "false" && !s.inert && !s.overflow, JSON.stringify(s));
  await metrics(1600); s = await state(); assert.ok(s.expanded === "false" && !s.divider && !s.overflow, JSON.stringify(s));
  await click("#shell-panel-toggle"); s = await state(); assert.ok(s.expanded === "true" && s.divider && s.now === 320 && s.draft === "preserved", JSON.stringify(s));
  await navigate(); s = await state(); assert.ok(s.now === 320 && s.stored === "320", JSON.stringify(s));
  await evaluate('localStorage.setItem("fm-agentos-shell-panel-width.v1", "900")'); await navigate(); s = await state(); assert.equal(s.now, 440);
  await metrics(800); s = await state(); assert.ok(s.now === 320 && s.main >= 480 && !s.overflow, JSON.stringify(s));
  await metrics(1600); s = await state(); assert.equal(s.now, 440);
  await evaluate('localStorage.setItem("fm-agentos-shell-panel-width.v1", "Infinity")'); await navigate(); s = await state(); assert.equal(s.now, 252);
  console.log(`Exact-head ${head}: desktop narrow/wide drag + keys, tablet, 390/320px, persistence and focus passed`);
} finally {
  ws?.close(); chrome.kill(); app.close();
  await new Promise((resolve) => chrome.once("exit", resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
