// Firstmate home ingestion: registry, backlog, state, transcript and inbox readers composed into the lanes model.
// Readers are bounded and read-only; the explicit startup FM_HOME is the only home ever opened (docs/ARCHITECTURE.md).
import { parseReviewNote } from "./review-note.js";
import { createHistoryReader, HistoryLimitError } from "./history-reader.js";
import { createAgentStateOwner, emptyAgentState } from "./agent-state.js";
import { projectWork, endpointIsLive, executionFingerprint, hasProcessIdentity, shouldProbeLiveness, createConcurrencyLimiter, verifyDurability, foldStatusLines, safeWorkNote } from "./work-model.js";
import { readSecondmates } from "./secondmates.js";
import { parseStatusLine, parseBacklogTask, holdWaitingOn } from "./firstmate-records.js";
import { readSecondmateMessages } from "./secondmate-messages.js";
import { readConversationTranscript } from "./transcript.js";
import { readSupervisionOutcomes } from "./supervision.js";
import { SAFE_NOTE_ID } from "./inbox.js";
import { VERIFIED_CAPTAIN, inboxInput, verifiedQuarterdeckNote } from "./authorship.js";
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const probeLiveness = createConcurrencyLimiter(4);

// Raised for unreadable or unselected homes; the gateway answers it with 503 and the message, never a path.
export class PublicDataError extends Error {}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lane";
}

export function shortIntent(value, limit = 240) {
  const text = String(value || "")
    .replace(/^\s*(?:[-*]|\d+\.)\s+/, "")
    .replace(/[*_`#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

// A Pi text part may contain several consecutive, independently tagged lane blocks.
// Preserve the durable text; only the per-lane API projections split the blocks.
const PRODUCT_LANE_ALIASES = ["fm-quarterdeck", "quarterdeck", "firstmate quarterdeck", "fm-agentos", "agentos", "agent-os", "agent os"];
const LANE_LABEL_ALIASES = { "fm-quarterdeck": PRODUCT_LANE_ALIASES, "fm-agentos": PRODUCT_LANE_ALIASES, "lavish-axi": ["lavish"] };
function explicitLaneBlocks(message, projects) {
  if (!message.transcriptSessionId || message.role !== "firstmate" || !["conversation", "branch"].includes(message.kind)) return null;
  const blocks = [];
  const marker = /^\[fm-lane ([^\]\r\n]+)\]\r?\n[\s\S]+?\r?\n\[end ([^\]\r\n]+)\](?=\r?\n|$)/gm;
  let end = 0;
  for (const match of message.text.matchAll(marker)) {
    if (!/^(?:\r?\n)*$/.test(message.text.slice(end, match.index))) return null;
    const name = match[1].toLowerCase();
    if (name !== match[2].toLowerCase()) return null;
    // A lane label can include a voyage/theme suffix (Example-Store-UI).
    // Exact registered names win; otherwise use the longest registered parent
    // followed by a hyphen. Never infer ownership from arbitrary body prose.
    const candidates = [...projects.filter((candidate) => candidate.id !== "general"), { id: "general", name: "General" }];
    const directLabels = (candidate) => [candidate.id, candidate.name.toLowerCase()];
    const aliasLabels = (candidate) => LANE_LABEL_ALIASES[candidate.id] || [];
    const resolve = (labels) => {
      const exact = candidates.filter((candidate) => labels(candidate).includes(name));
      if (exact.length) return exact;
      const parents = candidates.map((candidate) => ({ candidate, length: Math.max(0, ...labels(candidate)
        .filter((label) => name.startsWith(`${label}-`) && name.length > label.length + 1).map((label) => label.length)) }));
      const longest = Math.max(0, ...parents.map(({ length }) => length));
      return longest ? parents.filter(({ length }) => length === longest).map(({ candidate }) => candidate) : [];
    };
    // Explicit registered ownership must outrank compatibility aliases. Homes
    // can register both the current product and its historical name; an alias
    // on that historical lane must not make the current lane's own ID ambiguous.
    const direct = resolve(directLabels);
    const matches = direct.length ? direct : resolve(aliasLabels);
    if (matches.length !== 1) return null;
    blocks.push({ projectId: matches[0].id, name: match[1], text: match[0] });
    end = match.index + match[0].length;
  }
  return blocks.length && /^(?:\r?\n)*$/.test(message.text.slice(end)) ? blocks : null;
}

function parseProjects(markdown) {
  return markdown.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*-\s+(.+?)(?:\s+\[[^\]]+\])?\s+-\s+(.+)$/);
    if (!match) return [];
    const mission = shortIntent(match[2]);
    return [{ id: slug(match[1]), name: match[1].trim(), mission, intent: mission || "Fleet intent not recorded." }];
  });
}

async function repositoryPathsForHome(home, projects) {
  const root = path.join(home, "projects");
  const paths = new Map([["firstmate", path.resolve(home)]]);
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error?.code === "ENOENT") return paths; throw error; }
  const clones = entries.filter((entry) => entry.isDirectory()).map((entry) => [entry.name, path.join(root, entry.name)]);
  for (const [name, clonePath] of clones) paths.set(name, clonePath);
  for (const project of projects) {
    if (project.name.toLowerCase() === "firstmate") continue;
    const matches = clones.filter(([name]) => name.toLowerCase() === project.name.toLowerCase());
    if (matches.length === 1) paths.set(project.name, matches[0][1]);
  }
  return paths;
}

function captainIntent(markdown) {
  const lines = markdown.split(/\r?\n/);
  const heading = lines.findIndex((line) => /^##\s+Captain's intent\s*$/i.test(line));
  if (heading < 0) return "";
  for (const line of lines.slice(heading + 1)) {
    if (/^##\s+/.test(line)) break;
    if (line.trim()) return shortIntent(line, 150);
  }
  return "";
}

async function readBriefIntent(home, taskId) {
  let handle;
  try {
    handle = await open(path.join(home, "data", taskId, "brief.md"), "r");
    const prefix = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return captainIntent(prefix.toString("utf8", 0, bytesRead));
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
    throw error;
  } finally {
    await handle?.close();
  }
}

function currentTaskIntent(task, briefIntent) {
  const title = shortIntent(task?.title, 110);
  const detail = shortIntent(briefIntent || task?.bodyFirstLine, 150);
  if (!title && !detail) return "Task intent not recorded.";
  if (!detail || detail.toLowerCase() === title.toLowerCase()) return safeWorkNote(title);
  return safeWorkNote(shortIntent(`${title}${title ? " — " : ""}${detail}`));
}

function parseMeta(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap((line) => {
    const separator = line.indexOf("=");
    return separator > 0 ? [[line.slice(0, separator), line.slice(separator + 1)]] : [];
  }));
}

function isReviewRun(meta) {
  return ["running", "in progress", "validating", "reviewing", "waiting at gate", "waiting at a gate"].includes(meta.validation_state);
}

function laneStatus(tasks) {
  const states = tasks.map((task) => task.classification?.status || "unknown");
  for (const status of ["captain-action", "active", "review", "waiting", "cleanup", "unknown", "backlog", "newly-done"]) {
    if (states.includes(status)) return status === "captain-action" ? "needs-decision" : status === "newly-done" ? "ready-for-review" : status;
  }
  return tasks.length ? "steady" : "idle";
}

function taskProgress(state) {
  if (state === "done") return 100;
  if (["failed", "blocked", "paused", "needs-decision"].includes(state)) return 50;
  return 35;
}

function formatEventTime(date) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function recordTimestamp(headers, fileStat) {
  for (const value of [headers.at, headers.occurred_at, headers.created_at, headers.timestamp]) {
    const timestamp = new Date(value);
    if (value && !Number.isNaN(timestamp.valueOf())) return { timestamp, timestampSource: "explicit" };
  }
  // Headerless record files have no event clock. Creation time is the least mutable
  // fallback; use mtime only on filesystems that do not expose it.
  const created = new Date(fileStat.birthtimeMs);
  const hasCreationTime = !Number.isNaN(created.valueOf()) && fileStat.birthtimeMs > 0;
  return {
    timestamp: hasCreationTime ? created : new Date(fileStat.mtimeMs),
    timestampSource: hasCreationTime ? "birthtime" : "mtime",
  };
}

function parseHeaderRecord(text) {
  const lines = text.split(/\r?\n/);
  const separator = lines.findIndex((line) => line.trim() === "--");
  if (separator < 0) return { headers: {}, body: text.trim() };
  const headers = Object.fromEntries(lines.slice(0, separator).flatMap((line) => {
    const index = line.indexOf("=");
    return index > 0 ? [[line.slice(0, index).trim(), line.slice(index + 1).trim()]] : [];
  }));
  return { headers, body: lines.slice(separator + 1).join("\n").trim() };
}

function publicMessage({ author, role, source, text, timestamp, timestampSource = "explicit", sourceSequence = 0, taskId = null, state = "update", kind = "conversation", review }) {
  return { ...(review !== undefined ? { review } : {}), author, role, source, text, timestamp, timestampSource, sourceSequence, taskId, state, kind, time: formatEventTime(timestamp) };
}

function messageOrder(message) {
  if (message.role === "captain" || message.kind === "input") return 0;
  if (message.kind === "thinking" || message.kind === "narration") return 1;
  if (message.kind === "crew") return 3;
  return 2;
}

function compareMessages(a, b) {
  return a.timestamp - b.timestamp
    || messageOrder(a) - messageOrder(b)
    || a.source.localeCompare(b.source)
    || a.sourceSequence - b.sourceSequence
    || a.text.localeCompare(b.text);
}

function publicTimeline(messages) {
  return [...messages].sort(compareMessages).map(({ timestamp, timestampSource, sourceSequence, ...message }) => ({ ...message, occurredAt: timestamp.toISOString() }));
}

function publicSessions(tasks) {
  return tasks.map((task) => {
    const timestamps = task.events.map((event) => event.timestamp).sort((a, b) => a - b);
    return {
      id: task.id,
      state: task.state,
      eventCount: task.events.length,
      isLive: task.isLive,
      classification: task.classification,
      startedAt: timestamps[0]?.toISOString() || null,
      updatedAt: task.activityAt?.toISOString() || timestamps.at(-1)?.toISOString() || null,
    };
  }).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// `identify(headers, body)` returns the record's author/role/state/kind.
async function readRecordFile(filePath, source, identify, reader) {
  const [text, fileStat] = await Promise.all([reader.text(filePath), stat(filePath)]);
  const parsed = parseHeaderRecord(text);
  if (!parsed.body) return null;
  const { timestamp, timestampSource } = recordTimestamp(parsed.headers, fileStat);
  const isSteer = parsed.headers.schema === "fm-task-inbox.v1";
  reader.takeMessage();
  return publicMessage({
    ...(isSteer ? { author: "Firstmate", role: "firstmate", kind: "steer", state: "firstmate" } : await identify(parsed.headers, parsed.body)),
    source,
    text: parsed.body,
    ...(/^agentos-review:[0-9a-f-]{36}$/i.test(parsed.headers.request_id || "") ? { review: parseReviewNote(parsed.body) } : {}),
    timestamp,
    timestampSource,
    taskId: parsed.headers.task_id || parsed.headers.work_id || parsed.headers.endpoint_task_id || null,
  });
}

async function filesInOptionalDirectory(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && !entry.name.startsWith(".")).map((entry) => entry.name).sort();
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return [];
    throw error;
  }
}

async function steerActivity(home, taskId) {
  const root = path.join(home, "state", `${taskId}.inbox`);
  const files = (await Promise.all([root, path.join(root, "handled")].map(async (directory) =>
    (await filesInOptionalDirectory(directory)).filter((name) => name.endsWith(".msg")).map((name) => path.join(directory, name))))).flat();
  const changes = await Promise.all(files.map((file) => stat(file)));
  return changes.length ? new Date(Math.max(...changes.map((item) => item.mtimeMs))) : null;
}

async function readTaskSteers(home, taskId, reader) {
  const inboxRoot = path.join(home, "state", `${taskId}.inbox`);
  const locations = [
    [inboxRoot, `state/${taskId}.inbox`],
    [path.join(inboxRoot, "handled"), `state/${taskId}.inbox/handled`],
  ];
  const messages = [];
  for (const [directory, sourceRoot] of locations) {
    for (const name of await filesInOptionalDirectory(directory)) {
      if (!name.endsWith(".msg")) continue;
      const message = await readRecordFile(path.join(directory, name), `${sourceRoot}/${name}`, (headers) => ({ author: headers.author || "Firstmate", role: "firstmate", kind: "conversation", state: "firstmate" }), reader);
      if (message) messages.push({ ...message, taskId, kind: "steer" });
    }
  }
  return messages;
}

// Presence in an inbox is not authorship: only a verified Quarterdeck send is the
// Captain's (authorship.js). Every other note, including any `author=` header, is
// unverified input. Firstmate's own inbox is state/inbox; legacy inbox/ never verifies.
async function readCaptainNotes(home, reader) {
  const firstmateInbox = path.join(home, "state", "inbox");
  const locations = [
    [path.join(home, "inbox"), "inbox", false],
    [path.join(home, "inbox", "handled"), "inbox/handled", false],
    [firstmateInbox, "state/inbox", true],
    [path.join(firstmateInbox, "handled"), "state/inbox/handled", true],
  ];
  // A reservation is one short note id; read at most 256 bytes outside the history budget.
  const reservation = async (requestId) => {
    const reserved = path.join(firstmateInbox, ".requests", requestId);
    let file;
    try {
      if (!(await lstat(reserved)).isFile()) return null;
      file = await open(reserved, "r");
    } catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return null; throw error; }
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead).toString("utf8").split(/\r?\n/)[0].trim();
    } finally { await file.close(); }
  };
  const messages = [];
  for (const [directory, sourceRoot, inFirstmateInbox] of locations) {
    for (const name of await filesInOptionalDirectory(directory)) {
      if (!name.endsWith(".note") && !name.endsWith(".msg")) continue;
      const identify = async (headers, body) => await verifiedQuarterdeckNote({ name, inFirstmateInbox, headers, body, reservation }) ? VERIFIED_CAPTAIN : inboxInput();
      const message = await readRecordFile(path.join(directory, name), `${sourceRoot}/${name}`, identify, reader);
      if (message) messages.push(message);
    }
  }
  return messages;
}

function outboxText(text, json) {
  if (typeof json?.public_safe_outcome === "string") return json.public_safe_outcome;
  if (Array.isArray(json?.texts)) return json.texts.filter((item) => typeof item === "string").join("\n");
  for (const field of ["text", "outcome_text", "summary", "message"]) {
    if (typeof json?.[field] === "string") return json[field];
  }
  return text.trim();
}

async function readOutboxFile(filePath, source, reader) {
  const [text, fileStat] = await Promise.all([reader.text(filePath), stat(filePath)]);
  let json = null;
  try { json = JSON.parse(text); } catch {}
  const parsed = json ? { headers: json, body: outboxText(text, json) } : parseHeaderRecord(text);
  if (!parsed.body) return null;
  const { timestamp, timestampSource } = recordTimestamp(parsed.headers, fileStat);
  reader.takeMessage();
  return publicMessage({
    author: parsed.headers.source_home_id || parsed.headers.endpoint || "Outbox",
    role: "outbox",
    source,
    text: parsed.body,
    timestamp,
    timestampSource,
    taskId: parsed.headers.task_id || parsed.headers.work_id || parsed.headers.endpoint_task_id || null,
    state: parsed.headers.outcome_type || "outbox",
    kind: "crew",
  });
}

async function readOutboxMessages(home, reader) {
  const stateRoot = path.join(home, "state");
  const found = [];
  async function walk(directory, relative = "state") {
    const entries = await readdir(directory, { withFileTypes: true });
    const isOutboxDirectory = relative.split("/").at(-1) === "outbox" || relative.split("/").at(-1).endsWith("-outbox");
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const fullPath = path.join(directory, entry.name);
      const source = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(fullPath, source);
      } else if (entry.isFile() && (isOutboxDirectory || entry.name.includes(".outbox."))) {
        const message = await readOutboxFile(fullPath, source, reader);
        if (message) found.push(message);
      }
    }
  }
  await walk(stateRoot);
  return found;
}

async function readBacklog(home, reader = createHistoryReader()) {
  const readFile = reader.text;
  try {
    const backlog = await readFile(path.join(home, "data", "backlog.md"), "utf8");
    const tasks = new Map();
    let section = "";
    let currentTask = null;
    for (const line of backlog.split(/\r?\n/)) {
      const heading = line.match(/^##\s+(.+?)\s*$/);
      if (heading) {
        section = heading[1].trim().toLowerCase();
        currentTask = null;
        continue;
      }
      const item = line.match(/^\s*-\s+\[([ xX])\]\s+([^\s]+)\s+-\s+(.+)$/);
      if (item) {
        const inFlight = section === "in flight";
        const done = item[1].toLowerCase() === "x" || /^(done|completed|closed)\b/.test(section);
        const parsed = parseBacklogTask(item[3], done);
        currentTask = { ...parsed, id: item[2], projectName: parsed.repositoryPath ? path.basename(parsed.repositoryPath) : null,
          inFlight, state: done ? "done" : "active", bodyFirstLine: "", body: "", section };
        tasks.set(item[2], currentTask);
        continue;
      }
      const body = line.match(/^\s{2,}(\S.*)$/)?.[1];
      if (currentTask && body) {
        if (!currentTask.bodyFirstLine) currentTask.bodyFirstLine = shortIntent(body, 150);
        currentTask.body += `${body}\n`;
      }
    }
    for (const task of tasks.values()) {
      task.activeBlockers = task.holdOpen ? task.blockers.filter((id) => tasks.has(id) && tasks.get(id).state !== "done") : [];
    }
    return tasks;
  } catch (error) {
    if (error?.code === "ENOENT") return new Map();
    throw error;
  }
}

// The backlog remains the only ledger. Briefs supply classification evidence, never a second task list.
async function workSplit(home, backlogTasks, stateNames, agentState, projects, repositoryPaths, durability, acknowledgementsAvailable, reader, metaById) {
  const readFile = reader.text;
  const tight = { backlog: [], inProgress: [], justLanded: [] };
  const large = [];
  const today = new Date().toISOString().slice(0, 10);
  for (const task of backlogTasks.values()) {
    const brief = await readOptionalBrief(home, task.id);
    const briefBody = brief.replace(/^#\s+[^\n]*\n/, "");
    const notes = `${task.body}\n${briefBody}`;
    const isLarge = /\blarge project\b/i.test(notes);
    const hold = holdWaitingOn(task);
    let latest = null;
    let decision = null;
    if (stateNames.includes(`${task.id}.status`)) {
      const text = await readFile(path.join(home, "state", `${task.id}.status`), "utf8");
      const folded = foldStatusLines(text.trim().split(/\r?\n/).filter(Boolean), { kind: metaById.has(task.id) ? metaById.get(task.id).kind || "ship" : "unknown" });
      latest = folded.latest;
      decision = folded.pendingIssues.findLast((issue) => issue.state === "needs-decision");
    }
    const notedWait = notes.match(/(?:^|\n)\s*(?:waiting (?:on|for)|blocked by)\s*:?\s*([^\n.]+)/i)?.[1];
    const waitingOn = decision?.text || hold || (latest && ["blocked", "needs-decision", "paused", "waiting", "captain-held"].includes(latest.state) ? latest.text : null)
      || (notedWait ? shortIntent(notedWait, 150) : null);
    const name = safeWorkNote(task.title);
    // A task meta's project path is the durable repository identity for running work;
    // queued work falls back to the backlog's explicit repo field.
    let repository = task.projectName;
    if (stateNames.includes(`${task.id}.meta`)) {
      repository = path.basename(metaById.get(task.id)?.project || "") || repository;
    }
    const identity = { id: task.id, name, repository: repository || null, workGroup: task.workGroup, waitingOn: waitingOn ? safeWorkNote(waitingOn) : null };
    const phase = task.state === "done" ? task.doneDate === today ? "justLanded" : "earlierLanded"
      : task.section === "queued" ? "backlog" : "inProgress";
    if (isLarge) {
      const notedStage = notes.match(/(?:^|\n)\s*stage:\s*([^\n]+)/i)?.[1];
      const stage = task.state === "done" ? "Landed" : notedStage ? shortIntent(notedStage, 100) : task.section === "queued" ? "Backlog"
        : latest && ["blocked", "needs-decision", "paused", "waiting", "captain-held"].includes(latest.state) ? stateLabelForWork(latest.state) : "In progress";
      large.push({ ...identity, phase, stage: safeWorkNote(stage), waitingOn: safeWorkNote(waitingOn || "Nothing recorded") });
    } else if (task.state === "done") {
      // A historical done item is not automatically a recent landing.
      if (task.doneDate === today) tight.justLanded.push(identity);
    } else {
      tight[phase].push(identity);
    }
  }
  const ids = new Set([...backlogTasks.keys(), ...stateNames.filter((name) => /\.(meta|status)$/.test(name) && !name.startsWith(".")).map((name) => name.replace(/\.(meta|status)$/, ""))]);
  const records = await Promise.all([...ids].sort().map(async (id) => {
    const task = backlogTasks.get(id);
    const meta = metaById.get(id) || {};
    const lines = stateNames.includes(`${id}.status`) ? (await readFile(path.join(home, "state", `${id}.status`), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    const folded = foldStatusLines(lines, { kind: metaById.has(id) ? meta.kind || "ship" : "unknown" });
    const latest = folded.latest;
    const decision = folded.pendingIssues.findLast((issue) => issue.state === "needs-decision");
    let state = latest?.state || task?.state || "unknown";
    if (task?.state === "done" && !task.inFlight && ["working", "active", "update"].includes(state)) state = "done";
    const repositoryPath = meta.project || task?.repositoryPath || null;
    const lastCompletion = folded.completion;
    const recordedWork = [...large, ...Object.values(tight).flat()].find((entry) => entry.id === id);
    const completionIdentity = { source: lastCompletion ? "status" : "backlog", line: lastCompletion?.line, occurrence: lastCompletion?.index, doneDate: task?.doneDate || null };
    const inFlight = Boolean(task?.inFlight);
    const endpointLive = shouldProbeLiveness(state, inFlight) ? await probeLiveness(() => endpointIsLive(meta)) : null;
    return { id, name: task?.title || id, repositoryPath, state, pendingIssues: folded.pendingIssues,
      holdKind: task?.holdKind, holdReason: task?.holdReason, holdUntil: task?.holdUntil, holdOpen: task?.holdOpen,
      holdActive: task?.holdActive, holdDeferred: task?.holdDeferred, blockers: task?.blockers || [], activeBlockers: task?.activeBlockers || [],
      inFlight: Boolean(task?.inFlight), queued: task?.section === "queued", endpointLive, reviewRun: isReviewRun(meta),
      endpointEvidence: endpointLive === true ? hasProcessIdentity(meta) ? "live process incarnation" : "live terminal pane (weaker evidence; worker process unverified)" : endpointLive === false ? "endpoint not live" : "liveness unknown",
      executionFingerprint: executionFingerprint(meta, endpointLive),
      retained: meta.preserved === "true" || meta.cleanup_pending === "true", workGroup: task?.workGroup || null,
      taskIntent: currentTaskIntent(task, await readBriefIntent(home, id)), chatLaneId: projects.find((entry) => entry.name === (repositoryPath ? path.basename(repositoryPath) : task?.projectName))?.id || null,
      completionIdentity,
      completionAt: lastCompletion?.line.match(/\[at=([0-9]{9,12})(?:\]|\s)/)?.[1] ? new Date(Number(lastCompletion.line.match(/\[at=([0-9]{9,12})(?:\]|\s)/)[1]) * 1000).toISOString() : task?.doneDate || null,
      // A task-level head is not bound to this exact outcome. Quarterdeck completionRecords
      // supplies an explicit source-fingerprint binding; never migrate an old head blindly.
      commit: null, pullRequest: null, unboundCommit: Boolean(meta.completion_commit),
      large: large.some((entry) => entry.id === id), waitingOn: decision?.text || holdWaitingOn(task || {}) || (latest?.state === "captain-held" ? latest.text : null) || folded.pendingIssues.at(-1)?.text || recordedWork?.waitingOn || null };
  }));
  const model = await projectWork(records, agentState, { durability, acknowledgementsAvailable, repositoryPaths });
  return { tight: Object.fromEntries(Object.entries(tight).map(([key, items]) => [key, { count: items.length, items }])), large: { count: large.length, projects: large }, ...model };
}

function stateLabelForWork(state) { return state.replaceAll("-", " "); }

async function readOptionalBrief(home, id) {
  let handle;
  try {
    handle = await open(path.join(home, "data", id, "brief.md"), "r");
    const prefix = Buffer.alloc(16 * 1024);
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0);
    return prefix.toString("utf8", 0, bytesRead);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return "";
    throw error;
  } finally { await handle?.close(); }
}

// Captain-facing replies written by `fm-inbox.sh reply` live in state/inbox/.replies.
// Review reads them through receipts; Fleet Chats reads the same files directly.
// Symlinks are not followed. Names that are not note ids are ignored.
async function readInboxReplies(home, reader) {
  const directory = path.join(home, "state", "inbox", ".replies");
  let info;
  try { info = await lstat(directory); }
  catch (error) { if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return []; throw error; }
  if (!info.isDirectory()) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const messages = [];
  const seen = new Set();
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!SAFE_NOTE_ID.test(entry.name) || entry.isSymbolicLink() || !entry.isFile()) continue;
    const fullPath = path.join(directory, entry.name);
    let fileStat;
    try { fileStat = await lstat(fullPath); }
    catch (error) { if (error?.code === "ENOENT") continue; throw error; }
    if (!fileStat.isFile()) continue;
    const parsed = parseHeaderRecord(await reader.text(fullPath));
    if (!parsed.body) continue;
    const headerId = SAFE_NOTE_ID.test(parsed.headers.id || "") ? parsed.headers.id : "";
    const inReplyTo = headerId || entry.name;
    const recordId = `state/inbox/.replies/${inReplyTo}`;
    if (seen.has(recordId)) continue;
    seen.add(recordId);
    const { timestamp, timestampSource } = recordTimestamp(parsed.headers, fileStat);
    reader.takeMessage();
    messages.push({
      ...publicMessage({
        author: "Firstmate",
        role: "firstmate",
        kind: "conversation",
        state: "reply",
        source: `state/inbox/.replies/${entry.name}`,
        text: parsed.body,
        timestamp,
        timestampSource,
        sourceSequence: Number(parsed.headers.seq) || 0,
      }),
      recordId,
      inReplyTo,
    });
  }
  return messages;
}

function noteIdFromSource(source) {
  const stem = String(source || "").split("/").pop()?.replace(/\.(?:note|msg)$/, "") || "";
  return SAFE_NOTE_ID.test(stem) ? stem : "";
}

// Claude Code keeps transcripts under the server user's config directory;
// only this home's encoded project directory inside it is ever read.
export function claudeConfigDir(env) {
  return env.CLAUDE_CONFIG_DIR && path.isAbsolute(env.CLAUDE_CONFIG_DIR) ? env.CLAUDE_CONFIG_DIR : path.join(os.homedir(), ".claude");
}

export async function loadFirstmateHome(home, { includeHistory = true, sessionIds = [], diskIds = [], older = 0, diskOlder = 0, agentStateOwner = createAgentStateOwner(), durability = verifyDurability, reader = createHistoryReader(), claudeConfigDir = null, windowBytes = null } = {}) {
  const readFile = reader.text;
  if (!home) throw new PublicDataError("Fleet Chats offline: set FM_HOME to a readable Firstmate home (for example /absolute/path/to/firstmate).");
  const resolvedHome = path.resolve(home);
  try {
    const [registry, stateNames, backlogTasks, captainNotes, transcript, outboxMessages, inboxReplies, mateMessages] = await Promise.all([
      readFile(path.join(resolvedHome, "data", "projects.md"), "utf8"),
      readdir(path.join(resolvedHome, "state")),
      readBacklog(resolvedHome, reader),
      includeHistory ? readCaptainNotes(resolvedHome, reader) : [],
      includeHistory ? readConversationTranscript(resolvedHome, publicMessage, { selectedIds: diskIds, older: diskOlder, reader, claudeConfigDir, windowBytes }) : { messages: [], coverage: {} },
      includeHistory ? readOutboxMessages(resolvedHome, reader) : [],
      includeHistory ? readInboxReplies(resolvedHome, reader) : [],
      includeHistory ? readSecondmateMessages(resolvedHome, publicMessage, { reader, windowBytes }) : { messages: [], sources: [], warnings: [] },
    ]);
    const projects = parseProjects(registry);
    const repositoryPaths = await repositoryPathsForHome(resolvedHome, projects);
    let agentState;
    let taxonomyWarning = null;
    try { agentState = await agentStateOwner.read(); }
    catch { agentState = emptyAgentState(); taxonomyWarning = "Quarterdeck classification state unavailable; showing explicit unclassified fallback. Changes disabled until the state is repaired."; }
    const secondmates = await readSecondmates(resolvedHome, stateNames, { reader, parseMeta, probe: (meta) => probeLiveness(() => endpointIsLive(meta)) });
    const workBacklog = new Map([...backlogTasks].filter(([id]) => !secondmates.ids.has(id)));
    const workStateNames = stateNames.filter((name) => !secondmates.ids.has(name.replace(/\.(meta|status)$/, "")));
    const split = await workSplit(resolvedHome, workBacklog, workStateNames, agentState, projects, repositoryPaths, durability, !taxonomyWarning, reader, secondmates.metaById);
    split.warning = taxonomyWarning;
    const currentWork = new Map(split.items.map((item) => [item.id, item]));
    if (!projects.length) throw new Error("data/projects.md has no project entries");

    const metaNames = stateNames.filter((name) => name.endsWith(".meta") && !name.startsWith(".")).sort();
    const metaTaskIds = new Set(metaNames.map((name) => name.slice(0, -5)));
    const statusWarnings = [];
    const taskIdsToLoad = new Set([...metaTaskIds].filter((id) => !secondmates.ids.has(id)));
    for (const [taskId, task] of backlogTasks) {
      if (!secondmates.ids.has(taskId) && (task.inFlight || stateNames.includes(`${taskId}.status`))) taskIdsToLoad.add(taskId);
    }
    const taskResults = await Promise.all([...taskIdsToLoad].sort().map(async (taskId) => {
      const metaPresent = metaTaskIds.has(taskId);
      const statusName = `${taskId}.status`;
      const backlogTask = backlogTasks.get(taskId);
      let projectName = backlogTask?.projectName || "";
      if (metaPresent) {
        projectName = path.basename(secondmates.metaById.get(taskId)?.project || "") || projectName;
      }
      if (!projectName) return null;

      const statusStat = stateNames.includes(statusName) ? await stat(path.join(resolvedHome, "state", statusName)) : null;
      const statusActivity = statusStat ? new Date(statusStat.mtimeMs) : null;
      // Registered parent-channel files are projected once by the mate adapter.
      const eventSource = statusStat && !mateMessages.sources.some(({ id }) => id === taskId) ? { statusName, size: statusStat.size, mtime: statusActivity } : null;
      const [briefIntent, lastSteer] = await Promise.all([readBriefIntent(resolvedHome, taskId), includeHistory ? steerActivity(resolvedHome, taskId) : null]);
      return {
        id: taskId,
        projectName,
        inFlight: Boolean(backlogTask?.inFlight),
        isLive: currentWork.get(taskId)?.isLive === true,
        state: currentWork.get(taskId)?.sourceState || "unknown",
        classification: currentWork.get(taskId),
        taskIntent: currentTaskIntent(backlogTask, briefIntent),
        events: [],
        eventsLoaded: false,
        eventSource,
        activityAt: lastSteer && (!statusActivity || lastSteer > statusActivity) ? lastSteer : statusActivity,
      };
    }));
    const tasks = taskResults.filter(Boolean);
    const byTask = new Map(tasks.map((task) => [task.id, task]));
    const raiseActivity = (messages) => {
      for (const event of messages) {
        const task = byTask.get(event.taskId);
        if (task && event.timestamp && (!task.activityAt || event.timestamp > task.activityAt)) task.activityAt = event.timestamp;
      }
    };
    raiseActivity([...captainNotes, ...outboxMessages]);
    const displayedProjects = new Set(projects.filter(({ id }) => id !== "general").map(({ name }) => name));
    const admittedTasks = new Set();
    const loadTaskEvents = async (task) => {
      if (!includeHistory || !task || !displayedProjects.has(task.projectName) || admittedTasks.has(task.id)) return;
      admittedTasks.add(task.id);
      // Registered parent-channel history is owned/read only by the mate adapter.
      if (!task.eventSource) {
        task.eventsLoaded = mateMessages.sources.find(({ id }) => id === task.id)?.loaded ?? true;
        return;
      }
      const { statusName, size, mtime } = task.eventSource;
      // An empty log is fully read; nonempty history the budget cannot reach is not loaded.
      const window = size ? await reader.recent(path.join(resolvedHome, "state", statusName)) : null;
      task.eventsLoaded = !size || Boolean(window);
      if (!task.eventsLoaded) {
        statusWarnings.push(`state/${statusName} was not loaded: this request's read budget went to other sources.`);
        return;
      }
      if (!window) return;
      task.eventsOmittedBytes = window.omittedBytes;
      if (window.omittedBytes) statusWarnings.push(`state/${statusName}: only its newest whole lines loaded within this request's read budget; older task events are not shown.`);
      let index = 0;
      for await (const { line: raw } of window.lines) {
        const line = raw.trim();
        if (!line) continue;
        reader.takeMessage();
        const event = parseStatusLine(line);
        // A status file only supplies one clock. Keep its lines on that real mtime
        // and use file order solely as a stable tie-break, never fake milliseconds.
        task.events.push(publicMessage({
          ...event,
          timestamp: mtime,
          timestampSource: "mtime",
          sourceSequence: index++,
          author: task.id,
          role: "crew",
          source: `state/${statusName}`,
          taskId: task.id,
          text: `${event.state}: ${event.text}`,
          kind: "crew",
        }));
      }
    };
    // Requested/nonterminal displayed tasks are guaranteed visible independently
    // of outcomes, so their sequential windows precede competing ledger reads.
    const visibleTasks = new Set(sessionIds.slice(0, 60).filter((id) => displayedProjects.has(byTask.get(id)?.projectName)));
    for (const session of publicSessions(tasks.filter((task) => displayedProjects.has(task.projectName)))) {
      if (!["done", "failed"].includes(session.state)) visibleTasks.add(session.id);
    }
    for (const id of visibleTasks) await loadTaskEvents(byTask.get(id));
    const supervision = includeHistory ? await readSupervisionOutcomes(resolvedHome, publicMessage, reader) : { messages: [], sources: [], warnings: [] };
    raiseActivity(supervision.messages);
    // Retained genuine clocks finish recent membership; discarded windows have
    // spent no event records, and already attempted sources are never reread.
    for (const project of projects.filter((project) => displayedProjects.has(project.name))) {
      const ordered = publicSessions(tasks.filter((task) => task.projectName === project.name));
      for (const session of ordered.slice(0, 2 + Math.min(older, 20) * 10)) visibleTasks.add(session.id);
    }
    for (const session of publicSessions(tasks)) if (visibleTasks.has(session.id)) await loadTaskEvents(byTask.get(session.id));
    if (includeHistory) await Promise.all(tasks.filter((task) => visibleTasks.has(task.id)).map(async (task) => {
      task.events.push(...await readTaskSteers(resolvedHome, task.id, reader));
    }));
    const taskIds = new Set(tasks.map((task) => task.id));
    // The outcome ledger is authoritative when Pi also stores a displayed ⛵ mirror.
    const outcomeTexts = new Set(supervision.messages.map((message) => message.text));
    const transcriptMessages = transcript.messages.filter((message) => message.kind !== "supervision" || !outcomeTexts.has(message.text.replace(/^⛵\s*/, "")));
    const surfaced = new Set();
    for (const message of [...captainNotes, ...transcriptMessages, ...outboxMessages, ...supervision.messages]) {
      if (typeof message.recordId === "string") surfaced.add(message.recordId);
    }
    const noteById = new Map();
    for (const note of captainNotes) {
      if (!note.source.endsWith(".note")) continue;
      const id = noteIdFromSource(note.source);
      if (id && !noteById.has(id)) noteById.set(id, note);
    }
    const linkedReplies = [];
    const orphanReplies = [];
    for (const reply of inboxReplies) {
      if (surfaced.has(reply.recordId) || surfaced.has(reply.source)) continue;
      surfaced.add(reply.recordId);
      surfaced.add(reply.source);
      const note = noteById.get(reply.inReplyTo);
      if (!note) { orphanReplies.push(reply); continue; }
      if (note.taskId) reply.taskId = note.taskId;
      linkedReplies.push(reply);
    }
    const allCaptainMessages = [...captainNotes, ...transcriptMessages, ...linkedReplies, ...orphanReplies];
    const unscopedCaptainNotes = [...captainNotes.filter((message) => !message.taskId), ...linkedReplies.filter((message) => !message.taskId)];
    const unroutedOutbox = outboxMessages.filter((message) => !message.taskId || !taskIds.has(message.taskId));
    const markedReplies = new Map(allCaptainMessages.map((message) => [message, explicitLaneBlocks(message, projects)]));
    const sharedMessages = [...unscopedCaptainNotes, ...unroutedOutbox];
    const projectedBlocks = (message, projectId) => {
      const blocks = markedReplies.get(message);
      return blocks?.flatMap((block, index) => block.projectId === projectId ? [{
        ...message,
        text: block.text,
        // Add display context without changing each block's routing or identity.
        ...(blocks.length > 1 ? { mixedLaneMessage: { recordId: message.recordId, text: message.text, blocks } } : {}),
        recordId: blocks.length === 1 ? message.recordId : `${message.recordId}:block:${index}`,
        sourceSequence: message.sourceSequence + index / blocks.length,
      }] : []) || [];
    };
    const generalMessages = [...allCaptainMessages.flatMap((message) => markedReplies.get(message)
      ? projectedBlocks(message, "general") : [message]), ...unroutedOutbox, ...supervision.messages, ...mateMessages.messages];

    const registeredGeneral = projects.find((project) => project.id === "general");
    const lanes = projects.filter((project) => project.id !== "general").map((project) => {
      const projectTasks = tasks.filter((task) => task.projectName === project.name);
      const projectTaskIds = new Set(projectTasks.map((task) => task.id));
      const liveTasks = projectTasks.filter((task) => task.isLive);
      const routedOutbox = outboxMessages.filter((message) => message.taskId && projectTaskIds.has(message.taskId));
      const projectTerms = [project.id, project.id.replace(/^fm-/, "")];
      const routedCaptainNotes = allCaptainMessages.flatMap((message) => {
        const blocks = markedReplies.get(message);
        if (blocks) return projectedBlocks(message, project.id);
        return (message.taskId && projectTaskIds.has(message.taskId))
          || (message.transcriptSessionId && projectTerms.some((term) => term.length > 2 && slug(message.text).includes(term))) ? [message] : [];
      });
      const routedSupervision = supervision.messages.filter((message) => message.taskId && projectTaskIds.has(message.taskId));
      const messages = publicTimeline([...projectTasks.filter((task) => visibleTasks.has(task.id)).flatMap((task) => task.events), ...sharedMessages.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...routedCaptainNotes.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...routedOutbox.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...routedSupervision.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...mateMessages.messages.filter((message) => message.secondmateProjects.some((name) => name === project.id || name === project.name))]);
      // Flat transcript history follows source completion, never a presentation acknowledgement.
      const closed = projectTasks.length > 0 && projectTasks.every((task) => task.state === "done" && ["newly-done", "previously-done"].includes(task.classification?.status));
      const status = closed ? "closed" : laneStatus(projectTasks);
      const items = projectTasks.map((task) => ({
        title: task.id,
        state: task.state,
        isLive: task.isLive,
        taskIntent: task.taskIntent,
        classification: task.classification,
      }));
      const progress = items.length ? Math.round(items.reduce((sum, item) => sum + taskProgress(item.state), 0) / items.length) : 0;
      return {
        ...project,
        status,
        closed,
        laneOpen: !closed,
        crew: liveTasks.length,
        progress,
        items,
        sessions: publicSessions(projectTasks).map((session) => {
          const task = byTask.get(session.id);
          return { ...session, loaded: visibleTasks.has(session.id) && task.eventsLoaded !== false, ...(task.eventsOmittedBytes ? { omittedBytes: task.eventsOmittedBytes } : {}) };
        }),
        messages: includeHistory ? messages : [],
      };
    });

    lanes.push({
      id: "general",
      name: registeredGeneral?.name || "General",
      mission: registeredGeneral?.mission || "Fleet-wide captain notes and Firstmate activity that is not owned by one project.",
      intent: registeredGeneral?.intent || "Fleet-wide captain notes and Firstmate activity that is not owned by one project.",
      status: "idle",
      closed: false,
      laneOpen: true,
      crew: 0,
      progress: 0,
      items: [],
      sessions: [],
      messages: includeHistory ? publicTimeline(generalMessages.filter((message) => !message.taskId || !taskIds.has(message.taskId) || visibleTasks.has(message.taskId))) : [],
    });

    const today = new Date().toISOString().slice(0, 10);
    return {
      lanes,
      source: "Firstmate home",
      transcript: { ...transcript.coverage, outcomeSources: supervision.sources, secondmateSources: mateMessages.sources,
        warnings: [...(transcript.coverage.warnings || []), ...mateMessages.warnings, ...supervision.warnings, ...statusWarnings.sort()],
        expandable: transcript.coverage.expandable || (windowBytes !== null && windowBytes < 8 * 1024 * 1024 && mateMessages.sources.some((source) => source.omittedBytes > 0)) },
      workSplit: split,
      secondmates: secondmates.view,
      summary: {
        workCounts: split.counts,
        activeReviewRequired: split.activeReviewRequired,
        activeAgents: split.activeWorkerCount,
        openDecisions: split.counts["captain-action"],
        completedToday: split.items.filter((task) => task.sourceState === "done" && task.completionAt?.slice(0, 10) === today).length,
      },
    };
  } catch (error) {
    if (error instanceof HistoryLimitError) throw new PublicDataError(`Fleet Chats offline: ${error.message}`);
    if (error instanceof PublicDataError) throw error;
    throw new PublicDataError("Fleet Chats offline: FM_HOME is unreadable or is not a valid Firstmate home.");
  }
}

// The work-state endpoint re-reads a task's recorded repository identity before accepting a classification.
export async function recordedTaskRepository(home, taskId, reader = createHistoryReader()) {
  const backlog = await readBacklog(home, reader);
  let meta = {};
  try { meta = parseMeta(await readFile(path.join(home, "state", `${taskId}.meta`), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const recordedRepository = meta.project || backlog.get(taskId)?.repositoryPath;
  const repositoryPaths = await repositoryPathsForHome(path.resolve(home), parseProjects(await readFile(path.join(home, "data", "projects.md"), "utf8")));
  return { recordedRepository, repositoryPaths };
}
