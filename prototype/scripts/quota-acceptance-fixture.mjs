// Local-only browser acceptance fixture. Both readings pass through the quota
// source sanitizer; no live command, credentials, or shared preview is touched.
import { createServer } from "../server.js";
import { sanitizeQuota } from "../quota.js";

const provider = (name, scopes, windows) => ({
  provider: name, state: { status: "fresh", stale: false },
  quotaSemantics: { status: "partial", effectiveAvailability: scopes }, windows
});
const readings = [
  { schemaVersion: 5, providers: [provider("codex", [
    { scope: "all_models", status: "known", effectivePercentRemaining: 9, boundedBy: ["short", "week"], limitingWindowIds: ["week"], runway: { status: "projected_exhaustion", projectedExhaustedAt: "2030-01-03T09:00:00Z" } }
  ], [
    { id: "short", label: "session", kind: "session", percentRemaining: 44, resetsAt: "2030-01-02T00:00:00Z", pace: { status: "behind", reservePercentPoints: 15 } },
    { id: "week", label: "week", kind: "weekly", percentRemaining: 9, resetsAt: "2030-01-08T00:00:00Z", pace: { status: "ahead", reservePercentPoints: -30 } }
  ])] },
  { schemaVersion: 5, providers: [provider("grok", [], [
    { id: "unknown", label: "Reported window", kind: "weekly", percentRemaining: null, resetsAt: null },
    { id: "partial", label: "Measured window", kind: "session", percentRemaining: 31, resetsAt: null }
  ])] }
];
for (const [index, raw] of readings.entries()) {
  const reading = { providers: sanitizeQuota(raw), readAt: "2030-01-01T00:00:00.000Z", stale: false, error: null };
  const server = createServer({}, { quotaReader: async () => reading });
  server.listen(Number(process.env.QUOTA_ACCEPT_PORT || 4187) + index, "127.0.0.1", () => {
    console.log(`quota ${index === 0 ? "constrained" : "incomplete"}: http://127.0.0.1:${server.address().port}/#quota`);
  });
}
