import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validateAnswer } from "../bearings-answer.js";
import { BearingsUnavailable, MODEL_SCHEMA, contentRevision, createBearingsHub, createSnapshotRunner, normalizeSnapshot, publicText } from "../bearings.js";
import { createServer } from "../server.js";

const fixture = async (name) => JSON.parse(await readFile(new URL(`./fixtures/bearings/${name}.json`, import.meta.url), "utf8"));
const flush = () => new Promise((resolve) => setImmediate(resolve));

// Deterministic timers for the scheduler: nothing here waits on wall time.
function fakeClock(start = 10_000_000) {
  let now = start;
  let seq = 0;
  const tasks = new Set();
  const add = (fn, ms, every) => { const task = { id: ++seq, at: now + Math.max(0, ms), fn, every }; tasks.add(task); return task; };
  const timers = {
    setTimeout: (fn, ms) => add(fn, ms, 0), clearTimeout: (task) => { tasks.delete(task); },
    setInterval: (fn, ms) => add(fn, ms, ms), clearInterval: (task) => { tasks.delete(task); },
  };
  return {
    timers,
    now: () => now,
    pending: () => tasks.size,
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        await flush();
        const next = [...tasks].filter((task) => task.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        now = next.at;
        if (next.every) next.at += next.every; else tasks.delete(next);
        next.fn();
      }
      now = end;
      await flush();
    },
  };
}

function controlledRunner(initial) {
  const encode = (value) => value instanceof Error || typeof value === "string" ? value : JSON.stringify(value);
  let output = encode(initial);
  const calls = [];
  let gate = null;
  const runner = () => {
    calls.push(output);
    if (gate) return gate.promise.then(() => output);
    return output instanceof Error ? Promise.reject(output) : Promise.resolve(output);
  };
  return {
    runner, calls,
    set(value) { output = encode(value); },
    hold() { let release; gate = { promise: new Promise((resolve) => { release = resolve; }) }; return () => { const g = gate; gate = null; release(); return g; }; },
  };
}

test("normalizer keys calls, dedupes merges behind live decisions, and serves no paths", async () => {
  const content = normalizeSnapshot(await fixture("two-calls"));
  assert.deepEqual(content.cards.map((card) => card.key), ["decision:alpha-call", "decision:gamma-credential", "merge:beta-merge"]);
  const [alpha, gamma, merge] = content.cards;
  assert.equal(alpha.repo, "alpha-repo");
  assert.equal(alpha.summary, "Pick the alpha rollout window: Report: …/report.md");
  assert.equal(gamma.owner, "delta-mate");
  assert.equal(gamma.repo, null);
  assert.equal(merge.url, "https://example.invalid/synthetic/beta-repo/pull/7");
  assert.equal(merge.repo, "beta-repo");
  assert.equal(merge.checkedAt, "2026-01-02T03:00:00.000Z");
  for (const card of content.cards) assert.match(card.rev, /^[a-f0-9]{16}$/);
  assert.deepEqual(content.coverage, { known: 12, checked: 11, complete: false, provenClear: false, captainOmitted: 0, unmeasuredHomes: 0 });
  assert.deepEqual(content.omitted, [{ kind: "deferred-holds", count: 2 }]);
  assert.equal(content.generatedAt, "2026-01-02T03:04:05.000Z");
  assert.doesNotMatch(JSON.stringify(content), /\/srv\/|synthetic\/home/);
});

test("rich cards preserve full source asks and reasons, and link an exact decision subject", async () => {
  const raw = await fixture("two-calls");
  const ask = `Choose the release window. ${'Source context. '.repeat(60)}Recommended: staged — smaller blast radius. Alternative: immediate — faster delivery.`;
  const reason = `Review the change. ${'Review context. '.repeat(40)}Risk remains for older clients.`;
  raw.decisions_open[0].summary = ask;
  raw.contributions.captain.find(row => row.task === 'beta-merge').reason = reason;
  const decisionRow = raw.contributions.captain.find(row => row.task === 'alpha-call');
  decisionRow.url = 'https://example.invalid/acme/example-app/pull/42';
  const model = normalizeSnapshot(raw);
  assert.equal(model.cards[0].summary, ask);
  assert.equal(model.cards[0].url, decisionRow.url);
  assert.equal(model.cards.find(card => card.type === 'merge').reason, reason);
  assert.equal(model.cards.filter(card => card.task === 'alpha-call').length, 1);
  assert.equal(model.cards[0].options, undefined);
  assert.equal(model.cards[0].recommend_value, undefined);
  assert.equal(model.cards.find(card => card.type === 'merge').risk, undefined);
  const rev = model.cards[0].rev;
  raw.decisions_open[0].summary += ' Changed at the end.';
  assert.notEqual(normalizeSnapshot(raw).cards[0].rev, rev, 'changes beyond the former truncation boundary trigger a patch');
  decisionRow.url = 'https://user:secret@example.invalid/unsafe';
  assert.equal(normalizeSnapshot(raw).cards[0].url, null);
});

test("normalizer drops unsafe URLs and invalid rows with a disclosed count", async () => {
  const raw = await fixture("two-calls");
  raw.contributions.captain[0].url = "http://example.invalid/insecure";
  raw.decisions_open.push({ id: "../escape", summary: "bad id" }, { id: "no-summary" });
  const content = normalizeSnapshot(raw);
  assert.equal(content.cards.find((card) => card.type === "merge").url, null);
  assert.deepEqual(content.omitted.at(-1), { kind: "invalid-rows", count: 2 });
  assert.equal(publicText("see ~/private/tree/file.txt and /opt/a/b"), "see …/file.txt and …/b");
});

test("a decision with lettered lines offers those letters, and a card without them stays free text", async () => {
  const raw = await fixture("two-calls");
  const letters = "Choose the sample window.\na) Staged rollout — fewer users at once\nb) Ship now — faster delivery\nc) Wait — need another check";
  raw.decisions_open[0].summary = letters;
  raw.decisions_open[0].reason = "a) shorter\nb) list";
  const answer = normalizeSnapshot(raw).cards[0].answer;
  assert.deepEqual(answer.options, [
    { value: "a", label: "a", hint: "Staged rollout — fewer users at once" },
    { value: "b", label: "b", hint: "Ship now — faster delivery" },
    { value: "c", label: "c", hint: "Wait — need another check" },
  ]);
  assert.equal(answer.recommend, null);
  const model = { schema: "fm-quarterdeck-call.v1", rev: "model", state: "ready", ...normalizeSnapshot(raw) };
  const card = model.cards[0];
  assert.equal(validateAnswer({ requestId: "00000000-0000-4000-8000-000000000010", key: card.key, cardRev: card.rev, selection: "a", note: "" }, model).selection, "a");
  assert.throws(() => validateAnswer({ requestId: "00000000-0000-4000-8000-000000000010", key: card.key, cardRev: card.rev, selection: "z", note: "" }, model), /not offered/);
  raw.decisions_open[0].summary = "Provide the gamma sandbox credential";
  raw.decisions_open[0].reason = "No lettered choice is recorded.";
  assert.deepEqual(normalizeSnapshot(raw).cards[0].answer.options, []);
  raw.decisions_open[0].summary = "a) keep /srv/synthetic/workspace/data/secret\nb) drop the sample";
  delete raw.decisions_open[0].reason;
  const redacted = normalizeSnapshot(raw).cards[0].answer.options[0].hint;
  assert.equal(redacted.includes("synthetic"), false);
  assert.match(redacted, /secret/);
  raw.decisions_open[0].options = [{ value: "later", label: "Later" }];
  raw.decisions_open[0].summary = "a) staged\nb) now";
  assert.deepEqual(normalizeSnapshot(raw).cards[0].answer.options.map((option) => option.value), ["later"]);
  raw.decisions_open[0].options = [{ value: "reconcile", label: "Reconcile" }];
  assert.deepEqual(normalizeSnapshot(raw).cards[0].answer.options, []);
  raw.contributions.captain.find((row) => row.task === "beta-merge").reason = "a) merge it\nb) wait";
  assert.deepEqual(normalizeSnapshot(raw).cards.find((card) => card.type === "merge").answer.options.map((option) => option.value), ["merge"]);
});

test("content revision ignores the snapshot clock but follows every visible change", async () => {
  const raw = await fixture("two-calls");
  const before = normalizeSnapshot(raw);
  const later = normalizeSnapshot({ ...raw, generated: "2026-01-02T09:00:00Z" });
  assert.equal(contentRevision(later), contentRevision(before));
  assert.deepEqual(later.cards.map((card) => card.rev), before.cards.map((card) => card.rev));
  raw.decisions_open[1].summary = "Provide the rotated gamma sandbox credential";
  const changed = normalizeSnapshot(raw);
  assert.notEqual(contentRevision(changed), contentRevision(before));
  assert.equal(changed.cards[0].rev, before.cards[0].rev, "an untouched card keeps its revision");
  assert.notEqual(changed.cards[1].rev, before.cards[1].rev);
});

test("validation fails closed on an unrecognised projection", async () => {
  const raw = await fixture("two-calls");
  assert.throws(() => normalizeSnapshot({ ...raw, schema: "fm-bearings.v2" }), BearingsUnavailable);
  assert.throws(() => normalizeSnapshot({ ...raw, decisions_open: {} }), BearingsUnavailable);
  assert.throws(() => normalizeSnapshot({ ...raw, contributions: { ...raw.contributions, proven_clear: "no" } }), BearingsUnavailable);
  assert.throws(() => normalizeSnapshot([]), BearingsUnavailable);
});

async function syntheticHome(context, script) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-quarterdeck-bearings-"));
  context.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "bin"));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  if (script) {
    await writeFile(path.join(home, "bin", "fm-bearings-snapshot.sh"), `#!/usr/bin/env bash\n${script}\n`);
    await chmod(path.join(home, "bin", "fm-bearings-snapshot.sh"), 0o755);
  }
  return home;
}

test("runner invokes only the guarded snapshot with --json under FM_HOME and shares one run", async (context) => {
  const raw = await fixture("two-calls");
  const home = await syntheticHome(context, `echo "$# $*|$FM_HOME" >> "$FM_HOME/calls"\nsleep 0.2\ncat "$FM_HOME/fixture.json"`);
  await writeFile(path.join(home, "fixture.json"), JSON.stringify(raw));
  const run = createSnapshotRunner(home);
  const [first, second] = await Promise.all([run(), run()]);
  assert.equal(first, second);
  assert.equal(JSON.parse(first).schema, "fm-bearings.v1");
  assert.equal(await readFile(path.join(home, "calls"), "utf8"), `1 --json|${home}\n`);
});

test("runner bounds time and output and reports a missing or failing snapshot as unavailable", async (context) => {
  await assert.rejects(createSnapshotRunner(undefined)(), /FM_HOME is not configured/);
  await assert.rejects(createSnapshotRunner("relative/home")(), /must be absolute/);
  const missing = await syntheticHome(context, null);
  await assert.rejects(createSnapshotRunner(missing)(), /not installed/);
  const slow = await syntheticHome(context, "sleep 20 & wait");
  const started = Date.now();
  await assert.rejects(createSnapshotRunner(slow, { timeoutMs: 300 })(), /timed out/);
  assert.ok(Date.now() - started < 5000, "the whole process group is killed at the timeout");
  const noisy = await syntheticHome(context, "head -c 5000 /dev/zero | tr '\\0' x; sleep 20");
  await assert.rejects(createSnapshotRunner(noisy, { maxStdout: 1024 })(), /output too large/);
  const failing = await syntheticHome(context, "echo nope >&2; exit 4");
  await assert.rejects(createSnapshotRunner(failing)(), /exited 4/);
});

function hubFor(clock, source, options = {}) {
  let changed = null;
  let watching = 0;
  let print = "p0";
  const hub = createBearingsHub({ runner: source.runner, now: clock.now, timers: clock.timers, fingerprint: async () => print,
    watchRecords: (onChange) => { watching += 1; changed = onChange; return () => { watching -= 1; changed = null; }; }, ...options });
  return { hub, change: () => changed?.("data"), watching: () => watching, setPrint: (value) => { print = value; } };
}

test("scheduler never runs without a watcher and serves the cache immediately to the first one", async () => {
  const clock = fakeClock();
  const source = controlledRunner(await fixture("two-calls"));
  const { hub, change, watching } = hubFor(clock, source);
  hub.request();
  await clock.advance(30 * 60_000);
  assert.equal(source.calls.length, 0, "zero runs with no subscribers");
  assert.equal(watching(), 0);
  assert.equal(hub.current().state, "loading");
  assert.equal(hub.current().schema, MODEL_SCHEMA);

  const events = [];
  const unsubscribe = hub.subscribe((event) => events.push(event));
  await clock.advance(0);
  assert.equal(source.calls.length, 1);
  assert.equal(events.at(-1).type, "model");
  assert.equal(hub.current().cards.length, 3);
  unsubscribe();
  assert.equal(watching(), 0, "the last watcher leaving stops the watchers");
  change();
  await clock.advance(30 * 60_000);
  assert.equal(source.calls.length, 1);
  assert.equal(clock.pending(), 0, "no timers survive the last watcher");

  // A returning watcher within a minute is served the cache without a new run.
  const fresh = fakeClock();
  const again = controlledRunner(await fixture("two-calls"));
  const second = hubFor(fresh, again);
  second.hub.subscribe(() => {})();
  await fresh.advance(0);
  await fresh.advance(40_000);
  second.hub.subscribe(() => {});
  await fresh.advance(0);
  assert.equal(again.calls.length, 1);
});

test("record changes are debounced, rate-limited by the minimum gap, and pushed only when calls change", async () => {
  const clock = fakeClock();
  const raw = await fixture("two-calls");
  const source = controlledRunner(raw);
  const { hub, change } = hubFor(clock, source, { minGapMs: 30000 });
  const events = [];
  hub.subscribe((event) => events.push(event.type));
  await clock.advance(0);
  assert.equal(source.calls.length, 1);

  change(); change(); change();
  await clock.advance(2000);
  assert.equal(source.calls.length, 1, "a change inside the minimum gap waits");
  await clock.advance(28000);
  assert.equal(source.calls.length, 2, "it runs once the gap opens");
  assert.deepEqual(events, ["model", "observed"], "an unchanged Captain's Call is not pushed as a model");

  raw.decisions_open.pop();
  source.set(raw);
  change();
  await clock.advance(2000);
  assert.equal(source.calls.length, 2);
  await clock.advance(30000);
  assert.equal(source.calls.length, 3);
  assert.equal(events.at(-1), "model");
  assert.equal(hub.current().cards.length, 2);
  assert.ok(hub.stats().minGapMs >= 15000);
  assert.equal(createBearingsHub({ runner: source.runner, minGapMs: "1000" }).stats().minGapMs, 15000, "the gap has a 15 s floor");
});

test("one run at a time: a trigger during a run queues exactly one follow-up", async () => {
  const clock = fakeClock();
  const source = controlledRunner(await fixture("two-calls"));
  const release = source.hold();
  const { hub, change } = hubFor(clock, source, { minGapMs: 15000 });
  hub.subscribe(() => {});
  await clock.advance(0);
  assert.equal(hub.stats().running, true);
  change();
  await clock.advance(20000);
  change();
  await clock.advance(20000);
  assert.equal(source.calls.length, 1, "no overlapping run");
  release();
  await clock.advance(0);
  await clock.advance(0);
  assert.equal(source.calls.length, 2, "one follow-up after the run");
  await clock.advance(60000);
  assert.equal(source.calls.length, 2);
});

test("the age ceiling and the stat fingerprint refresh calls while watched", async () => {
  const clock = fakeClock();
  const source = controlledRunner(await fixture("two-calls"));
  const { hub, setPrint } = hubFor(clock, source, { maxAgeMs: 300000 });
  hub.subscribe(() => {});
  await clock.advance(0);
  await clock.advance(290000);
  assert.equal(source.calls.length, 1);
  await clock.advance(10000);
  assert.equal(source.calls.length, 2, "ceiling reached");
  setPrint("p1");
  await clock.advance(10000);
  await clock.advance(2000);
  await clock.advance(30000);
  assert.equal(source.calls.length, 3, "fingerprint change triggers a run without fs.watch");
});

test("the record watch reacts to backlog.md and *.meta only, never to other state files", async (context) => {
  const home = await syntheticHome(context, null);
  await mkdir(path.join(home, "state", "secondmate-summary-cache"));
  const clock = fakeClock();
  const source = controlledRunner(await fixture("two-calls"));
  const hub = createBearingsHub({ home, runner: source.runner, fingerprint: null, now: clock.now, timers: clock.timers });
  context.after(() => hub.close());
  hub.subscribe(() => {});
  await clock.advance(0);
  assert.equal(source.calls.length, 1);
  const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 150)); await clock.advance(40000); };
  await writeFile(path.join(home, "state", "alpha.status"), "working\n");
  await writeFile(path.join(home, "state", "alpha.turn-ended"), "1\n");
  await writeFile(path.join(home, "state", "secondmate-summary-cache", "beta.meta"), "x\n");
  await writeFile(path.join(home, "data", "projects.md"), "- Alpha\n");
  await settle();
  assert.equal(source.calls.length, 1, "unrelated and nested writes are ignored");
  await writeFile(path.join(home, "state", "alpha.meta"), "pr=https://example.invalid/p/1\n");
  await settle();
  assert.equal(source.calls.length, 2);
  await writeFile(path.join(home, "data", "backlog.md"), "# Backlog\n");
  await settle();
  assert.equal(source.calls.length, 3);
});

test("30 minutes of default cadence: quiet, churning, then backgrounded", async () => {
  const quiet = fakeClock();
  const still = controlledRunner(await fixture("two-calls"));
  hubFor(quiet, still).hub.subscribe(() => {});
  await quiet.advance(30 * 60_000);
  assert.equal(still.calls.length, 7, "first watcher plus one ceiling run every 5 min");

  // Records change every 5 s for 30 min, then the only tab goes to the background.
  const busy = fakeClock();
  const churn = controlledRunner(await fixture("two-calls"));
  const { hub, change } = hubFor(busy, churn);
  const leave = hub.subscribe(() => {});
  for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += 5000) { change(); await busy.advance(5000); }
  assert.ok(churn.calls.length <= 61, `${churn.calls.length} runs is within the 30 s gap budget`);
  assert.ok(churn.calls.length >= 55, "steady churn keeps calls current");
  leave();
  const foreground = churn.calls.length;
  for (let elapsed = 0; elapsed < 30 * 60_000; elapsed += 5000) { change(); await busy.advance(5000); }
  assert.equal(churn.calls.length, foreground, "no runs while nobody watches");
  assert.equal(busy.pending(), 0);
});

test("a poll counts as a watcher only for its time-to-live", async () => {
  const clock = fakeClock();
  const source = controlledRunner(await fixture("two-calls"));
  const { hub, watching } = hubFor(clock, source);
  hub.touch();
  await clock.advance(0);
  assert.equal(source.calls.length, 1);
  assert.equal(watching(), 1);
  await clock.advance(70000);
  assert.equal(watching(), 0, "an abandoned poller stops the scheduler");
  await clock.advance(30 * 60_000);
  assert.equal(source.calls.length, 1);
});

test("a failed run keeps the last good calls and marks them stale; never blanks them", async () => {
  const clock = fakeClock();
  const source = controlledRunner(await fixture("two-calls"));
  const { hub, change } = hubFor(clock, source);
  const events = [];
  hub.subscribe((event) => events.push(event));
  await clock.advance(0);
  const good = hub.current();
  source.set("not json");
  change();
  await clock.advance(32000);
  assert.equal(hub.current().state, "stale");
  assert.equal(hub.current().stale, true);
  assert.equal(hub.current().error, "Bearings output is not JSON");
  assert.deepEqual(hub.current().cards, good.cards);
  assert.equal(events.at(-1).type, "observed");
  assert.equal(events.at(-1).stale, true);

  const cold = fakeClock();
  const broken = controlledRunner(new BearingsUnavailable("Firstmate bearings snapshot is not installed"));
  const empty = hubFor(cold, broken);
  empty.hub.subscribe(() => {});
  await cold.advance(0);
  assert.equal(empty.hub.current().state, "unavailable");
  assert.equal(empty.hub.current().error, "Firstmate bearings snapshot is not installed");
  assert.deepEqual(empty.hub.current().cards, []);
});

// ---- HTTP: cached read, ?since catch-up and the SSE stream ----

function streamClient(port, headers = {}, pathName = "/api/bearings/stream") {
  const events = [];
  const waiters = [];
  let buffer = "";
  let ended = false;
  let response;
  const deliver = () => { for (const waiter of [...waiters]) if (waiter.test()) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(); } };
  const request = http.get({ host: "127.0.0.1", port, path: pathName, headers }, (stream) => {
    response = stream;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = { comment: block.startsWith(":"), raw: block };
        for (const line of block.split("\n")) {
          const [, field, value] = /^([a-z]+): ?(.*)$/.exec(line) || [];
          if (field === "event") event.event = value;
          if (field === "id") event.id = value;
          if (field === "retry") event.retry = Number(value);
          if (field === "data") event.data = JSON.parse(value);
        }
        events.push(event);
      }
      deliver();
    });
    stream.on("end", () => { ended = true; deliver(); });
  });
  request.on("error", () => {});
  return {
    events,
    get status() { return response?.statusCode; },
    get headers() { return response?.headers; },
    get ended() { return ended; },
    until(test, label = "stream condition") {
      if (test()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 3000);
        waiters.push({ test, resolve: () => { clearTimeout(timer); resolve(); } });
      });
    },
    stop() { response?.destroy(); request.destroy(); },
  };
}

async function liveServer(context, { revision = "a".repeat(40), snapshot, source, clock, options = {} } = {}) {
  const hubSource = source || controlledRunner(await fixture("two-calls"));
  const hub = createBearingsHub({ runner: hubSource.runner, watchRecords: null, fingerprint: null, ...(clock ? { now: clock.now, timers: clock.timers } : {}) });
  let head = revision;
  const server = createServer({}, { revisionResolver: { initial: revision, snapshot: snapshot || (async () => head) }, bearingsSource: hub, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  return { server, hub, source: hubSource, port: server.address().port, base: `http://127.0.0.1:${server.address().port}`, moveHead: (value) => { head = value; } };
}

test("GET /api/bearings serves the cached model, ?since answers unchanged, and no path leaks", async (context) => {
  const { base, hub } = await liveServer(context);
  const first = await (await fetch(`${base}/api/bearings`)).json();
  assert.equal(first.schema, MODEL_SCHEMA);
  assert.equal(first.state, "loading", "the read never waits for a snapshot run");
  await new Promise((resolve) => setTimeout(resolve, 20));
  const model = await (await fetch(`${base}/api/bearings`)).json();
  assert.equal(model.state, "ready");
  assert.equal(model.cards.length, 3);
  assert.doesNotMatch(JSON.stringify(model), /\/srv\/|synthetic\/home/);
  const unchanged = await (await fetch(`${base}/api/bearings?since=${model.rev}`)).json();
  assert.deepEqual(Object.keys(unchanged).sort(), ["checkedAt", "error", "firstmateActivity", "observedAt", "rev", "stale", "state", "unchanged"]);
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.firstmateActivity.lastTurnAt, null);
  assert.ok(Number.isFinite(Date.parse(unchanged.firstmateActivity.readAt)));
  const changed = await (await fetch(`${base}/api/bearings?since=outdated`)).json();
  assert.equal(changed.cards.length, 3);
  assert.equal(hub.stats().runs, 1);
});

test("the stream says hello, sends the model unless Last-Event-ID matches, then pushes changes and freshness", async (context) => {
  const raw = await fixture("two-calls");
  const source = controlledRunner(raw);
  const clock = fakeClock(Date.now());
  const { port, hub } = await liveServer(context, { source, clock });
  const client = streamClient(port);
  context.after(() => client.stop());
  await client.until(() => client.events.some((event) => event.event === "model" && event.data.state === "ready"), "ready model");
  assert.equal(client.status, 200);
  assert.match(client.headers["content-type"], /^text\/event-stream/);
  assert.equal(client.headers["content-encoding"], undefined, "event streams are never gzipped");
  assert.equal(client.events[0].retry, 3000);
  assert.deepEqual(client.events[1], { comment: false, raw: client.events[1].raw, event: "hello", data: { servedCommit: "a".repeat(40) } });
  const ready = client.events.find((event) => event.event === "model" && event.data.state === "ready");
  assert.equal(ready.id, ready.data.rev);

  const resumed = streamClient(port, { "last-event-id": hub.current().rev });
  context.after(() => resumed.stop());
  await resumed.until(() => resumed.events.length >= 3, "resumed hello");
  assert.deepEqual(resumed.events.slice(1, 3).map((event) => event.event), ["hello", "observed"], "a client already holding this revision gets no model");

  // Same calls on the next run: only freshness is pushed.
  const before = client.events.length;
  hub.request();
  await clock.advance(32000);
  await client.until(() => client.events.length > before, "observed after an unchanged run");
  assert.deepEqual(client.events.slice(before).map((event) => event.event), ["observed"]);
  assert.equal(client.events.at(-1).data.rev, ready.data.rev);

  raw.decisions_open.pop();
  source.set(raw);
  hub.request();
  await clock.advance(32000);
  await client.until(() => client.events.at(-1).event === "model", "changed model");
  const pushed = client.events.at(-1);
  assert.equal(pushed.data.cards.length, 2);
  assert.equal(pushed.id, pushed.data.rev);
  assert.notEqual(pushed.data.rev, ready.data.rev);
  assert.equal(hub.stats().runs, 3);
  resumed.stop();
  client.stop();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(hub.stats().subscribers, 0, "closed streams unsubscribe");
  assert.equal(hub.stats().active, false, "and the scheduler stops with the last one");
});

test("a served-revision change mid-stream sends event: revision and closes", async (context) => {
  const { port, moveHead } = await liveServer(context, { options: { bearingsStream: { heartbeatMs: 40 } } });
  const client = streamClient(port);
  context.after(() => client.stop());
  await client.until(() => client.events.some((event) => event.event === "observed" && event.data.firstmateActivity), "activity heartbeat");
  assert.equal(client.events.find((event) => event.event === "observed").data.firstmateActivity.lastWakeAt, null);
  moveHead("b".repeat(40));
  await client.until(() => client.ended, "stream end");
  assert.equal(client.events.at(-1).event, "revision");
});

test("streams are capped, recycled, refused through preview paths, and ended by server.close", async (context) => {
  const { port, server, base } = await liveServer(context, { options: { bearingsStream: { maxStreams: 2, recycleMs: 150 } } });
  const a = streamClient(port);
  const b = streamClient(port);
  context.after(() => { a.stop(); b.stop(); });
  await a.until(() => a.events.length >= 2, "first stream");
  await b.until(() => b.events.length >= 2, "second stream");
  const refused = await fetch(`${base}/api/bearings/stream`);
  assert.equal(refused.status, 503);
  await a.until(() => a.ended, "recycled stream");
  assert.equal(a.events.at(-1).event, "bye");
  const preview = await fetch(`${base}/preview/main/api/bearings/stream`);
  assert.equal(preview.status, 404);

  const c = streamClient(port);
  await c.until(() => c.events.length >= 2, "third stream");
  await new Promise((resolve) => server.close(resolve));
  await c.until(() => c.ended, "server.close ends open streams instead of hanging");
  assert.equal(c.events.at(-1).event, "bye");
});
