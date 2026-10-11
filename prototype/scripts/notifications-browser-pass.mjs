// Headless UI evidence only. Permission, subscription and server enrollment are mocked.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { acquireFixturePage, waitForBrowserPort, cleanupBrowserProfile } from "./browser-harness.mjs";

const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(import.meta.dirname, "../.."), encoding: "utf8" }).trim();

const temp = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-notification-ui-")), profile = path.join(temp, "profile");
await mkdir(profile);
const chrome = spawn(process.env.CHROMIUM || "chromium", ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
let spawnError, diagnostics = "";
chrome.on("error", (error) => { spawnError = error; });
chrome.stderr.on("data", (chunk) => { diagnostics = (diagnostics + chunk).slice(-2000); });
// Confine the CLI's bridge records to this child's synthetic temporary home.
const env = { ...process.env, HOME: temp, CHROME_DEVTOOLS_AXI_SESSION: `quarterdeck-notifications-${process.pid}`, CHROME_DEVTOOLS_AXI_IDLE_TIMEOUT_MS: "60000", CHROME_DEVTOOLS_AXI_USER_DATA_DIR: profile };
for (const key of ["CHROME_DEVTOOLS_AXI_AUTO_CONNECT", "CHROME_DEVTOOLS_AXI_MCP_SERVER_URL"]) delete env[key];
const exec = promisify(execFile);
const browser = async (...args) => (await exec("chrome-devtools-axi", args, { env, timeout: 45000, maxBuffer: 1024 * 1024 })).stdout;
const evaluate = async (code) => {
  const output = await browser("eval", code);
  if (/isError":\s*true|Error:|Exception:/.test(output)) throw Error(output);
  return output;
};
const server = createServer({ FM_QUARTERDECK_STATE_PATH: path.join(temp, "state.json") }, {
  quotaReader: async () => ({ providers: [], stale: false, error: "Offline fixture" }),
  costReader: async () => ({ azure: { status: "unavailable" }, github: { status: "unavailable" } }),
  lanesReader: async () => ({ lanes: [], transcript: { sessions: [], warnings: [] } }),
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
try {
  const port = await waitForBrowserPort(chrome, profile, { spawnError: () => spawnError, diagnostics: () => diagnostics });
  env.CHROME_DEVTOOLS_AXI_BROWSER_URL = `http://127.0.0.1:${port}`;
  await acquireFixturePage(browser, `http://127.0.0.1:${server.address().port}/#preferences`, head);
  await evaluate(`async () => {
    for (let n = 0; n < 150; n++) {
      const status = document.querySelector('[data-notification-status]');
      if (window.quarterdeckNotifications && status?.textContent.includes('off in the server configuration')) {
        if (!document.querySelector('[data-notification-enable]').disabled) throw Error('disabled server allowed enrollment');
        if ((await navigator.serviceWorker.getRegistrations()).length) throw Error('status registered a real worker');
        return 'PASS disabled configuration; no registration';
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    } throw Error('disabled status timeout');
  }`);
  for (const [width, height] of [[1366, 900], [390, 844]]) {
    await browser("resize", String(width), String(height));
    await evaluate(`async () => {
      const original = document.querySelector('#notification-preferences');
      let fixture = original.cloneNode(true); original.replaceWith(fixture);
      const calls = [], stored = new Map(); let subscribed = false, permission = 'default', serverEnrolled = false;
      const subscription = { options: {}, toJSON: () => ({ endpoint: 'synthetic' }), unsubscribe: async () => { calls.push('unsubscribe'); subscribed = false; } };
      const registration = { active: { scriptURL: location.origin + '/notifications-worker.js' }, pushManager: {
        getSubscription: async () => subscribed ? subscription : null,
        subscribe: async () => { calls.push('subscribe'); subscribed = true; return subscription; }
      }, unregister: async () => { calls.push('unregister'); } };
      const fake = { isSecureContext: true, location, PushManager: {}, navigator: { userAgent: 'Android Chrome', serviceWorker: {
        getRegistration: async () => subscribed ? registration : null, register: async () => { calls.push('register'); return registration; }, ready: Promise.resolve(registration)
      } }, Notification: { get permission() { return permission; }, requestPermission: async () => { calls.push('permission'); permission = 'granted'; return 'granted'; } },
      matchMedia: () => ({ matches: false }), crypto, localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) }, addEventListener() {},
      fetch: async (url) => { if (url.endsWith('/enroll')) serverEnrolled = true; if (url.endsWith('/disable')) { calls.push('server-disable'); serverEnrolled = false; }
        return { ok: true, json: async () => ({ configured: true, origin: location.origin, publicKey: btoa(String.fromCharCode(...new Uint8Array(65).fill(4))).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''), state: serverEnrolled ? 'enabled' : 'not-enabled', subscribed: serverEnrolled }) };
      } };
      const controller = quarterdeckNotifications.mount(fake, fixture); await new Promise(resolve => setTimeout(resolve, 20));
      const preference = fixture.querySelector('[data-notification-preference]');
      const status = fixture.querySelector('[data-notification-status]');
      if (!preference.checked || stored.has('fm-quarterdeck-push-alerts-v1')) throw Error('missing preference did not default on without writing consent');
      if (!status.textContent.includes('preference is on') || !status.textContent.includes('permission: not granted')) throw Error('default/permission status is dishonest');
      if (calls.length) throw Error('status caused permission or registration');
      for (const state of ['denied', 'unknown', 'granted', 'default']) {
        permission = state; await controller.refresh();
        if (calls.length || serverEnrolled || subscribed) throw Error('permission reconciliation enrolled');
        if (fixture.querySelector('[data-notification-enable]').disabled !== ['denied', 'unknown'].includes(state)) throw Error('permission control mismatch ' + state);
      }
      preference.checked = false; preference.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 20));
      if (stored.get('fm-quarterdeck-push-alerts-v1') !== 'false' || !status.textContent.includes('preference is off')) throw Error('explicit off not saved');
      if (calls.join() !== 'server-disable') throw Error('off without enrollment caused browser mutations');
      calls.length = 0;
      preference.checked = true; preference.dispatchEvent(new Event('change'));
      await new Promise(resolve => setTimeout(resolve, 20));
      if (calls.length || serverEnrolled || subscribed) throw Error('setting on alone enrolled');
      fixture.querySelector('[data-notification-enable]').click(); await new Promise(resolve => setTimeout(resolve, 20));
      if (calls.join() !== 'permission,register,subscribe') throw Error('enable ordering ' + calls);
      if (!fixture.textContent.includes('best effort')) throw Error('delivery promise not scoped');
      fixture.querySelector('[data-notification-disable]').click(); await new Promise(resolve => setTimeout(resolve, 20));
      if (calls.slice(-3).join() !== 'server-disable,unsubscribe,unregister') throw Error('disable ordering');
      if (!fixture.textContent.includes('Disabled.') || preference.checked || stored.get('fm-quarterdeck-push-alerts-v1') !== 'false') throw Error('missing disabled preference/status');
      await controller.refresh();
      if (preference.checked || !status.textContent.includes('preference is off')) throw Error('refresh lost explicit off');
      const remounted = fixture.cloneNode(true); fixture.replaceWith(remounted);
      quarterdeckNotifications.mount(fake, remounted); await new Promise(resolve => setTimeout(resolve, 20));
      if (remounted.querySelector('[data-notification-preference]').checked) throw Error('reload lost explicit off');
      fixture = remounted;
      const box = fixture.querySelector('[data-notification-preference]');
      const boxRect = box.getBoundingClientRect(), labelRect = box.closest('label').getBoundingClientRect();
      if (boxRect.width < 16 || boxRect.width > 24 || boxRect.height > 24 || labelRect.height < 44) throw Error('checkbox inherited numeric-input sizing or lost its touch target');
      const buttons = [...fixture.querySelectorAll('button')];
      if (innerWidth > 1000 && buttons.some(button => Math.abs(button.getBoundingClientRect().top - buttons[0].getBoundingClientRect().top) > 1)) throw Error('desktop controls need the full panel width');
      for (const button of buttons) {
        const r = button.getBoundingClientRect(); if (r.width < 1 || r.height < 30 || r.right > innerWidth + 1 || r.left < 0) throw Error('button overflow');
      }
      if (document.documentElement.scrollWidth > innerWidth + 1) throw Error('page horizontal overflow');
      if ((await navigator.serviceWorker.getRegistrations()).length) throw Error('mock flow registered a real worker');
      fixture.querySelector('[data-notification-status]').scrollIntoView({ block: 'center' });
      return 'PASS mocked default-on preference, permission, explicit enable/disable and layout ${width}x${height}; no OS/provider proof';
    }`);
    if (process.env.FM_PUSH_PROOF_DIR) {
      await mkdir(process.env.FM_PUSH_PROOF_DIR, { recursive: true });
      await browser("screenshot", path.join(process.env.FM_PUSH_PROOF_DIR, `notifications-${width}.png`));
    }
  }
  console.log("PASS notification UI at desktop/phone widths; all permissions/subscriptions/provider boundaries mocked; no physical OS push claim");
} finally {
  await browser("stop").catch(() => {});
  await cleanupBrowserProfile(chrome, profile);
  await new Promise((resolve) => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
