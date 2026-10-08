import path from "node:path";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { createConcurrencyLimiter, endpointIsLive, foldStatusLines, hasProcessIdentity, safeWorkNote } from "./work-model.js";

const MAX_BYTES = 256 * 1024;
const MAX_ITEMS = 64;
const limitProbe = createConcurrencyLimiter(4);

// Only the structured registry suffix supplies location and scope. Keep malformed
// identities so a persistent supervisor cannot become an ordinary task by accident.
export function parseSecondmates(text) {
  const mates = new Map();
  for (const line of text.split(/\r?\n/)) {
    const id = line.match(/^- ([A-Za-z0-9][A-Za-z0-9._-]*)(?:\s|$)/)?.[1];
    if (!id) continue;
    const entry = line.match(/^- \S+ - (.+) \((?:(?:host: ([^;]+); root: ([^;]+); ))?home: ([^;]+); scope: (.+); projects: ([^;]*); added (\d{4}-\d{2}-\d{2})\)\s*$/);
    const [, summary, host, root, home, scope, projects] = entry || [];
    const valid = Boolean(home && path.isAbsolute(home.trim()) && scope?.trim()
      && (!host || (/^[A-Za-z0-9._-]+$/.test(host.trim()) && path.isAbsolute(root.trim()))));
    const record = { id, registered: true, summary: summary?.trim(), scope: scope?.trim(), projects: projects?.trim(), home: valid ? home.trim() : null,
      remote: Boolean(host), warning: valid ? null : "Registry entry unavailable or malformed" };
    mates.set(id, mates.has(id) ? { id, registered: true, warning: "Duplicate registry identity" } : record);
  }
  return mates;
}

export function countSecondmateBacklog(text, excludedIds = new Set()) {
  let section = "", openWork = 0, captainCalls = 0;
  for (const line of text.split(/\r?\n/)) {
    const heading = line.match(/^##\s+(.+?)\s*$/);
    if (heading) section = heading[1].trim().toLowerCase();
    const item = line.match(/^\s*-\s+\[ \]\s+(\S+)\s+-\s+(.+)$/);
    if (!item || /^(done|completed|closed)\b/.test(section) || excludedIds.has(item[1])) continue;
    openWork++;
    if (/\(hold-kind:\s*captain\s*\)/i.test(item[2])) captainCalls++;
  }
  return { openWork, captainCalls };
}

// Child homes are read-only. Resolve confinement before opening a bounded regular
// file; do not follow a final symlink or block on a special file.
async function readLedger(home, name) {
  const root = await realpath(home);
  const file = path.join(root, "data", name);
  const relative = path.relative(root, await realpath(file));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Ledger escapes home");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error("Ledger unavailable");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error("Ledger too large");
    return buffer.toString("utf8", 0, size);
  } finally { await handle.close(); }
}

function isRemote(meta) {
  return Boolean(meta.remote_host || meta.host || meta.remote === "true" || meta.backend === "remote" || meta.window?.startsWith("remote:"));
}

export async function readSecondmates(home, stateNames, { reader, parseMeta, probe = endpointIsLive } = {}) {
  const metaById = new Map(await Promise.all(stateNames.filter((name) => name.endsWith(".meta") && !name.startsWith(".")).map(async (name) =>
    [name.slice(0, -5), parseMeta(await reader.text(path.join(home, "state", name)))])));
  let identities = new Map(), warning = null;
  try { identities = parseSecondmates(await readLedger(home, "secondmates.md")); }
  catch (error) { if (error.code !== "ENOENT") warning = "Second mate registry unavailable; showing runtime identities only."; }
  for (const [id, meta] of metaById) {
    if (meta.kind === "secondmate" && !identities.has(id)) identities.set(id, { id, registered: false,
      home: path.isAbsolute(meta.home || "") ? meta.home : null, remote: isRemote(meta) });
  }
  const ids = new Set(identities.keys());
  const items = await Promise.all([...identities.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, MAX_ITEMS).map(async (mate) => {
    const meta = metaById.get(mate.id) || {};
    const remote = mate.remote || isRemote(meta);
    const item = { id: mate.id, registered: mate.registered, summary: safeWorkNote(mate.summary || "Charter not registered"),
      scope: safeWorkNote(mate.scope || "Scope not registered"), projects: safeWorkNote(mate.projects), location: remote ? "remote" : mate.home ? "local" : "unknown",
      state: "unknown", stateEvidence: "Liveness unknown", backlog: null, warning: mate.warning || null };
    if (remote) return { ...item, state: "not-read", stateEvidence: "Remote state is not read" };
    if (mate.warning) return item;
    const live = await limitProbe(() => probe(meta));
    if (live === false) { item.state = "unreachable"; item.stateEvidence = "Recorded endpoint is not live"; }
    if (live === true) {
      const lines = stateNames.includes(`${mate.id}.status`) ? (await reader.text(path.join(home, "state", `${mate.id}.status`))).split(/\r?\n/).filter(Boolean) : [];
      const latest = foldStatusLines(lines).latest;
      item.state = latest ? ["working", "active", "in-progress"].includes(latest.state) ? "live" : "idle" : "unknown";
      item.stateEvidence = hasProcessIdentity(meta) ? "Process incarnation matches" : "Live terminal pane; worker process unverified";
    }
    if (mate.home) {
      try { item.backlog = countSecondmateBacklog(await readLedger(mate.home, "backlog.md"), ids); }
      catch { item.warning = "Local backlog unavailable"; }
    }
    return item;
  }));
  if (ids.size > MAX_ITEMS) warning = "Second mate display limited to 64 entries; all known identities remain excluded from work.";
  return { ids, metaById, view: { items, warning } };
}
