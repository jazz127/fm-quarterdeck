import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { cleanupBrowserProfile, waitForBrowserPort } from "../scripts/browser-harness.mjs";

const runningBrowser = () => ({ exitCode: null, signalCode: null });
const missingPort = () => { const error = Error("Not ready"); error.code = "ENOENT"; throw error; };

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
