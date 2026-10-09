import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, utimes, symlink, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { readFirstmateActivity } from "../firstmate-activity.js";
import { claudeProjectDirectory } from "../claude-transcript.js";

const stamp = "2026-01-02T03:04:05.000Z";
test("activity clocks use fresh mtimes, missing files remain unknown and external state is rejected", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-fixture-"));
  try {
    const home = path.join(root, "home");
    await mkdir(path.join(home, "state"), { recursive: true });
    const queue = path.join(home, "state/.wake-queue");
    await writeFile(queue, "not a timestamp");
    await utimes(queue, new Date(stamp), new Date(stamp));
    const external = path.join(root, "external");
    await writeFile(external, "synthetic");
    await symlink(external, path.join(home, "state/.last-heartbeat"));
    const first = await readFirstmateActivity(home);
    assert.equal(first.lastWakeAt, stamp);
    assert.equal(first.watcherBeatAt, null);
    assert.equal(first.heartbeatAt, null);
    assert.equal(first.lastTurnAt, null);
    assert.ok(Number.isFinite(Date.parse(first.readAt)));
    const next = "2026-01-02T04:05:06.000Z";
    await utimes(queue, new Date(next), new Date(next));
    assert.equal((await readFirstmateActivity(home)).lastWakeAt, next);
    assert.equal((await readFirstmateActivity(null)).lastWakeAt, null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("primary Claude and Pi transcript clocks exclude unrelated newer sessions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "activity-transcript-"));
  try {
    const home = path.join(root, "home"), config = path.join(root, "config");
    await mkdir(path.join(home, "state"), { recursive: true });
    const directory = claudeProjectDirectory(config, home);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(home, "state/.lock-session"), "primary");
    const primary = path.join(directory, "primary.jsonl");
    await writeFile(primary, "{}\n");
    await utimes(primary, new Date(stamp), new Date(stamp));
    await writeFile(path.join(directory, "wake.jsonl"), "{}\n");
    assert.equal((await readFirstmateActivity(home, { claudeConfigDir: config })).lastTurnAt, stamp);
    const piDir = path.join(root, `--${home.replace(/^\/+/, "").replaceAll("/", "-")}--`);
    await mkdir(piDir);
    const pi = path.join(piDir, "primary.jsonl");
    await writeFile(pi, JSON.stringify({ type: "session", cwd: home }) + "\n");
    const piStamp = "2026-01-03T03:04:05.000Z";
    await utimes(pi, new Date(piStamp), new Date(piStamp));
    await writeFile(path.join(home, "state/.branch-mirror-cursor"), JSON.stringify({ file: pi }));
    assert.equal((await readFirstmateActivity(home)).lastTurnAt, piStamp);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Overview compact activity ticks and warns without visible status or fabricated clocks", async () => {
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("let firstmateActivity ="), source.indexOf("function lanesQuery()"));
  const node = { dataset: {}, replaceChildren(...children) { this.children = children; this.textContent = children.map((child) => child.textContent).join(" "); } };
  const context = vm.createContext({ $: () => node, Date, document: { createElement: () => ({ textContent: "" }) } });
  vm.runInContext(code, context);
  vm.runInContext("renderFirstmateActivity()", context);
  assert.equal(node.textContent, "Last seen unknown unknown Watcher unknown");
  const now = Date.parse(stamp);
  context.now = now;
  context.activity = { lastTurnAt: stamp, lastWakeAt: null, watcherBeatAt: stamp, heartbeatAt: null, readAt: stamp };
  vm.runInContext("firstmateActivity = activity; activityFetchedAt = now; renderFirstmateActivity(now)", context);
  assert.equal(node.children[0].textContent, `Last seen ${new Date(stamp).toLocaleTimeString([], { hour12: false })} 0s`);
  assert.equal(node.children[1].textContent, "Watcher 0s");
  assert.equal(node.dataset.state, "fresh");
  vm.runInContext("renderFirstmateActivity(now + 301000)", context);
  assert.match(node.children[0].textContent, /Last seen \d{2}:\d{2}:\d{2} 5m/);
  assert.equal(node.children[1].textContent, "Watcher 5m");
  assert.doesNotMatch(node.textContent, /activity|ago|live|stale|as of/);
  assert.match(node.title, /Read:/);
  assert.equal(node.dataset.state, "warning");
  vm.runInContext("activityFetchedAt = now + 301000; renderFirstmateActivity(now + 301000)", context);
  assert.equal(node.dataset.state, "warning");
  assert.doesNotMatch(node.textContent, /as of/);
  const css = await readFile(new URL("../public/styles.css", import.meta.url), "utf8");
  assert.match(css, /#fleet-source \{[^}]*display: flex;[^}]*justify-content: space-between;[^}]*white-space: nowrap;/);
});
