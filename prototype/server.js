import { createNotificationService, notificationConfiguration } from "./notifications.js";
import { deviceId } from "./notification-state.js";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { watch, readFileSync } from "node:fs";
import { createHistoryReader, resolveHistoryLimits } from "./history-reader.js";
import { validateRegistry, previewPath, proxyPreview } from "./previews.js";
import { validChatView } from "./chat-view.js";
import { createAgentStateOwner, configuredStatePath, fingerprint } from "./agent-state.js";
import { verifyDurability, resolveRepositoryIdentity } from "./work-model.js";
import { PreviewLifecycle } from "./preview-lifecycle.js";
import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { readFirstmateActivity } from "./firstmate-activity.js";
import { compactLanes } from "./lane-payload.js";
import { createQuotaReader } from "./quota.js";
import { createBearingsHub } from "./bearings.js";
import { createProcrastinationStore, procrastinationKey } from "./call-procrastination.js";
import { createLandedAckStore, landedAckKey } from "./landed-ack.js";
import { chatAskKey, chatAsksPath, createCallSource, createChatAskScanner } from "./chat-asks.js";
import { AnswerRefused, MAX_BODY_BYTES as MAX_ANSWER_BODY_BYTES, createAnswerRelay } from "./bearings-answer.js";
import { MAX_THREAD_BODY_BYTES, ThreadRefused, createThreadRelay, createTranscriptTurns } from "./bearings-thread.js";
import { createConfiguredCostReader } from "./costs.js";
import { readPreferences } from "./preferences.js";
import { readHealthPreferences, saveHealthPreferences, validHealthPreferences } from "./health-preferences.js";
import { createRevisionResolver } from "./revision.js";
import { reviewVersion, reviewConfiguration, validateReviewPayload, reconcileLocalReview, deliverReview, deliverLocalReview, awaitingReviewCount, localReviewStatus } from "./review.js";
import { createInboxBatcher } from "./inbox-batcher.js";
import { announceReview, inboxReady, inboxReviewState } from "./inbox.js";
import { PublicDataError, claudeConfigDir, loadFirstmateHome, recordedTaskRepository, shortIntent } from "./firstmate-home.js";
import { loadExpenses } from "./expense-ledger.js";
import { exactHttpsOrigin, exactOriginRequest, isJsonRequest, readJsonBody, sameOriginAuthorized, sendNowRequested } from "./request-guards.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// server.js stays the single entry for tests, scripts and the watcher; the readers keep their own modules.
export { claudeConfigDir, loadFirstmateHome } from "./firstmate-home.js";
export { loadExpenses, rollupLedger } from "./expense-ledger.js";
const gzipAsync = promisify(gzip);

const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_DIR = path.resolve(APP_DIR, "..");
const PUBLIC_DIR = path.join(APP_DIR, "public");
const DEFAULT_FLEET_PATH = path.join(APP_DIR, "data", "fleet.json");
const STATIC_FILES = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/icons/quarterdeck-192.png", ["icons/quarterdeck-192.png", "image/png"]],
  ["/icons/quarterdeck-512.png", ["icons/quarterdeck-512.png", "image/png"]],
  ["/icons/apple-touch-icon-180.png", ["icons/apple-touch-icon-180.png", "image/png"]],
  ["/notifications-ui.js", ["notifications-ui.js", "text/javascript; charset=utf-8"]],
  ["/notifications-worker.js", ["notifications-worker.js", "text/javascript; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/chat-ask-extraction.js", ["chat-ask-extraction.js", "text/javascript; charset=utf-8"]],
  ["/sidebar-version.js", ["sidebar-version.js", "text/javascript; charset=utf-8"]],
  ["/work-hierarchy.js", ["work-hierarchy.js", "text/javascript; charset=utf-8"]],
  ["/bulk-controls.js", ["bulk-controls.js", "text/javascript; charset=utf-8"]],
  ["/message-kinds.js", ["message-kinds.js", "text/javascript; charset=utf-8"]],
  ["/filter-view.js", ["filter-view.js", "text/javascript; charset=utf-8"]],
  ["/pane-bounds.js", ["pane-bounds.js", "text/javascript; charset=utf-8"]],
  ["/message-font-size.js", ["message-font-size.js", "text/javascript; charset=utf-8"]],
  ["/quota-view-model.js", ["quota-view-model.js", "text/javascript; charset=utf-8"]],
  ["/cost-view-model.js", ["cost-view-model.js", "text/javascript; charset=utf-8"]],
  ["/inbox-pending.js", ["inbox-pending.js", "text/javascript; charset=utf-8"]],
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
  ["/bearings-work.js", ["bearings-work.js", "text/javascript; charset=utf-8"]],
  ["/overview-tabs.js", ["overview-tabs.js", "text/javascript; charset=utf-8"]],
  ["/call-lifecycle.js", ["call-lifecycle.js", "text/javascript; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
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

function fleetFromFirstmate(firstmate) {
  return {
    summary: firstmate.summary,
    workSplit: firstmate.workSplit,
    secondmates: firstmate.secondmates,
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

async function loadFleet(env, agentStateOwner, durability, historyLimits) {
  if (env.FM_HOME) return fleetFromFirstmate(await loadFirstmateHome(env.FM_HOME, { includeHistory: false, agentStateOwner, durability, reader: createHistoryReader(historyLimits) }));
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

export async function dashboardData(env = process.env, agentStateOwner = createAgentStateOwner(configuredStatePath(env)), durability = verifyDurability, expenseReader = loadExpenses, historyLimits = resolveHistoryLimits(env)) {
  const [fleet, expenses, firstmateActivity] = await Promise.all([loadFleet(env, agentStateOwner, durability, historyLimits), expenseReader(env), readFirstmateActivity(env.FM_HOME, { claudeConfigDir: claudeConfigDir(env) })]);
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

export function createServer(env = process.env, { publicDir = PUBLIC_DIR, quotaReader = createQuotaReader({ maxAge: env.FM_QUOTA_MAX_AGE }), bearingsSource, bearingsStream = {}, answerRelay, threadRelay, costReader = createConfiguredCostReader(env), expenseReader = loadExpenses, lanesReader = loadFirstmateHome, durabilityVerifier = verifyDurability, reviewDeliver = deliverReview, localReviewDeliver = (payload, statusPath) => deliverLocalReview(payload, undefined, statusPath), localReviewReceipt = reconcileLocalReview, reviewCount = (receipts) => awaitingReviewCount(undefined, receipts), reviewStatus = localReviewStatus, previewRegistry, chatDeliver, revisionResolver = createRevisionResolver(REPO_DIR, reviewVersion), lifecycleFactory = (entries, options) => new PreviewLifecycle(entries, options), procrastination = createProcrastinationStore(env), landedAcks = createLandedAckStore(env), notificationOptions = {}, historicalAnswer = null } = {}) {
  const historyLimits = resolveHistoryLimits(env);
  const review = reviewConfiguration(env);
  const agentStatePath = configuredStatePath(env);
  const agentStateOwner = createAgentStateOwner(agentStatePath);
  if (env.FM_HOME) {
    const relative = path.relative(path.resolve(env.FM_HOME), path.resolve(agentStatePath));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("Quarterdeck presentation state must be outside FM_HOME");
  }
  const inboxBatcher = createInboxBatcher({ home: env.FM_HOME, statePath: agentStatePath });
  bearingsSource ||= createCallSource({ home: env.FM_HOME, receipts: inboxBatcher.receipts, hub: createBearingsHub({ home: env.FM_HOME, minGapMs: env.FM_BEARINGS_MIN_GAP_MS, maxAgeMs: env.FM_BEARINGS_MAX_AGE_MS, timeoutMs: env.FM_BEARINGS_TIMEOUT_MS }), chat: createChatAskScanner({ home: env.FM_HOME, claudeConfigDir: claudeConfigDir(env), historyLimits, statePath: chatAsksPath(configuredStatePath(env)), historicalAnswer }) });
  answerRelay ||= createAnswerRelay({ home: env.FM_HOME, note: inboxBatcher.note, receipts: inboxBatcher.receipts });
  threadRelay ||= createThreadRelay({ home: env.FM_HOME, note: inboxBatcher.note, receipts: inboxBatcher.receipts, transcript: createTranscriptTurns({ home: env.FM_HOME, claudeConfigDir: claudeConfigDir(env), historyLimits }) });
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
  const notifications = createNotificationService({
    configuration: notificationConfiguration(env), source: bearingsSource, revision: syncRevision,
    initializeEvidence: async () => { await inboxBatcher.initializeEvidence(); await procrastination.initializeEvidence(); },
    evidence: async () => {
      try {
        const [input, pending, parked] = await Promise.all([bearingsSource.notificationEvidence(), inboxBatcher.pending({ strict: true }), procrastination.evidence()]);
        return { ...input, pending, procrastination: parked };
      } catch { return { available: false }; }
    },
    ...notificationOptions,
  });
  const notificationRate = { at: 0, count: 0 };
  const lastDataRead = new Map();
  // In-flight and confirmed sends in this gateway process share the same receipt.
  // The receiver must also deduplicate messageId durably across gateway restarts.
  const chatReceipts = new Map();
  // Only an operator-configured, canonical HTTPS DNS origin may bypass the loopback review guard.
  // Match the wire Host and Origin exactly; forwarding headers are not authority.
  const allowedReviewOrigin = env.FM_REVIEW_ALLOWED_ORIGIN || "";
  if (allowedReviewOrigin && !exactHttpsOrigin(allowedReviewOrigin)) {
    throw new Error("FM_REVIEW_ALLOWED_ORIGIN must be one exact HTTPS DNS origin without port or path");
  }
  const dev = env.FM_DEV === "1";
  let version = randomUUID();
  const clients = new Set();
  const authorized = (request) => sameOriginAuthorized(request, allowedReviewOrigin);
  const previewReads = new Set(["/notifications-ui.js", "/", "/app.js", "/chat-ask-extraction.js", "/sidebar-version.js", "/bulk-controls.js", "/work-hierarchy.js", "/message-kinds.js", "/filter-view.js", "/pane-bounds.js", "/message-font-size.js", "/quota-view-model.js", "/cost-view-model.js", "/styles.css", "/inbox-pending.js", "/review-target.js", "/review-client.js", "/panel-resize.js", "/shell-panel.js", "/shell-panel-layout.js", "/shell-width.js", "/shell-panel.css", "/dev-reload.js", "/bearings-patch.js", "/bearings-live.js", "/bearings-view.js", "/bearings-answer-form.js", "/bearings-overflow.js", "/bearings-dismiss.js", "/bearings-thread-panel.js", "/bearings-procrastinate.js", "/bearings-landed.js", "/bearings-work.js", "/overview-tabs.js", "/call-lifecycle.js", "/api/dashboard", "/api/lanes", "/api/preferences", "/api/preferences/health", "/api/quota", "/api/bearings", "/api/costs", "/api/health", "/api/review", "/api/review/status", "/api/dev-reload"]);
  // Quarterdeck's own viewing state and relays stay on the host (BEARINGS.md); previews poll /api/bearings instead.
  const hostOnlyRoutes = new Set(["/api/bearings/stream", "/api/bearings/answer", "/api/bearings/answer/status", "/api/bearings/dismiss",
    "/api/bearings/procrastinate", "/api/bearings/landed/acks", "/api/bearings/landed/ack", "/api/bearings/thread", "/api/inbox/pending", "/api/inbox/send-now"]);
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
      const arrived = request.method === "POST" && ["/api/bearings/answer", "/api/bearings/thread"].includes(url.pathname) ? inboxBatcher.arrive() : undefined;
      if (arrived) response.once("close", arrived);
      const preview = previewPath(url.pathname);
      const commit = await syncRevision();
      if (!commit) { await sendJson(request, response, 503, { error: "Serving revision unavailable" }); return; }
      const registeredSelection = preview ? registry.get(preview.id) : registry.get(hostId);
      const selected = registeredSelection?.id === hostId ? { ...registeredSelection, commit } : registeredSelection;
      const selectedCommit = selected?.commit || commit;
      if (url.pathname.startsWith("/api/notifications/")) {
        const pushOrigin = env.FM_QUARTERDECK_PUSH_ORIGIN;
        const permitted = pushOrigin ? exactOriginRequest(request, pushOrigin) : authorized(request);
        if (!permitted || deploymentTier || dev || preview) { await sendJson(request, response, 403, { error: "Notifications require the stable private origin" }); return; }
        if (request.method !== "POST" || url.search || !["/api/notifications/status", "/api/notifications/enroll", "/api/notifications/disable"].includes(url.pathname) || !isJsonRequest(request)) { await sendJson(request, response, 400, { error: "Notification JSON operation required" }); return; }
        const minute = Math.floor(Date.now() / 60000);
        if (minute !== notificationRate.at) { notificationRate.at = minute; notificationRate.count = 0; }
        if (++notificationRate.count > 30) { await sendJson(request, response, 429, { error: "Notification request limit reached" }); return; }
        const { body, tooLarge } = await readJsonBody(request, 4096);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Subscription too large" }); return; }
        const enroll = url.pathname.endsWith("/enroll");
        if (!body || Object.keys(body).sort().join(",") !== (enroll ? "id,subscription" : "id") || !deviceId(body.id)) { await sendJson(request, response, 400, { error: "Exact installation fields required" }); return; }
        try {
          const value = await (enroll ? notifications.enroll(body.id, body.subscription) : url.pathname.endsWith("/disable") ? notifications.disable(body.id) : notifications.status(body.id));
          await sendJson(request, response, 200, value);
        } catch { await sendJson(request, response, 409, { error: "Notifications unavailable; check configuration or installation state" }); }
        return;
      }
      if (url.pathname === "/notifications-worker.js") {
        const origin = await notifications.origin();
        if (!origin || deploymentTier || dev || request.headers.host !== origin.slice("https://".length)) { await sendJson(request, response, 403, { error: "Notification worker requires the configured host" }); return; }
      }
      if (request.method === "GET" && url.pathname === "/api/previews") {
        await lifecycle.ready;
        await sendJson(request, response, 200, lifecycle.list());
        return;
      }
      if (url.pathname === "/api/previews/select" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 400, { error: "Registry ID JSON only" }); return; }
        const { body, tooLarge } = await readJsonBody(request, 256);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Selection too large" }); return; }
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
      if (preview && hostOnlyRoutes.has(url.pathname)) { await sendJson(request, response, 404, { error: "Preview route not allowed" }); return; }
      if (selected?.id === hostId && request.method === "GET" && ["/api/dashboard", "/api/lanes", "/api/preferences", "/api/preferences/health", "/api/quota", "/api/costs"].includes(url.pathname)) {
        response.once("finish", () => { if (response.statusCode === 200) lastDataRead.set(hostId, new Date().toISOString()); });
      }
      if (preview && preview.pathname === "/api/chat" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
        if (!isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required" }); return; }
        const { body: message, tooLarge } = await readJsonBody(request, 12288);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Chat too large" }); return; }
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
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 400, { error: "JSON required" }); return; }
        const { body, tooLarge } = await readJsonBody(request, 2048);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Request too large" }); return; }
        if (!body || !["acknowledge", "classify", "create-taxonomy"].includes(body.action) || !/^[a-f0-9]{64}$/.test(body.taskFingerprint || "")) { await sendJson(request, response, 400, { error: "Invalid presentation request" }); return; }
        const current = await loadFirstmateHome(env.FM_HOME, { includeHistory: false, agentStateOwner, durability: durabilityVerifier, reader: createHistoryReader(historyLimits) });
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
            const { recordedRepository, repositoryPaths } = await recordedTaskRepository(env.FM_HOME, item.id, createHistoryReader(historyLimits));
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
        const intake = status && env.FM_HOME ? inboxReviewState(await inboxBatcher.receipts(), batch) : null;
        await sendJson(request, response, status ? 200 : 404, status ? { ...status, ...(intake && status.state === "accepted" ? intake : {}), intake: intake?.state || null } : { error: "Receipt not found; keep the batch and retry Send" });
        return;
      }
      if (url.pathname === "/api/review" || (preview && preview.pathname === "/api/review")) {
        if (request.method === "GET") {
          used = true;
          const intakeReady = review.delivery === "local" && env.FM_HOME ? await inboxReady(env.FM_HOME).catch(() => false) : false;
          const receipts = review.delivery === "local" && env.FM_HOME ? await inboxBatcher.receipts().catch(() => null) : null;
          await sendJson(request, response, 200, { version: selectedCommit, sessionId: review.sessionId, ready: review.ready, delivery: review.delivery,
            intakeReady, awaitingReview: review.delivery === "local" && (!env.FM_HOME || receipts) ? await reviewCount(receipts) : null });
          return;
        }
        if (request.method === "POST") {
          if (!authorized(request)) { await sendJson(request, response, 403, { error: "Review requires an authorized same-origin request" }); return; }
          if (!isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required" }); return; }
          const { body: payload, tooLarge } = await readJsonBody(request, 150000);
          if (tooLarge) { await sendJson(request, response, 413, { error: "Review too large" }); return; }
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
              if (env.FM_HOME) await announceReview(env.FM_HOME, existing.payload, inboxBatcher.note, { immediate: sendNowRequested(request) });
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
            if (review.delivery === "local" && env.FM_HOME) await announceReview(env.FM_HOME, attributed, inboxBatcher.note, { immediate: sendNowRequested(request) });
            await sendJson(request, response, 200, receipt);
          } catch {
            await sendJson(request, response, 502, { error: "Review delivery unconfirmed; queue retained for retry" });
          }
          return;
        }
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") {
        await sendJson(request, response, 200, await dashboardData(env, agentStateOwner, durabilityVerifier, expenseReader, historyLimits));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/lanes") {
        const ids = (name) => url.searchParams.getAll(name).filter((id) => id.length <= 250).slice(0, 60);
        const page = (name) => Math.min(20, Math.max(0, Number.parseInt(url.searchParams.get(name) || "0", 10) || 0));
        // Additive opt-in only: old callers retain the full bounded source window.
        const requestedBytes = Number(url.searchParams.get("windowBytes"));
        const windowBytes = url.searchParams.has("windowBytes") && Number.isSafeInteger(requestedBytes)
          ? Math.min(8 * 1024 * 1024, Math.max(1024 * 1024, requestedBytes)) : null;
        const firstmate = await lanesReader(env.FM_HOME, { sessionIds: ids("session"), diskIds: ids("disk"), older: page("older"), diskOlder: page("diskOlder"), agentStateOwner, durability: durabilityVerifier, claudeConfigDir: claudeConfigDir(env), windowBytes, reader: createHistoryReader(historyLimits) });
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
          if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 400, { error: "JSON required" }); return; }
          const { body: value, tooLarge } = await readJsonBody(request, 2048);
          if (tooLarge) { await sendJson(request, response, 413, { error: "Request too large" }); return; }
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
        if (streams.size >= streamOptions.maxStreams) { await sendJson(request, response, 503, { error: "Too many live streams; poll /api/bearings" }); return; }
        openBearingsStream(request, response);
        return;
      }
      if (url.pathname === "/api/inbox/pending" && request.method === "GET") {
        try { await sendJson(request, response, 200, { items: await inboxBatcher.pending() }); }
        catch { await sendJson(request, response, 503, { error: "Pending inbox state unavailable; saved items retained" }); }
        return;
      }
      if (url.pathname === "/api/inbox/send-now" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin" }); return; }
        try { await inboxBatcher.flush(); await sendJson(request, response, 200, { state: "sent" }); }
        catch { await sendJson(request, response, 502, { error: "Delivery unconfirmed; pending items retained for retry" }); }
        return;
      }
      // Captain's Call answers: host only, an explicit captain submit relayed to Firstmate (BEARINGS.md "Answers").
      if (url.pathname === "/api/bearings/answer" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        const { body, tooLarge } = await readJsonBody(request, MAX_ANSWER_BODY_BYTES);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Answer too large", code: "too-long" }); return; }
        // A request spanning a fast-forward is refused rather than answered under a mixed identity.
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        try {
          const accepted = await answerRelay.submit(body, bearingsSource.current(), { immediate: sendNowRequested(request), arrived });
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
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        const { body, tooLarge } = await readJsonBody(request, 1024);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Request too large", code: "too-long" }); return; }
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
        const current = bearingsSource.current?.() || {};
        const openKeys = current.state === "ready" || current.state === "stale"
          ? new Set((current.cards || []).filter((card) => !card.readOnly).map((card) => card.key)) : null;
        try { await sendJson(request, response, 200, await procrastination.view(openKeys)); }
        catch { await sendJson(request, response, 503, { error: "Procrastination state unavailable" }); }
        return;
      }
      if (url.pathname === "/api/bearings/procrastinate" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        const { body, tooLarge } = await readJsonBody(request, 1024);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Request too large", code: "too-long" }); return; }
        const fields = body && typeof body === "object" && !Array.isArray(body) ? Object.keys(body).sort().join(",") : "";
        const durationOk = fields === "duration,key" && procrastinationKey(body.key) && ["3h", "6h", "1d", "3d"].includes(body.duration);
        const clearOk = fields === "clear,key" && body.clear === true && procrastinationKey(body.key);
        if (!durationOk && !clearOk) { await sendJson(request, response, 400, { error: "Procrastinate must name a call and a duration or a clear", code: "invalid" }); return; }
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        const card = (bearingsSource.current()?.cards || []).find((entry) => entry.key === body.key);
        if (!card) { await sendJson(request, response, 409, { error: "This call is no longer open", code: "gone" }); return; }
        if (card.readOnly) { await sendJson(request, response, 409, { error: "This call is answered in its own home", code: "read-only" }); return; }
        try {
          const next = durationOk ? await procrastination.set(body.key, body.duration) : await procrastination.clear(body.key);
          await sendJson(request, response, 200, next);
        } catch { await sendJson(request, response, 503, { error: "Quarterdeck could not record procrastination; try again" }); }
        return;
      }
      // Just landed acknowledgements (BEARINGS.md "Just landed"): Quarterdeck viewing state only.
      if (url.pathname === "/api/bearings/landed/acks" && request.method === "GET") {
        try { await sendJson(request, response, 200, await landedAcks.read()); }
        catch { await sendJson(request, response, 503, { error: "Landed acknowledgements unavailable" }); }
        return;
      }
      if (url.pathname === "/api/bearings/landed/ack" && request.method === "POST") {
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        const { body, tooLarge } = await readJsonBody(request, 1024);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Request too large", code: "too-long" }); return; }
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
        if (!authorized(request)) { await sendJson(request, response, 403, { error: "Unauthorized origin", code: "origin" }); return; }
        if (url.search || !isJsonRequest(request)) { await sendJson(request, response, 415, { error: "JSON required", code: "invalid" }); return; }
        const { body, tooLarge } = await readJsonBody(request, MAX_THREAD_BODY_BYTES);
        if (tooLarge) { await sendJson(request, response, 413, { error: "Question too large", code: "too-long" }); return; }
        if (await syncRevision(true) !== commit) { await sendJson(request, response, 409, { error: "Quarterdeck updated; reload to continue", code: "revision" }); return; }
        try { await sendJson(request, response, 202, await threadRelay.submit(body, bearingsSource.current(), { immediate: sendNowRequested(request), arrived })); }
        catch (error) {
          if (!(error instanceof ThreadRefused)) throw error;
          await sendJson(request, response, error.status, { error: error.message, code: error.code });
        }
        return;
      }
      if (url.pathname === "/api/bearings/thread" && request.method === "GET") {
        try { await sendJson(request, response, 200, await threadRelay.history(String(url.searchParams.get("key") || ""), bearingsSource.current())); }
        catch (error) {
          await sendJson(request, response, error instanceof ThreadRefused ? error.status : 502, { error: error instanceof ThreadRefused ? error.message : "Firstmate receipts unavailable", code: error instanceof ThreadRefused ? error.code : "unavailable" });
        }
        return;
      }
      if (url.pathname === "/api/bearings/answer/status" && request.method === "GET") {
        try {
          await sendJson(request, response, 200, await answerRelay.status(String(url.searchParams.get("ids") || "").split(",")));
        } catch (error) {
          await sendJson(request, response, error instanceof AnswerRefused ? error.status : 502, { error: error instanceof AnswerRefused ? error.message : "Firstmate receipts unavailable" });
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") {
        // `ok` is HTTP readiness (preview launchers rely on it). Fleet-feed health is
        // reported separately and never starts or waits for a collection run.
        const { rev, state, observedAt, checkedAt, stale, error, ageMs = null, maxAgeMs = null } = bearingsSource.freshness();
        const bearings = { rev, state, observedAt, checkedAt, stale, error, ageMs, maxAgeMs, remoteCollection: "cache" };
        await sendJson(request, response, 200, { ok: true, service: "fm-quarterdeck", status: bearings.state === "ready" && !bearings.stale ? "ok" : "degraded", bearings });
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
      void guarded(() => event.type === "model" ? send("model", event.model, event.model.rev) : send("observed", { rev: event.rev, state: event.state, observedAt: event.observedAt, checkedAt: event.checkedAt, stale: event.stale, error: event.error, primaryRecap: event.primaryRecap }));
    });
    const heartbeat = setInterval(() => { void guarded(() => { response.write(": hb\n\n"); void send("observed", bearingsSource.freshness()); }); }, streamOptions.heartbeatMs);
    const recycle = setTimeout(() => stream.end("bye"), streamOptions.recycleMs);
    response.on("close", () => { streams.delete(stream); unsubscribe(); clearInterval(heartbeat); clearTimeout(recycle); });
  }
  // Open event streams would hold server.close() forever; end them and stop the scheduler first.
  const closeServer = server.close.bind(server);
  server.close = (callback) => {
    for (const stream of [...streams]) stream.end("bye");
    notifications.close();
    bearingsSource.close?.();
    return closeServer(callback);
  };
  server.bearings = bearingsSource;
  server.notifications = notifications;
  server.previewLifecycle = lifecycle;
  server.shutdownPreviews = () => lifecycle.close();
  server.on("close", () => { inboxBatcher.close(); lifecycle.close().catch(() => {}); });
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
