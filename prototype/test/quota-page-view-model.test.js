import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { quotaAcceptanceReading } from "../scripts/quota-acceptance-fixture.mjs";
const window = {};
vm.runInNewContext(await readFile(new URL("../public/quota-view-model.js", import.meta.url), "utf8"), { window });
const { project, summarize, paceBand } = window.quotaViewModel;
const now = Date.parse("2030-01-01T00:00:00Z");
const scope = (percentRemaining, status = "through_reset") => ({ scope: "all", percentRemaining, boundedBy: ["w"], limitingWindowIds: ["w"], runway: { status, seconds: 600, exhaustedAt: "2030-01-01T00:10:00Z" } });
const provider = (name, percent, extra = {}) => ({ provider: name, status: "fresh", scopes: [scope(percent)], windows: [{ id: "w", label: "week", percentRemaining: percent, resetsAt: "2030-01-02T00:00:00Z", pace: { status: "behind", reservePercentPoints: percent - 50 } }], ...extra });
test("screenshot fixtures retain all sanitized providers and distinct stale/exhaustion states", () => {
  const normal = quotaAcceptanceReading();
  assert.equal(normal.providers.length, 18);
  assert.equal(normal.providers.filter(p => p.windows.length).length, 3);
  assert.equal(normal.providers.filter(p => p.status === "error").length, 1);
  assert.equal(normal.providers.filter(p => p.status === "auth_required").length, 13);
  assert.equal(normal.providers.find(p => p.provider === "grok").windows[0].durationSeconds, 604800);
  assert.equal(quotaAcceptanceReading("provider-stale").providers[0].stale, true);
  assert.equal(quotaAcceptanceReading("whole-stale").stale, true);
  const statuses = quotaAcceptanceReading("exhaustion").providers.flatMap(p => p.scopes.map(s => s.runway.status));
  assert.ok(statuses.includes("projected_exhaustion")); assert.ok(statuses.includes("exhausted_now"));
  assert.equal(quotaAcceptanceReading("unavailable").readAt, null);
});

test("summary selects valid fresh scope evidence, counts unknown and reports stable ties", () => {
  const result = summarize(project({ providers: [provider("grok", 6), provider("codex", 98), provider("claude", 6), provider("agy", 1, { stale: true }), provider("partial", 0, { status: "partial" }), provider("invalid", 101)] }, { now, sortMode: "source" }), now);
  assert.equal(result.tightest.provider, "grok");
  assert.equal(result.tightest.percentRemaining, 6);
  assert.equal(result.tightest.limit.id, "w");
  assert.equal(result.tightest.tied, 1);
  assert.equal(result.mostRoom.provider, "codex");
  assert.equal(result.unknown, 3);
  const empty = summarize(project({ providers: [] }, { now }), now);
  assert.equal(empty.tightest, null); assert.equal(empty.mostRoom, null); assert.equal(empty.nextReset, null);
});
test("runway tallies each scope status; stale and non-fresh projections are unknown", () => {
  const providers = ["through_reset", "projected_exhaustion", "exhausted_now", "unknown"].map((status, i) => provider(`p${i}`, 10, { scopes: [scope(10, status)] }));
  providers.push(provider("stale", 10, { stale: true }));
  const { runway } = summarize(project({ providers }, { now }), now);
  assert.equal(runway.total, 5); assert.equal(runway.through_reset, 1); assert.equal(runway.projected_exhaustion, 1); assert.equal(runway.exhausted_now, 1); assert.equal(runway.unknown, 2); assert.equal(runway.soonest.seconds, 600);
});
test("next reset excludes past, missing, invalid, stale and non-fresh provider evidence", () => {
  const providers = [provider("later", 20), provider("sooner", 10, { windows: [{ id: "w", resetsAt: "2030-01-01T00:30:00Z" }, { id: "past", resetsAt: "2029-12-31T23:00:00Z" }, { id: "invalid", resetsAt: "bad" }] }), provider("stale", 5, { stale: true }), provider("partial", 5, { status: "partial" })];
  const summary = summarize(project({ providers }, { now }), now);
  assert.equal(summary.nextReset.provider, "sooner"); assert.equal(summary.thenReset.provider, "later");
  const captured = summarize(project({ providers, stale: true }, { now }), now);
  assert.equal(captured.tightest, null); assert.equal(captured.nextReset.captured, true);
});
test("provider sorting shares the sidebar window keys, not Grok effective scope percentages", () => {
  const providers = [provider("grok", 6, { windows: [{ id: "w", percentRemaining: 60, pace: { status: "behind", reservePercentPoints: 10 } }] }), provider("codex", 20, { windows: [{ id: "w", percentRemaining: 20, pace: { status: "ahead", reservePercentPoints: -20 } }] })];
  for (const mode of ["highest", "lowest", "runway", "runway-lowest", "az", "za"]) {
    const result = project({ providers }, { now, sortMode: mode, sidebarSort: mode });
    assert.deepEqual(Array.from(result.detail, p => p.provider), Array.from(result.sidebar, p => p.provider));
    for (const p of result.detail) { const f = result.sidebar.find(f => f.provider === p.provider); assert.equal(p.sortRemaining, f.sortRemaining); assert.equal(p.sortRunway.value, f.sortRunway.value); }
  }
  assert.equal(project({ providers }, { now }).detail[0].provider, "grok");
  assert.equal(project({ providers }, { now, lowestFirst: true }).detail[0].provider, "codex");
  const agy = provider("agy", 40, { scopes: [scope(40), { ...scope(90), scope: "other", boundedBy: ["other"] }], windows: [{ id: "w", percentRemaining: 40, pace: { status: "behind", reservePercentPoints: 30 } }, { id: "other", percentRemaining: 90, pace: { status: "behind", reservePercentPoints: 10 } }] });
  const result = project({ providers: [agy] }, { now });
  assert.equal(result.detail[0].sortRemaining, 40); assert.equal(result.detail[0].sortRunway.value, 10);
  agy.windows[1].percentRemaining = null;
  assert.equal(project({ providers: [agy] }, { now }).detail[0].sortRemaining, null);
  const stale = project({ providers: [agy], stale: true }, { now }).detail[0];
  assert.equal(stale.sortRemaining, null); assert.equal(stale.sortRunway, null);
});
test("band requires source pace reserve and a valid captured marker; geometry never determines its text", () => {
  const w = { percentRemaining: 80, pace: { status: "behind", reservePercentPoints: 45.6 } };
  const band = paceBand(w, 35.7);
  assert.equal(band.left, 35.7); assert.ok(Math.abs(band.width - 44.3) < 0.001); assert.equal(band.reserve, 45.6); assert.equal(band.kind, "reserve");
  assert.equal(paceBand(w, 35.7, true), null); assert.equal(paceBand(w, null), null);
  assert.equal(paceBand({ ...w, pace: { status: "unknown", reservePercentPoints: 45 } }, 35), null);
  assert.equal(paceBand({ ...w, pace: { status: "ahead" } }, 35), null);
  assert.equal(paceBand({ ...w, durationBasis: "provider_label", pace: { status: "unknown" } }, 35), null);
  assert.equal(paceBand({ ...w, percentRemaining: 9, pace: { status: "ahead", reservePercentPoints: -30 } }, 39).kind, "deficit");
});
