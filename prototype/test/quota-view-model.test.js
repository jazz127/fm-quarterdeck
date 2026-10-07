import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { sanitizeQuota } from "../quota.js";

const code = await readFile(new URL("../public/quota-view-model.js", import.meta.url), "utf8");
const window = {};
vm.runInNewContext(code, { window });
const { project, groups, marker, windowLabels } = window.quotaViewModel;

test("sanitized quota projection retains source binding, every window, exact reset and unknown values", () => {
  const providers = sanitizeQuota({ schemaVersion: 5, providers: [{
    provider: "codex", state: { status: "fresh", stale: false, authStatus: "usable" },
    quotaSemantics: { status: "partial", effectiveAvailability: [{ scope: "all_models", status: "known", effectivePercentRemaining: 12,
      boundedBy: ["day", "week"], limitingWindowIds: ["week"] }] },
    windows: [
      { id: "day", label: "Daily", kind: "daily", percentRemaining: 12, resetsAt: "2030-01-02T03:04:05.000Z" },
      { id: "week", label: "Weekly", kind: "weekly", percentRemaining: 80 },
      { id: "unknown", label: "Unknown", kind: "session" },
    ],
  }] });
  const reading = { providers, stale: false };
  const result = project(reading);
  assert.equal(result.detail.length, 1);
  assert.equal(result.detail[0].windows.length, 3);
  assert.equal(result.detail[0].critical.kind, "source-limiting");
  assert.equal(result.detail[0].critical.windows[0].id, "week");
  assert.equal(result.detail[0].windows[0].isLimiting, false);
  assert.equal(result.detail[0].windows[0].resetsAt, "2030-01-02T03:04:05.000Z");
  assert.equal(result.detail[0].windows[2].percentRemaining, null);
  assert.deepEqual(Array.from(result.sidebar[0].windows, (window) => window.id), ["day", "week"]);
  assert.equal(result.sidebar[0].windows[1].isLimiting, true);
  assert.equal(providers[0].windows[1].isLimiting, undefined, "input is not mutated");
  const withoutBinding = project({ providers: [{ ...providers[0], scopes: providers[0].scopes.map((scope) => ({ ...scope, limitingWindowIds: [] })) }] });
  assert.equal(withoutBinding.detail[0].critical.kind, "lowest-scope-binding-unknown");
  const unknown = project({ providers: [{ ...providers[0], scopes: [], windows: [providers[0].windows[2]] }] });
  assert.equal(unknown.detail[0].critical.kind, "unknown");
  assert.equal(unknown.sidebar.length, 0, "unknown is not zero in the sidebar");
});

test("authoritative scope bounds create two families, never labels or ambiguous overlaps", () => {
  const windows = ["gemini_5h", "gemini_7d", "claude_5h", "claude_7d", "extra"].map((id, i) => ({ id, label: `Window ${i}`, percentRemaining: i === 0 ? 0 : i * 20 }));
  const provider = { provider: "agy", windows, scopes: [
    { scope: "gemini", boundedBy: ["gemini_5h", "gemini_7d"] },
    { scope: "claude_gpt", boundedBy: ["claude_5h", "claude_7d"] }
  ] };
  const family = groups(provider);
  assert.equal(family.length, 3);
  assert.deepEqual(Array.from(family, (g) => g.windows.length), [2, 2, 1]);
  assert.equal(family[0].scope, "gemini");
  assert.equal(family[1].scope, "claude_gpt");
  assert.equal(family[2].scope, null);
  assert.equal(project({ providers: [provider], readAt: "2030-01-01T00:00:00Z" }).sidebar.length, 3);
  assert.equal(groups({ ...provider, scopes: [] }).length, 1, "display labels do not create families");
  assert.deepEqual(Array.from(windowLabels({ scope: "gemini", windows: [
    { label: "Gemini 5-hour" }, { label: "Gemini weekly" }, { label: "Extra period" }
  ] })), ["5h", "weekly", "Extra period"]);
  assert.deepEqual(Array.from(windowLabels({ scope: null, windows: [{ label: "Gemini 5-hour" }, { label: "Gemini weekly" }] })), ["Gemini 5-hour", "Gemini weekly"], "unproven group keeps full labels");
  assert.deepEqual(Array.from(windowLabels({ scope: "gemini", windows: [{ label: "Gemini 5-hour" }, { label: "Other 5-hour" }] })), ["Gemini 5-hour", "Other 5-hour"], "duplicate shorthand must not obscure distinct windows");
  assert.equal(groups({ ...provider, windows: [windows[0]] })[0].windows.length, 1);
  assert.equal(groups({ ...provider, scopes: [{ scope: "a", boundedBy: ["gemini_5h"] }, { scope: "b", boundedBy: ["gemini_5h"] }] })[0].scope, null);
});

test("remaining-window notch is evidence-bound to captured interval, including endpoints and rollover", () => {
  const w = { startsAt: "2030-01-01T00:00:00Z", resetsAt: "2030-01-01T05:00:00Z", durationSeconds: 18000 };
  assert.equal(marker(w, w.startsAt), 100);
  assert.equal(marker(w, "2030-01-01T02:30:00Z"), 50);
  assert.equal(marker(w, w.resetsAt), 0);
  const week = { startsAt: "2030-01-01T00:00:00Z", resetsAt: "2030-01-08T00:00:00Z", durationSeconds: 604800 };
  assert.ok(Math.abs(marker(week, "2030-01-02T11:00:00Z") - 79.1667) < 0.001, "5d13h of seven days remaining");
  assert.ok(marker(week, "2030-01-03T00:00:00Z") < marker(week, "2030-01-02T11:00:00Z"));
  assert.equal(marker(w, "2030-01-01T05:00:01Z"), null, "old reset is never rolled forward");
  assert.equal(marker({ ...w, startsAt: null }, w.resetsAt), null);
  const sourcePace = { cycleBasis: "window_seconds", cycleSeconds: 18000, timeRemainingPercent: 50 };
  assert.equal(marker({ ...w, startsAt: null, pace: sourcePace }, "2030-01-01T02:30:00Z"), 50, "source-declared duration and pace validate implied start");
  assert.equal(marker({ ...w, startsAt: null, pace: { ...sourcePace, timeRemainingPercent: 60 } }, "2030-01-01T02:30:00Z"), null, "disagreeing source pace is not guessed over");
  assert.equal(marker({ ...w, startsAt: null, pace: { ...sourcePace, cycleSeconds: 604800 } }, "2030-01-01T02:30:00Z"), null);
  assert.equal(marker({ ...w, durationSeconds: null }, w.resetsAt), null);
  assert.equal(marker({ ...w, durationSeconds: 3600 }, w.resetsAt), null);
  assert.equal(marker({ ...w, resetsAt: null }, w.startsAt), null);
  assert.equal(marker({ ...w, startsAt: "2030-01-02T00:00:00Z" }, w.startsAt), null);
  assert.equal(marker({ ...w, durationSeconds: -1 }, w.startsAt), null);
  assert.equal(marker(w, "not a timestamp"), null);
});

test("Grok source provider combines independent weekly windows into one card with distinct compact labels", () => {
  const grok = { provider: "grok", windows: [
    { id: "credits", label: "week", kind: "weekly", percentRemaining: 8 },
    { id: "product:grok_build", label: "Grok Build", kind: "weekly", percentRemaining: 40 },
    { id: "product:chat", label: "Chat", kind: "weekly", percentRemaining: 95 },
    { id: "product:unknown_7", label: "Product 7", kind: "weekly", percentRemaining: 0 }
  ], scopes: [
    { scope: "all_products", boundedBy: ["credits"] },
    { scope: "product:grok_build", boundedBy: ["credits", "product:grok_build"] },
    { scope: "product:chat", boundedBy: ["credits", "product:chat"] }
  ] };
  const [family] = groups(grok);
  assert.equal(groups(grok).length, 1);
  assert.equal(family.scope, null, "overlapping source scopes do not imply a shared allowance");
  assert.deepEqual(Array.from(family.windows, w => w.percentRemaining), [8, 40, 95, 0]);
  assert.deepEqual(Array.from(windowLabels(family)), ["Credits", "Build", "Chat", "Product 7"]);
  assert.equal(project({ providers: [grok] }).sidebar.length, 1);
});

test("stale and unavailable readings remain distinguishable from zero", () => {
  const provider = { provider: "codex", status: "fresh", windows: [{ id: "short", label: "5h", percentRemaining: 0 }, { id: "unknown", label: "7d", percentRemaining: null }], scopes: [] };
  const stale = project({ providers: [provider], stale: true });
  assert.equal(stale.sidebar[0].windows[0].percentRemaining, 0);
  assert.equal(stale.sidebar[0].windows[0].stale, true);
  assert.equal(stale.sidebar[0].windows[1].percentRemaining, null);
  assert.equal(project({ providers: [{ ...provider, status: "unavailable" }] }).sidebar.length, 0);
});

test("reused age labels and stale boundary suppress all effective projections", () => {
  const now = Date.parse("2030-01-01T00:05:00Z");
  const provider = {
    provider: "codex", status: "fresh", stale: false, reused: true,
    refreshedAt: "2030-01-01T00:04:18Z", quotaStatus: "known",
    scopes: [{ scope: "all_models", status: "known", percentRemaining: 42,
      pace: { status: "ahead", reservePercentPoints: -4 },
      runway: { status: "projected_exhaustion", seconds: 600, exhaustedAt: "2030-01-01T00:15:00Z" } }],
    windows: [{ id: "session", label: "Session", percentRemaining: 42, pace: { status: "behind" } }]
  };
  const reused42s = project({ providers: [provider], maxAgeMs: 300000 }, { now }).detail[0];
  assert.equal(reused42s.reusedLabel, "reused 42s");
  const reused3m = project({ providers: [{ ...provider, refreshedAt: "2030-01-01T00:02:00Z" }], maxAgeMs: 300000 }, { now: Date.parse("2030-01-01T00:05:00Z") }).detail[0];
  assert.equal(reused3m.reusedLabel, "reused 3m");

  const boundaryProvider = { ...provider, refreshedAt: "2030-01-01T00:00:00Z" };
  const atBoundary = project({ providers: [boundaryProvider], maxAgeMs: 300000 }, { now }).detail[0];
  assert.equal(atBoundary.stale, true, "age equal to maximum age is stale");
  assert.equal(atBoundary.staleLabel, "stale · 5m");
  assert.equal(atBoundary.reusedLabel, null, "stale marker takes precedence over reused");
  assert.equal(atBoundary.critical.kind, "unknown");
  assert.equal(atBoundary.scopes[0].percentRemaining, null);
  assert.equal(atBoundary.scopes[0].pace.status, "unknown");
  assert.equal(atBoundary.scopes[0].runway.status, "unknown");
  assert.equal(atBoundary.scopes[0].runway.exhaustedAt, null);
  assert.equal(atBoundary.windows[0].pace.status, "unknown");
  const beforeBoundary = project({ providers: [boundaryProvider], maxAgeMs: 300000 }, { now: now - 1 }).detail[0];
  assert.equal(beforeBoundary.stale, false);

  const sourceStale = project({ providers: [{ ...provider, status: "stale", refreshedAt: "2030-01-01T00:04:59Z" }], maxAgeMs: 300000 }, { now }).detail[0];
  assert.equal(sourceStale.stale, true, "quota-axi stale status is authoritative before max age");
});

test("stale suppression retains valid captured interval evidence in every projection", () => {
  const capturedAt = "2030-01-01T02:30:00Z";
  const durationSeconds = 18000;
  const pace = { status: "ahead", reservePercentPoints: -4, cycleBasis: "window_seconds", cycleSeconds: durationSeconds, timeRemainingPercent: 50 };
  const windows = [
    { id: "implied", label: "Session", percentRemaining: 42, resetsAt: "2030-01-01T05:00:00Z", durationSeconds, pace },
    { id: "explicit", label: "Other", percentRemaining: 70, startsAt: "2030-01-01T00:00:00Z", resetsAt: "2030-01-01T05:00:00Z", durationSeconds, pace },
    { id: "inconsistent", label: "Unproven", percentRemaining: 70, resetsAt: "2030-01-01T05:00:00Z", durationSeconds, pace: { ...pace, timeRemainingPercent: 60 } }
  ];
  const provider = { provider: "codex", status: "fresh", authStatus: "usable", refreshedAt: capturedAt, scopes: [], windows };
  for (const sourceState of [{}, { stale: true }, { status: "stale" }]) {
    const reading = { providers: [{ ...provider, ...sourceState }], capturedAt, maxAgeMs: 300000 };
    const result = project(reading, { now: Date.parse(capturedAt) + (Object.keys(sourceState).length ? 1000 : 300000) });
    for (const surface of [result.detail[0], result.sidebar[0], ...groups(result.detail[0])]) {
      assert.equal(marker(surface.windows[0], capturedAt), 50);
      assert.equal(marker(surface.windows[1], capturedAt), 50);
      assert.equal(marker(surface.windows[2], capturedAt), null);
      for (const window of surface.windows) {
        assert.equal(window.pace.status, "unknown");
        assert.equal(window.pace.reservePercentPoints, null);
        assert.equal(window.pace.cycleBasis, "window_seconds");
        assert.equal(window.pace.cycleSeconds, durationSeconds);
      }
    }
  }
  assert.equal(provider.windows[0].pace.status, "ahead");
  assert.equal(provider.windows[0].pace.reservePercentPoints, -4);
});

test("stale compact quota eligibility stays bound to measured source limits", () => {
  const refreshedAt = "2030-01-01T00:00:00Z";
  const providers = [
    { provider: "codex", status: "fresh", authStatus: "usable", refreshedAt, windows: [], scopes: [
      { scope: "unmeasured", percentRemaining: null },
      { scope: "all_models", percentRemaining: 42, pace: { status: "ahead" } },
      { scope: "exhausted", percentRemaining: 0 }
    ] },
    { provider: "grok", status: "fresh", authStatus: "usable", refreshedAt,
      scopes: [{ scope: "all_models", percentRemaining: 80 }], windows: [{ id: "unknown", label: "Hidden source", percentRemaining: null }] },
    { provider: "kimi", status: "fresh", authStatus: "usable", refreshedAt, scopes: [{ scope: "unmeasured", percentRemaining: null }], windows: [] },
    { provider: "claude", status: "fresh", authStatus: "usable", refreshedAt, scopes: [],
      windows: [{ id: "session", label: "Session", percentRemaining: 0 }, { id: "unmeasured", label: "Unmeasured window", percentRemaining: null }] },
    { provider: "cursor", status: "fresh", authStatus: "unusable", refreshedAt, scopes: [], windows: [{ id: "session", percentRemaining: 60 }] }
  ];
  const reading = { providers, maxAgeMs: 300000 };
  const captured = Date.parse(refreshedAt);
  const identity = (projection) => Array.from(projection.sidebar, (family) => `${family.provider}:${family.scope}`);
  const fresh = project(reading, { now: captured + 290000 });
  assert.deepEqual(identity(fresh), ["codex:all_models", "codex:exhausted", "claude:null"]);
  const staleReadings = [
    [reading, captured + 305000],
    [{ ...reading, stale: true }, captured + 1000],
    [{ ...reading, providers: providers.map((provider) => ({ ...provider, stale: true })) }, captured + 1000],
    [{ ...reading, providers: providers.map((provider) => ({ ...provider, status: "stale" })) }, captured + 1000]
  ];
  for (const [staleReading, now] of staleReadings) {
    const stale = project(staleReading, { now });
    assert.deepEqual(identity(stale), identity(fresh));
    for (const family of stale.sidebar) {
      assert.equal(family.stale, true);
      assert.equal(family.windows[0].pace.status, "unknown");
    }
    assert.equal(stale.sidebar[0].windows[0].percentRemaining, null);
    assert.equal(stale.sidebar[1].windows[0].percentRemaining, null);
    assert.equal(stale.sidebar[2].windows[0].percentRemaining, 0);
    assert.equal(stale.sidebar[2].windows[1].percentRemaining, null);
    assert.equal(stale.detail.length, fresh.detail.length);
  }
  assert.equal(providers[0].scopes[1].percentRemaining, 42);
  assert.equal(providers[0].scopes[1].pace.status, "ahead");
});
