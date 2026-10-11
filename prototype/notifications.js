import path from "node:path";
import { realpath, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import webPush from "web-push";
import { configuredStatePath } from "./agent-state.js";
import { taggedEnvelope } from "./bearings-thread.js";
import { notificationPaths, privateJson, digest, deviceId, createNotificationOwner } from "./notification-state.js";
import { createPushProvider, validSubscription } from "./push-provider.js";

export const GENERIC_NOTIFICATION = Object.freeze({ title: "Quarterdeck", body: "A new Captain’s Call needs your attention", destination: "/#overview" });
const pendingStates = new Set(["queued", "retry", "sending"]);
const exactOrigin = (value) => typeof value === "string" && /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(value);
const outside = (root, file) => { const rel = path.relative(root, file); return rel === ".." || rel.startsWith(`..${path.sep}`); };
export async function notificationConfiguration(env) {
  if (env.FM_QUARTERDECK_PUSH_ENABLED !== "1") return null;
  if (!env.FM_HOME || env.FM_DEPLOYMENT_TIER || env.FM_PREVIEW_GENERATION || env.FM_PREVIEW_COMMIT || env.FM_DEV === "1" || !exactOrigin(env.FM_QUARTERDECK_PUSH_ORIGIN) || !(env.FM_QUARTERDECK_STATE_PATH || env.FM_AGENTOS_STATE_PATH)) throw new Error("Push requires a configured stable private host");
  const state = configuredStatePath(env), directory = path.dirname(state);
  if (!path.isAbsolute(state) || path.normalize(state) !== state || await realpath(directory) !== directory || !outside(await realpath(env.FM_HOME), directory)) throw new Error("Push state must be private and outside FM_HOME");
  const info = await stat(directory);
  if (info.mode & 0o077 || info.uid !== process.getuid()) throw new Error("Push state directory must be private");
  const paths = notificationPaths(env), keys = await privateJson(paths.keys, 1024);
  if (Object.keys(keys).sort().join(",") !== "privateKey,publicKey,subject") throw new Error("Invalid operator push keys");
  // Validation/signing stays with the standards library; never generate keys here.
  if (typeof keys.subject !== "string" || !/^mailto:[^\s@]+@[^\s@]+$/.test(keys.subject)) throw new Error("Operator push contact required");
  webPush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return { origin: env.FM_QUARTERDECK_PUSH_ORIGIN, publicKey: keys.publicKey, paths,
    binding: digest(await realpath(env.FM_HOME), env.FM_QUARTERDECK_PUSH_ORIGIN, keys.publicKey), provider: createPushProvider(keys) };
}
export const filedIdentity = (card) => ["decision", "merge"].includes(card?.type) &&
  typeof card.owner === "string" && card.owner.length > 0 && card.owner.length <= 80 &&
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(card.task || "") && card.key === `${card.type}:${card.task}` ? digest(card.owner, card.task) : null;

// Per-item receipts have already been expanded by the existing inbox owner. The
// producer answer envelope also suppresses a merge->decision replacement by task.
export function eligibleView(evidence, now = Date.now(), maxAgeMs = 300000) {
  const model = evidence?.model;
  const observed = Date.parse(model?.observedAt), checked = Date.parse(evidence?.checkedAt);
  if (!evidence?.available || !Number.isFinite(checked) || checked > now + 5000 || now - checked > 15000 || !Array.isArray(evidence.receipts?.pending) || !Array.isArray(evidence.receipts?.handled) || !Array.isArray(evidence.receipts?.replies) || model?.state !== "ready" || model.stale || !Number.isFinite(observed) || observed > now + 5000 || now - observed > maxAgeMs || !Array.isArray(model.cards) || !Array.isArray(evidence.pending) || !evidence.procrastination?.until) return null;
  const answeredTasks = new Set();
  for (const note of [...(evidence.receipts?.pending || []), ...(evidence.receipts?.handled || [])]) {
    if (!note?.request_id?.startsWith("quarterdeck-call:")) continue;
    const answer = taggedEnvelope(note.body, "fm-bearings-answer");
    if (answer?.schema === "fm-bearings-answer.v1" && answer.channel === "quarterdeck" && ["decision", "merge"].includes(answer.type) && typeof answer.task === "string") answeredTasks.add(answer.task);
  }
  const queued = new Set(evidence.pending.map((item) => /^(decision|merge):/.test(item.key || "") ? item.key.replace(/^[^:]+:/, "") : null));
  const parked = new Set(Object.entries(evidence.procrastination.until).filter(([, until]) => Date.parse(until) > now).map(([key]) => key.replace(/^[^:]+:/, "")));
  const result = new Map();
  for (const card of model.cards) {
    const identity = filedIdentity(card);
    if (!identity) continue;
    result.set(identity, { card, actionable: Boolean(card.answer) && !card.answered && !card.sentReceipt && !answeredTasks.has(card.task) && !queued.has(card.task) && !parked.has(card.task) });
  }
  // Supplemental closed holds are positive, local-owner resolution evidence.
  // An omitted/absent card alone never has this authority.
  for (const hold of model.holds || []) {
    if (hold.source === "data/backlog.md" && hold.closed === true && hold.open === false && /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(hold.task || "")) {
      result.set(digest("(main)", hold.task), { card: { key: `decision:${hold.task}` }, actionable: false, resolved: true });
    }
  }
  return result;
}
export function observeNotifications(state, view, now) {
  if (!view) return;
  const active = Object.entries(state.subscriptions).filter(([, sub]) => sub.enabled);
  const recipients = active.filter(([, sub]) => sub.baseline);
  for (const [identity, { card, actionable }] of view) {
    if (state.seen[identity]) {
      const aliases = state.seen[identity].aliases ||= [state.seen[identity].key];
      if (!aliases.includes(card.key)) aliases.push(card.key);
      continue;
    }
    // Positive closure is a durable identity even before a filed card is seen.
    const entry = { key: card.key, aliases: [card.key], detectedAt: now, sourceClock: card.clock?.at || null, disposition: !recipients.length ? "baseline" : !actionable ? "suppressed" : "event" };
    state.seen[identity] = entry;
    if (entry.disposition !== "event") continue;
    const id = randomUUID();
    state.events[id] = { identity, detectedAt: now, expiresAt: now + 900000, payload: { ...GENERIC_NOTIFICATION, event: id } };
    for (const [device] of recipients) state.outbox[`${id}:${device}`] = { event: id, device, state: "queued", attempts: 0, nextAt: now };
  }
  for (const [, sub] of active) sub.baseline = true;
  for (const item of Object.values(state.outbox)) {
    if (!pendingStates.has(item.state)) continue;
    const event = state.events[item.event], current = view.get(event.identity);
    if (!state.subscriptions[item.device].enabled || current && !current.actionable) item.state = "cancelled";
    else if (now >= event.expiresAt) item.state = "expired";
    // Absence does not prove resolution. Defer unknown/omitted work to expiry.
  }
}
export function retryDelay(retryAfter, attempts, now, random = Math.random) {
  let delay = 0;
  if (typeof retryAfter === "string") delay = /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - now;
  return Math.max(Number.isFinite(delay) ? delay : 0, Math.min(120000, 5000 * 2 ** (attempts - 1)) + Math.floor(random() * 1000));
}

export function createNotificationService({ configuration, source, evidence, initializeEvidence, revision, now = Date.now, timers = globalThis, random = Math.random } = {}) {
  let config = null, owner = null, error = null, coverage = "waiting", unsubscribe = null, timer = null, closed = false, serial = Promise.resolve();
  const ready = Promise.resolve(configuration).then((value) => { config = value; if (value) owner = createNotificationOwner(value.paths, value.binding); }).catch(() => { error = "needs-repair"; });
  const run = (fn) => { const work = serial.then(async () => { await ready; return fn(); }); serial = work.catch(() => {}); return work; };
  function stopDemand() { unsubscribe?.(); unsubscribe = null; timers.clearInterval(timer); timer = null; }
  async function demand() {
    if (closed || !owner || error) { stopDemand(); return; }
    const state = await owner.read();
    if (Object.values(state?.subscriptions || {}).some((sub) => sub.enabled)) {
      if (!unsubscribe) unsubscribe = source.subscribe(() => { void tick(); });
      if (!timer) { timer = timers.setInterval(() => { void tick(); }, 15000); timer.unref?.(); }
    } else stopDemand();
  }
  async function readView() {
    const input = await evidence();
    return eligibleView(input, now());
  }
  async function cycle() {
    if (closed || !owner || error) return;
    if (!await revision()) { coverage = "revision-unavailable"; stopDemand(); return; }
    const state = await owner.read();
    if (!state || !Object.values(state.subscriptions).some((sub) => sub.enabled)) { await demand(); return; }
    const view = await readView();
    if (!view) { coverage = "eligibility-unavailable"; return; }
    coverage = "ready";
    await owner.update((saved) => observeNotifications(saved, view, now()));
    const current = await owner.read();
    // One bounded provider attempt per cycle; pending delivery persists across restarts.
    const candidate = Object.values(current.outbox).find((item) => pendingStates.has(item.state) && item.attempts < 5 && item.nextAt <= now() && view.get(current.events[item.event].identity)?.actionable);
    if (!candidate) return;
    const latest = await readView(); // Deliberate fresh receipt/pending/park read before send.
    if (!latest || !await revision() || closed) { coverage = "eligibility-unavailable"; return; }
    let send;
    await owner.update((saved) => {
      observeNotifications(saved, latest, now());
      const item = saved.outbox[`${candidate.event}:${candidate.device}`], event = saved.events[candidate.event], sub = saved.subscriptions[candidate.device];
      if (!pendingStates.has(item.state) || item.nextAt > now() || !latest.get(event.identity)?.actionable || !sub.enabled) return;
      if (item.attempts >= 5) { item.state = "failed"; return; }
      item.state = "sending"; item.attempts++; item.nextAt = now() + 90000;
      send = { item: structuredClone(item), event: structuredClone(event), subscription: structuredClone(sub.subscription) };
    });
    if (!send) return;
    let result;
    try { result = await config.provider(send.subscription, send.event.payload, {
      ttl: Math.max(1, Math.floor((send.event.expiresAt - now()) / 1000)), topic: send.item.event.replaceAll("-", ""),
      remainingTtl: () => Math.floor((send.event.expiresAt - now()) / 1000),
      beforeSend: async () => {
        if (closed || now() >= send.event.expiresAt || !await revision()) return false;
        const finalView = await readView();
        if (!finalView) { coverage = "eligibility-unavailable"; return false; }
        let permitted = false;
        await owner.update((saved) => {
          observeNotifications(saved, finalView, now());
          const item = saved.outbox[`${send.item.event}:${send.item.device}`], sub = saved.subscriptions[item.device];
          permitted = item.state === "sending" && item.attempts === send.item.attempts && sub.enabled && digest(sub.subscription) === digest(send.subscription) && Boolean(finalView.get(send.event.identity)?.actionable);
        });
        return permitted && !closed && now() < send.event.expiresAt && Boolean(await revision());
      },
    }); }
    catch { result = { statusCode: 0 }; } // No raw endpoint/credential diagnostics.
    await owner.update((saved) => {
      const item = saved.outbox[`${send.item.event}:${send.item.device}`];
      if (item.attempts !== send.item.attempts) return;
      const code = result.statusCode;
      if (result.skipped) { if (item.state === "sending") { item.state = "retry"; item.nextAt = now() + 5000; } return; }
      if (code >= 200 && code < 300) { item.state = "accepted"; item.acceptedAt = now(); }
      else if (code === 404 || code === 410) {
        saved.subscriptions[item.device] = { enabled: false, baseline: false, subscription: null }; item.state = "failed";
        for (const pending of Object.values(saved.outbox)) if (pending.device === item.device && pendingStates.has(pending.state)) pending.state = "cancelled";
      }
      else if (now() >= send.event.expiresAt) item.state = "expired";
      else if (item.attempts >= 5 || code && code !== 429 && code < 500) item.state = "failed";
      else { item.state = "retry"; item.nextAt = now() + retryDelay(result.retryAfter, item.attempts, now(), random); item.acceptanceUnknown = code === 0; }
    });
    await demand();
  }
  let tickPending = null;
  function tick() {
    return tickPending ||= run(cycle).catch(() => { error = "needs-repair"; stopDemand(); }).finally(() => { tickPending = null; });
  }
  const status = (id) => run(async () => {
    if (!config || error) return { configured: Boolean(config), state: error || "operator-disabled" };
    try {
      const state = await owner.read(), sub = state?.subscriptions[id];
      const deliveries = Object.values(state?.outbox || {}).filter((item) => item.device === id);
      return { configured: true, origin: config.origin, publicKey: config.publicKey,
        state: !sub?.enabled ? "not-enabled" : !sub.baseline ? "waiting-for-baseline" : coverage === "ready" ? "enabled" : coverage,
        subscribed: Boolean(sub?.enabled), accepted: deliveries.filter((item) => item.state === "accepted").length,
        failed: deliveries.filter((item) => item.state === "failed").length, retrying: deliveries.filter((item) => item.state === "retry").length };
    } catch { error = "needs-repair"; stopDemand(); return { configured: true, state: error }; }
  });
  async function enroll(id, subscription) {
    if (!deviceId(id) || !validSubscription(subscription)) throw new Error("Invalid subscription");
    await run(async () => {
      if (!config || error || closed || !await revision()) throw new Error("Notifications unavailable");
      if (!await owner.read()) await initializeEvidence();
      await owner.update((state) => {
        if (Object.entries(state.subscriptions).some(([other, sub]) => other !== id && sub.subscription?.endpoint === subscription.endpoint)) throw new Error("Subscription belongs to another installation");
        const prior = state.subscriptions[id];
        state.subscriptions[id] = { subscription, enabled: true, baseline: prior?.enabled ? prior.baseline : false };
      }, true);
      await demand();
    });
    await tick();
    return status(id);
  }
  async function disable(id) {
    await run(async () => {
      if (!owner) throw new Error("Notification owner unavailable; opt-out was not recorded");
      if (await owner.read()) await owner.update((state) => {
        if (state.subscriptions[id]) { state.subscriptions[id] = { enabled: false, baseline: false, subscription: null }; }
        for (const item of Object.values(state.outbox)) if (item.device === id && pendingStates.has(item.state)) item.state = "cancelled";
      });
      await demand();
    });
    return status(id);
  }
  void ready.then(async () => { try { await demand(); if (unsubscribe) void tick(); } catch { error = "needs-repair"; stopDemand(); } });
  return { ready, tick, status, enroll, disable, async origin() { await ready; return config?.origin || null; }, close() { closed = true; stopDemand(); } };
}
