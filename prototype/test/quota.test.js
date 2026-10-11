import assert from "node:assert/strict";
import test from "node:test";
import { categorizeSubscriptionText, createQuotaReader, sanitizeQuota } from "../quota.js";
import { createServer } from "../server.js";

const fixture = () => ({ schemaVersion: 5, providers: [{ provider: "codex", state: { status: "fresh", stale: false }, quotaSemantics: { status: "partial", effectiveAvailability: [
  { scope: "all_models", status: "known", effectivePercentRemaining: 42, runway: { status: "unknown" } },
  { scope: "model:sample", status: "unknown", effectivePercentRemaining: 0 },
] }, windows: [{ id: "session", label: "session", kind: "session", percentRemaining: 42, resetsAt: "2030-01-01T00:00:00.000Z" }, { id: "weekly", label: "week", kind: "weekly" }], accountKey: "private", source: "/private", error: "secret" }] });
const run = (value) => async () => ({ stdout: JSON.stringify(value) });

test("sanitizes all supported providers and skips an unknown provider", () => {
  const names = ["claude", "codex", "cursor", "copilot", "grok", "kimi", "zai", "agy", "alibaba", "opencode-go", "commandcode", "minimax", "mimo", "deepseek", "openrouter", "elevenlabs", "devin", "muse"];
  for (const schemaVersion of [5, 6]) {
    const raw = fixture();
    raw.schemaVersion = schemaVersion;
    raw.providers = names.map((provider) => ({ ...structuredClone(raw.providers[0]), provider }));
    assert.deepEqual(sanitizeQuota(raw).map((provider) => provider.provider), names);
    raw.providers.push({ ...structuredClone(raw.providers[0]), provider: "untrusted-provider" });
    assert.deepEqual(sanitizeQuota(raw).map((provider) => provider.provider), names);
  }
});

test("sanitizes known, partial and unknown quota without forwarding identity or diagnostics", () => {
  const output = sanitizeQuota(fixture());
  assert.equal(output[0].scopes[0].percentRemaining, 42);
  assert.equal(output[0].scopes[1].percentRemaining, null);
  assert.equal(output[0].windows[1].percentRemaining, null);
  assert.doesNotMatch(JSON.stringify(output), /private|secret|accountKey|source/);
});

test("allowlists provider freshness metadata and omits unrecognized state fields", () => {
  const raw = fixture();
  raw.providers[0].state = { status: "fresh", stale: false, reused: true, refreshedAt: "2030-01-01T00:00:00Z", private: "secret" };
  const provider = sanitizeQuota(raw)[0];
  assert.equal(provider.status, "fresh");
  assert.equal(provider.stale, false);
  assert.equal(provider.reused, true);
  assert.equal(provider.refreshedAt, "2030-01-01T00:00:00.000Z");
  assert.doesNotMatch(JSON.stringify(provider), /secret|private/);
  raw.providers[0].state.status = "stale";
  assert.equal(sanitizeQuota(raw)[0].stale, true);
});

test("quota CLI uses the configured max age with existing live-read safety arguments", async () => {
  const calls = [];
  const reader = createQuotaReader({ maxAge: "7m", execute: async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify(fixture()) };
  } });
  const reading = await reader();
  assert.equal(reading.maxAgeMs, 300000);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0][0], "quota-axi");
  assert.deepEqual(calls[0][1], ["--full", "--json", "--no-credential-refresh", "--max-age", "5m"]);
  assert.equal(calls[0][2].timeout, 15000);
  let fallbackArgs;
  const capped = await createQuotaReader({ maxAge: "90m", execute: async (_command, args) => {
    fallbackArgs = args;
    return { stdout: JSON.stringify(fixture()) };
  } })();
  assert.equal(capped.maxAgeMs, 300000, "configured reuse cannot exceed the five-minute refresh cadence");
  assert.equal(fallbackArgs.at(-1), "5m");
});

test("source interval metadata is allowlisted and invalid timing is not forwarded", () => {
  const raw = fixture();
  raw.providers[0].windows[0].startsAt = "2029-12-31T19:00:00Z";
  raw.providers[0].windows[0].durationSeconds = 18000;
  raw.providers[0].windows[1].startsAt = "private-account";
  raw.providers[0].windows[1].durationSeconds = -1;
  const windows = sanitizeQuota(raw)[0].windows;
  assert.equal(windows[0].durationSeconds, 18000);
  assert.equal(windows[0].startsAt, "2029-12-31T19:00:00.000Z");
  assert.equal(windows[1].durationSeconds, null);
  assert.equal(windows[1].startsAt, null);
  assert.doesNotMatch(JSON.stringify(windows), /private-account/);
});

test("full quota-axi timing fields are allowlisted without exposing identity or unrelated fields", async () => {
  const raw = fixture();
  raw.generatedAt = "2030-01-01T00:00:00Z";
  raw.providers[0].windows[0] = { id: "session", label: "session", kind: "session", resetsAt: "2030-01-01T05:00:00Z", windowSeconds: 18000,
    pace: { status: "on_pace", cycleBasis: "window_seconds", cycleSeconds: 18000, timeRemainingPercent: 100, account: "secret" }, account: "private" };
  const reader = createQuotaReader({ run: run(raw), now: () => Date.parse(raw.generatedAt) + 5000 });
  const result = await reader();
  assert.equal(result.readAt, "2030-01-01T00:00:00.000Z");
  assert.equal(result.capturedAt, result.readAt);
  assert.equal(result.providers[0].windows[0].durationSeconds, 18000);
  assert.equal(result.providers[0].windows[0].pace.cycleBasis, "window_seconds");
  assert.equal(result.providers[0].windows[0].pace.timeRemainingPercent, 100);
  assert.doesNotMatch(JSON.stringify(result), /secret|private|account/);
  const withoutCapture = await createQuotaReader({ run: run({ ...raw, generatedAt: undefined }), now: () => Date.parse(raw.generatedAt) })();
  assert.equal(withoutCapture.capturedAt, null, "reader clock is not substituted for a missing source capture");
});

test("categorizes subscription annotations for every provider and leaves unfamiliar prose unknown", () => {
  const raw = fixture();
  raw.providers[0].windows[0].resetText = "You have used some of your 5-hour limit, it will fully refresh in 3 hours, 17 minutes.";
  raw.providers[0].windows[1].resetText = "You have used some of your weekly limit, it will fully refresh in 5 days, 22 hours.";
  const other = structuredClone(raw.providers[0]);
  other.provider = "agy";
  other.windows[0].resetText = "Account secret/private text";
  raw.providers.push(other);
  const result = sanitizeQuota(raw);
  assert.deepEqual(result[0].windows.map((w) => w.annotation.category), ["Partial usage", "Partial usage"]);
  assert.match(result[0].windows[0].annotation.meaning, /Full refresh in 3 hours, 17 minutes/);
  assert.equal(result[1].windows[0].annotation.category, "Unknown");
  assert.equal(categorizeSubscriptionText(null), null);
  assert.doesNotMatch(JSON.stringify(result), /secret\/private|resetText/);
});

test("Antigravity grouped model-family labels are accepted without admitting paths", () => {
  const raw = fixture();
  raw.providers[0].provider = "agy";
  raw.providers[0].windows[0].label = "Claude/GPT week";
  assert.equal(sanitizeQuota(raw)[0].windows[0].label, "Claude/GPT week");
  raw.providers[0].windows[0].label = "/private/account";
  assert.deepEqual(sanitizeQuota(raw), []);
  raw.providers[0].provider = "codex";
  raw.providers[0].windows[0].label = "Claude/GPT week";
  assert.deepEqual(sanitizeQuota(raw), []);
});

test("unavailable and stale providers never claim effective headroom", () => {
  for (const state of [{ status: "auth_required", stale: false }, { status: "fresh", stale: true }]) {
    const raw = fixture();
    raw.providers[0].state = state;
    assert.equal(sanitizeQuota(raw)[0].scopes[0].percentRemaining, null);
  }
});

test("rejects malformed response schema and unknown versions", () => {
  for (const bad of [{}, { ...fixture(), schemaVersion: 100 }, { ...fixture(), providers: "bad" }]) {
    assert.throws(() => sanitizeQuota(bad), /schema/);
  }
});

test("coalesces simultaneous calls, caches success and retains stale reading with age on failure", async () => {
  let clock = 100000, calls = 0, finish;
  const reader = createQuotaReader({ now: () => clock, ttlMs: 1000, run: () => { calls++; return new Promise((resolve, reject) => { finish = calls === 1 ? () => resolve({ stdout: JSON.stringify(fixture()) }) : () => reject(new Error("token secret")); }); } });
  const a = reader(), b = reader();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  finish();
  assert.deepEqual(await a, await b);
  clock += 400;
  assert.equal((await reader()).ageMs, 400);
  assert.equal(calls, 1);
  clock += 1000;
  const c = reader();
  await new Promise((resolve) => setImmediate(resolve));
  finish();
  const stale = await c;
  assert.equal(stale.stale, true);
  assert.equal(stale.ageMs, 1400);
  clock += 100;
  assert.equal((await reader()).stale, true);
  assert.equal((await reader()).ageMs, 1500);
  assert.equal(stale.providers[0].scopes[0].percentRemaining, 42);
  assert.match(stale.error, /Quota refresh unavailable: Quota read failed/);
  assert.doesNotMatch(JSON.stringify(stale), /token secret/);
});

test("missing executable, malformed JSON and timeout give unavailable rather than zero", async () => {
  for (const [run, reason] of [[async () => { throw Object.assign(new Error("secret"), { code: "ENOENT" }); }, "not installed"], [async () => ({ stdout: "{" }), "response invalid"], [async () => ({ stdout: JSON.stringify({ providers: [] }) }), "response invalid"]]) {
    const result = await createQuotaReader({ run })();
    assert.match(result.error, new RegExp(reason));
    assert.deepEqual(result.providers, []);
  }
  const result = await createQuotaReader({ run: () => new Promise(() => {}) })();
  assert.match(result.error, /timed out/);
});

test("server quota endpoint uses injected reader without touching live command", async (t) => {
  const raw = fixture();
  raw.providers.push({ ...structuredClone(raw.providers[0]), provider: "muse" },
    { ...structuredClone(raw.providers[0]), provider: "future-provider" }, { provider: "codex", windows: [{}] });
  const server = createServer({}, { revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) }, quotaReader: createQuotaReader({ run: run(raw) }) });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/quota`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.providers.map((p) => p.provider), ["codex", "muse"]);
  assert.equal(body.unsupportedProviders, 2);
  assert.equal(body.error, null);
  assert.doesNotMatch(JSON.stringify(body), /private|secret/);
});

test("preserves omitted authStatus as null while validating explicit usable and unusable statuses", () => {
  const raw = {
    schemaVersion: 5,
    providers: [
      { provider: "codex", state: { status: "fresh", stale: false }, quotaSemantics: { status: "known", effectiveAvailability: [] }, windows: [{ id: "w1", label: "session", kind: "session" }] },
      { provider: "grok", state: { status: "fresh", stale: false, authStatus: "usable" }, quotaSemantics: { status: "known", effectiveAvailability: [] }, windows: [{ id: "w2", label: "week", kind: "weekly" }] },
      { provider: "commandcode", state: { status: "auth_required", stale: false, authStatus: "unusable" }, quotaSemantics: { status: "unknown", effectiveAvailability: [] }, windows: [] },
      { provider: "agy", state: { status: "fresh", stale: false }, quotaSemantics: { status: "known", effectiveAvailability: [] }, windows: [{ id: "w3", label: "Gemini 5-hour", kind: "session" }] },
    ]
  };
  const sanitized = sanitizeQuota(raw);
  assert.equal(sanitized[0].authStatus, null);
  assert.equal(sanitized[1].authStatus, "usable");
  assert.equal(sanitized[2].authStatus, "unusable");
  assert.equal(sanitized[3].authStatus, null);
});

test("sanitizes multiple active providers, multiple windows, limiting windows, and unmeasurable pace", () => {
  const raw = {
    schemaVersion: 5,
    providers: [
      {
        provider: "codex",
        state: { status: "fresh", stale: false },
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [{
            scope: "all_models",
            status: "known",
            effectivePercentRemaining: 19,
            boundedBy: ["weekly"],
            limitingWindowIds: ["weekly"],
            pace: { status: "ahead", worstReservePercentPoints: -6.45 }
          }]
        },
        windows: [{ id: "weekly", label: "week", kind: "weekly", percentRemaining: 19, pace: { status: "ahead", reservePercentPoints: -6.45 } }]
      },
      {
        provider: "grok",
        state: { status: "fresh", stale: false, authStatus: "usable" },
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [{
            scope: "all_products",
            status: "known",
            effectivePercentRemaining: 12,
            boundedBy: ["credits", "build"],
            limitingWindowIds: ["credits"],
            pace: { status: "ahead", worstReservePercentPoints: -70.15 }
          }]
        },
        windows: [
          { id: "credits", label: "Credits", kind: "weekly", percentRemaining: 12, pace: { status: "ahead", reservePercentPoints: -70.15 } },
          { id: "build", label: "Grok Build", kind: "weekly", percentRemaining: 12, pace: { status: "ahead", reservePercentPoints: -70.15 } }
        ]
      },
      {
        provider: "agy",
        state: { status: "fresh", stale: false },
        quotaSemantics: {
          status: "known",
          effectiveAvailability: [
            {
              scope: "gemini",
              status: "known",
              effectivePercentRemaining: 68,
              boundedBy: ["gemini_5h", "gemini_weekly"],
              limitingWindowIds: ["gemini_5h"],
              pace: { status: "unknown" }
            },
            {
              scope: "claude_gpt",
              status: "known",
              effectivePercentRemaining: 100,
              boundedBy: ["claude_gpt_5h", "claude_gpt_weekly"],
              limitingWindowIds: ["claude_gpt_5h"],
              pace: { status: "unknown" }
            }
          ]
        },
        windows: [
          { id: "gemini_5h", label: "Gemini 5-hour", kind: "session", percentRemaining: 68, pace: { status: "unknown" } },
          { id: "gemini_weekly", label: "Gemini weekly", kind: "weekly", percentRemaining: 78, pace: { status: "unknown" } },
          { id: "claude_gpt_5h", label: "Claude/GPT 5-hour", kind: "session", percentRemaining: 100, pace: { status: "unknown" } },
          { id: "claude_gpt_weekly", label: "Claude/GPT weekly", kind: "weekly", percentRemaining: 100, pace: { status: "unknown" } }
        ]
      },
      {
        provider: "claude",
        state: { status: "auth_required", stale: false },
        quotaSemantics: { status: "unknown", effectiveAvailability: [] },
        windows: []
      }
    ]
  };
  const sanitized = sanitizeQuota(raw);
  assert.equal(sanitized.length, 4);
  assert.deepEqual(sanitized.map((p) => p.provider), ["codex", "grok", "agy", "claude"]);
  assert.equal(sanitized[0].scopes[0].limitingWindowIds[0], "weekly");
  assert.equal(sanitized[1].windows.length, 2);
  assert.equal(sanitized[2].windows.length, 4);
  assert.equal(sanitized[2].scopes[0].limitingWindowIds[0], "gemini_5h");
  assert.equal(sanitized[2].scopes[0].pace.status, "unknown");
  assert.equal(sanitized[2].scopes[0].pace.reservePercentPoints, null);
  assert.equal(sanitized[3].status, "auth_required");
  assert.equal(sanitized[3].windows.length, 0);
});

test("reader preserves known providers and counts unsupported or malformed entries without leaking them", async () => {
  const base = fixture().providers[0];
  const malformed = [null, [], {},
    { ...base, provider: "future-provider", accountKey: "discarded-identity" },
    { ...base, windows: "bad" }, { ...base, windows: [{}] },
    { ...base, windows: Array(101).fill(base.windows[0]) },
    { ...base, state: null }, { ...base, quotaSemantics: null },
    { ...base, quotaSemantics: { ...base.quotaSemantics, effectiveAvailability: "bad" } },
    { ...base, quotaSemantics: { ...base.quotaSemantics, effectiveAvailability: [{}] } },
    { ...base, quotaSemantics: { ...base.quotaSemantics, effectiveAvailability: Array(101).fill(base.quotaSemantics.effectiveAvailability[0]) } },
  ];
  for (const entry of malformed) {
    const result = await createQuotaReader({ run: run({ schemaVersion: 6, providers: [entry, base] }) })();
    assert.equal(result.error, null);
    assert.equal(result.stale, false);
    assert.equal(result.unsupportedProviders, 1);
    assert.deepEqual(result.providers.map((p) => p.provider), ["codex"]);
    assert.equal(result.providers[0].windows[0].percentRemaining, 42);
    assert.doesNotMatch(JSON.stringify(result), /discarded-identity|future-provider|private|secret/);
  }
  const empty = await createQuotaReader({ run: run({ schemaVersion: 6, providers: malformed }) })();
  assert.deepEqual(empty.providers, []);
  assert.equal(empty.readAt, null);
  assert.equal(empty.ageMs, null);
  assert.equal(empty.stale, false);
  assert.equal(empty.error, "Quota unavailable: Quota response invalid");
  assert.doesNotMatch(JSON.stringify(empty), /discarded-identity|future-provider|private|secret/);
});

test("all-rejected refresh retains the last successful snapshot through later failures", async () => {
  let clock = 100000, calls = 0;
  const raw = fixture();
  raw.generatedAt = new Date(clock - 5000).toISOString();
  raw.providers.push({ provider: "future-provider", accountKey: "discarded-identity" });
  const reader = createQuotaReader({ now: () => clock, ttlMs: 1000, run: async () => {
    calls++;
    if (calls === 1) return run(raw)();
    if (calls === 2) return run({ schemaVersion: 6, providers: [{ provider: "codex", windows: [{}], error: "secret" }] })();
    throw new Error("secret failure");
  } });
  const reading = await reader();
  clock += 1000;
  const rejected = await reader();
  assert.deepEqual(rejected.providers, reading.providers);
  assert.equal(rejected.readAt, reading.readAt);
  assert.equal(rejected.capturedAt, reading.capturedAt);
  assert.equal(rejected.unsupportedProviders, reading.unsupportedProviders);
  assert.equal(rejected.ageMs, 6000);
  assert.equal(rejected.stale, true);
  assert.equal(rejected.error, "Quota refresh unavailable: Quota response invalid");
  clock += 400;
  assert.deepEqual(await reader(), { ...rejected, ageMs: 6400 });
  assert.equal(calls, 2, "invalid refreshes also respect the retry interval");
  clock += 600;
  const failed = await reader();
  assert.deepEqual(failed, { ...rejected, ageMs: 7000, error: "Quota refresh unavailable: Quota read failed" });
  assert.doesNotMatch(JSON.stringify([rejected, failed]), /discarded-identity|future-provider|secret/);
});

test("a genuinely empty provider response is successful and replaces an older snapshot", async () => {
  for (const startWithReading of [false, true]) {
    let clock = 100000, calls = 0;
    const reader = createQuotaReader({ now: () => clock, ttlMs: 1000, run: async () => {
      calls++;
      if (startWithReading && calls === 1) return run(fixture())();
      return run({ schemaVersion: 6, providers: [] })();
    } });
    if (startWithReading) {
      assert.equal((await reader()).providers.length, 1);
      clock += 1000;
    }
    const empty = await reader();
    assert.deepEqual(empty.providers, []);
    assert.equal(empty.unsupportedProviders, 0);
    assert.equal(empty.error, null);
    assert.equal(empty.stale, false);
    assert.equal(empty.readAt, new Date(clock).toISOString());
    assert.equal(empty.ageMs, 0);
  }
});

test("reader accepts muse and retains unsupported count across cache and stale refresh", async () => {
  let clock = 100000, fail = false;
  const raw = fixture();
  raw.providers.push({ ...structuredClone(raw.providers[0]), provider: "muse" }, {});
  const reader = createQuotaReader({ now: () => clock, ttlMs: 1000, run: async () => {
    if (fail) throw new Error("synthetic failure");
    return run(raw)();
  } });
  const reading = await reader();
  assert.deepEqual(reading.providers.map((p) => p.provider), ["codex", "muse"]);
  assert.equal(reading.unsupportedProviders, 1);
  assert.equal(reading.error, null);
  assert.equal((await reader()).unsupportedProviders, 1);
  clock += 1001;
  fail = true;
  const stale = await reader();
  assert.equal(stale.stale, true);
  assert.equal(stale.unsupportedProviders, 1);
  assert.deepEqual(stale.providers, reading.providers);
});

test("response and per-provider size limits remain bounded", () => {
  const base = fixture().providers[0];
  const bounded = { ...base, windows: Array(100).fill(base.windows[0]),
    quotaSemantics: { ...base.quotaSemantics, effectiveAvailability: Array(100).fill(base.quotaSemantics.effectiveAvailability[0]) } };
  const raw = { schemaVersion: 6, providers: Array(40).fill(bounded) };
  const result = sanitizeQuota(raw);
  assert.equal(result.length, 40);
  assert.equal(result[0].windows.length, 100);
  assert.equal(result[0].scopes.length, 100);
  raw.providers.push({ provider: "future-provider" });
  assert.throws(() => sanitizeQuota(raw), /schema/);
});

test("a newly returned old capture never resets successful reading age", async () => {
  const raw = fixture();
  raw.generatedAt = "2030-01-01T00:00:00Z";
  const captured = Date.parse(raw.generatedAt);
  let clock = captured + 2040000;
  const reader = createQuotaReader({ run: run(raw), now: () => clock });
  const first = await reader();
  assert.equal(first.ageMs, 2040000);
  clock += 60000;
  const reread = await reader();
  assert.equal(reread.ageMs, 2100000);
  assert.equal(reread.readAt, first.readAt);
});

test("configured reuse cannot exceed the five-minute actual-data refresh cadence", async () => {
  for (const [configured, expected, milliseconds] of [["7m", "5m", 300000], ["1h", "5m", 300000], ["30s", "30s", 30000]]) {
    let args;
    const result = await createQuotaReader({ maxAge: configured, execute: async (_command, input) => {
      args = input; return { stdout: JSON.stringify(fixture()) };
    } })();
    assert.equal(args.at(-1), expected);
    assert.equal(result.maxAgeMs, milliseconds);
  }
});
