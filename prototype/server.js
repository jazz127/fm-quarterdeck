import { parseReviewNote } from "./review-note.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { watch, readFileSync } from "node:fs";
import { createHistoryReader, HistoryLimitError } from "./history-reader.js";
import { validateRegistry, previewPath, proxyPreview } from "./previews.js";
import { validChatView } from "./chat-view.js";
import { createAgentStateOwner, configuredStatePath, emptyAgentState, fingerprint } from "./agent-state.js";
import { projectWork, endpointIsLive, executionFingerprint, hasProcessIdentity, shouldProbeLiveness, createConcurrencyLimiter, verifyDurability, resolveRepositoryIdentity, foldStatusLines, safeWorkNote } from "./work-model.js";
import { parseStatusLine, parseBacklogTask, holdWaitingOn } from "./firstmate-records.js";
import { PreviewLifecycle } from "./preview-lifecycle.js";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { readConversationTranscript } from "./transcript.js";
import { readFirstmateActivity } from "./firstmate-activity.js";
import { compactLanes } from "./lane-payload.js";
import { readSupervisionOutcomes } from "./supervision.js";
import { createQuotaReader } from "./quota.js";
import { createBearingsHub } from "./bearings.js";
import { createProcrastinationStore, procrastinationKey } from "./call-procrastination.js";
import { createLandedAckStore, landedAckKey } from "./landed-ack.js";
import { chatAskKey, chatAsksPath, createCallSource, createChatAskScanner } from "./chat-asks.js";
import { AnswerRefused, MAX_BODY_BYTES as MAX_ANSWER_BODY_BYTES, createAnswerRelay } from "./bearings-answer.js";
import { MAX_THREAD_BODY_BYTES, ThreadRefused, createThreadRelay, createTranscriptTurns } from "./bearings-thread.js";
import { createConfiguredCostReader } from "./costs.js";
import { readExpenseOverlay } from "./private-runtime.js";
import { readPreferences } from "./preferences.js";
import { readHealthPreferences, saveHealthPreferences, validHealthPreferences } from "./health-preferences.js";
import { createRevisionResolver } from "./revision.js";
import { reviewVersion, reviewConfiguration, validateReviewPayload, reconcileLocalReview, deliverReview, deliverLocalReview, awaitingReviewCount, localReviewStatus } from "./review.js";
import { announceReview, inboxReady, inboxReceipts, inboxReviewState, SAFE_NOTE_ID } from "./inbox.js";
import { VERIFIED_CAPTAIN, inboxInput, verifiedQuarterdeckNote } from "./authorship.js";
import { lstat, open, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const gzipAsync = promisify(gzip);
const probeLiveness = createConcurrencyLimiter(4);

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(APP_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DEFAULT_FLEET_PATH = path.join(APP_DIR, "data", "fleet.json");
const DEMO_LEDGER_PATH = path.join(APP_DIR, "data", "demo-ledger.json");
const CANONICAL_LEDGER_PATH = path.join(REPO_DIR, "expenses", "ledger.json");
const TERMINAL_STATES = new Set(["done", "failed", "blocked", "paused"]);
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/icons/quarterdeck-192.png", ["icons/quarterdeck-192.png", "image/png"]],
  ["/icons/quarterdeck-512.png", ["icons/quarterdeck-512.png", "image/png"]],
  ["/icons/apple-touch-icon-180.png", ["icons/apple-touch-icon-180.png", "image/png"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/sidebar-version.js", ["sidebar-version.js", "text/javascript; charset=utf-8"]],
  ["/work-hierarchy.js", ["work-hierarchy.js", "text/javascript; charset=utf-8"]],
  ["/bulk-controls.js", ["bulk-controls.js", "text/javascript; charset=utf-8"]],
  ["/message-kinds.js", ["message-kinds.js", "text/javascript; charset=utf-8"]],
  ["/filter-view.js", ["filter-view.js", "text/javascript; charset=utf-8"]],
  ["/pane-bounds.js", ["pane-bounds.js", "text/javascript; charset=utf-8"]],
  ["/message-font-size.js", ["message-font-size.js", "text/javascript; charset=utf-8"]],
  ["/quota-view-model.js", ["quota-view-model.js", "text/javascript; charset=utf-8"]],
  ["/cost-view-model.js", ["cost-view-model.js", "text/javascript; charset=utf-8"]],
  ["/review-target.js", ["review-target.js", "text/javascript; charset=utf-8"]],
  ["/review-client.js", ["review-client.js", "text/javascript; charset=utf-8"]],
  ["/panel-resize.js", ["panel-resize.js", "text/javascript; charset=utf-8"]],
  ["/shell-panel.js", ["shell-panel.js", "text/javascript; charset=utf-8"]],
  ["/shell-panel-layout.js", ["shell-panel-layout.js", "text/javascript; charset=utf-8"]],
  ["/shell-width.js", ["shell-width.js", "text/javascript; charset=utf-8"]],
  ["/shell-panel.css", ["shell-panel.css", "text/css; charset=utf-8"]],
  ["/preview-selector.js", ["preview-selector.js", "text/javascript; charset=utf-8"]],
  ["/bearings-patch.js", ["bearings-patch.js", "text/javascript; charset=utf-8"]],
  ["/bearings-live.js", ["bearings-live.js", "text/javascript; charset=utf-8"]],
  ["/bearings-view.js", ["bearings-view.js", "text/javascript; charset=utf-8"]],
  ["/bearings-answer-form.js", ["bearings-answer-form.js", "text/javascript; charset=utf-8"]],
  ["/bearings-overflow.js", ["bearings-overflow.js", "text/javascript; charset=utf-8"]],
  ["/bearings-dismiss.js", ["bearings-dismiss.js", "text/javascript; charset=utf-8"]],
  ["/bearings-thread-panel.js", ["bearings-thread-panel.js", "text/javascript; charset=utf-8"]],
  ["/bearings-procrastinate.js", ["bearings-procrastinate.js", "text/javascript; charset=utf-8"]],
  ["/bearings-landed.js", ["bearings-landed.js", "text/javascript; charset=utf-8"]],
  ["/overview-tabs.js", ["overview-tabs.js", "text/javascript; charset=utf-8"]],
  ["/call-lifecycle.js", ["call-lifecycle.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

class PublicDataError extends Error {}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parseCents(amount) {
  if (typeof amount !== "string" || !/^-?\d+\.\d{2}$/.test(amount)) {
    throw new Error(`invalid ledger amount: ${amount}`);
  }
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [units, decimals] = unsigned.split(".");
  const cents = BigInt(units) * 100n + BigInt(decimals);
  return negative ? -cents : cents;
}

function formatCents(cents) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
}

function displayLabel(value) {
  const titleWord = (word) => {
    const upper = word.toUpperCase();
    return ["AI", "API", "DNS", "SaaS"].includes(upper) ? upper : word[0].toUpperCase() + word.slice(1).toLowerCase();
  };
  return String(value).trim().split(/[-_\s]+/).filter(Boolean)
    .map((word) => word.split("/").map(titleWord).join("/"))
    .join(" ");
}

function expenseCategory(entry) {
  if (typeof entry.category === "string" && entry.category.trim()) return displayLabel(entry.category);
  const text = `${entry.project_id || ""} ${entry.project_name || ""} ${entry.description || ""} ${entry.note || ""}`.toLowerCase();
  if (typeof entry.amount === "string" && entry.amount.startsWith("-")) return "Credits";
  if (/\b(hosting|cloudflare)\b/.test(text)) return "Hosting";
  if (/\b(domain|dns|porkbun|registrar)\b/.test(text)) return "Domains & DNS";
  if (/\b(model|openai|codex|xai|google ai|anthropic)\b/.test(text)) return "AI & model services";
  if (/\bgithub\b/.test(text) || (/\bartifact signing\b/.test(text) && !/\busage beyond\b/.test(text))) return "Developer tools";
  if (/\b(azure|aws|gcp|cloud usage)\b/.test(text)) return "Cloud services";
  if (/\b(m365|microsoft 365|software|subscription|saas)\b/.test(text)) return "Software subscriptions";
  return "Uncategorized";
}

function expenseDescription(entry) {
  const description = entry.description || entry.note || "No description provided";
  return typeof description === "string" ? description.replace(/^\[[^\]]+\]\s*/, "") : String(description);
}

function expenseConfidence(entry) {
  if (entry.confidence !== undefined && entry.confidence !== null && String(entry.confidence).trim()) return displayLabel(entry.confidence);
  const tag = typeof entry.note === "string" ? entry.note.match(/^\[([^\]]+)\]/)?.[1] : null;
  return tag ? displayLabel(tag) : null;
}

export function rollupLedger(ledger) {
  if (!ledger || !Array.isArray(ledger.entries) || typeof ledger.default_currency !== "string" || !ledger.default_currency) {
    throw new Error("ledger must include default_currency and an entries array");
  }

  const overall = ledger.entries.length === 0 ? new Map([[ledger.default_currency, 0n]]) : new Map();
  const projects = new Map();
  const categories = new Map();
  const entries = [];
  for (const entry of ledger.entries) {
    const currency = entry.currency || ledger.default_currency;
    const cents = parseCents(entry.amount);
    overall.set(currency, (overall.get(currency) || 0n) + cents);
    const projectId = entry.project_id;
    if (typeof projectId !== "string" || !projectId) throw new Error("ledger entry is missing project_id");
    if (!projects.has(projectId)) {
      projects.set(projectId, { id: projectId, name: entry.project_name || projectId, totals: new Map() });
    }
    const project = projects.get(projectId);
    if (entry.project_name) project.name = entry.project_name;
    project.totals.set(currency, (project.totals.get(currency) || 0n) + cents);

    const category = expenseCategory(entry);
    if (!categories.has(category)) categories.set(category, new Map());
    const categoryTotals = categories.get(category);
    categoryTotals.set(currency, (categoryTotals.get(currency) || 0n) + cents);
    entries.push({
      id: entry.id || "",
      date: entry.date || "",
      projectId,
      projectName: entry.project_name || projectId,
      category,
      amount: entry.amount,
      currency,
      description: expenseDescription(entry),
      confidence: expenseConfidence(entry),
    });
  }

  const money = ([currency, cents]) => ({ currency, amount: formatCents(cents) });
  return {
    entryCount: entries.length,
    overall: [...overall.entries()].sort().map(money),
    projects: [...projects.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((project) => ({ ...project, totals: [...project.totals.entries()].sort().map(money) })),
    categories: [...categories.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, totals]) => ({ name, totals: [...totals.entries()].sort().map(money) })),
    entries,
  };
}

function validateFleet(fleet) {
  if (!fleet || typeof fleet !== "object" || Array.isArray(fleet)) throw new Error("status JSON must be an object");
  if (!fleet.summary || typeof fleet.summary !== "object" || Array.isArray(fleet.summary)) {
    throw new Error("status JSON must include a summary object");
  }
  for (const field of ["activeAgents", "openDecisions", "completedToday"]) {
    if (!Number.isFinite(fleet.summary[field])) throw new Error(`status summary.${field} must be a number`);
  }
  if (!Array.isArray(fleet.projects)) throw new Error("status JSON must include a projects array");
  for (const project of fleet.projects) {
    if (!project || typeof project !== "object" || Array.isArray(project)) throw new Error("each status project must be an object");
    for (const field of ["id", "name", "status", "mission"]) {
      if (typeof project[field] !== "string" || !project[field]) throw new Error(`status project.${field} must be a non-empty string`);
    }
    if (!Number.isFinite(project.agents) || !Number.isFinite(project.progress)) {
      throw new Error("status project agents and progress must be numbers");
    }
    if (!Array.isArray(project.items)) throw new Error("status project.items must be an array");
  }
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "lane";
}

function shortIntent(value, limit = 240) {
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

function laneStatus(tasks) {
  const states = tasks.map((task) => task.classification?.status || "unknown");
  for (const status of ["captain-action", "active", "waiting", "cleanup", "unknown", "backlog", "newly-done"]) {
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
async function workSplit(home, backlogTasks, stateNames, agentState, projects, repositoryPaths, durability, acknowledgementsAvailable, reader) {
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
      const folded = foldStatusLines(text.trim().split(/\r?\n/).filter(Boolean), { kind: stateNames.includes(`${task.id}.meta`) ? parseMeta(await readFile(path.join(home, "state", `${task.id}.meta`), "utf8")).kind || "ship" : "unknown" });
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
      const meta = await readFile(path.join(home, "state", `${task.id}.meta`), "utf8");
      repository = path.basename(parseMeta(meta).project || "") || repository;
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
    const meta = stateNames.includes(`${id}.meta`) ? parseMeta(await readFile(path.join(home, "state", `${id}.meta`), "utf8")) : {};
    const lines = stateNames.includes(`${id}.status`) ? (await readFile(path.join(home, "state", `${id}.status`), "utf8")).split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
    const folded = foldStatusLines(lines, { kind: stateNames.includes(`${id}.meta`) ? meta.kind || "ship" : "unknown" });
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
      inFlight: Boolean(task?.inFlight), queued: task?.section === "queued", endpointLive,
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
    const [registry, stateNames, backlogTasks, captainNotes, transcript, outboxMessages, supervision, inboxReplies] = await Promise.all([
      readFile(path.join(resolvedHome, "data", "projects.md"), "utf8"),
      readdir(path.join(resolvedHome, "state")),
      readBacklog(resolvedHome, reader),
      includeHistory ? readCaptainNotes(resolvedHome, reader) : [],
      includeHistory ? readConversationTranscript(resolvedHome, publicMessage, { selectedIds: diskIds, older: diskOlder, reader, claudeConfigDir, windowBytes }) : { messages: [], coverage: {} },
      includeHistory ? readOutboxMessages(resolvedHome, reader) : [],
      includeHistory ? readSupervisionOutcomes(resolvedHome, publicMessage, reader) : { messages: [], sources: [] },
      includeHistory ? readInboxReplies(resolvedHome, reader) : [],
    ]);
    const projects = parseProjects(registry);
    const repositoryPaths = await repositoryPathsForHome(resolvedHome, projects);
    let agentState;
    let taxonomyWarning = null;
    try { agentState = await agentStateOwner.read(); }
    catch { agentState = emptyAgentState(); taxonomyWarning = "Quarterdeck classification state unavailable; showing explicit unclassified fallback. Changes disabled until the state is repaired."; }
    const split = await workSplit(resolvedHome, backlogTasks, stateNames, agentState, projects, repositoryPaths, durability, !taxonomyWarning, reader);
    split.warning = taxonomyWarning;
    const currentWork = new Map(split.items.map((item) => [item.id, item]));
    if (!projects.length) throw new Error("data/projects.md has no project entries");

    const metaNames = stateNames.filter((name) => name.endsWith(".meta") && !name.startsWith(".")).sort();
    const metaTaskIds = new Set(metaNames.map((name) => name.slice(0, -5)));
    const taskIdsToLoad = new Set(metaTaskIds);
    for (const [taskId, task] of backlogTasks) {
      if (task.inFlight || stateNames.includes(`${taskId}.status`)) taskIdsToLoad.add(taskId);
    }
    const taskResults = await Promise.all([...taskIdsToLoad].sort().map(async (taskId) => {
      const metaPresent = metaTaskIds.has(taskId);
      const statusName = `${taskId}.status`;
      const backlogTask = backlogTasks.get(taskId);
      let projectName = backlogTask?.projectName || "";
      if (metaPresent) {
        const metaText = await readFile(path.join(resolvedHome, "state", `${taskId}.meta`), "utf8");
        projectName = path.basename(parseMeta(metaText).project || "") || projectName;
      }
      if (!projectName) return null;

      let statusEvents = [];
      if (stateNames.includes(statusName)) {
        const statusPath = path.join(resolvedHome, "state", statusName);
        const [statusText, statusStat] = await Promise.all([readFile(statusPath, "utf8"), stat(statusPath)]);
        const lines = statusText.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        statusEvents = lines.map((line, index) => {
          reader.takeMessage();
          const event = parseStatusLine(line);
          // A status file only supplies one clock. Keep its lines on that real mtime
          // and use file order solely as a stable tie-break, never fake milliseconds.
          const timestamp = new Date(statusStat.mtimeMs);
          return publicMessage({
            ...event,
            timestamp,
            timestampSource: "mtime",
            sourceSequence: index,
            author: taskId,
            role: "crew",
            source: `state/${statusName}`,
            taskId,
            text: `${event.state}: ${event.text}`,
            kind: "crew",
          });
        });
      }
      const [briefIntent, lastSteer] = await Promise.all([readBriefIntent(resolvedHome, taskId), includeHistory ? steerActivity(resolvedHome, taskId) : null]);
      return {
        id: taskId,
        projectName,
        inFlight: Boolean(backlogTask?.inFlight),
        isLive: currentWork.get(taskId)?.status === "active",
        state: currentWork.get(taskId)?.sourceState || "unknown",
        classification: currentWork.get(taskId),
        taskIntent: currentTaskIntent(backlogTask, briefIntent),
        events: statusEvents,
        activityAt: lastSteer && (!statusEvents.length || lastSteer > statusEvents[0].timestamp) ? lastSteer : statusEvents[0]?.timestamp || null,
      };
    }));
    const tasks = taskResults.filter(Boolean);
    const byTask = new Map(tasks.map((task) => [task.id, task]));
    for (const event of [...captainNotes, ...outboxMessages, ...supervision.messages]) {
      const task = byTask.get(event.taskId);
      if (task && event.timestamp && (!task.activityAt || event.timestamp > task.activityAt)) task.activityAt = event.timestamp;
    }
    // History loading is independent of live execution and completion attention.
    const visibleTasks = new Set(sessionIds.slice(0, 60));
    for (const project of projects) {
      const ordered = publicSessions(tasks.filter((task) => task.projectName === project.name));
      for (const session of ordered.slice(0, 2 + Math.min(older, 20) * 10)) visibleTasks.add(session.id);
      for (const session of ordered) if (!["done", "failed"].includes(session.state)) visibleTasks.add(session.id);
    }
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
      ? projectedBlocks(message, "general") : [message]), ...unroutedOutbox, ...supervision.messages];

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
      const messages = publicTimeline([...projectTasks.filter((task) => visibleTasks.has(task.id)).flatMap((task) => task.events), ...sharedMessages.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...routedCaptainNotes.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...routedOutbox.filter((message) => !message.taskId || visibleTasks.has(message.taskId)), ...routedSupervision.filter((message) => !message.taskId || visibleTasks.has(message.taskId))]);
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
        sessions: publicSessions(projectTasks).map((session) => ({ ...session, loaded: visibleTasks.has(session.id) })),
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
      transcript: { ...transcript.coverage, outcomeSources: supervision.sources },
      workSplit: split,
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

function fleetFromFirstmate(firstmate) {
  return {
    summary: firstmate.summary,
    workSplit: firstmate.workSplit,
    projects: firstmate.lanes.map((lane) => ({
      id: lane.id,
      name: lane.name,
      status: lane.status,
      mission: lane.mission,
      intent: lane.intent || "Fleet intent not recorded.",
      agents: lane.crew,
      progress: lane.progress,
      items: lane.items,
    })),
    source: firstmate.source,
  };
}

async function loadFleet(env, agentStateOwner, durability) {
  if (env.FM_HOME) return fleetFromFirstmate(await loadFirstmateHome(env.FM_HOME, { includeHistory: false, agentStateOwner, durability }));
  const configuredPath = env.FM_STATUS_PATH ? path.resolve(env.FM_STATUS_PATH) : null;
  const fleet = await readJson(configuredPath || DEFAULT_FLEET_PATH);
  validateFleet(fleet);
  return {
    ...fleet,
    projects: fleet.projects.map((project) => ({
      ...project,
      intent: shortIntent(project.intent || project.mission) || "Fleet intent not recorded.",
      items: project.items.map((item) => ({
        ...item,
        taskIntent: shortIntent(item.taskIntent) || "Task intent not recorded.",
      })),
    })),
    source: configuredPath ? "configured status" : "demo fixture (set FM_HOME for live fleet)",
  };
}

export async function loadExpenses(env = {}, { canonicalPath = CANONICAL_LEDGER_PATH, demoPath = DEMO_LEDGER_PATH } = {}) {
  try {
    const overlay = await readExpenseOverlay(env);
    if (overlay) return { ...rollupLedger(overlay.ledger), source: "private overlay (selected FM_HOME)", demo: false };
  } catch {
    return { entryCount: 0, overall: [], projects: [], categories: [], entries: [], source: "private overlay (selected FM_HOME)", demo: false, error: "Private expense overlay could not be read." };
  }
  try {
    const ledger = await readJson(canonicalPath);
    return { ...rollupLedger(ledger), source: "expenses/ledger.json", demo: false };
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { entryCount: 0, overall: [], projects: [], categories: [], entries: [], source: "expenses/ledger.json", demo: false, error: "Expense ledger could not be read." };
    }
    const demoLedger = await readJson(demoPath);
    return { ...rollupLedger(demoLedger), source: "demo fixture (expenses/ledger.json not found)", demo: true };
  }
}

export async function dashboardData(env = process.env, agentStateOwner = createAgentStateOwner(configuredStatePath(env)), durability = verifyDurability, expenseReader = loadExpenses) {
  const [fleet, expenses, firstmateActivity] = await Promise.all([loadFleet(env, agentStateOwner, durability), expenseReader(env), readFirstmateActivity(env.FM_HOME, { claudeConfigDir: claudeConfigDir(env) })]);
  const configuredRefresh = Number(env.FM_REFRESH_MS || 0);
  return {
    generatedAt: new Date().toISOString(),
    refreshMs: Number.isFinite(configuredRefresh) && configuredRefresh >= 5000 ? configuredRefresh : 0,
    fleet,
    expenses,
    firstmateActivity,
  };
}

async function sendJson(request, response, status, body) {
  const acceptsGzip = String(request.headers["accept-encoding"] || "").split(",")
    .some((encoding) => {
      const match = encoding.trim().match(/^gzip(?:\s*;\s*q=(0(?:\.\d+)?|1(?:\.0+)?|\.\d+))?$/i);
      return match && (match[1] === undefined || Number(match[1]) > 0);
    });
  const json = JSON.stringify(body);
  const payload = acceptsGzip ? await gzipAsync(json) : json;
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    vary: "Accept-Encoding",
    ...(acceptsGzip ? { "content-encoding": "gzip" } : {}),
  });
  response.end(payload);
}

export function createServer(env = process.env, { publicDir = PUBLIC_DIR, quotaReader = createQuotaReader({ maxAge: env.FM_QUOTA_MAX_AGE }), bearingsSource = createCallSource({ home: env.FM_HOME, hub: createBearingsHub({ home: env.FM_HOME, minGapMs: env.FM_BEARINGS_MIN_GAP_MS, maxAgeMs: env.FM_BEARINGS_MAX_AGE_MS }), chat: createChatAskScanner({ home: env.FM_HOME, claudeConfigDir: claudeConfigDir(env), statePath: chatAsksPath(configuredStatePath(env)) }) }), bearingsStream = {}, answerRelay = createAnswerRelay({ home: env.FM_HOME }), threadRelay = createThreadRelay({ home: env.FM_HOME, transcript: createTranscriptTurns({ home: env.FM_HOME, claudeConfigDir: claudeConfigDir(env) }) }), costReader = createConfiguredCostReader(env), expenseReader = loadExpenses, lanesReader = loadFirstmateHome, durabilityVerifier = verifyDurability, reviewDeliver = deliverReview, localReviewDeliver = (payload, statusPath) => deliverLocalReview(payload, undefined, statusPath), localReviewReceipt = reconcileLocalReview, reviewCount = (receipts) => awaitingReviewCount(undefined, receipts), reviewStatus = localReviewStatus, previewRegistry, chatDeliver, revisionResolver = createRevisionResolver(REPO_DIR, reviewVersion), lifecycleFactory = (entries, options) => new PreviewLifecycle(entries, options), procrastination = createProcrastinationStore(env), landedAcks = createLandedAckStore(env) } = {}) {
  const review = reviewConfiguration(env);
  const agentStatePath = configuredStatePath(env);
  const agentStateOwner = createAgentStateOwner(agentStatePath);
  if (env.FM_HOME) {
    const relative = path.relative(path.resolve(env.FM_HOME), path.resolve(agentStatePath));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Quarterdeck presentation state must be outside FM_HOME");
  }
  const servedCommit = revisionResolver.initial;
  const registered = validateRegistry(previewRegistry ?? (env.FM_PREVIEW_REGISTRY_PATH ? JSON.parse(readFileSync(env.FM_PREVIEW_REGISTRY_PATH, "utf8")) : []));
  const deploymentTier = env.FM_DEPLOYMENT_TIER || "";
  if (deploymentTier && deploymentTier !== "uat") throw new Error("UAT-only deployment cannot be a Main gateway");
  const hostId = deploymentTier === "uat" ? "uat" : "main";
  if (registered.length && (!registered.some((entry) => entry.id === hostId && entry.commit === servedCommit && !entry.checkout && !entry.port) ||
      (deploymentTier === "uat" && registered.some((entry) => entry.id === "main")))) {
    throw new Error("Registry must include the exact stable host revision (not a managed child)");
  }
  const registry = new Map(registered.map((entry) => [entry.id, entry]));
  const lifecycle = lifecycleFactory(registered, { root: env.FM_PREVIEW_ROOT, primary: REPO_DIR, mainCommit: servedCommit, hostId, env: { ...env, FM_QUARTERDECK_STATE_PATH: agentStatePath },
    idleMs: env.FM_PREVIEW_IDLE_MS, startMs: env.FM_PREVIEW_START_MS, stopMs: env.FM_PREVIEW_STOP_MS,
    portMin: env.FM_PREVIEW_PORT_MIN, portMax: env.FM_PREVIEW_PORT_MAX });
  const syncRevision = async (force = false) => {
    const commit = await revisionResolver.snapshot(force);
    return commit === servedCommit ? commit : null;
  };
  const lastDataRead = new Map();
  // In-flight and confirmed sends in this gateway process share the same receipt.
  // The receiver must also deduplicate messageId durably across gateway restarts.
  const chatReceipts = new Map();
  // Only an operator-configured, canonical HTTPS DNS origin may bypass the loopback review guard.
  // Match the wire Host and Origin exactly; forwarding headers are not authority.
  const allowedReviewOrigin = env.FM_REVIEW_ALLOWED_ORIGIN || "";
  if (allowedReviewOrigin && !/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(allowedReviewOrigin)) {
    throw new Error("FM_REVIEW_ALLOWED_ORIGIN must be one exact HTTPS DNS origin without port or path");
  }
  const dev = env.FM_DEV === "1";
  let version = randomUUID();
  const clients = new Set();
  const authorized = (request) => {
    const host = request.headers.host || "";
    const origin = request.headers.origin || "";
    return (/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) && origin === `http://${host}`) ||
      Boolean(allowedReviewOrigin && host === allowedReviewOrigin.slice("https://".length) && origin === allowedReviewOrigin);
  };
  const previewReads = new Set(["/", "/app.js", "/sidebar-version.js", "/bulk-controls.js", "/work-hierarchy.js", "/message-kinds.js", "/filter-view.js", "/pane-bounds.js", "/message-font-size.js", "/quota-view-model.js", "/cost-view-model.js", "/styles.css", "/review-target.js", "/review-client.js", "/panel-resize.js", "/shell-panel.js", "/shell-panel-layout.js", "/shell-width.js", "/shell-panel.css", "/dev-reload.js", "/bearings-patch.js", "/bearings-live.js", "/bearings-view.js", "/bearings-answer-form.js", "/bearings-overflow.js", "/bearings-dismiss.js", "/bearings-thread-panel.js", "/bearings-procrastinate.js", "/bearings-landed.js", "/overview-tabs.js", "/call-lifecycle.js", "/api/dashboard", "/api/lanes", "/api/preferences", "/api/preferences/health", "/api/quota", "/api/bearings", "/api/costs", "/api/health", "/api/review", "/api/review/status", "/api/dev-reload"]);
  // Live Captain's Call streams (host only; previews poll /api/bearings?since).
  const streamOptions = { heartbeatMs: 20000, recycleMs: 600000, maxStreams: 16, ...bearingsStream };
  const streams = new Set();
  const server = http.createServer(async (request, response) => {
    let release;
    let used = false;
    let workDone = false;
    let responseDone = false;
    const finishUse = () => { if (workDone && responseDone && release) { release(used); release = null; } };
    for (const event of ["finish", "close"]) response.once(event, () => { responseDone = true; finishUse(); });
    try {
      const url = new URL(request.url || "/", "http://localhost");
      const preview = previewPath(url.pathname);
      const commit = await syncRevision();
      if (!commit) { await sendJson(request, response, 503, { error: "Serving revision unavailable" }); return; }
      const registeredSelection = preview ? registry.get(preview.id) : registry.get(hostId);
      const selected = registeredSelection?.id === hostId ? { ...registeredSelection, commit } : registeredSelection;
      const selectedCommit = selected?.commit || commit;
      if (request.method === "GET" && url.pathname === "/api/previews") {
        await lifecycle.ready;
        await sendJson(request, response, 200, lifecycle.list());
        return;
      }
      if (url.pathname === "/api/previews/select" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 400, { error: "Registry ID JSON only" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (text.length > 256) { await sendJson(request, response, 413, { error: "Selection too large" }); return; } }
        let body;
        try { body = JSON.parse(text); } catch {}
        if (!body || Object.keys(body).join(",") !== "id" || typeof body.id !== "string" || !registry.has(body.id)) { await sendJson(request, response, 400, { error: "Select only a registered ID" }); return; }
        const result = await lifecycle.select(body.id);
        await sendJson(request, response, result.accepted ? 200 : 409, result);
        return;
      }
      if (preview && !selected) { await sendJson(request, response, 404, { error: "Unknown preview" }); return; }
      if (preview?.id === hostId && lifecycle.status(hostId).state !== "ready") {
        await sendJson(request, response, 409, { error: "Stable host revision differs from registered checkpoint; preview refused" }); return;
      }
      if (preview && request.method === "POST" && !authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
      if (preview && request.method === "GET" && !previewReads.has(preview.pathname)) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
      if (preview && selected.id !== hostId) release = lifecycle.acquire(selected.id);
      if (preview && selected.id !== hostId && (!release || !await lifecycle.verify(selected.id))) {
        if (request.method === "GET" && preview.pathname === "/") {
          response.writeHead(503, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
          response.end(`<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Quarterdeck · preview unavailable</title><link rel="stylesheet" href="/styles.css"><script>window.FM_HOST_ID=${JSON.stringify(hostId)};window.FM_PREVIEW_ID=${JSON.stringify(selected.id)};window.FM_SERVED_COMMIT=${JSON.stringify(selected.commit)}</script><script defer src="/preview-selector.js"></script></head><body><main style="padding-top:160px"><header class="product-identity"><strong>Quarterdeck · preview unavailable</strong></header><p role="status" style="margin:16px">This version is not ready. Select it to start, retry below, or return to the stable ${hostId === "main" ? "Main" : "UAT"} host. Your drafts are retained in this tab.</p></main></body></html>`);
        } else await sendJson(request, response, 503, { error: "Preview stopped", branch: selected.branch, commit: selected.commit });
        return;
      }
      if (preview && selected.id !== hostId && request.method === "GET" && !["/api/review", "/api/review/status", "/api/quota", "/api/costs"].includes(preview.pathname)) {
        await proxyPreview(lifecycle.runtime(selected.id), preview.pathname, url.search, request, response, (time) => { used = true; lastDataRead.set(selected.id, time); }, hostId);
        if (preview.pathname === "/" && response.statusCode === 200) used = true;
        return;
      }
      if (preview && (selected.id === hostId || ["/api/quota", "/api/costs", "/api/work-state"].includes(preview.pathname))) url.pathname = preview.pathname;
      if (selected?.id === hostId && request.method === "GET" && ["/api/dashboard", "/api/lanes", "/api/preferences", "/api/preferences/health", "/api/quota", "/api/costs"].includes(url.pathname)) {
        response.once("finish", () => { if (response.statusCode === 200) lastDataRead.set(hostId, new Date().toISOString()); });
      }
      if (preview && preview.pathname === "/api/chat" && request.method === "POST") {
        const host = request.headers.host || "";
        const origin = request.headers.origin || "";
        const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) && origin === `http://${host}`;
        const allowed = allowedReviewOrigin && host === allowedReviewOrigin.slice("https://".length) && origin === allowedReviewOrigin;
        if (!loopback && !allowed) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
        if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 415, { error: "JSON required" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (text.length > 12288) { await sendJson(request, response, 413, { error: "Chat too large" }); return; } }
        let message;
        try { message = JSON.parse(text); } catch { message = null; }
        if (!message || Object.keys(message).sort().join(",") !== "messageId,route,schema,text,viewContext" || message.schema !== "fm-agentos-chat.v1" ||
            typeof message.text !== "string" || !message.text.trim() || message.text.length > 4000 ||
            typeof message.route !== "string" || !/^#(?:lanes(?:\/[^\s#?]*)?|overview|work|expenses|quota|preferences|closed)$/.test(message.route) ||
            typeof message.messageId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(message.messageId) ||
            !validChatView(message.viewContext, message.route, selected.branch, selected.commit)) {
          await sendJson(request, response, 400, { error: "Invalid chat message" }); return;
        }
        if (selected.id === hostId && await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Serving revision changed; retry" }); return; }
        if (!chatDeliver) { await sendJson(request, response, 503, { error: "Primary Firstmate chat is not configured" }); return; }
        used = true;
        try {
          const key = `${selected.id}:${message.messageId}`;
          const fingerprint = JSON.stringify(message);
          const prior = chatReceipts.get(key);
          if (prior && prior.fingerprint !== fingerprint) { await sendJson(request, response, 409, { error: "Message ID already used for different content" }); return; }
          let delivery = prior?.delivery;
          if (!delivery) {
            delivery = chatDeliver({ ...message, destination: "primary-firstmate", provenance: {
              preview: selected.id, branch: selected.branch, commit: selected.commit, remoteCheckpoint: selected.remoteCheckpoint, receivedAt: new Date().toISOString(), dataReadAt: lastDataRead.get(selected.id) || null, route: message.route,
            } }).then((receipt) => {
              if (!receipt || typeof receipt.receiptId !== "string" || !receipt.receiptId) throw new Error("Missing receipt");
              return receipt;
            });
            chatReceipts.set(key, { fingerprint, delivery });
          }
          try {
            const receipt = await delivery;
            await sendJson(request, response, 200, { receiptId: receipt.receiptId, contextAttached: true });
          } catch {
            chatReceipts.delete(key); // Unconfirmed deliveries may be retried with the same receiver idempotency key.
            await sendJson(request, response, 502, { error: "Chat delivery unconfirmed" });
          }
        } catch { await sendJson(request, response, 502, { error: "Chat delivery unconfirmed" }); }
        return;
      }
      if (url.pathname === "/api/work-state" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 400, { error: "JSON required" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (text.length > 2048) { await sendJson(request, response, 413, { error: "Request too large" }); return; } }
        let body;
        try { body = JSON.parse(text); } catch {}
        if (!body || !["acknowledge", "classify", "create-taxonomy"].includes(body.action) || !/^[a-f0-9]{64}$/.test(body.taskFingerprint || "")) { await sendJson(request, response, 400, { error: "Invalid presentation request" }); return; }
        const current = await loadFirstmateHome(env.FM_HOME, { includeHistory: false, agentStateOwner, durability: durabilityVerifier });
        const item = current.workSplit.items.find((entry) => entry.taskFingerprint === body.taskFingerprint);
        if (!item || current.workSplit.warning) { await sendJson(request, response, 409, { error: "Current task or Quarterdeck state unavailable" }); return; }
        try {
          if (body.action === "acknowledge") {
            if (Object.keys(body).sort().join(",") !== "action,completionFingerprint,taskFingerprint" || !item.completionFingerprint || item.completionFingerprint !== body.completionFingerprint) { await sendJson(request, response, 409, { error: "Completion changed; refresh before acknowledging" }); return; }
            const ack = await agentStateOwner.acknowledge(body.taskFingerprint, body.completionFingerprint);
            await sendJson(request, response, 200, { acknowledgedAt: ack.acknowledgedAt });
          } else {
            if (body.action === "classify" && Object.keys(body).sort().join(",") !== "action,laneId,taskFingerprint,themeId") throw new Error("Invalid assignment");
            if (body.action === "create-taxonomy" && Object.keys(body).sort().join(",") !== "action,kind,laneName,taskFingerprint,themeName") throw new Error("Invalid taxonomy");
            const backlog = await readBacklog(env.FM_HOME);
            let meta = {};
            try { meta = parseMeta(await readFile(path.join(env.FM_HOME, "state", `${item.id}.meta`), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
            const recordedRepository = meta.project || backlog.get(item.id)?.repositoryPath;
            const repositoryPaths = await repositoryPathsForHome(path.resolve(env.FM_HOME), parseProjects(await readFile(path.join(env.FM_HOME, "data", "projects.md"), "utf8")));
            const { repositoryPath } = resolveRepositoryIdentity(recordedRepository, await agentStateOwner.read(), repositoryPaths);
            if (!repositoryPath || fingerprint("task.v1", repositoryPath, item.id) !== item.taskFingerprint) throw new Error("Repository identity changed or unknown");
            await agentStateOwner.update((state) => {
              const latestIdentity = resolveRepositoryIdentity(recordedRepository, state, repositoryPaths);
              if (latestIdentity.repositoryPath !== repositoryPath) throw new Error("Repository identity changed");
              let repo = latestIdentity.repository;
              if (body.action === "create-taxonomy") {
                if (!repo) { repo = { id: item.repositoryId, name: item.repository, path: path.normalize(repositoryPath), lanes: [] }; state.repositories.push(repo); }
                let lane = repo.lanes.find((entry) => entry.name === body.laneName);
                if (!lane) { lane = { id: `lane-${fingerprint(body.laneName).slice(0, 24)}`, name: body.laneName, themes: [] }; repo.lanes.push(lane); }
                let theme = lane.themes.find((entry) => entry.name === body.themeName && entry.kind === body.kind);
                if (!theme) { theme = { id: `theme-${fingerprint(body.themeName, body.kind).slice(0, 24)}`, name: body.themeName, kind: body.kind }; lane.themes.push(theme); }
                state.assignments[item.taskFingerprint] = { repositoryId: repo.id, laneId: lane.id, themeId: theme.id };
              } else if (body.laneId === "unclassified" && body.themeId === "unclassified") delete state.assignments[item.taskFingerprint];
              else state.assignments[item.taskFingerprint] = { repositoryId: repo?.id, laneId: body.laneId, themeId: body.themeId };
            });
            await sendJson(request, response, 200, { saved: true });
          }
        } catch { await sendJson(request, response, 400, { error: "Invalid or unavailable Quarterdeck presentation state" }); }
        return;
      }
      if (url.pathname === "/api/review/status" || (preview && preview.pathname === "/api/review/status")) {
        if (request.method !== "GET" || review.delivery !== "local" || !/^[0-9a-f-]{36}$/i.test(url.searchParams.get("batchId") || "")) {
          await sendJson(request, response, 400, { error: "Local batch ID required" }); return;
        }
        const batch = url.searchParams.get("batchId");
        const status = await reviewStatus(batch);
        const intake = status && env.FM_HOME ? inboxReviewState(await inboxReceipts(env.FM_HOME), batch) : null;
        await sendJson(request, response, status ? 200 : 404, status ? { ...status, ...(intake && status.state === "accepted" ? intake : {}), intake: intake?.state || null } : { error: "Receipt not found; keep the batch and retry Send" });
        return;
      }
      if (url.pathname === "/api/review" || (preview && preview.pathname === "/api/review")) {
        if (request.method === "GET") {
          used = true;
          const intakeReady = review.delivery === "local" && env.FM_HOME ? await inboxReady(env.FM_HOME).catch(() => false) : false;
          const receipts = review.delivery === "local" && env.FM_HOME ? await inboxReceipts(env.FM_HOME).catch(() => null) : null;
          await sendJson(request, response, 200, { version: selectedCommit, sessionId: review.sessionId, ready: review.ready, delivery: review.delivery,
            intakeReady, awaitingReview: review.delivery === "local" && (!env.FM_HOME || receipts) ? await reviewCount(receipts) : null });
          return;
        }
        if (request.method === "POST") {
          const host = request.headers.host || "";
          const origin = request.headers.origin || "";
          const loopback = /^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host) && origin === `http://${host}`;
          const allowed = allowedReviewOrigin && host === allowedReviewOrigin.slice("https://".length) && origin === allowedReviewOrigin;
          if (!loopback && !allowed) {
            await sendJson(request, response, 403, { error: "Review requires an authorized same-origin request" });
            return;
          }
          if (!/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) {
            await sendJson(request, response, 415, { error: "JSON required" });
            return;
          }
          let text = "";
          for await (const chunk of request) {
            text += chunk;
            if (text.length > 150000) { await sendJson(request, response, 413, { error: "Review too large" }); return; }
          }
          let payload;
          try { payload = JSON.parse(text); } catch { payload = null; }
          // A slow upload may span a fast-forward. Refuse it rather than deliver
          // under either a stale or mixed identity.
          if (await syncRevision(true) !== commit || !validateReviewPayload(payload, payload?.version, review.sessionId)) {
            await sendJson(request, response, 400, { error: "Invalid review payload or version" });
            return;
          }
          used = true;
          try {
            const existing = review.delivery === "local" ? await localReviewReceipt(payload) : null;
            if (existing) {
              if (env.FM_HOME) await announceReview(env.FM_HOME, existing.payload);
              await sendJson(request, response, 200, { receiptId: existing.receiptId, delivery: "local" });
              return;
            }
            if (payload.version !== selectedCommit) {
              await sendJson(request, response, 400, { error: "Invalid review payload or version" }); return;
            }
            const attributed = { ...payload, provenance: {
              branch: selected?.branch || (hostId === "uat" ? "uat" : null), commit: selectedCommit, remoteCheckpoint: selected?.remoteCheckpoint ?? null, preview: selected?.id || (hostId === "uat" ? "uat" : null),
              receivedAt: new Date().toISOString(), dataReadAt: lastDataRead.get(selected?.id || hostId) || null, route: payload.route,
            } };
            const receipt = review.delivery === "lavish"
              ? await reviewDeliver(attributed, review.endpoint)
              : await localReviewDeliver(attributed, env.FM_REVIEW_STATUS_PATH);
            if (review.delivery === "local" && env.FM_HOME) await announceReview(env.FM_HOME, attributed);
            await sendJson(request, response, 200, receipt);
          } catch {
            await sendJson(request, response, 502, { error: "Review delivery unconfirmed; queue retained for retry" });
          }
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        await sendJson(request, response, 200, await dashboardData(env, agentStateOwner, durabilityVerifier, expenseReader));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/lanes") {
        const ids = (name) => url.searchParams.getAll(name).filter((id) => id.length <= 250).slice(0, 60);
        const page = (name) => Math.min(20, Math.max(0, Number.parseInt(url.searchParams.get(name) || "0", 10) || 0));
        // Additive opt-in only: old callers retain the full bounded source window.
        const requestedBytes = Number(url.searchParams.get("windowBytes"));
        const windowBytes = url.searchParams.has("windowBytes") && Number.isSafeInteger(requestedBytes)
          ? Math.min(8 * 1024 * 1024, Math.max(1024 * 1024, requestedBytes)) : null;
        const firstmate = await lanesReader(env.FM_HOME, { sessionIds: ids("session"), diskIds: ids("disk"), older: page("older"), diskOlder: page("diskOlder"), agentStateOwner, durability: durabilityVerifier, claudeConfigDir: claudeConfigDir(env), windowBytes });
        await sendJson(request, response, 200, {
          generatedAt: new Date().toISOString(),
          source: firstmate.source,
          firstmateActivity: await readFirstmateActivity(env.FM_HOME, { claudeConfigDir: claudeConfigDir(env) }),
          ...(url.searchParams.get("format") === "refs.v1" ? compactLanes(firstmate.lanes) : { lanes: firstmate.lanes }),
          transcript: firstmate.transcript,
        });
        return;
      }
      if (url.pathname === "/api/preferences/health") {
        if (request.method === "GET") {
          await sendJson(request, response, 200, await readHealthPreferences(env));
          return;
        }
        if (request.method === "POST") {
          if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
          if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 400, { error: "JSON required" }); return; }
          let text = "";
          for await (const chunk of request) { text += chunk; if (text.length > 2048) { await sendJson(request, response, 413, { error: "Request too large" }); return; } }
          let value;
          try { value = JSON.parse(text); } catch {}
          if (!validHealthPreferences(value)) { await sendJson(request, response, 400, { error: "Use whole minutes from 1 to 1440 for both settings" }); return; }
          try { await sendJson(request, response, 200, await saveHealthPreferences(env, value)); }
          catch { await sendJson(request, response, 503, { error: "Health preferences could not be saved" }); }
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/preferences") {
        try {
          await sendJson(request, response, 200, await readPreferences(env.FM_HOME));
        } catch {
          await sendJson(request, response, 503, { error: "Preferences unavailable: check FM_HOME/data/captain.md." });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/costs") {
        await sendJson(request, response, 200, await costReader());
        used = true;
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/quota") {
        await sendJson(request, response, 200, await quotaReader());
        used = true;
        if (selected) lastDataRead.set(selected.id, new Date().toISOString());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bearings") {
        bearingsSource.touch();
        // A refresh or poll reads any new transcript lines first (bounded, stat-only when idle).
        // Only the chat scan is awaited; the snapshot run never delays a read.
        if (bearingsSource.refresh) await bearingsSource.refresh();
        const since = url.searchParams.get("since");
        const freshness = bearingsSource.freshness();
        const model = since && since === freshness.rev ? { unchanged: true, ...freshness } : bearingsSource.current();
        const firstmateActivity = await readFirstmateActivity(env.FM_HOME, { claudeConfigDir: claudeConfigDir(env) });
        await sendJson(request, response, 200, { ...model, firstmateActivity });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/bearings/stream") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        if (streams.size >= streamOptions.maxStreams) { await sendJson(request, response, 503, { error: "Too many live streams; poll /api/bearings" }); return; }
        openBearingsStream(request, response);
        return;
      }
      // Captain's Call answers: host only, an explicit captain submit relayed to Firstmate (BEARINGS.md "Answers").
      if (url.pathname === "/api/bearings/answer" && request.method === "POST") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > MAX_ANSWER_BODY_BYTES) { await sendJson(request, response, 413, { error: "Answer too large", code: "too-long" }); return; } }
        let body = null;
        try { body = JSON.parse(text); } catch {}
        // A request spanning a fast-forward is refused rather than answered under a mixed identity.
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        try {
          const accepted = await answerRelay.submit(body, bearingsSource.current());
          // A chat ask has no Firstmate hold to close it; the confirmed relay resolves it here.
          if (accepted.envelope?.type === "chat") await bearingsSource.resolveChat?.(accepted.key, "answered", { requestId: accepted.requestId }).catch(() => {});
          await sendJson(request, response, 202, accepted);
        } catch (error) {
          if (!(error instanceof AnswerRefused)) throw error;
          await sendJson(request, response, error.status, { error: error.message, code: error.code });
        }
        return;
      }
      // Dismiss a chat ask (BEARINGS.md "Chat asks"): recorded only in Quarterdeck's own state.
      if (url.pathname === "/api/bearings/dismiss" && request.method === "POST") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1024) { await sendJson(request, response, 413, { error: "Request too large", code: "too-long" }); return; } }
        let body = null;
        try { body = JSON.parse(text); } catch {}
        if (!body || typeof body !== "object" || Object.keys(body).sort().join(",") !== "cardRev,key" || !chatAskKey(body.key) || !/^[0-9a-f]{16}$/.test(String(body.cardRev))) {
          await sendJson(request, response, 400, { error: "Dismiss must name a chat ask and the revision shown", code: "invalid" }); return;
        }
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        const card = (bearingsSource.current().cards || []).find((entry) => entry.key === body.key);
        if (!card || card.type !== "chat") { await sendJson(request, response, 409, { error: "This ask is no longer open", code: "gone" }); return; }
        if (card.rev !== body.cardRev) { await sendJson(request, response, 409, { error: "This ask changed; review it before dismissing", code: "changed" }); return; }
        try { await bearingsSource.resolveChat(body.key, "dismissed"); }
        catch { await sendJson(request, response, 503, { error: "Quarterdeck could not record the dismissal; try again", code: "unrecorded" }); return; }
        await sendJson(request, response, 200, { state: "dismissed", key: body.key });
        return;
      }
      // Procrastinate (BEARINGS.md "Procrastinated calls"): Quarterdeck viewing state only, never an answer.
      if (url.pathname === "/api/bearings/procrastinate" && request.method === "GET") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        const current = bearingsSource.current?.() || {};
        const openKeys = current.state === "ready" || current.state === "stale"
          ? new Set((current.cards || []).map((card) => card.key)) : null;
        try { await sendJson(request, response, 200, await procrastination.view(openKeys)); }
        catch { await sendJson(request, response, 503, { error: "Procrastination state unavailable" }); }
        return;
      }
      if (url.pathname === "/api/bearings/procrastinate" && request.method === "POST") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1024) { await sendJson(request, response, 413, { error: "Request too large", code: "too-long" }); return; } }
        let body = null;
        try { body = JSON.parse(text); } catch {}
        const fields = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
        const durationOk = fields === "duration,key" && procrastinationKey(body.key) && ["3h", "6h", "1d", "3d"].includes(body.duration);
        const clearOk = fields === "clear,key" && body.clear === true && procrastinationKey(body.key);
        if (!durationOk && !clearOk) { await sendJson(request, response, 400, { error: "Procrastinate must name a call and a duration or a clear", code: "invalid" }); return; }
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        const card = (bearingsSource.current()?.cards || []).find((entry) => entry.key === body.key);
        if (!card) { await sendJson(request, response, 409, { error: "This call is no longer open", code: "gone" }); return; }
        try {
          const next = durationOk ? await procrastination.set(body.key, body.duration) : await procrastination.clear(body.key);
          await sendJson(request, response, 200, next);
        } catch { await sendJson(request, response, 503, { error: "Quarterdeck could not record procrastination; try again" }); }
        return;
      }
      // Just landed acknowledgements (BEARINGS.md "Just landed"): Quarterdeck viewing state only.
      if (url.pathname === "/api/bearings/landed/acks" && request.method === "GET") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        try { await sendJson(request, response, 200, await landedAcks.read()); }
        catch { await sendJson(request, response, 503, { error: "Landed acknowledgements unavailable" }); }
        return;
      }
      if (url.pathname === "/api/bearings/landed/ack" && request.method === "POST") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > 1024) { await sendJson(request, response, 413, { error: "Request too large", code: "too-long" }); return; } }
        let body = null;
        try { body = JSON.parse(text); } catch {}
        if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== "key" || !landedAckKey(body.key)) {
          await sendJson(request, response, 400, { error: "Acknowledge must name a landed card", code: "invalid" }); return;
        }
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        const current = bearingsSource.current?.() || {};
        if (current.state !== "ready" && current.state !== "stale") { await sendJson(request, response, 409, { error: "Just landed is not ready", code: "not-ready" }); return; }
        const open = current.landed || [];
        const card = open.find((entry) => entry.key === body.key);
        if (!card || !/^[0-9a-f]{16}$/.test(String(card.rev || ""))) { await sendJson(request, response, 409, { error: "This landing is no longer shown", code: "gone" }); return; }
        try {
          const next = await landedAcks.acknowledge(body.key, card.rev, new Set(open.map((entry) => entry.key)));
          await sendJson(request, response, 200, next);
        } catch { await sendJson(request, response, 503, { error: "Quarterdeck could not record the acknowledgement; try again" }); }
        return;
      }
      // Card threads (BEARINGS.md "Card threads"): an explicit captain question about one card,
      // relayed as an inbox note; the history is a read-only join. Host only.
      if (url.pathname === "/api/bearings/thread" && request.method === "POST") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !/^application\/json(?:\s*;|$)/i.test(request.headers["content-type"] || "")) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        let text = "";
        for await (const chunk of request) { text += chunk; if (Buffer.byteLength(text) > MAX_THREAD_BODY_BYTES) { await sendJson(request, response, 413, { error: "Question too large", code: "too-long" }); return; } }
        let body = null;
        try { body = JSON.parse(text); } catch {}
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        try { await sendJson(request, response, 202, await threadRelay.submit(body, bearingsSource.current())); }
        catch (error) {
          if (!(error instanceof ThreadRefused)) throw error;
          await sendJson(request, response, error.status, { error: error.message, code: error.code });
        }
        return;
      }
      if (url.pathname === "/api/bearings/thread" && request.method === "GET") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        try { await sendJson(request, response, 200, await threadRelay.history(String(url.searchParams.get("key") || ""), bearingsSource.current())); }
        catch (error) {
          await sendJson(request, response, error instanceof ThreadRefused ? error.status : 502, { error: error instanceof ThreadRefused ? error.message : "Firstmate receipts unavailable", code: error instanceof ThreadRefused ? error.code : "unavailable" });
        }
        return;
      }
      if (url.pathname === "/api/bearings/answer/status" && request.method === "GET") {
        if (preview) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
        try {
          await sendJson(request, response, 200, await answerRelay.status(String(url.searchParams.get("ids") || "").split(",")));
        } catch (error) {
          await sendJson(request, response, error instanceof AnswerRefused ? error.status : 502, { error: error instanceof AnswerRefused ? error.message : "Firstmate receipts unavailable" });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        await sendJson(request, response, 200, { ok: true, service: "fm-quarterdeck" });
        return;
      }
      if (dev && request.method === "GET" && url.pathname === "/api/dev-reload") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write(`retry: 1000\n\nevent: version\ndata: ${version}\n\n`);
        clients.add(response);
        response.on("close", () => clients.delete(response));
        return;
      }
      const asset = request.method === "GET"
        ? (dev && url.pathname === "/dev-reload.js" ? ["dev-reload.js", "text/javascript; charset=utf-8"] : STATIC_FILES.get(url.pathname))
        : null;
      if (!asset) {
        await sendJson(request, response, 404, { error: "Not found" });
        return;
      }
      const [filename, contentType] = asset;
      let body = await readFile(path.join(publicDir, filename));
      if (filename === "index.html") {
        body = Buffer.from(body.toString("utf8").replace("</head>", `<script>window.FM_BOOT_REVISION=${JSON.stringify(commit)}</script></head>`));
      }
      if (filename === "index.html" && registered.length) {
        body = Buffer.from(body.toString("utf8").replace("</head>", `<script>window.FM_HOST_ID=${JSON.stringify(hostId)};window.FM_PREVIEW_ID=${JSON.stringify(hostId)};window.FM_SERVED_COMMIT=${JSON.stringify(selected.commit)}</script><script defer src="/preview-selector.js"></script></head>`));
      } else if (filename === "index.html" && deploymentTier === "uat") {
        // Standalone UAT owns its served local revision and has no published checkpoint.
        // Do not depend on the registered-preview selector to populate the shell control.
        body = Buffer.from(body.toString("utf8")
          .replace("</head>", `<script>window.FM_STANDALONE_UAT=${JSON.stringify({ name: "UAT", source: "local", revision: commit, publication: "unpublished", action: "Show version details" })}</script></head>`)
          .replace("</main>", `<span class="uat-deployment-label" role="status" title="UAT · local, unpublished; not Main · full revision ${commit}">UAT · local · ${commit.slice(0, 6)}<span class="sr-only"> Full revision ${commit}; unpublished; not Main.</span></span></main>`));
      }
      if (dev && filename === "index.html") {
        body = Buffer.from(body.toString("utf8").replace("</body>",
          `<script src="/dev-reload.js" data-version="${version}"></script></body>`));
      }
      response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" });
      response.end(body);
    } catch (error) {
      await sendJson(request, response, error instanceof PublicDataError ? 503 : 500, {
        error: error instanceof PublicDataError ? error.message : "Quarterdeck could not load data",
      });
    } finally { workDone = true; responseDone ||= response.writableFinished || response.destroyed; finishUse(); }
  });
  // SSE framing is written by hand: sendJson gzips, which would buffer events.
  function openBearingsStream(request, response) {
    response.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive", "x-accel-buffering": "no" });
    const send = async (event, data, id) => {
      if (event === "model" || event === "observed") data = { ...data, firstmateActivity: await readFirstmateActivity(env.FM_HOME, { claudeConfigDir: claudeConfigDir(env) }) };
      if (!response.writableEnded && !response.destroyed) response.write(`${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const stream = { end: (event) => { if (!response.writableEnded) { send(event, {}); response.end(); } } };
    streams.add(stream);
    // Every push and heartbeat re-checks the served revision; old code never streams.
    const guarded = async (write) => {
      if (response.writableEnded) return;
      if (await syncRevision() !== servedCommit) { stream.end("revision"); return; }
      if (!response.writableEnded) write();
    };
    response.write("retry: 3000\n\n");
    send("hello", { servedCommit });
    const current = bearingsSource.current();
    if (request.headers["last-event-id"] !== current.rev) send("model", current, current.rev);
    else send("observed", bearingsSource.freshness());
    const unsubscribe = bearingsSource.subscribe((event) => {
      void guarded(() => event.type === "model" ? send("model", event.model, event.model.rev) : send("observed", { rev: event.rev, state: event.state, observedAt: event.observedAt, checkedAt: event.checkedAt, stale: event.stale, error: event.error }));
    });
    const heartbeat = setInterval(() => { void guarded(() => { response.write(": hb\n\n"); void send("observed", bearingsSource.freshness()); }); }, streamOptions.heartbeatMs);
    const recycle = setTimeout(() => stream.end("bye"), streamOptions.recycleMs);
    response.on("close", () => { streams.delete(stream); unsubscribe(); clearInterval(heartbeat); clearTimeout(recycle); });
  }
  // Open event streams would hold server.close() forever; end them and stop the scheduler first.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    for (const stream of [...streams]) stream.end("bye");
    bearingsSource.close?.();
    return closeServer(callback);
  };
  server.bearings = bearingsSource;
  server.previewLifecycle = lifecycle;
  server.shutdownPreviews = () => lifecycle.close();
  server.on("close", () => { lifecycle.close().catch(() => {}); });
  if (dev) {
    let watcher;
    let pending;
    const notify = () => {
      version = randomUUID();
      for (const client of clients) client.write(`event: version\ndata: ${version}\n\n`);
    };
    server.on("listening", () => {
      watcher = watch(publicDir, () => {
        clearTimeout(pending);
        pending = setTimeout(notify, 75);
      });
      watcher.on("error", (error) => console.error("Quarterdeck asset watcher failed:", error));
    });
    server.on("close", () => {
      clearTimeout(pending);
      watcher?.close();
    });
  }
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || "127.0.0.1";
  const port = Number(process.env.PORT || 4173);
  const server = createServer(process.env);
  if (process.env.FM_PREVIEW_ROOT && host !== "127.0.0.1") throw new Error("Lifecycle gateway must bind to loopback");
  server.listen(port, host, () => console.log(`fm-quarterdeck is live at http://${host}:${port}`));
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    server.close();
    try { await server.shutdownPreviews(); } catch { process.exitCode = 1; }
  };
  process.on("SIGTERM", close);
  process.on("SIGINT", close);
}
