// Synthetic sanitized fixtures only. No quota command, credentials or shared preview.
import { pathToFileURL } from "node:url";
import { createServer } from "../server.js";
import { sanitizeQuota } from "../quota.js";
export const quotaCaptureTime = "2026-09-25T04:50:00.000Z";
const scope = (scope, percent, ids, runway = "through_reset", reserve = null) => ({ scope, status: "known", effectivePercentRemaining: percent, boundedBy: ids, limitingWindowIds: [ids[0]],
  pace: { status: reserve === null ? "unknown" : reserve < 0 ? "ahead" : "behind", worstReservePercentPoints: reserve },
  runway: { status: runway, usableRunwaySeconds: runway === "projected_exhaustion" ? 600 : null, projectedExhaustedAt: runway === "projected_exhaustion" ? "2026-09-25T05:00:00.000Z" : null } });
const provider = (provider, scopes, windows) => ({ provider, state: { status: "fresh", stale: false, authStatus: "usable", refreshedAt: quotaCaptureTime, reused: true }, quotaSemantics: { status: "known", effectiveAvailability: scopes }, windows });
const weekly = (id, label, percent, reserve) => ({ id, label, kind: "weekly", percentRemaining: percent, startsAt: "2026-09-23T22:52:52.000Z", resetsAt: "2026-09-30T22:52:52.000Z", pace: { status: reserve === null ? "unknown" : reserve < 0 ? "ahead" : "behind", reservePercentPoints: reserve, cycleBasis: "starts_at_resets_at", cycleSeconds: 604800 } });
const inactive = (provider, status) => ({ provider, state: { status }, quotaSemantics: { status: "unknown", effectiveAvailability: [] }, windows: [] });
export function quotaAcceptanceReading(state = "normal") {
  if (state === "unavailable") return { providers: [], readAt: null, stale: false, error: "quota-axi is not installed" };
  const raw = { schemaVersion: 5, providers: [
    provider("codex", [scope("all_models", 19, ["weekly"], "through_reset", -6.45)], [{ id: "weekly", label: "weekly", kind: "weekly", percentRemaining: 19, windowSeconds: 604800, resetsAt: "2026-09-30T17:50:00.000Z", pace: { status: "ahead", cycleBasis: "window_seconds", cycleSeconds: 604800, timeRemainingPercent: 79.1667, reservePercentPoints: -6.45 } }]),
    provider("grok", [scope("all_products", 12, ["credits"], "through_reset", -70.15)], [weekly("credits", "week", 12, -70.15), weekly("product:grok_build", "Grok Build", 43, -70.15), weekly("product:chat", "Chat", 80, null)]),
    provider("agy", [scope("gemini", 68, ["gemini_5h", "gemini_weekly"], "unknown"), scope("claude_gpt", 100, ["claude_gpt_5h", "claude_gpt_weekly"], "unknown")], [
      { id: "gemini_5h", label: "Gemini 5-hour", kind: "session", percentRemaining: 68, resetsAt: "2026-09-25T05:56:31.000Z", pace: { status: "unknown" } },
      { id: "gemini_weekly", label: "Gemini weekly", kind: "weekly", percentRemaining: 78, resetsAt: "2026-09-30T03:37:19.000Z", resetText: "You have used some of your weekly limit, it will fully refresh in 4 days, 22 hours.", pace: { status: "unknown" } },
      { id: "claude_gpt_5h", label: "Claude/GPT 5-hour", kind: "session", percentRemaining: 100, resetsAt: "2026-09-25T09:51:35.000Z", pace: { status: "unknown" } },
      { id: "claude_gpt_weekly", label: "Claude/GPT weekly", kind: "weekly", percentRemaining: 100, resetsAt: "2026-10-02T04:51:35.000Z", pace: { status: "unknown" } }
    ]),
    inactive("cursor", "error"),
    inactive("copilot", "fresh"),
    ...["claude", "commandcode", "kimi", "zai", "alibaba", "opencode-go", "minimax", "mimo", "deepseek", "openrouter", "elevenlabs", "devin", "muse"].map(provider => inactive(provider, "auth_required"))
  ] };
  if (state === "provider-stale") raw.providers[0].state.stale = true;
  if (state === "exhaustion") {
    raw.providers[0].quotaSemantics.effectiveAvailability[0].runway = { status: "projected_exhaustion", usableRunwaySeconds: 600, projectedExhaustedAt: "2026-09-25T05:00:00.000Z" };
    raw.providers[1].quotaSemantics.effectiveAvailability[0].runway = { status: "exhausted_now", usableRunwaySeconds: 0 };
    raw.providers[1].quotaSemantics.effectiveAvailability[0].effectivePercentRemaining = 0;
    raw.providers[1].windows[0].percentRemaining = 0;
  }
  return { providers: sanitizeQuota(raw), readAt: quotaCaptureTime, capturedAt: quotaCaptureTime, maxAgeMs: 300000, stale: state === "whole-stale", error: state === "whole-stale" ? "Quota refresh unavailable: Quota read timed out" : null, unsupportedProviders: 2 };
}
export function createQuotaAcceptanceServer(state) {
  return createServer({}, { quotaReader: state === "loading" ? () => new Promise(() => {}) : async () => quotaAcceptanceReading(state) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const [index, state] of ["normal", "provider-stale", "whole-stale", "exhaustion", "unavailable", "loading"].entries()) {
    const server = createQuotaAcceptanceServer(state);
    server.listen(Number(process.env.QUOTA_ACCEPT_PORT || 4187) + index, "127.0.0.1", () => console.log(`quota ${state}: http://127.0.0.1:${server.address().port}/#quota`));
  }
}
