import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);
const PROVIDERS = new Set(["claude", "codex", "cursor", "copilot", "grok", "kimi", "zai", "agy", "alibaba", "opencode-go", "commandcode", "minimax", "mimo", "deepseek", "openrouter", "elevenlabs", "devin", "muse"]);
const good = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && /^[a-zA-Z0-9 _:.+-]{1,80}$/.test(value) ? value : null;
const number = (value, max = 100) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
const date = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
const STATES = new Set(["fresh", "stale", "unavailable", "auth_required", "rate_limited", "error", "usable", "unusable", "expired_refreshable", "known", "partial", "unknown", "ahead", "on_pace", "behind", "mixed", "through_reset", "projected_exhaustion", "exhausted_now"]);
const enumValue = (value) => STATES.has(value) ? value : "unknown";
const DEFAULT_MAX_AGE = "5m";
function quotaMaxAge(value) {
  const match = /^(\d+)(s|m|h)$/.exec(typeof value === "string" ? value.trim() : "");
  if (!match) return { value: DEFAULT_MAX_AGE, ms: 300000 };
  const amount = Number(match[1]);
  const ms = amount * ({ s: 1000, m: 60000, h: 3600000 })[match[2]];
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 300000 ? { value: `${amount}${match[2]}`, ms } : { value: DEFAULT_MAX_AGE, ms: 300000 };
}

// Interpret only known subscription annotation grammar. Never forward arbitrary
// vendor prose (which may contain identities or diagnostics) to the browser.
export function categorizeSubscriptionText(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^You have used some of your (\d+-hour|daily|weekly|monthly) limit, it will fully refresh in (\d+ (?:day|days|hour|hours|minute|minutes)(?:, \d+ (?:day|days|hour|hours|minute|minutes))*)\.$/i.exec(value.trim());
  if (match && match[1].length <= 40 && match[2].length <= 80) {
    return { category: "Partial usage", meaning: `Some of the ${match[1]} limit has been used. Full refresh in ${match[2]}.` };
  }
  return { category: "Unknown", meaning: "Subscription note could not be interpreted." };
}

// Deliberate allowlist: account keys, source paths, errors, commands and raw vendor payloads never leave this module.
function sanitizeProvider(provider) {
  if (!good(provider) || !PROVIDERS.has(provider.provider) || !Array.isArray(provider.windows) || provider.windows.length > 100 || !good(provider.state) || !good(provider.quotaSemantics) || !Array.isArray(provider.quotaSemantics.effectiveAvailability)) throw new Error("schema");
  const windows = provider.windows.map((window) => {
    // Antigravity names its grouped window "Claude/GPT …"; permit that fixed
    // model-family prefix, not arbitrary slash-bearing paths or identities.
    const label = text(window?.label) || (provider.provider === "agy" && typeof window?.label === "string" && /^Claude\/GPT [a-zA-Z0-9 _:.+-]{1,60}$/.test(window.label) ? window.label : null);
    if (!good(window) || !text(window.id) || !label || !text(window.kind)) throw new Error("schema");
    // quota-axi publishes windowSeconds (not durationSeconds). Keep the
    // synthetic legacy interval field for existing injected fixtures only.
    const sourceDuration = number(window.windowSeconds, 1e10) ?? number(window.durationSeconds, 1e10) ??
      (window.pace?.cycleBasis === "starts_at_resets_at" ? number(window.pace.cycleSeconds, 1e10) : null);
    // AGY's quota-summary adapter classifies provider buckets but omits numeric
    // intervals. Use only its explicit period classification, never model or
    // unknown windows. This is marker evidence, not a pace/availability input.
    const labelDuration = provider.provider === "agy" ? window.kind === "weekly" ? 604800
      : window.kind === "session" && /(?:^| )5-hour$/i.test(label) ? 18000 : null : null;
    const durationSeconds = sourceDuration ?? labelDuration;
    const pace = good(window.pace) ? { status: enumValue(window.pace.status), reservePercentPoints: typeof window.pace.reservePercentPoints === "number" && Number.isFinite(window.pace.reservePercentPoints) ? window.pace.reservePercentPoints : null,
      cycleBasis: ["window_seconds", "starts_at_resets_at"].includes(window.pace.cycleBasis) ? window.pace.cycleBasis : null,
      cycleSeconds: number(window.pace.cycleSeconds, 1e10), timeRemainingPercent: number(window.pace.timeRemainingPercent) } : null;
    return { id: window.id, label, kind: window.kind, percentRemaining: number(window.percentRemaining), resetsAt: date(window.resetsAt), startsAt: date(window.startsAt), durationSeconds, ...(sourceDuration === null && labelDuration !== null ? { durationBasis: "provider_label" } : {}), annotation: categorizeSubscriptionText(window.resetText), pace };
  });
  if (provider.quotaSemantics.effectiveAvailability.length > 100) throw new Error("schema");
  const scopes = provider.quotaSemantics.effectiveAvailability.map((scope) => {
    if (!good(scope) || !text(scope.scope)) throw new Error("schema");
    return { scope: scope.scope, status: enumValue(scope.status), percentRemaining: scope.status === "known" && provider.state.stale !== true && provider.state.status === "fresh" ? number(scope.effectivePercentRemaining) : null,
      boundedBy: Array.isArray(scope.boundedBy) ? scope.boundedBy.filter((id) => text(id) && windows.some((w) => w.id === id)).slice(0, 100) : [],
      limitingWindowIds: Array.isArray(scope.limitingWindowIds) ? scope.limitingWindowIds.filter((id) => text(id) && windows.some((w) => w.id === id)).slice(0, 100) : [],
      pace: good(scope.pace) ? { status: enumValue(scope.pace.status), reservePercentPoints: typeof scope.pace.worstReservePercentPoints === "number" && Number.isFinite(scope.pace.worstReservePercentPoints) ? scope.pace.worstReservePercentPoints : null } : null,
      runway: good(scope.runway) ? { status: enumValue(scope.runway.status), seconds: number(scope.runway.usableRunwaySeconds, 1e10), exhaustedAt: date(scope.runway.projectedExhaustedAt) } : null };
  });
  const status = enumValue(provider.state.status);
  return { provider: provider.provider, status, stale: provider.state.stale === true || status === "stale", reused: provider.state.reused === true, refreshedAt: date(provider.state.refreshedAt), authStatus: provider.state.authStatus ? enumValue(provider.state.authStatus) : null, quotaStatus: enumValue(provider.quotaSemantics.status),
    unresolvedWindowIds: Array.isArray(provider.quotaSemantics.unresolvedWindowIds) ? provider.quotaSemantics.unresolvedWindowIds.filter((id) => text(id)).slice(0, 100) : [], windows, scopes };
}

export function sanitizeQuota(raw) {
  if (!good(raw) || ![5, 6].includes(raw.schemaVersion) || !Array.isArray(raw.providers) || raw.providers.length > 40) throw new Error("schema");
  return raw.providers.flatMap((provider) => {
    try { return [sanitizeProvider(provider)]; }
    catch (error) {
      // A provider's unsupported shape must not discard other valid providers.
      if (error?.message !== "schema") throw error;
      return [];
    }
  });
}

export function createQuotaReader({ run, execute = exec, now = Date.now, ttlMs = 60000, maxAge = process.env.FM_QUOTA_MAX_AGE } = {}) {
  const age = quotaMaxAge(maxAge || DEFAULT_MAX_AGE);
  run ||= (timeout) => execute("quota-axi", ["--full", "--json", "--no-credential-refresh", "--max-age", age.value], { timeout, maxBuffer: 1024 * 1024, windowsHide: true });
  let firstRead = true;
  let last = null;
  let current = null;
  let nextReadAt = 0;
  let pending = null;
  const interval = Math.max(1000, Math.min(300000, ttlMs));
  return async () => {
    if (pending) return pending;
    if (now() < nextReadAt && current) return { ...current, ageMs: current.readAt ? Math.max(0, now() - Date.parse(current.readAt)) : null };
    const timeout = firstRead ? 15000 : 6000;
    firstRead = false;
    pending = (async () => {
      try {
        // Bound injected runners too; real execFile has its own kill timeout.
        let timer;
        const result = await Promise.race([Promise.resolve().then(() => run(timeout)), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeout + 500); })]).finally(() => clearTimeout(timer));
        const raw = JSON.parse(typeof result === "string" ? result : result.stdout);
        const providers = sanitizeQuota(raw);
        // Reject a wholly unsupported response before replacing the last good
        // snapshot; partial results and genuinely empty responses remain valid.
        if (raw.providers.length && !providers.length) throw new Error("schema");
        // The source capture clock, not the later CLI exit time, is the timing
        // basis for every reset marker. Legacy injected fixtures without it
        // retain the reader clock for freshness but cannot prove live timing.
        const capturedAt = date(raw.generatedAt);
        last = { providers, unsupportedProviders: raw.providers.length - providers.length, readAt: capturedAt || new Date(now()).toISOString(), capturedAt, maxAgeMs: age.ms, stale: false, error: null };
        nextReadAt = now() + interval;
        current = { ...last, ageMs: Math.max(0, now() - Date.parse(last.readAt)) };
        return current;
      } catch (error) {
        nextReadAt = now() + Math.min(interval, 5000);
        const reason = error?.code === "ENOENT" ? "quota-axi is not installed" : error?.message === "timeout" || error?.killed ? "Quota read timed out" : error instanceof SyntaxError || error?.message === "schema" ? "Quota response invalid" : "Quota read failed";
        current = last ? { ...last, stale: true, error: `Quota refresh unavailable: ${reason}`, ageMs: Math.max(0, now() - Date.parse(last.readAt)) } : { providers: [], readAt: null, ageMs: null, maxAgeMs: age.ms, stale: false, error: `Quota unavailable: ${reason}` };
        return current;
      }
    })();
    try { return await pending; } finally { pending = null; }
  };
}
