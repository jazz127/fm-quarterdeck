import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const defaultAgentStatePath = fileURLToPath(new URL("./data/agent-state.json", import.meta.url));
// A product rename must not silently select a different private state owner.
export function configuredStatePath(env = {}) {
  const current = env.FM_QUARTERDECK_STATE_PATH;
  const legacy = env.FM_AGENTOS_STATE_PATH;
  if (current && legacy && current !== legacy) throw new Error("Conflicting Quarterdeck state owners; select one explicit path");
  return current || legacy || defaultAgentStatePath;
}
export const fingerprint = (...parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const id = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$/.test(value);
const label = (value) => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 120 && !/[\x00-\x1f/\\]/.test(value);
const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const keys = (obj, allowed) => obj && typeof obj === "object" && !Array.isArray(obj) && Object.keys(obj).every((key) => allowed.includes(key));
export const emptyAgentState = () => ({ schema: "fm-agentos-state.v1", repositories: [], assignments: {}, acknowledgements: {} });

export function validateAgentState(state) {
  if (!keys(state, ["schema", "repositories", "assignments", "acknowledgements", "completionRecords"]) || state.schema !== "fm-agentos-state.v1" || !Array.isArray(state.repositories) || state.repositories.length > 100 || !keys(state.assignments, Object.keys(state.assignments || {})) || !keys(state.acknowledgements, Object.keys(state.acknowledgements || {}))) throw new Error("Invalid Quarterdeck state schema");
  const repos = new Map();
  for (const repo of state.repositories) {
    if (!keys(repo, ["id", "name", "path", "lanes", "remote", "github", "destinations", "aliases"]) || !id(repo.id) || !label(repo.name) || typeof repo.path !== "string" || !path.isAbsolute(repo.path) || path.normalize(repo.path) !== repo.path || repos.has(repo.id) || [...repos.values()].some((other) => other.path === repo.path) || !Array.isArray(repo.lanes) || repo.lanes.length > 100 || (repo.remote !== undefined && !/^[a-zA-Z0-9._-]{1,80}$/.test(repo.remote)) || (repo.github !== undefined && !/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(repo.github))) throw new Error("Invalid repository taxonomy");
    if (repo.destinations !== undefined && (!Array.isArray(repo.destinations) || repo.destinations.length > 10 || repo.destinations.some((entry) => !keys(entry, ["environment", "tier"]) || !label(entry.environment) || !["uat", "production"].includes(entry.tier)) || new Set(repo.destinations.map((entry) => entry.environment)).size !== repo.destinations.length)) throw new Error("Invalid deployment destinations");
    if (repo.aliases !== undefined && (!Array.isArray(repo.aliases) || repo.aliases.length > 30 || repo.aliases.some((alias) => !label(alias)) || new Set(repo.aliases).size !== repo.aliases.length || [...repos.values()].some((other) => other.aliases?.some((alias) => repo.aliases.includes(alias))))) throw new Error("Invalid repository aliases");
    repos.set(repo.id, repo);
    const lanes = new Set();
    for (const lane of repo.lanes) {
      if (!keys(lane, ["id", "name", "themes"]) || !id(lane.id) || lane.id === "unclassified" || !label(lane.name) || lanes.has(lane.id) || !Array.isArray(lane.themes) || lane.themes.length > 100) throw new Error("Invalid lane taxonomy");
      lanes.add(lane.id);
      const themes = new Set();
      for (const theme of lane.themes) {
        if (!keys(theme, ["id", "name", "kind"]) || !id(theme.id) || theme.id === "unclassified" || !label(theme.name) || !["theme", "iteration"].includes(theme.kind) || themes.has(theme.id)) throw new Error("Invalid theme taxonomy");
        themes.add(theme.id);
      }
    }
  }
  if (Object.keys(state.assignments).length > 20000 || Object.keys(state.acknowledgements).length > 50000) throw new Error("Quarterdeck state too large");
  for (const [task, assignment] of Object.entries(state.assignments)) {
    const repo = repos.get(assignment?.repositoryId);
    const lane = repo?.lanes.find((item) => item.id === assignment?.laneId);
    if (!hash(task) || !keys(assignment, ["repositoryId", "laneId", "themeId"]) || !lane || !lane.themes.some((item) => item.id === assignment.themeId)) throw new Error("Invalid task assignment");
  }
  for (const [completion, ack] of Object.entries(state.acknowledgements)) {
    if (!hash(completion) || !keys(ack, ["taskFingerprint", "acknowledgedAt"]) || !hash(ack.taskFingerprint) || typeof ack.acknowledgedAt !== "string" || !Number.isFinite(Date.parse(ack.acknowledgedAt))) throw new Error("Invalid completion acknowledgement");
  }
  if (state.completionRecords !== undefined) {
    if (!keys(state.completionRecords, Object.keys(state.completionRecords || {})) || Object.keys(state.completionRecords).length > 50000) throw new Error("Invalid completion records");
    for (const [sourceFingerprint, record] of Object.entries(state.completionRecords)) {
      if (!hash(sourceFingerprint) || !keys(record, ["taskFingerprint", "commit", "pullRequest"]) || !hash(record.taskFingerprint) || !/^[a-f0-9]{40}$/.test(record.commit || "") || (record.pullRequest !== undefined && !/^[1-9]\d*$/.test(String(record.pullRequest)))) throw new Error("Invalid exact completion binding");
    }
  }
  return state;
}

// Lock is shared across processes/tabs. Never steal a lock from an uncertain writer.
// A crash before rename leaves the previous complete document; abandoned locks fail safely.
export function createAgentStateOwner(file = defaultAgentStatePath) {
  if (typeof file !== "string" || !path.isAbsolute(file)) throw new Error("Quarterdeck state path must be absolute");
  async function read() {
    try {
      const info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4 * 1024 * 1024) throw new Error("Invalid Quarterdeck state file");
      return validateAgentState(JSON.parse(await readFile(file, "utf8")));
    } catch (error) { if (error.code === "ENOENT") return emptyAgentState(); throw error; }
  }
  async function update(change) {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    let lock;
    for (let attempt = 0; attempt < 50; attempt++) {
      try { lock = await open(`${file}.lock`, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST") throw error; await new Promise((resolve) => setTimeout(resolve, 20)); }
    }
    if (!lock) throw new Error("Quarterdeck state busy; retry later");
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      const state = await read();
      const result = await change(state);
      validateAgentState(state);
      const serialized = JSON.stringify(state, null, 2) + "\n";
      if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Error("Quarterdeck state too large");
      const handle = await open(temp, "wx", 0o600);
      try { await handle.writeFile(serialized); await handle.sync(); } finally { await handle.close(); }
      await rename(temp, file);
      const directory = await open(path.dirname(file), "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return result;
    } finally { await unlink(temp).catch(() => {}); await lock.close(); await unlink(`${file}.lock`); }
  }
  return { read, update,
    acknowledge: (taskFingerprint, completionFingerprint) => update((state) => {
      if (!hash(taskFingerprint) || !hash(completionFingerprint)) throw new Error("Invalid completion identity");
      const prior = state.acknowledgements[completionFingerprint];
      if (prior && prior.taskFingerprint !== taskFingerprint) throw new Error("Completion identity conflict");
      return state.acknowledgements[completionFingerprint] ||= { taskFingerprint, acknowledgedAt: new Date().toISOString() };
    }),
  };
}
