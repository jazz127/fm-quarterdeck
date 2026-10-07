// Stable-host controller. Linux /proc identity is required; unsupported hosts fail closed.
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, readlink, mkdir, open, rename, unlink, rmdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { previewHealth, commitRelation } from "./previews.js";

const exec = promisify(execFile);
export const LAUNCHER = fileURLToPath(new URL("./preview-child.js", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const SHA = /^[a-f0-9]{40}$/;

export async function noSymlinks(absolute) {
  if (!path.isAbsolute(absolute) || path.normalize(absolute) !== absolute) throw new Error("Unsafe preview path");
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split("/").filter(Boolean)) {
    current = path.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("Symlink preview path rejected");
  }
  return absolute;
}

// Read-only Git commands, with inherited Git overrides removed. Never checkout/fetch/reset.
export async function proveCheckout(root, relative, commit, primary) {
  if (!SHA.test(commit) || typeof relative !== "string" || !/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(relative)) throw new Error("Unsafe registered checkout");
  await noSymlinks(root);
  const checkout = await noSymlinks(path.join(root, relative));
  if (checkout === primary || primary.startsWith(`${checkout}/`)) throw new Error("Primary checkout cannot be a preview");
  await noSymlinks(path.join(checkout, ".git"));
  await noSymlinks(path.join(checkout, "prototype", "server.js"));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0" };
  const git = async (args) => (await exec("git", ["-c", "core.fsmonitor=false", ...args], { cwd: checkout, env, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout.trim();
  if (await git(["rev-parse", "--show-toplevel"]) !== checkout || await git(["rev-parse", "HEAD"]) !== commit) throw new Error("Revision mismatch: checkout HEAD");
  if (await git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("Checkout must be clean and immutable");
  const tracked = await git(["ls-files", "--stage", "-z"]);
  for (const item of tracked.split("\0").filter(Boolean)) {
    const separator = item.indexOf("\t");
    if (separator < 0 || /^(120000|160000) /.test(item)) throw new Error("Symlink or submodule checkout content rejected");
    await noSymlinks(path.join(checkout, item.slice(separator + 1)));
  }
  return checkout;
}

export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return null;
  try {
    const [stat, boot, cwd, command, environment] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"), readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readlink(`/proc/${pid}/cwd`), readFile(`/proc/${pid}/cmdline`, "utf8"), readFile(`/proc/${pid}/environ`, "utf8"),
    ]);
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { pid, start: fields[19], boot: boot.trim(), cwd, command, generation: environment.split("\0").find((s) => s.startsWith("FM_PREVIEW_GENERATION="))?.split("=")[1] || "" };
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return null;
    throw new Error("Process identity unknown; operator reconciliation required");
  }
}
function validIdentity(value) {
  return Boolean(value && Number.isSafeInteger(value.pid) && value.pid > 0 && /^\d+$/.test(value.start) &&
    typeof value.boot === "string" && value.boot && typeof value.cwd === "string" && path.isAbsolute(value.cwd) &&
    typeof value.command === "string" && value.command && typeof value.generation === "string");
}
export function sameIdentity(a, b) {
  return Boolean(validIdentity(a) && validIdentity(b) && ["pid", "start", "boot", "cwd", "command", "generation"].every((key) => a[key] === b[key]));
}
async function jsonRead(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(await handle.readFile("utf8")); } finally { await handle.close(); }
}
async function jsonWrite(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
  await rename(temp, file);
}
async function runtimeDirectories(root, id) {
  // Durable HOME/cache is not source content: helper writes must not poison the
  // next immutable-checkout proof. These directories survive every generation.
  let directory = root;
  for (const part of [".agentos-runtime", id]) {
    await noSymlinks(directory);
    directory = path.join(directory, part);
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await noSymlinks(directory);
  }
  const result = {};
  for (const [variable, name] of Object.entries({ HOME: "home", XDG_CACHE_HOME: "cache", XDG_CONFIG_HOME: "config", XDG_DATA_HOME: "data", TMPDIR: "tmp" })) {
    const location = path.join(directory, name);
    await mkdir(location, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    await noSymlinks(location);
    result[variable] = location;
  }
  return result;
}
function bounded(value, fallback, min, max) {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error("Invalid lifecycle bound");
  return n;
}

export class PreviewLifecycle {
  constructor(entries, { root, primary, mainCommit, hostId = "main", env = {}, idleMs, startMs, stopMs, portMin, portMax,
    now = Date.now, identity = processIdentity, launch = spawn, prove = proveCheckout, health = previewHealth, relation = commitRelation } = {}) {
    this.entries = new Map(entries.map((entry) => [entry.id, entry]));
    this.states = new Map(entries.map((entry) => [entry.id, { state: "stopped", reason: entry.checkout ? "Select to start isolated preview" : "Not provisioned" }]));
    this.root = root; this.primary = primary; this.mainCommit = mainCommit; this.hostId = hostId; this.env = env;
    this.hostLabel = hostId === "main" ? "Main" : "UAT";
    this.idleMs = bounded(idleMs, 300000, 1000, 1800000);
    this.startMs = bounded(startMs, 15000, 100, 60000);
    this.stopMs = bounded(stopMs, 3000, 50, 10000);
    this.portMin = bounded(portMin, 43000, 1024, 65535);
    this.portMax = bounded(portMax, 43031, this.portMin, 65535);
    this.now = now; this.identity = identity; this.launch = launch; this.prove = prove; this.health = health; this.relation = relation;
    this.relations = new Map(entries.map((entry) => [entry.id, entry.remoteCheckpoint == null ? "absent" : entry.commit === entry.remoteCheckpoint ? "equal" : "unknown"]));
    this.ownerGeneration = randomUUID(); this.pending = null; this.owned = null; this.closed = false;
    this.ready = this.initialize().catch(() => { this.problem = "Controller recovery unavailable; operator reconciliation required"; });
    this.timer = setInterval(() => this.tick().catch(() => { this.problem = `Cleanup failed; ${this.hostLabel} remains available`; }), 250);
    this.timer.unref();
  }
  async initialize() {
    if (!this.root) return;
    await noSymlinks(this.root);
    this.lock = path.join(this.root, ".agentos-controller");
    this.recordFile = path.join(this.lock, "child.json");
    try { await mkdir(this.lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await noSymlinks(this.lock);
      const owner = await jsonRead(path.join(this.lock, "owner.json"));
      if (!validIdentity(owner)) throw new Error("Unknown controller record");
      const live = await this.identity(owner.pid);
      if (live) throw new Error(sameIdentity(owner, live) ? "Controller already active" : "Unknown controller identity");
      // Atomically claim stale ownership; simultaneous recovering controllers cannot both win.
      await mkdir(path.join(this.lock, "recovery"), { mode: 0o700 });
      this.recoveryClaim = true;
    }
    this.lockOwned = true;
    await jsonWrite(path.join(this.lock, "owner.json"), await this.identity(process.pid));
    try {
      const record = await jsonRead(this.recordFile);
      if (!validIdentity(record.identity)) throw new Error("Incomplete child identity");
      const live = await this.identity(record.identity.pid);
      if (live) {
        this.orphan = record;
        this.problem = sameIdentity(live, record.identity) ? "Previous child exiting; waiting for exact identity to disappear" : "Unknown child identity; operator reconciliation required";
      } else await unlink(this.recordFile);
    } catch (error) { if (error.code !== "ENOENT") { this.problem = "Unknown child record; operator reconciliation required"; } }
  }
  updateHostRevision(commit) {
    if (this.hostId !== "uat") return;
    const entry = this.entries.get("uat");
    if (entry) this.entries.set("uat", Object.freeze({ ...entry, commit }));
    this.mainCommit = commit;
  }
  list() {
    return [...this.entries.values()].map((entry) => {
      const status = this.states.get(entry.id);
      const relation = this.relations.get(entry.id);
      const aligned = relation === "equal";
      const host = entry.id === this.hostId && entry.commit === this.mainCommit && (this.hostId !== "main" || aligned);
      const state = host ? "ready" : entry.id === this.hostId ? "revision-mismatch" :
        entry.id.startsWith("dev-") && status.state === "stopped" && !aligned ? "revision-mismatch" : status.state;
      return { id: entry.id, name: entry.name, branch: entry.branch, commit: entry.commit, remoteCheckpoint: entry.remoteCheckpoint,
        relation, captured: entry.id.startsWith("dev-") ? aligned : null,
        validation: entry.id.startsWith("dev-") && !aligned ? "not captured" : entry.validation,
        ...status, state, health: ["ready", "idling"].includes(state) ? "running" : "stopped",
        freshness: host ? "current" : status.checkedAt ? (this.now() - Date.parse(status.checkedAt) < 5000 ? "current" : "stale") : "unknown", idleMs: this.idleMs,
        reason: host ? (this.hostId === "main" ? "Warm Main · stable gateway" : "Local UAT · stable gateway; not Main or published UAT") : entry.id === this.hostId ? (this.hostId === "main" ? "Local Main differs from authoritative remote Main; not previewable" : "Host revision differs from registered UAT; not previewable") :
          entry.id.startsWith("dev-") && !aligned ? "Development local/remote mismatch: not durably captured or previewable" : this.problem || status.reason,
        activeRequests: this.owned?.id === entry.id ? this.owned.active : 0 };
    });
  }
  status(id) { return this.list().find((entry) => entry.id === id); }
  set(id, state, reason, extra = {}) { this.states.set(id, { ...this.states.get(id), state, reason, ...extra }); }
  async select(id) {
    await this.ready;
    if (!this.entries.has(id)) return { accepted: false, error: "Unknown preview" };
    if (id === this.hostId) return { ...this.status(id), accepted: this.status(id).state === "ready" };
    if (this.closed || this.problem) return { ...this.status(id), accepted: false, state: "busy", reason: this.problem || "Controller closing" };
    if (this.pending) return { ...this.status(id), accepted: this.pending.id === id, operation: this.pending.id === id ? this.pending.operation : null, reason: this.pending.id === id ? this.status(id).reason : "Busy: another tab is selecting a version" };
    if (this.owned?.id === id && ["ready", "idling"].includes(this.status(id).state)) {
      const release = this.acquire(id);
      if (!release) return { ...this.status(id), accepted: false, reason: "Busy: retiring preview" };
      try { if (await this.verify(id)) { release(true); return { ...this.status(id), accepted: true }; } }
      finally { release(false); }
    }
    const entry = this.entries.get(id);
    if (!this.root || !entry.checkout) {
      this.set(id, "failed", "Preview is not provisioned; ask the operator to register an isolated checkout");
      return { ...this.status(id), accepted: false };
    }
    const operation = randomUUID();
    this.pending = { id, operation, previous: this.owned?.id || null, validated: false };
    this.set(id, "starting", "Validating registered immutable checkout", { operation, previous: this.pending.previous, checkedAt: null });
    this.job = this.prepare(entry, this.pending);
    return { ...this.status(id), accepted: true };
  }
  async prepare(entry, pending) {
    try {
      pending.checkout = await this.prove(this.root, entry.checkout, entry.commit, this.primary);
      this.relations.set(entry.id, await this.relation(entry.commit, entry.remoteCheckpoint, pending.checkout));
      if (entry.id.startsWith("dev-") && this.relations.get(entry.id) !== "equal") throw new Error("Revision mismatch: development remote checkpoint");
      if (this.closed) throw new Error("Controller closing");
      pending.validated = true;
      if (this.owned) this.set(entry.id, "busy", "Waiting for current preview to finish requests and reach its idle deadline");
      await this.tick();
    } catch (error) { this.fail(entry.id, error); }
  }
  fail(id, error) {
    const mismatch = /Revision mismatch/.test(error.message);
    const reason = mismatch ? "Revision mismatch: exact checkout and runtime proof required" : /clean and immutable/.test(error.message)
      ? `Checkout changed: operator must restore it offline before retrying. ${this.hostLabel} remains available`
      : `Start failed. ${this.hostLabel} is available; retry or explicitly return to the previous version`;
    this.set(id, mismatch ? "revision-mismatch" : "failed", reason, { checkedAt: null });
    this.pending = null;
  }
  acquire(id) {
    const owned = this.owned;
    if (!owned || owned.id !== id || !["ready", "idling"].includes(this.status(id).state) || owned.stopping) return null;
    owned.active++;
    this.set(id, "ready", "Serving isolated preview");
    let released = false;
    return (used = false) => {
      if (released) return;
      released = true; owned.active--;
      if (used) owned.lastUse = this.now();
    };
  }
  runtime(id) {
    return this.owned?.id === id ? { ...this.entries.get(id), url: `http://127.0.0.1:${this.owned.port}` } : null;
  }
  async verify(id) {
    if (!this.owned || this.owned.id !== id) return false;
    const owned = this.owned;
    if (owned.exited || !sameIdentity(owned.identity, await this.identity(owned.child.pid))) {
      this.set(id, "failed", `Child exited or identity changed; ${this.hostLabel} remains available`, { checkedAt: null }); return false;
    }
    const proof = await this.health(this.runtime(id));
    if (this.owned !== owned) return false;
    if (proof.health !== "running") {
      if (!owned.starting || proof.state === "revision-mismatch") this.set(id, proof.state || "failed", proof.reason || "Preview health failed", { checkedAt: null });
      return false;
    }
    this.set(id, "ready", "Exact revision verified", { checkedAt: proof.checkedAt });
    return true;
  }
  async tick() {
    await this.ready;
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      if (this.orphan) {
        const live = await this.identity(this.orphan.identity.pid);
        if (!live) { await unlink(this.recordFile); this.orphan = null; this.problem = null; }
        // Never signal or adopt a record from another controller generation.
      }
      if (this.problem) return;
      const owned = this.owned;
      if (owned?.exited && !owned.starting && owned.active === 0) {
        await this.stopOwned(owned);
        this.set(owned.id, "failed", `Preview crashed. Retry explicitly; ${this.hostLabel} remains warm`, { checkedAt: null });
      } else if (owned && !owned.starting && owned.active === 0 && this.now() - owned.lastUse >= this.idleMs) {
        this.set(owned.id, "idling", "Idle deadline reached; retiring exact owned child");
        await this.stopOwned(owned);
      } else if (owned && !owned.starting && owned.active === 0 && this.status(owned.id).state === "ready") {
        this.set(owned.id, "idling", "No active requests; checkout and drafts are retained");
      }
      if (!this.owned && this.pending?.validated) await this.start(this.pending);
    } finally { this.ticking = false; }
  }
  async start(pending) {
    const entry = this.entries.get(pending.id);
    try {
      // Repeat proof after the idle wait, immediately before the fixed launch.
      const checkout = await this.prove(this.root, entry.checkout, entry.commit, this.primary);
      this.relations.set(entry.id, await this.relation(entry.commit, entry.remoteCheckpoint, checkout));
      if (entry.id.startsWith("dev-") && this.relations.get(entry.id) !== "equal") throw new Error("Revision mismatch: development remote checkpoint");
      const port = entry.port ?? this.portMin;
      if (port < this.portMin || port > this.portMax) throw new Error("Port outside controller bounds");
      const directories = await runtimeDirectories(this.root, entry.id);
      const generation = randomUUID();
      const intent = { generation, checkout, commit: entry.commit, port, id: entry.id, identity: null };
      await jsonWrite(this.recordFile, intent); // Crash in the spawn/record gap is quarantined, never guessed.
      this.set(entry.id, "starting", "Starting on loopback; waiting for exact revision health");
      const child = this.launch(process.execPath, [LAUNCHER], {
        cwd: checkout, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: { PATH: process.env.PATH, ...directories, HOST: "127.0.0.1", PORT: String(port),
          FM_PREVIEW_GENERATION: generation, FM_PREVIEW_COMMIT: entry.commit,
          ...(this.env.FM_HOME ? { FM_HOME: this.env.FM_HOME } : {}),
          ...(this.env.FM_QUARTERDECK_STATE_PATH ? { FM_QUARTERDECK_STATE_PATH: this.env.FM_QUARTERDECK_STATE_PATH } : {}) },
      });
      const owned = { ...intent, child, active: 0, lastUse: this.now(), starting: true, exited: false };
      this.owned = owned;
      child.on("error", () => { if (!child.pid) owned.exited = true; });
      child.on("exit", () => { owned.exited = true; });
      // The repository-owned child announces its own listener; a port squatter cannot supply this evidence.
      owned.listening = false;
      child.on("message", (message) => { if (message?.generation === generation && message?.port === port && message?.commit === entry.commit) owned.listening = true; });
      for (let i = 0; i < 20 && !owned.identity && !owned.exited; i++) {
        owned.identity = await this.identity(child.pid);
        if (!owned.identity) await sleep(10);
      }
      if (!owned.identity || owned.identity.generation !== generation || owned.identity.cwd !== checkout) throw new Error("Child identity not proven");
      await jsonWrite(this.recordFile, { ...intent, identity: owned.identity });
      const deadline = Date.now() + this.startMs;
      while (!owned.exited && Date.now() < deadline && !this.closed) {
        if (owned.listening && await this.verify(entry.id)) {
          owned.starting = false; owned.lastUse = this.now(); this.pending = null; return;
        }
        if (this.status(entry.id).state === "revision-mismatch") throw new Error("Revision mismatch: runtime");
        await sleep(50);
      }
      throw new Error("Start deadline exceeded or child exited");
    } catch (error) {
      if (this.owned) {
        this.owned.starting = false;
        try { await this.stopOwned(this.owned); } catch { this.problem = `Exact child cleanup unconfirmed; alternate starts blocked; ${this.hostLabel} remains available`; }
      }
      this.fail(entry.id, error);
    }
  }
  async stopOwned(owned) {
    if (this.owned !== owned || owned.active > 0) throw new Error("Active or unowned child cannot stop");
    owned.stopping = true;
    const signal = async (name) => {
      if (owned.exited) return;
      const current = await this.identity(owned.child.pid);
      if (!current) { owned.exited = true; return; }
      if (!sameIdentity(current, owned.identity) || current.generation !== owned.generation) throw new Error("Unknown process identity; not signalled");
      // ChildProcess retains its own exit state; never signal a PID read from disk or a port owner.
      owned.child.kill(name);
    };
    const wait = async () => { const until = Date.now() + this.stopMs; while (!owned.exited && Date.now() < until) await sleep(20); };
    await signal("SIGTERM"); await wait();
    if (!owned.exited) { await signal("SIGKILL"); await wait(); }
    if (!owned.exited) throw new Error("Owned child did not exit");
    await unlink(this.recordFile);
    this.owned = null;
    this.set(owned.id, "stopped", "Stopped; isolated checkout and durable data retained", { checkedAt: null });
  }
  close() {
    this.closingPromise ??= this.finishClose();
    return this.closingPromise;
  }
  async finishClose() {
    this.closed = true; clearInterval(this.timer); await this.ready;
    while (this.ticking) await sleep(20);
    await this.job;
    while (this.owned?.active > 0) await sleep(25);
    if (this.owned) await this.stopOwned(this.owned);
    if (this.lockOwned && !this.problem && !this.orphan) {
      if (this.recoveryClaim) await rmdir(path.join(this.lock, "recovery"));
      await unlink(path.join(this.lock, "owner.json")); await rmdir(this.lock);
    }
  }
}
