// Explicit operator-only onboarding. The HTTP server and skills never call this.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

import { LEGACY_BASE_PREFERENCES, LEGACY_QUARTERDECK_BASE_PREFERENCES } from "./onboarding-legacy.js";

export const CURRENT_VERSION = 3;
export const BASE_PREFERENCES = `# Working preferences

## Quarterdeck base skill preferences
Provenance: Quarterdeck-owned defaults from fm-quarterdeck/prototype/onboarding.js; preference schema v3.
Reason: Help discovered Quarterdeck skills work together without replacing user choices. User-authored preferences and explicit task/role authority take precedence; ask on conflicts.

- Use the installed /fmqd-lanes skill for captain-facing lane envelopes. These are display/navigation hints, not authority or causal work boundaries.
- Use /fmqd-toolcheck when deliberately requested to audit the installed bootstrap's declared tools, read-only; discovery is not permission to install or upgrade.
- Deliberately consider activating /fmqd-quartermaster at meaningful checkpoints: recurring failures, regressions, changed assumptions, expanding machinery without better proof, evidence-neutral retries, or material resource exposure. State why the checkpoint merits a review; do not run on every small change. If the skill is unavailable, report that rather than inventing its execution.
- For Quartermaster, define the evaluation cohort using shared objectives, state owners, dependencies, evidence and resource exposure. Related labeled and unlabeled work across lanes/epics may belong to one evaluation; labels and individual workers are not automatic causal boundaries. Include/exclude adjacent work with reasons and ask the decision owner when ambiguity matters.
- Quartermaster runs once and reports advisory recommendations, then stops. It is not a daemon, hook, scheduler, continuously running review, automatic retry or implementation authority. Any investigation needs existing authorization and explicit bounds; worker roles cannot acquire delegation authority from this preference.
- These preferences grant no standing authority for merges, signing, deployment, package execution, cloud mutation, cleanup, paid retries or other consequential actions. Use the canonical discovered skills, not copied skill instructions in this record.
`;
export const OWNED_VERSIONS = Object.freeze({ 1: LEGACY_BASE_PREFERENCES, 2: LEGACY_QUARTERDECK_BASE_PREFERENCES, 3: BASE_PREFERENCES });
const MARKER = "fm-agentos-preferences";
const MAX_BYTES = 128 * 1024;
const digest = (text) => createHash("sha256").update(text).digest("hex");

export function ownedBlock(version, body) {
  return `<!-- ${MARKER}:begin v${version} sha256=${digest(body)} -->\n${body}<!-- ${MARKER}:end -->\n`;
}

// Retain earlier exact templates here when releasing a new version. Only known,
// byte-intact blocks can be migrated; a digest alone is not ownership evidence.
export function preferencePlan(text, { remove = false, versions = OWNED_VERSIONS, currentVersion = CURRENT_VERSION } = {}) {
  const occurrences = [...text.matchAll(/fm-agentos-preferences/g)];
  const matches = [...text.matchAll(/<!-- fm-agentos-preferences:begin v([1-9]\d*) sha256=([a-f0-9]{64}) -->\n([\s\S]*?)<!-- fm-agentos-preferences:end -->\n/g)];
  if (occurrences.length && (occurrences.length !== 2 || matches.length !== 1)) {
    throw new Error("Malformed or ambiguous Quarterdeck ownership markers; resolve manually without overwriting user text.");
  }
  const found = matches[0];
  if (found && (versions[found[1]] !== found[3] || digest(found[3]) !== found[2])) {
    throw new Error("Quarterdeck block is edited or its version is unrecognized; refusing migration/removal.");
  }
  const block = remove ? "" : ownedBlock(currentVersion, versions[currentVersion]);
  let next;
  if (found) next = text.slice(0, found.index) + block + text.slice(found.index + found[0].length);
  else if (remove) next = text;
  else next = text + block; // No bytes outside the boundary are inserted or changed.
  return { next, block, changed: next !== text, action: remove ? "remove" : found ? "update" : "seed" };
}

function identity(info) {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs, info.nlink].map(String).join(":");
}
function inspectPath(target, directory) {
  const info = fs.lstatSync(target, { bigint: true });
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (!directory && info.nlink !== 1n)) {
    throw new Error("Refusing symlink, hard-linked file or unexpected path type.");
  }
  return identity(info);
}
function validateHome(home, authoritativeHome) {
  if (typeof home !== "string" || !path.isAbsolute(home) || path.normalize(home) !== home || home.endsWith(path.sep) || home === path.parse(home).root) {
    throw new Error("Select a normalized absolute Firstmate home, not a root or relative path.");
  }
  // Compare strings before inspecting anything: never discover another home to
  // resolve a mismatch with the explicitly configured authority.
  if (authoritativeHome && home !== authoritativeHome) throw new Error("Selected home differs from authoritative FM_HOME; unset it deliberately to rebind.");
  const dirs = [];
  let cursor = path.parse(home).root;
  dirs.push([cursor, inspectPath(cursor, true)]);
  for (const component of home.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, component);
    dirs.push([cursor, inspectPath(cursor, true)]);
  }
  // Same minimal live-home shape as the dashboard's sources; no other home,
  // endpoints, executables or private records are searched or read.
  for (const name of ["data", "state"]) dirs.push([path.join(home, name), inspectPath(path.join(home, name), true)]);
  const projects = path.join(home, "data/projects.md");
  dirs.push([projects, inspectPath(projects, false)]);
  return dirs;
}
function snapshot(home, authoritativeHome) {
  const paths = validateHome(home, authoritativeHome);
  const dataFd = fs.openSync(path.join(home, "data"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const target = `/proc/self/fd/${dataFd}/captain.md`;
  let info;
  let bytes = Buffer.alloc(0);
  try {
    if (identity(fs.fstatSync(dataFd, { bigint: true })) !== paths.find(([name]) => name === path.join(home, "data"))[1]) throw new Error("Home changed before inspection.");
    try {
      info = inspectPath(target, false);
      const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const stat = fs.fstatSync(fd, { bigint: true });
        if (identity(stat) !== info || stat.size > BigInt(MAX_BYTES)) throw new Error("Preference record changed or is oversized.");
        bytes = fs.readFileSync(fd);
        if (bytes.length > MAX_BYTES || identity(fs.fstatSync(fd, { bigint: true })) !== info || inspectPath(target, false) !== info) throw new Error("Preference record changed during inspection.");
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (info !== undefined) throw new Error("Preference record disappeared during inspection.");
      info = null;
    }
    if (JSON.stringify(stablePaths(paths)) !== JSON.stringify(stablePaths(validateHome(home, authoritativeHome)))) throw new Error("Home changed during inspection.");
  } finally { fs.closeSync(dataFd); }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\0")) throw new Error("Preference record contains NUL bytes.");
  return { paths, info, text, token: digest(JSON.stringify({ paths: stablePaths(paths), info, bytes: digest(bytes) })) };
}

export function previewOnboarding(home, { authoritativeHome, remove = false } = {}) {
  const before = snapshot(home, authoritativeHome);
  const plan = preferencePlan(before.text, { remove });
  if (Buffer.byteLength(plan.next) > MAX_BYTES) throw new Error("Result exceeds the Preferences size limit.");
  return Object.freeze({ home, authoritativeHome, remove, token: before.token, action: plan.action, changed: plan.changed, block: plan.block });
}

export function applyOnboarding(preview, confirmation) {
  const expected = `${preview.remove ? "remove" : "seed"} ${preview.home}`;
  if (confirmation !== expected) throw new Error("Confirmation did not match the selected home; nothing written.");
  // Pin the validated directory: Linux /proc/self/fd paths prevent a parent
  // swap from redirecting publication or cleanup into a different home.
  // Existing locks are never reclaimed automatically, even if apparently stale.
  const beforeLock = snapshot(preview.home, preview.authoritativeHome);
  if (beforeLock.token !== preview.token) throw new Error("Home or preferences changed since preview; preview again.");
  const dataFd = fs.openSync(path.join(preview.home, "data"), fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const pinned = `/proc/self/fd/${dataFd}`;
  const lock = `${pinned}/.agentos-preferences.lock`;
  const target = `${pinned}/captain.md`;
  let lockFd;
  let temporary;
  try {
    if (identity(fs.fstatSync(dataFd, { bigint: true })) !== beforeLock.paths.find(([name]) => name === path.join(preview.home, "data"))[1]) throw new Error("Home changed before locking.");
    lockFd = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    const before = snapshot(preview.home, preview.authoritativeHome);
    // Creating our lock changes data's timestamps, but not its identity. Compare
    // file bytes/metadata and all path identities, excluding directory times.
    if (!sameSnapshot(beforeLock, before)) throw new Error("Home or preferences changed while locking.");
    const plan = preferencePlan(before.text, { remove: preview.remove });
    if (!plan.changed) return { changed: false, action: plan.action };
    temporary = `${pinned}/.agentos-preferences-${randomUUID()}.tmp`;
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, plan.next); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const latest = snapshot(preview.home, preview.authoritativeHome);
    if (!sameSnapshot(before, latest)) throw new Error("Unsafe concurrent replacement; nothing replaced.");
    if (before.info === null) {
      // No-clobber publication for an absent file, even if another writer wins.
      fs.linkSync(temporary, target);
      fs.unlinkSync(temporary);
    } else {
      // Requires the operator's exclusive-access confirmation (see CLI/docs).
      // Synchronous final check + rename avoids yielding to another onboarding
      // run; the exclusive lock serializes all cooperating onboarding writers.
      fs.chmodSync(temporary, Number(fs.lstatSync(target).mode) & 0o777);
      if (!sameSnapshot(before, snapshot(preview.home, preview.authoritativeHome))) throw new Error("Unsafe concurrent replacement; nothing replaced.");
      fs.renameSync(temporary, target);
    }
    temporary = undefined;
    fs.fsyncSync(dataFd);
    return { changed: true, action: plan.action };
  } finally {
    if (temporary && fs.existsSync(temporary)) fs.unlinkSync(temporary);
    try {
      if (lockFd !== undefined) {
        const owned = identity(fs.fstatSync(lockFd, { bigint: true }));
        fs.closeSync(lockFd);
        if (inspectPath(lock, false) !== owned) throw new Error("Lock changed; refusing unsafe cleanup.");
        fs.unlinkSync(lock);
      }
    } finally { fs.closeSync(dataFd); }
  }
}

function stablePaths(paths) {
  return paths.map(([name, info], i) => [name, i === paths.length - 1 ? info : info.split(":").slice(0, 3)]);
}
function sameSnapshot(a, b) {
  return a.info === b.info && a.text === b.text && JSON.stringify(stablePaths(a.paths)) === JSON.stringify(stablePaths(b.paths));
}
