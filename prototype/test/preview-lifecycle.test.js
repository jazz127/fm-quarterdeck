import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import net from "node:net";
import { PreviewLifecycle, proveCheckout, processIdentity, sameIdentity, LAUNCHER } from "../preview-lifecycle.js";
import { validateRegistry } from "../previews.js";

const sha = "a".repeat(40);
const entries = validateRegistry([
  { id: "main", name: "Main", branch: "main", commit: sha, remoteCheckpoint: sha, validation: "accepted" },
  ...["one", "two", "bad"].map((id) => ({ id: `dev-${id}`, name: id, branch: `dev/${id}`, commit: sha, remoteCheckpoint: sha, validation: "captured", checkout: id })),
]);
const wait = async (predicate) => { const end = Date.now() + 4000; while (!predicate()) { if (Date.now() > end) throw new Error("Timed out"); await new Promise((r) => setTimeout(r, 10)); } };
async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-controller-"));
  let time = 10000, pid = 900000, live = 0, maximum = 0;
  const processes = new Map(), calls = [], signals = [];
  const identity = async (id) => id === process.pid ? processIdentity(id) : processes.get(id) || null;
  let mode = "normal", bad = false;
  const { registry = entries, ...options } = overrides;
  const lifecycle = new PreviewLifecycle(registry, { root, primary: "/primary", mainCommit: sha, idleMs: 1000, startMs: 150, stopMs: 50,
    now: () => time, identity,
    prove: async (base, relative, commit) => { assert.equal(base, root); assert.equal(commit, sha); if (bad) throw new Error("Revision mismatch"); return path.join(root, relative); },
    health: async () => mode === "mismatch" ? { health: "stopped", state: "revision-mismatch", reason: "Revision mismatch" } : { health: "running", checkedAt: new Date(time).toISOString() },
    launch: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter(); child.pid = ++pid;
      const evidence = { pid, start: String(pid), boot: "test-boot", cwd: options.cwd, command: `${command}\0${args.join("\0")}\0`, generation: options.env.FM_PREVIEW_GENERATION };
      processes.set(pid, evidence); live++; maximum = Math.max(maximum, live);
      child.kill = (signal) => {
        signals.push({ pid: child.pid, signal });
        if (mode === "stubborn" && signal === "SIGTERM") return;
        if (processes.delete(child.pid)) live--;
        child.emit("exit", 0, signal);
      };
      setImmediate(() => { if (mode !== "timeout") child.emit("message", { generation: evidence.generation, port: Number(options.env.PORT), commit: sha }); });
      return child;
    }, ...options });
  await lifecycle.ready;
  // This fixture advances a synthetic clock and explicitly ticks transitions.
  // A real interval can race those ticks and move Ready to Idling between polls.
  // Real-child integration fixtures below keep the production interval.
  clearInterval(lifecycle.timer);
  t.after(async () => { mode = "normal"; for (const [id, evidence] of processes) if (lifecycle.owned?.child.pid === id) processes.set(id, lifecycle.owned.identity || evidence); await lifecycle.close(); await rm(root, { recursive: true, force: true }); });
  return { lifecycle, root, calls, signals, processes, advance(ms) { time += ms; }, mode(value) { mode = value; }, bad(value) { bad = value; }, get live() { return live; }, get maximum() { return maximum; } };
}

test("ID starts deduplicate, fixed launch uses loopback, serial replacement honors active leases and idle completion", async (t) => {
  const statePath = "/synthetic/private/quarterdeck-state.json";
  const f = await fixture(t, { env: { FM_QUARTERDECK_STATE_PATH: statePath, FM_LAVISH_REVIEW_URL: "http://127.0.0.1:9000" } }), c = f.lifecycle;
  const results = await Promise.all(Array.from({ length: 12 }, () => c.select("dev-one")));
  assert.equal(new Set(results.map((r) => r.operation)).size, 1);
  await wait(() => c.status("dev-one").state === "ready");
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].command, process.execPath);
  assert.deepEqual(f.calls[0].args, [LAUNCHER]);
  assert.equal(f.calls[0].options.shell, false);
  assert.equal(f.calls[0].options.env.HOST, "127.0.0.1");
  assert.equal(f.calls[0].options.env.PORT, "43000");
  assert.equal(f.calls[0].options.env.HOME, path.join(f.root, ".agentos-runtime", "dev-one", "home"));
  assert.ok(!f.calls[0].options.env.HOME.startsWith(`${f.calls[0].options.cwd}/`));
  assert.equal(f.calls[0].options.env.FM_PREVIEW_REGISTRY_PATH, undefined);
  assert.equal(f.calls[0].options.env.FM_QUARTERDECK_STATE_PATH, statePath);
  assert.equal(f.calls[0].options.env.FM_LAVISH_REVIEW_URL, undefined);
  const release = c.acquire("dev-one");
  const replacement = await c.select("dev-two");
  assert.equal(replacement.accepted, true);
  await wait(() => c.status("dev-two").state === "busy");
  assert.equal((await c.select("dev-bad")).accepted, false);
  f.advance(2000); await c.tick(); assert.equal(f.signals.length, 0);
  release(true); release(true); // a request/stream/delivery lease is idempotent and finishes at last use
  await c.tick(); assert.equal(f.signals.length, 0);
  f.advance(1001); await c.tick();
  await wait(() => c.status("dev-two").state === "ready");
  assert.equal(c.status("dev-one").state, "stopped");
  assert.equal(f.maximum, 1); assert.equal(f.calls.length, 2);
  assert.equal(c.status("main").state, "ready");
  assert.deepEqual(f.signals.map((s) => s.signal), ["SIGTERM"]);
});

test("local-first UAT/Staging serve even when remote is ahead, diverged, unknown or absent; failed local never becomes remote", async (t) => {
  const remote = "b".repeat(40);
  const registry = validateRegistry([entries[0],
    { id: "uat", name: "UAT", branch: "uat", commit: sha, remoteCheckpoint: remote, validation: "review-ready", checkout: "one" },
    { id: "stg", name: "Staging", branch: "stg", commit: sha, remoteCheckpoint: remote, validation: "captured", checkout: "two" }]);
  const f = await fixture(t, { registry, relation: async (_local, checkpoint) => checkpoint == null ? "absent" : "diverged" });
  const c = f.lifecycle;
  await c.select("uat"); await wait(() => c.status("uat").state === "ready");
  assert.equal(c.status("uat").commit, sha); assert.equal(c.status("uat").remoteCheckpoint, remote);
  assert.equal(c.status("uat").relation, "diverged"); assert.equal(c.runtime("uat").commit, sha);
  for (const relation of ["local-ahead", "remote-ahead", "unknown", "absent", "equal"]) {
    c.relation = async () => relation;
    f.advance(1001); await c.tick();
    await c.select("stg"); await wait(() => c.status("stg").state === "ready");
    assert.equal(c.status("stg").relation, relation); assert.equal(c.runtime("stg").commit, sha);
    f.advance(1001); await c.tick();
  }
  f.mode("mismatch"); await c.select("uat"); await wait(() => c.status("uat").state === "revision-mismatch" && !c.owned);
  assert.equal(c.runtime("uat"), null); assert.equal(c.status("main").state, "ready");
  assert.equal(c.status("uat").remoteCheckpoint, remote);
  assert.equal(f.maximum, 1);
});

test("main and development mismatches refuse preview and cannot claim captured", async (t) => {
  const remote = "b".repeat(40);
  const registry = validateRegistry([{ ...entries[0], remoteCheckpoint: remote }, { ...entries[1], remoteCheckpoint: remote }]);
  const f = await fixture(t, { registry, relation: async () => "diverged" });
  const c = f.lifecycle;
  assert.equal(c.status("main").state, "revision-mismatch");
  assert.equal((await c.select("main")).accepted, false);
  assert.equal(c.status("dev-one").captured, false);
  await c.select("dev-one"); await wait(() => c.status("dev-one").state === "revision-mismatch");
  assert.equal(c.status("dev-one").captured, false); assert.equal(f.calls.length, 0);
});

test("registry polling never renews idle; retirement retains checkout, receipts and durable entry", async (t) => {
  const f = await fixture(t), c = f.lifecycle;
  await mkdir(path.join(f.root, "one")); await writeFile(path.join(f.root, "one", "receipt"), "durable");
  await c.select("dev-one"); await wait(() => c.status("dev-one").state === "ready");
  for (let i = 0; i < 100; i++) c.list();
  f.advance(1001); await c.tick();
  assert.equal(c.status("dev-one").state, "stopped");
  assert.equal(await readFile(path.join(f.root, "one", "receipt"), "utf8"), "durable");
  assert.equal(c.status("dev-one").commit, sha); assert.equal(f.live, 0);
});

test("preflight failure leaves old alternate untouched; failed replacement and explicit retry preserve main", async (t) => {
  const f = await fixture(t), c = f.lifecycle;
  await c.select("dev-one"); await wait(() => c.status("dev-one").state === "ready");
  f.bad(true); await c.select("dev-bad"); await wait(() => c.status("dev-bad").state === "revision-mismatch");
  assert.equal(f.signals.length, 0); assert.equal(f.live, 1);
  f.bad(false); f.mode("timeout"); await c.select("dev-two");
  await wait(() => c.status("dev-two").state === "busy");
  f.advance(1001); await c.tick();
  assert.equal(c.status("dev-two").state, "failed");
  assert.equal(c.status("dev-two").previous, "dev-one");
  assert.equal(c.status("main").state, "ready"); assert.equal(f.live, 0);
  f.mode("normal"); await c.select("dev-two"); await wait(() => c.status("dev-two").state === "ready");
  assert.equal(f.maximum, 1);
});

test("runtime revision mismatch never becomes Ready and exact failed child is cleaned", async (t) => {
  const f = await fixture(t); f.mode("mismatch");
  await f.lifecycle.select("dev-one"); await wait(() => f.lifecycle.status("dev-one").state === "revision-mismatch" && !f.lifecycle.owned);
  assert.equal(f.live, 0); assert.equal(f.lifecycle.status("main").state, "ready");
});

test("graceful stop escalates once within bounds; reused PID/start/generation never receives a signal", async (t) => {
  const f = await fixture(t), c = f.lifecycle;
  await c.select("dev-one"); await wait(() => c.status("dev-one").state === "ready");
  f.mode("stubborn"); f.advance(1001); await c.tick();
  assert.deepEqual(f.signals.map((s) => s.signal), ["SIGTERM", "SIGKILL"]);
  f.mode("normal"); await c.select("dev-two"); await wait(() => c.status("dev-two").state === "ready");
  const owned = c.owned;
  f.processes.set(owned.child.pid, { ...owned.identity, start: "reused" });
  await assert.rejects(c.stopOwned(owned), /Unknown process identity/);
  assert.equal(f.signals.length, 2); assert.equal(c.status("main").state, "ready");
  f.processes.set(owned.child.pid, owned.identity);
});

test("a spontaneous child crash is not Ready, permits explicit restart and never restarts automatically", async (t) => {
  const f = await fixture(t), c = f.lifecycle;
  await c.select("dev-one"); await wait(() => c.status("dev-one").state === "ready");
  c.owned.child.kill("SIGKILL"); await c.tick();
  assert.equal(c.status("dev-one").state, "failed"); assert.equal(f.calls.length, 1);
  await c.select("dev-one"); await wait(() => c.status("dev-one").state === "ready");
  assert.equal(f.calls.length, 2);
});

test("recovery never adopts or kills records; unknown identity blocks starts while main stays warm", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-recovery-"));
  const lock = path.join(root, ".agentos-controller"); await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), JSON.stringify({ pid: 700001, start: "1", boot: "boot", cwd: root, command: "node", generation: "" }));
  const evidence = { pid: 700002, start: "2", boot: "boot", cwd: root, command: "node", generation: "old" };
  await writeFile(path.join(lock, "child.json"), JSON.stringify({ identity: evidence }));
  let live = { ...evidence, start: "3" };
  const c = new PreviewLifecycle(entries, { root, primary: "/primary", mainCommit: sha,
    identity: async (pid) => pid === 700001 ? null : pid === 700002 ? live : processIdentity(pid),
    launch: () => { throw new Error("Must not launch"); } });
  await c.ready; t.after(async () => { await c.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await c.select("dev-one")).accepted, false); assert.match(c.status("dev-one").reason, /Unknown child identity/);
  assert.equal(c.status("main").state, "ready");
  live = null; await c.tick(); assert.equal(c.problem, null);
  assert.deepEqual((await readdir(lock)).sort(), ["owner.json", "recovery"]);
});

test("second controller cannot take a live controller lock; main remains available", async (t) => {
  const f = await fixture(t);
  const second = new PreviewLifecycle(entries, { root: f.root, mainCommit: sha });
  await second.ready; await second.close();
  assert.match(second.problem, /reconciliation/); assert.equal(second.status("main").state, "ready");
  assert.equal((await second.select("dev-one")).accepted, false);
});

test("immutable checkout proof rejects traversal, every symlink component, dirty content and mismatched HEAD without Git mutation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const checkout = path.join(root, "one"); await mkdir(path.join(checkout, "prototype"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } }).trim();
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "Test");
  await writeFile(path.join(checkout, "prototype/server.js"), "export const fixture = true;\n");
  git("add", "."); git("commit", "-qm", "fixture"); const head = git("rev-parse", "HEAD");
  const index = await readFile(path.join(checkout, ".git/index"));
  assert.equal(await proveCheckout(root, "one", head, "/primary"), checkout);
  for (const relative of ["../one", "/one", "one/../one", "one//one", "one\\one", "."]) await assert.rejects(proveCheckout(root, relative, head, "/primary"));
  await assert.rejects(proveCheckout(root, "one", sha, "/primary"), /Revision mismatch/);
  await assert.rejects(proveCheckout(root, "one", head, checkout), /Primary/);
  await symlink(checkout, path.join(root, "link")); await assert.rejects(proveCheckout(root, "link", head, "/primary"), /Symlink/);
  await symlink(root, path.join(root, "rootlink")); await assert.rejects(proveCheckout(path.join(root, "rootlink"), "one", head, "/primary"), /Symlink/);
  assert.deepEqual(await readFile(path.join(checkout, ".git/index")), index);
  assert.equal(git("rev-parse", "HEAD"), head);
  await writeFile(path.join(checkout, "prototype/server.js"), "dirty");
  await assert.rejects(proveCheckout(root, "one", head, "/primary"), /clean and immutable/);
  assert.equal(sameIdentity(await processIdentity(process.pid), await processIdentity(process.pid)), true);
});

test("real fixed child proves health, exits on controller crash, and stale owner recovers without adoption", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "preview-real-"));
  const checkout = path.join(root, "one"); await mkdir(path.join(checkout, "prototype"), { recursive: true });
  await writeFile(path.join(checkout, "prototype/server.js"), `import http from 'node:http'; import {writeFileSync} from 'node:fs'; import path from 'node:path'; writeFileSync(path.join(process.env.HOME, 'runtime-marker'), 'durable'); export function createServer() { return http.createServer((req,res) => { res.setHeader('content-type','application/json'); res.end(JSON.stringify(req.url === '/api/health' ? {ok:true,service:'fm-quarterdeck'} : {version:process.env.FM_PREVIEW_COMMIT})); }); }`);
  await writeFile(path.join(checkout, "package.json"), '{"type":"module"}');
  const git = (...args) => execFileSync("git", args, { cwd: checkout, encoding: "utf8" }).trim();
  git("init", "-q"); git("add", "."); git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const commit = git("rev-parse", "HEAD");
  const listener = net.createServer(); await new Promise((r) => listener.listen(0, "127.0.0.1", r));
  const port = listener.address().port; await new Promise((r) => listener.close(r));
  const registered = [{ ...entries[0], commit, remoteCheckpoint: commit }, { ...entries[1], commit, remoteCheckpoint: commit }];
  const options = { root, primary: "/primary", mainCommit: commit, portMin: port, portMax: port, idleMs: 300000 };
  const script = path.join(root, "owner.mjs");
  await writeFile(script, `import {PreviewLifecycle} from ${JSON.stringify(new URL("../preview-lifecycle.js", import.meta.url).href)};
    const c = new PreviewLifecycle(${JSON.stringify(registered)}, ${JSON.stringify(options)});
    await c.ready; await c.select('dev-one');
    const timer = setInterval(() => { if (c.status('dev-one').state === 'ready') { clearInterval(timer); process.send(c.owned.identity); } }, 10);`);
  const owner = spawn(process.execPath, [script], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  let recovered;
  t.after(async () => { if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL"); await recovered?.close(); await rm(root, { recursive: true, force: true }); });
  const evidence = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Real child failed to start")), 10000);
    owner.once("message", (message) => { clearTimeout(timer); resolve(message); });
    owner.once("error", (error) => { clearTimeout(timer); reject(error); });
  });
  assert.equal(sameIdentity(evidence, await processIdentity(evidence.pid)), true);
  assert.equal(await readFile(path.join(root, ".agentos-runtime/dev-one/home/runtime-marker"), "utf8"), "durable");
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(await proveCheckout(root, "one", commit, "/primary"), checkout);
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/review`)).json()).version, commit);
  const exited = new Promise((r) => owner.once("exit", r)); owner.kill("SIGKILL"); await exited;
  const deadline = Date.now() + 6000;
  while (await processIdentity(evidence.pid)) { if (Date.now() > deadline) throw new Error("Orphan did not exit after IPC disconnect"); await new Promise((r) => setTimeout(r, 25)); }
  recovered = new PreviewLifecycle(registered, options); await recovered.ready;
  assert.equal(recovered.problem, undefined); assert.equal(recovered.owned, null);
  assert.equal(recovered.status("main").state, "ready");
  await recovered.select("dev-one"); await wait(() => recovered.status("dev-one").state === "ready");
  assert.notEqual(recovered.owned.generation, evidence.generation);
  assert.equal(git("status", "--porcelain"), "");
  assert.equal(await readFile(path.join(root, ".agentos-runtime/dev-one/home/runtime-marker"), "utf8"), "durable");
});

test("durable runtime directories cannot follow operator-root symlinks", async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, "elsewhere"));
  await symlink(path.join(f.root, "elsewhere"), path.join(f.root, ".agentos-runtime"));
  await f.lifecycle.select("dev-one");
  await wait(() => f.lifecycle.status("dev-one").state === "failed");
  assert.equal(f.calls.length, 0);
  assert.equal(f.lifecycle.status("main").state, "ready");
});

test("transient startup health remains Starting until proof or deadline, never an early Failed", async (t) => {
  let samples = 0;
  const f = await fixture(t, { health: async () => ++samples < 2
    ? { health: "stopped", state: "failed" }
    : { health: "running", checkedAt: new Date().toISOString() } });
  await f.lifecycle.select("dev-one");
  await wait(() => samples === 1);
  assert.equal(f.lifecycle.status("dev-one").state, "starting");
  await wait(() => f.lifecycle.status("dev-one").state === "ready");
});

test("malformed process identity is unknown, not absent evidence authorizing a new child", () => {
  assert.equal(sameIdentity({}, {}), false);
  assert.equal(sameIdentity({ pid: 1 }, { pid: 1 }), false);
});
