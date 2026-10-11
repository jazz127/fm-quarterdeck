import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { acquireFixturePage, browserCpuRate, cleanupBrowserProfile, waitForBrowserPort } from "../scripts/browser-harness.mjs";

const runningBrowser = () => ({ exitCode: null, signalCode: null });
const missingPort = () => { const error = Error("Not ready"); error.code = "ENOENT"; throw error; };

const fixtureUrl = "http://127.0.0.1:4100/#overview", revision = "a".repeat(40);
const unselected = "error: No page is currently selected\ncode: BROWSER_ERROR\n";
// Synthetic axi CLI shaped like the hosted runner: newpage creates the target
// but leaves no page selected, so the caller must list and select it.
function hostedBrowser({ newpageError = unselected, created = [fixtureUrl], selectable = true, document = {}, open = ["about:blank"], selected } = {}) {
  const pages = open.map((url, index) => ({ id: String(index + 1), url })), calls = [];
  const browser = async (...args) => {
    calls.push(args.join(" "));
    if (args[0] === "newpage") {
      for (const url of created) pages.push({ id: String(pages.length + 1), url });
      if (newpageError) throw Object.assign(Error(`Command failed: chrome-devtools-axi ${args.join(" ")}`), { stdout: newpageError });
      selected = pages.at(-1).id;
      return "page:\n";
    }
    if (args[0] === "pages") return `pages[${pages.length}]{id,url,selected}:\n${pages.map((page) => `  ${page.id},${page.url},${page.id === selected}`).join("\n")}\n`;
    if (args[0] === "selectpage") { if (selectable) selected = args[1]; return "selected\n"; }
    if (args[0] === "eval") {
      const state = { href: pages.find((page) => page.id === selected)?.url, revision, navigation: "navigate", ...document };
      const evaluate = vm.runInNewContext(`(${args[1]})`, {
        document: { readyState: 'complete' },
        location: { href: state.href },
        window: { FM_BOOT_REVISION: state.revision },
        performance: { getEntriesByType: type => type === 'navigation' ? [{ type: state.navigation }] : [] },
        setTimeout,
      });
      return `result: ${await evaluate()}\n`;
    }
    throw Error(`unexpected ${args[0]}`);
  };
  return { browser, calls };
}

test("hosted unselected newpage fails bare acquisition but selects the actual own target", async () => {
  await assert.rejects(hostedBrowser().browser("newpage", fixtureUrl), (error) => error.stdout === unselected);
  const { browser, calls } = hostedBrowser();
  assert.equal(await acquireFixturePage(browser, fixtureUrl, revision), "2");
  assert.deepEqual(calls, ["pages", `newpage ${fixtureUrl}`, "pages", "selectpage 2", "pages", calls.at(-1)]);
  assert.match(calls.at(-1), /^eval /, "the fresh document and served revision are verified before interaction");
});

test("a selected newpage still lists, selects and verifies the same own target", async () => {
  const { browser, calls } = hostedBrowser({ newpageError: "" });
  assert.equal(await acquireFixturePage(browser, fixtureUrl, revision), "2");
  assert.deepEqual(calls.slice(0, 5), ["pages", `newpage ${fixtureUrl}`, "pages", "selectpage 2", "pages"]);
});

test("freshness follows the requested URL and revision for another fixture", async () => {
  const url = 'http://127.0.0.1:4101/#work', servedRevision = 'c'.repeat(40);
  const { browser } = hostedBrowser({ created: [url], document: { revision: servedRevision } });
  assert.equal(await acquireFixturePage(browser, url, servedRevision), '2');
});

test("a fresh page beside a same-URL original selects only the newly created target", async () => {
  const { browser, calls } = hostedBrowser({ open: ["about:blank", fixtureUrl], selected: "2" });
  assert.equal(await acquireFixturePage(browser, fixtureUrl, revision), "3");
  assert.ok(calls.includes("selectpage 3") && !calls.includes("selectpage 2"));
});

test("unrelated newpage errors keep their original failure without listing pages", async () => {
  const { browser, calls } = hostedBrowser({ newpageError: "error: Target closed\ncode: BROWSER_ERROR\n" });
  await assert.rejects(acquireFixturePage(browser, fixtureUrl, revision), /Command failed/);
  assert.deepEqual(calls, ["pages", `newpage ${fixtureUrl}`]);
});

for (const [name, created, count] of [["a missing", [], 0], ["an ambiguous", [fixtureUrl, fixtureUrl], 2]]) {
  test(`${name} own target stops with the listing and original error as evidence`, async () => {
    const { browser, calls } = hostedBrowser({ created });
    await assert.rejects(acquireFixturePage(browser, fixtureUrl, revision),
      new RegExp(`found ${count}:[\\s\\S]*1,about:blank,false[\\s\\S]*newpage: error: No page is currently selected`));
    assert.ok(!calls.some((call) => call.startsWith("selectpage")), "no guessed target is selected");
  });
}

test("a failed selection stops before interaction", async () => {
  const { browser, calls } = hostedBrowser({ selectable: false });
  await assert.rejects(acquireFixturePage(browser, fixtureUrl, revision), /target 2 .* was not selected:[\s\S]*2,http:\/\/127\.0\.0\.1:4100\/#overview,false/);
  assert.ok(!calls.some((call) => call.startsWith("eval")));
});

for (const [name, document] of [["stale revision", { revision: "b".repeat(40) }], ["reloaded realm", { navigation: "reload" }], ["wrong document", { href: "about:blank" }]]) {
  test(`a ${name} fails the own fixture document check`, async () => {
    await assert.rejects(acquireFixturePage(hostedBrowser({ document }).browser, fixtureUrl, revision), /is not a fresh .* document/);
  });
}

test("browser CPU throttling accepts only a finite bounded rate", () => {
  for (const rate of ["1", "1.5", "6", "20"]) assert.equal(browserCpuRate(rate), Number(rate));
  for (const rate of ["", "0", "21", "Infinity", "not-a-rate"]) assert.throws(() => browserCpuRate(rate), /FM_BROWSER_CPU_RATE/);
});

test("cold browser readiness beyond ten seconds uses a separate bounded launch budget", async () => {
  let elapsed = 0, polls = 0;
  const port = await waitForBrowserPort(runningBrowser(), "/synthetic/profile", {
    now: () => elapsed,
    wait: async (ms) => { elapsed += ms; },
    readActivePort: async () => { polls++; return elapsed < 12000 ? missingPort() : "9222\n/devtools/browser/fixture"; },
  });
  assert.equal(port, 9222);
  assert.equal(elapsed, 12000);
  assert.equal(polls, 121, "readiness is polled, not a second browser launch");
});

test("browser readiness times out at thirty seconds with bounded startup evidence", async () => {
  let elapsed = 0;
  await assert.rejects(waitForBrowserPort(runningBrowser(), "/synthetic/profile", {
    now: () => elapsed, wait: async (ms) => { elapsed += ms; },
    readActivePort: async () => missingPort(), diagnostics: () => "Synthetic startup diagnostic",
  }), /Chromium startup timed out after 30000ms: Synthetic startup diagnostic/);
  assert.equal(elapsed, 30000, "a browser that never starts still fails closed");
});

test("partially written or invalid debugging ports are not readiness", async () => {
  let elapsed = 0;
  const readings = ["", "0", "65536", "not a port", "9223\n/devtools/browser/fixture"];
  assert.equal(await waitForBrowserPort(runningBrowser(), "/synthetic/profile", {
    now: () => elapsed, wait: async (ms) => { elapsed += ms; }, readActivePort: async () => readings.shift(),
  }), 9223);
  assert.equal(elapsed, 400);
});

for (const browser of [{exitCode: 1, signalCode: null}, {exitCode: null, signalCode: "SIGKILL"}]) {
  test(`browser exit ${browser.exitCode ?? browser.signalCode} fails immediately instead of waiting`, async () => {
    await assert.rejects(waitForBrowserPort(browser, "/synthetic/profile", {
      readActivePort: async () => assert.fail("exited browser must not be polled"), diagnostics: () => "Synthetic failure",
    }), /Chromium exited (1|SIGKILL): Synthetic failure/);
  });
}

test("spawn and profile access errors retain their original failure", async () => {
  for (const code of ["ENOENT", "EACCES"]) {
    const error = Object.assign(Error(code), {code});
    await assert.rejects(waitForBrowserPort(runningBrowser(), "/synthetic/profile", code === "ENOENT"
      ? {spawnError: () => error} : {readActivePort: async () => { throw error; }}), (received) => received === error);
  }
});

test("browser profile cleanup waits for the Chromium process to exit", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-browser-cleanup-test-"));
  const profile = path.join(scratch, "profile");
  await mkdir(path.join(profile, "Default"), { recursive: true });
  const childScript = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "const target = path.join(process.argv[1], 'Default', 'writer');",
    "const write = () => fs.writeFileSync(target, String(Date.now()));",
    "write();",
    "const timer = setInterval(write, 10);",
    "console.log('ready');",
    "process.on('SIGTERM', () => setTimeout(() => { clearInterval(timer); process.exit(0); }, 200));",
  ].join("\n");
  const child = spawn(process.execPath, ["-e", childScript, profile], { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    let removalOptions, exitedBeforeRemoval;
    await cleanupBrowserProfile(child, profile, {
      removeProfile: async (directory, options) => {
        removalOptions = options;
        exitedBeforeRemoval = child.exitCode !== null || child.signalCode !== null;
        await rm(directory, options);
      },
    });
    assert.ok(exitedBeforeRemoval, "profile removal follows child exit");
    assert.deepEqual(removalOptions, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
  }
});

for (const code of ["ENOTEMPTY", "EBUSY"]) {
  test(`residual ${code} profile removal failure warns without replacing the browser result`, async () => {
    const warnings = [];
    let options;
    await assert.doesNotReject(cleanupBrowserProfile(
      { pid: undefined, exitCode: 0, signalCode: null },
      "/tmp/quarterdeck-browser-cleanup-failure",
      {
        removeProfile: async (_directory, receivedOptions) => {
          options = receivedOptions;
          const error = Error(code);
          error.code = code;
          throw error;
        },
        warn: (message) => warnings.push(message),
      },
    ));
    assert.deepEqual(options, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`Could not remove Chromium temporary profile .*${code}`));
  });
}

for (const code of ["EACCES", "EIO", undefined]) {
  test(`unexpected ${code ?? "uncoded"} profile removal failure rejects`, async () => {
    const error = Error("Profile removal failed");
    error.code = code;
    const warnings = [];
    await assert.rejects(cleanupBrowserProfile(
      { pid: undefined, exitCode: 0, signalCode: null },
      "/tmp/quarterdeck-browser-cleanup-failure",
      {
        removeProfile: async () => { throw error; },
        warn: (message) => warnings.push(message),
      },
    ), (received) => received === error);
    assert.deepEqual(warnings, []);
  });
}
