// Prepared exact-head task-private acceptance. Do not run while the browser hold is open.
// Requires already-installed Chromium; never installs or uses shared browser state.
// Optional read-only prior-revision diagnosis: FM_TAXONOMY_DIAGNOSE_URL + FM_TAXONOMY_EXPECTED_UAT.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
const root = path.resolve(import.meta.dirname, "../..");
const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
assert.equal(execFileSync("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, encoding: "utf8" }).trim(), "", "candidate must be ready and clean BEFORE consuming a browser pass");
const lab = path.join(root, ".taxonomy-lab"); await mkdir(lab, { recursive: true });
const profile = await mkdtemp(path.join(lab, "chrome-"));
const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore" });
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ws;
const deadline = setTimeout(() => { console.error("FAIL: bounded direct browser pass expired"); chrome.kill("SIGKILL"); process.exitCode = 1; }, 180000);
try {
  let port;
  for (let i = 0; i < 100; i++) {
    try { port = Number((await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; }
    catch { if (chrome.exitCode !== null) throw new Error(`Chromium exited ${chrome.exitCode}`); await wait(100); }
  }
  assert.ok(port, "task-private CDP ready");
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  ws = new WebSocket(pages[0].webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener("open", resolve, { once: true }); ws.addEventListener("error", reject, { once: true }); });
  let id = 0; const pending = new Map();
  ws.addEventListener("message", ({ data }) => {
    const reply = JSON.parse(data), entry = pending.get(reply.id); if (!entry) return;
    pending.delete(reply.id); clearTimeout(entry.timer);
    reply.error ? entry.reject(new Error(JSON.stringify(reply.error))) : entry.resolve(reply.result);
  });
  const cmd = (method, params = {}) => new Promise((resolve, reject) => {
    const next = ++id, timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(next, { resolve, reject, timer }); ws.send(JSON.stringify({ id: next, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await cmd("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
    return reply.result.value;
  };
  const until = async (expression) => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await wait(100); } throw new Error(`Readiness timeout: ${expression}`); };
  await cmd("Page.enable");
  if (process.env.FM_TAXONOMY_DIAGNOSE_URL) {
    const url = new URL(process.env.FM_TAXONOMY_DIAGNOSE_URL);
    assert.equal(url.protocol, "https:"); assert.ok(/^[a-f0-9]{40}$/.test(process.env.FM_TAXONOMY_EXPECTED_UAT || ""));
    await cmd("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cmd("Page.navigate", { url: `${url.origin}/#lanes` });
    await until("Boolean(document.querySelector('#lane-filter-rows input'))");
    const version = await evaluate("fetch('/api/review').then(r=>r.json()).then(r=>r.version)");
    assert.equal(version, process.env.FM_TAXONOMY_EXPECTED_UAT);
    const geometry = `(() => { const names=['.workspace','.main-stage','#messages','#shell-panel-toggle','#shell-panel-resize','.context-rail']; return {route:location.hash,width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,boxes:Object.fromEntries(names.map(name=>[name,document.querySelector(name)?.getBoundingClientRect().toJSON()]))}; })()`;
    const diagnosis = { version, desktop: await evaluate(geometry) };
    const shot = await cmd("Page.captureScreenshot", { format: "png" }); await writeFile(path.join(lab, "uat-desktop.png"), Buffer.from(shot.data, "base64"));
    await evaluate("location.hash='#overview'"); await wait(300); diagnosis.overview = await evaluate(geometry);
    await cmd("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate("location.hash='#lanes'"); await wait(300); diagnosis.phone = await evaluate(geometry);
    await writeFile(path.join(lab, "uat-diagnosis.json"), JSON.stringify(diagnosis, null, 2));
  }
  const { acceptance } = await import("./taxonomy-browser-acceptance.mjs");
  const result = await acceptance({ cmd, evaluate, until, wait, lab, head });
  await writeFile(path.join(lab, `acceptance-${head}.json`), JSON.stringify({ head, result }, null, 2));
  console.log(`PASS exact-head ${head}: taxonomy desktop/tablet/390/320`);
} catch (error) { console.error(`FAIL direct pass: ${error.stack}`); await writeFile(path.join(lab, "failure.txt"), String(error.stack)); process.exitCode = 1; }
finally { clearTimeout(deadline); ws?.close(); chrome.kill("SIGKILL"); await new Promise((resolve) => chrome.exitCode !== null ? resolve() : chrome.once("exit", resolve)); await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
