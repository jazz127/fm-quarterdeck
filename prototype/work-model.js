import path from "node:path";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fingerprint } from "./agent-state.js";
const exec = promisify(execFile);
export const WORK_STATUSES = ["active", "waiting", "captain-action", "cleanup", "unknown", "backlog", "newly-done", "previously-done"];

export function safeWorkNote(value) {
  const text = String(value || "");
  if (/-----BEGIN [\w ]*PRIVATE KEY-----|\b(?:api[_ -]?key|access[_ -]?token|password|secret|credential)\s*[:=]\s*\S+|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[opusr]_[A-Za-z0-9_]{20,})\b/i.test(text)) return "Sensitive operational detail withheld";
  return text.replace(/(^|[\s("'=])(?:\/(?:[^\s)"'<>])+|[A-Za-z]:\\[^\s)"'<>]+)/g, "$1[private path]");
}

export function resolveRepositoryIdentity(recorded, state, projectPaths = new Map()) {
  const absolute = typeof recorded === "string" && path.isAbsolute(recorded) ? path.normalize(recorded) : null;
  if (absolute) {
    const repository = state.repositories.find((entry) => entry.path === absolute);
    return { repositoryPath: repository?.path || absolute, repository };
  }
  const alias = state.repositories.find((entry) => entry.aliases?.includes(recorded));
  if (alias) return { repositoryPath: alias.path, repository: alias };
  if (typeof recorded !== "string" || !recorded || path.basename(recorded) !== recorded || recorded === "." || recorded === ".." || recorded.includes("\\")) return { repositoryPath: null, repository: undefined };
  const entries = [...projectPaths];
  const exact = entries.filter(([name]) => name === recorded);
  const matches = exact.length ? exact : entries.filter(([name]) => name.toLowerCase() === recorded.toLowerCase());
  const paths = new Set(matches.map(([, value]) => path.normalize(value)));
  const repositoryPath = paths.size === 1 ? [...paths][0] : null;
  const repository = repositoryPath ? state.repositories.find((entry) => entry.path === repositoryPath) : undefined;
  return { repositoryPath, repository };
}

export function foldStatusLines(lines) {
  const events = lines.map((line, index) => {
    const match = line.match(/^([a-z-]+)(?:\s+\[([^\]]+)\])?:\s*(.+)$/i);
    return { state: match?.[1].toLowerCase() || "update", text: match?.[3] || line, line, index, key: match?.[2]?.match(/(?:^|\s)key=([a-zA-Z0-9._-]+)(?=\s|$)/)?.[1] || line.match(/\[key=([a-zA-Z0-9._-]+)\]/)?.[1] || null };
  });
  const open = new Map();
  const resolved = new Set();
  for (const event of events) {
    if (["blocked", "paused", "needs-decision", "waiting"].includes(event.state) && event.key) { open.set(event.key, event); resolved.delete(event.key); }
    else if (event.state === "resolved" && event.key && open.has(event.key)) { open.delete(event.key); resolved.add(event.key); }
  }
  const actionable = events.filter((event) => !["resolved", "update"].includes(event.state) && !(event.key && resolved.has(event.key) && ["blocked", "paused", "needs-decision", "waiting"].includes(event.state)));
  return { latest: actionable.at(-1), completion: events.filter((event) => event.state === "done").at(-1), pendingIssues: [...open.values()].map(({ key, state }) => ({ key, state })) };
}

export function classifyCurrent({ state, inFlight, endpointLive, queued, retained, pendingIssues = [] }) {
  if (pendingIssues.some((issue) => issue.state === "needs-decision")) return "captain-action";
  if (pendingIssues.length) return "waiting";
  if (state === "needs-decision") return "captain-action";
  if (["blocked", "paused", "waiting"].includes(state)) return "waiting";
  if (retained || ["cleanup", "preserved", "retained"].includes(state)) return "cleanup";
  if (state === "done") return "newly-done";
  if (queued && !inFlight) return "backlog";
  if (inFlight && endpointLive === true && ["working", "active", "in-progress"].includes(state)) return "active";
  return "unknown";
}

// PID alone is vulnerable to reuse. Only an exact process incarnation is live evidence.
function validPid(meta) { return /^[1-9]\d*$/.test(meta.worker_pid || ""); }

function darwinStartIdentity(meta) {
  const identity = meta.worker_start_identity || meta.worker_started_at;
  if (!identity) return null;
  const timestamp = Date.parse(identity);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}

export async function endpointIsLive(meta, { platform = process.platform, read = readFile, run = exec } = {}) {
  if (meta.remote_host) return null;
  const processFields = [meta.worker_pid, meta.worker_start_ticks, meta.worker_boot_id, meta.worker_start_identity, meta.worker_started_at];
  if (validPid(meta) && platform === "darwin") {
    const expectedStart = darwinStartIdentity(meta);
    if (expectedStart !== null) {
      try {
        const { stdout } = await run("ps", ["-o", "lstart=", "-o", "stat=", "-p", meta.worker_pid], { encoding: "utf8", timeout: 2500, maxBuffer: 4096 });
        if (!stdout.trim()) return false;
        const match = stdout.trim().match(/^(.+?)\s+([A-Z][A-Za-z+<>-]*)$/);
        if (!match) return null;
        const actualStart = Date.parse(match[1]);
        if (!Number.isFinite(actualStart)) return null;
        return Math.floor(actualStart / 1000) === expectedStart && !/[ZX]/.test(match[2]);
      } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; return null; }
    }
  } else if (validPid(meta) && platform === "linux" && /^\d+$/.test(meta.worker_start_ticks || "") && /^[a-f0-9-]{36}$/.test(meta.worker_boot_id || "")) {
    try {
      if ((await read("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== meta.worker_boot_id) return false;
      const proc = await read(`/proc/${meta.worker_pid}/stat`, "utf8");
      const fields = proc.slice(proc.lastIndexOf(")") + 2).split(" ");
      return fields[19] === meta.worker_start_ticks && !["Z", "X"].includes(fields[0]);
    } catch (error) { if (["ENOENT", "ESRCH"].includes(error.code)) return false; return null; }
  }
  // A partial or unsupported process identity must not be replaced by weaker
  // pane evidence. Pane checks are only for legacy records with no identity.
  if (processFields.some((value) => value !== undefined && value !== null && value !== "")) return null;
  if (meta.backend !== "herdr" && meta.backend !== "tmux") return null;
  const options = { encoding: "utf8", timeout: 1500, maxBuffer: 64 * 1024 };
  if (meta.backend === "herdr") return herdrPaneIsLive(meta, run, options);
  return tmuxWindowIsLive(meta, run, options);
}

export function executionFingerprint(meta, endpointLive) {
  if (endpointLive !== true) return null;
  const processFields = [meta.worker_pid, meta.worker_start_ticks, meta.worker_boot_id, meta.worker_start_identity, meta.worker_started_at];
  if (processFields.some((value) => value !== undefined && value !== null && value !== "")) {
    if (!validPid(meta)) return null;
    const identity = meta.worker_start_ticks || meta.worker_start_identity || meta.worker_started_at;
    if (!identity || (meta.worker_start_ticks && !/^[a-f0-9-]{36}$/.test(meta.worker_boot_id || ""))) return null;
    return fingerprint("execution.v1", meta.worker_boot_id || null, meta.worker_pid, identity);
  }
  if (meta.backend === "herdr" && meta.herdr_session && meta.herdr_pane_id) return fingerprint("execution.pane.v1", meta.backend, meta.herdr_session, meta.herdr_pane_id);
  if (meta.backend === "tmux" && meta.window) return fingerprint("execution.pane.v1", meta.backend, meta.window);
  return null;
}

function herdrErrorCode(error) {
  for (const output of [error?.stdout, error?.stderr]) {
    try { const code = JSON.parse(String(output || "")).error?.code; if (code) return code; } catch { /* Unstructured CLI errors are inconclusive. */ }
  }
  return null;
}

async function herdrPaneIsLive(meta, run, options) {
  const { herdr_session: session, herdr_pane_id: pane } = meta;
  if (!session || !pane) return null;
  const herdr = (args) => run("herdr", [...args, "--session", session], options);
  let paneReply;
  try { paneReply = JSON.parse((await herdr(["pane", "get", pane])).stdout); }
  catch (error) { return herdrErrorCode(error) === "pane_not_found" ? false : null; }
  if (paneReply.error?.code === "pane_not_found") return false;
  if (paneReply.error?.code || paneReply.result?.pane?.pane_id !== pane) return null;

  let agentReply;
  try { agentReply = JSON.parse((await herdr(["agent", "get", pane])).stdout); }
  catch (error) { return herdrErrorCode(error) === "agent_not_found" ? false : null; }
  if (agentReply.error?.code === "agent_not_found") return false;
  if (agentReply.error?.code || !["working", "idle", "done", "blocked"].includes(agentReply.result?.agent?.agent_status)) return null;

  let processReply;
  try { processReply = JSON.parse((await herdr(["pane", "process-info", "--pane", pane])).stdout); }
  catch { return null; }
  const info = processReply.result?.process_info;
  if (processReply.result?.type !== "pane_process_info" || info?.pane_id !== pane || !Number.isSafeInteger(info.shell_pid) || !Array.isArray(info.foreground_processes) || !info.foreground_processes.length) return null;
  const shells = new Set(["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "tcsh", "csh", "fish"]);
  const isShell = (value) => shells.has(path.basename(String(value || "")).replace(/^-/, ""));
  let sawShellOnly = false;
  for (const process of info.foreground_processes) {
    const names = [process.name, process.argv0].filter((value) => typeof value === "string" && value);
    if (!names.length) continue;
    if (!names.every(isShell)) return true;
    sawShellOnly = true;
  }
  return sawShellOnly ? false : null;
}

async function tmuxWindowIsLive(meta, run, options) {
  const target = meta.window;
  if (typeof target !== "string" || !target || (target.match(/:/g) || []).length !== 1) return null;
  const [session, window] = target.split(":");
  if (!session || !window) return null;
  try {
    const { stdout } = await run("tmux", ["list-windows", "-t", `=${session}`, "-F", "#{window_name}"], options);
    return stdout.split(/\r?\n/).some((line) => line === window);
  } catch { return null; }
}

// Read-only probes: no fetch, ref mutation, branch checkout or publication.
// A cached remote-tracking ref is not enough: the actual remote must agree now.
export async function verifyDurability(repository, commit, pullRequest, run = exec) {
  if (!repository || !/^[a-f0-9]{40}$/.test(commit || "")) return [];
  const options = { cwd: repository.path, timeout: 2500, signal: AbortSignal.timeout(5000), maxBuffer: 128 * 1024, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GH_PROMPT_DISABLED: "1" } };
  const evidence = [];
  const remote = repository.remote || "origin";
  for (const [branch, badge] of [["main", "remote Main"], ["uat", "remote UAT"]]) {
    try {
      const ref = `refs/heads/${branch}`;
      const [advertised, advertisedRef, extra] = (await run("git", ["ls-remote", "--exit-code", remote, ref], options)).stdout.trim().split(/\s+/);
      if (!/^[a-f0-9]{40}$/.test(advertised) || advertisedRef !== ref || extra) continue;
      // The advertised exact head must exist locally to prove graph containment.
      await run("git", ["merge-base", "--is-ancestor", commit, advertised], options);
      evidence.push({ badge, commit, destination: ref, head: advertised, checkedAt: new Date().toISOString() });
    } catch { /* Unknown or unavailable remote/object graph never proves delivery. */ }
  }
  if (repository.github && /^[1-9]\d*$/.test(String(pullRequest || ""))) {
    try {
      const record = JSON.parse((await run("gh-axi", ["api", `repos/${repository.github}/pulls/${pullRequest}`], options)).stdout);
      if (record.merged === true && Number.isFinite(Date.parse(record.merged_at)) && record.merge_commit_sha === commit && record.base?.repo?.full_name === repository.github && ["main", "uat"].includes(record.base?.ref) && record.html_url === `https://github.com/${repository.github}/pull/${pullRequest}`) {
        evidence.push({ badge: "merged PR", commit, destination: record.base.ref, url: record.html_url, mergedAt: record.merged_at });
      }
    } catch { /* No prose/branch-name/status-line fallback. */ }
  }
  if (repository.github && repository.destinations?.length) {
    try {
      for (const destination of repository.destinations) {
        // Query the destination's newest deployment, NOT a commit-filtered history.
        // An older successful deployment cannot establish what is live there now.
        const deployments = JSON.parse((await run("gh-axi", ["api", `repos/${repository.github}/deployments?environment=${encodeURIComponent(destination.environment)}&per_page=1`], options)).stdout);
        const deployment = deployments[0];
        if (!deployment || deployment.environment !== destination.environment || deployment.sha !== commit || !Number.isSafeInteger(deployment.id)) continue;
        const statuses = JSON.parse((await run("gh-axi", ["api", `repos/${repository.github}/deployments/${deployment.id}/statuses?per_page=1`], options)).stdout);
        if (statuses[0]?.state === "success" && statuses[0].environment === destination.environment && Number.isSafeInteger(statuses[0].id)) evidence.push({ badge: destination.tier === "production" ? "Live production" : "Live UAT", tier: destination.tier, commit, deploymentId: deployment.id, destination: destination.environment, statusId: statuses[0].id, checkedAt: new Date().toISOString() });
      }
    } catch { /* Merge and containment are not deployment evidence. */ }
  }
  return evidence;
}

export async function projectWork(records, state, { durability = verifyDurability, acknowledgementsAvailable = true, repositoryPaths = new Map() } = {}) {
  const items = [];
  const activeExecutions = new Set();
  // Bound external evidence work per snapshot; unverified candidates stay reviewable.
  const evidenceDeadline = Date.now() + 6000;
  const probes = new Map();
  for (const record of records) {
    const { repositoryPath, repository } = resolveRepositoryIdentity(record.repositoryPath, state, repositoryPaths);
    // Navigation keys stay stable across taxonomy edits and cannot collide with operator IDs.
    const repositoryId = repositoryPath ? `repo-${fingerprint(repositoryPath).slice(0, 24)}` : "unknown";
    const taskFingerprint = repositoryPath ? fingerprint("task.v1", repositoryPath, record.id) : fingerprint("task.v1", null, record.id, record.repositoryPath || null);
    const assignment = state.assignments[taskFingerprint];
    const assignedLane = assignment?.repositoryId === repository?.id ? repository?.lanes.find((lane) => lane.id === assignment.laneId) : null;
    const assignedTheme = assignedLane?.themes.find((theme) => theme.id === assignment.themeId);
    const lane = assignedLane ? { id: assignedLane.id, name: assignedLane.name } : { id: "unclassified", name: "Fleet unclassified" };
    // Explicit legacy metadata remains useful, but does not fabricate a workstream.
    const theme = assignedTheme || (record.workGroup ? { id: `legacy-${fingerprint(record.workGroup).slice(0, 24)}`, name: record.workGroup.name, kind: record.workGroup.kind, legacy: true } : { id: "unclassified", name: "Voyage unclassified", kind: "theme" });
    let status = classifyCurrent(record);
    if (status === "active") activeExecutions.add(record.executionFingerprint || taskFingerprint);
    const completionSourceFingerprint = record.state === "done" ? fingerprint("completion-source.v1", taskFingerprint, record.completionIdentity) : null;
    const bound = completionSourceFingerprint && state.completionRecords?.[completionSourceFingerprint];
    const commit = bound?.taskFingerprint === taskFingerprint ? bound.commit : record.commit || null;
    const pullRequest = bound?.taskFingerprint === taskFingerprint ? bound.pullRequest : record.pullRequest;
    const completionFingerprint = completionSourceFingerprint ? fingerprint("completion.v1", taskFingerprint, record.completionIdentity, commit) : null;
    const evidence = [];
    const acknowledgement = completionFingerprint && state.acknowledgements[completionFingerprint];
    if (acknowledgement?.taskFingerprint === taskFingerprint) evidence.push({ badge: "acknowledged", acknowledgedAt: acknowledgement.acknowledgedAt, completionFingerprint });
    if (completionFingerprint && commit) {
      const key = fingerprint(repository?.id, commit, pullRequest);
      if (!probes.has(key) && probes.size < 8 && Date.now() < evidenceDeadline) {
        const remaining = evidenceDeadline - Date.now();
        probes.set(key, new Promise((resolve) => {
          const timer = setTimeout(() => resolve([]), remaining);
          Promise.resolve().then(() => durability(repository, commit, pullRequest)).then((value) => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve([]); });
        }));
      }
      if (probes.has(key)) evidence.push(...await probes.get(key));
    }
    const completionAttention = completionFingerprint ? evidence.length ? "previously-done" : acknowledgementsAvailable ? "newly-done" : "unknown" : null;
    if (status === "newly-done") status = completionAttention;
    items.push({ id: record.id, name: safeWorkNote(record.name), taskIntent: safeWorkNote(record.taskIntent), chatLaneId: record.chatLaneId || null,
      taskFingerprint, repositoryId, repository: repository?.name || (repositoryPath ? path.basename(repositoryPath) : "Repository unknown"),
      lane, theme, status, sourceState: record.state, livenessEvidence: record.livenessEvidence || (record.endpointLive === true ? "live process incarnation" : record.endpointLive === false ? "endpoint not live" : "liveness unknown"),
      endpointEvidence: record.livenessEvidence || (record.endpointLive === true ? "live process incarnation" : record.endpointLive === false ? "endpoint not live" : "liveness unknown"),
      retained: Boolean(record.retained), pendingIssues: record.pendingIssues || [], completionAttention, large: Boolean(record.large), waitingOn: record.waitingOn ? safeWorkNote(record.waitingOn) : null,
      completionFingerprint, completionSourceFingerprint, completionAt: record.completionAt || null, evidence,
      unboundCommit: Boolean(record.unboundCommit && !bound),
      delivery: completionFingerprint ? evidence.some((entry) => entry.tier === "production") ? "Live production" : evidence.some((entry) => entry.tier === "uat") ? "Live UAT · ready for review" : "Ready for review · deployment unknown" : "Not completed",
      taxonomyOptions: repository?.lanes.map((entry) => ({ id: entry.id, name: entry.name, themes: entry.themes })) || [],
    });
  }
  const counts = (rows) => Object.fromEntries(WORK_STATUSES.map((status) => [status, rows.filter((item) => ["newly-done", "previously-done"].includes(status) ? item.completionAttention === status : item.status === status || (status === "unknown" && item.completionAttention === "unknown")).length]));
  const repositories = [];
  for (const repositoryId of new Set(items.map((item) => item.repositoryId))) {
    const rows = items.filter((item) => item.repositoryId === repositoryId);
    const lanes = [...new Set(rows.map((item) => item.lane.id))].map((laneId) => {
      const laneRows = rows.filter((item) => item.lane.id === laneId);
      return { ...laneRows[0].lane, counts: counts(laneRows), themes: [...new Set(laneRows.map((item) => item.theme.id))].map((themeId) => {
        const themeRows = laneRows.filter((item) => item.theme.id === themeId);
        return { ...themeRows[0].theme, counts: counts(themeRows), items: themeRows };
      }) };
    });
    repositories.push({ id: repositoryId, name: rows[0].repository, counts: counts(rows), lanes });
  }
  return { items, repositories, counts: counts(items), activeWorkerCount: activeExecutions.size, activeReviewRequired: activeExecutions.size > 8 };
}
