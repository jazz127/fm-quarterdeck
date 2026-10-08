import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { createAgentStateOwner, emptyAgentState, validateAgentState, fingerprint } from "../agent-state.js";
import { classifyCurrent, projectWork, verifyDurability, endpointIsLive, executionFingerprint, hasProcessIdentity, shouldProbeLiveness, createConcurrencyLimiter, foldStatusLines } from "../work-model.js";
import { createServer, loadFirstmateHome } from "../server.js";
const lab = path.resolve(import.meta.dirname, "../../.taxonomy-lab");
async function temporary(context) { await mkdir(lab, { recursive: true }); const dir = await mkdtemp(path.join(lab, "test-")); context.after(() => rm(dir, { recursive: true, force: true })); return dir; }
const taxonomy = () => ({ ...emptyAgentState(), repositories: [{ id: "repo", name: "Product", path: "/synthetic/product", lanes: [{ id: "ui", name: "Interface", themes: [{ id: "r1", name: "Review", kind: "iteration" }] }] }] });
const record = (extras = {}) => ({ id: "arbitrary-hyphenated-task", name: "Does not imply a lane", repositoryPath: "/synthetic/product", state: "done", completionIdentity: { line: "done [at=1]: ready", occurrence: 2 }, ...extras });

test("explicit taxonomy validation refuses dangling assignments, duplicates and paths in labels", () => {
  assert.equal(validateAgentState(taxonomy()).repositories.length, 1);
  for (const mutate of [(s) => s.repositories.push(s.repositories[0]), (s) => s.repositories[0].lanes[0].name = "/private/path", (s) => s.repositories[0].lanes[0].themes[0].kind = "epic", (s) => s.assignments[fingerprint("task")] = { repositoryId: "repo", laneId: "missing", themeId: "r1" }, (s) => s.secret = "credential"]) { const state = taxonomy(); mutate(state); assert.throws(() => validateAgentState(state)); }
});

test("current-state classification separates an active review run and preserves captain action", () => {
  const input = { inFlight: true, endpointLive: true, state: "working" };
  assert.equal(classifyCurrent(input), "active");
  for (const [extras, expected] of [[{ state: "done" }, "newly-done"], [{ state: "paused" }, "waiting"], [{ state: "blocked" }, "waiting"], [{ state: "needs-decision" }, "captain-action"], [{ retained: true }, "cleanup"], [{ endpointLive: false }, "unknown"], [{ endpointLive: null }, "unknown"], [{ inFlight: false }, "unknown"], [{ queued: true, inFlight: false }, "backlog"], [{ state: "paused", reviewRun: true }, "review"], [{ state: "working", reviewRun: true, pendingIssues: [{ state: "needs-decision" }] }, "captain-action"]]) assert.equal(classifyCurrent({ ...input, ...extras }), expected);
});

test("review run signal classifies current task records and contributes hierarchy counts", async (context) => {
  const home = await temporary(context); await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Product - Product work\n");
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] review-task - Work (repo: /synthetic/product)\n");
  await writeFile(path.join(home, "state/review-task.meta"), "project=/synthetic/product\nvalidation_state=validating (running)\n");
  await writeFile(path.join(home, "state/review-task.status"), "paused [at=1]: waiting for review pipeline\n");
  const owner = createAgentStateOwner(path.join(home, "quarterdeck-state.json"));
  const split = await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] });
  assert.equal(split.workSplit.items[0].status, "review");
  assert.equal(split.workSplit.counts.review, 1);
  assert.equal(split.workSplit.repositories[0].counts.review, 1);
  assert.equal(split.workSplit.repositories[0].lanes[0].themes[0].counts.review, 1);
  const vmContext = { window: {} }; vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), vmContext);
  assert.equal(vmContext.window.workHierarchy.statusLabels.review, "In review");
  assert.equal(vmContext.window.workHierarchy.statusConciseLabels.review, "In review");
  assert.equal(vmContext.window.workHierarchy.statusAbbreviations.review, "V");
  assert.equal(vmContext.window.workHierarchy.statusCounts(split.workSplit.items).review, 1);
  await writeFile(path.join(home, "state/review-task.meta"), "project=/synthetic/product\n");
  await writeFile(path.join(home, "state/review-task.status"), "paused [at=2]: validation pipeline waiting at review gate\n");
  assert.equal((await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] })).workSplit.items[0].status, "review", "status-line review signal works without a metadata marker");
  await writeFile(path.join(home, "state/review-task.status"), "paused [at=3]: waiting for an external dependency\n");
  assert.equal((await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] })).workSplit.items[0].status, "waiting", "ordinary waits are not review runs");
  await writeFile(path.join(home, "state/review-task.meta"), "project=/synthetic/product\nvalidation_state=validating (running)\n");
  await writeFile(path.join(home, "state/review-task.status"), "needs-decision [at=4]: choose a route\n");
  assert.equal((await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] })).workSplit.items[0].status, "captain-action", "captain decisions retain precedence");
});

test("only explicit review or validation pipeline text promotes work status and hierarchy counts", async (context) => {
  const home = await temporary(context); await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Product - Product work\n");
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] pipeline-task - Work (repo: /synthetic/product)\n");
  await writeFile(path.join(home, "state/pipeline-task.meta"), "project=/synthetic/product\n");
  const owner = createAgentStateOwner(path.join(home, "quarterdeck-state.json"));
  const vmContext = { window: {} }; vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), vmContext);
  for (const [text, reviewCount] of [
    ["deployment pipeline running", 0],
    ["deployment pipeline in progress", 0],
    ["deployment pipeline waiting at a gate", 0],
    ["pipeline review running", 1],
    ["pipeline validation in progress", 1],
  ]) {
    for (const [state, ordinaryStatus] of [["paused", "waiting"], ["waiting", "waiting"], ["working", "unknown"], ["active", "unknown"], ["in-progress", "unknown"]]) {
      await writeFile(path.join(home, "state/pipeline-task.status"), `${state} [at=1]: ${text}\n`);
      const { workSplit } = await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] });
      assert.equal(workSplit.items[0].status, reviewCount ? "review" : ordinaryStatus, `${state}: ${text}`);
      const repository = workSplit.repositories[0], lane = repository.lanes[0], theme = lane.themes[0];
      for (const counts of [workSplit.counts, repository.counts, lane.counts, theme.counts, vmContext.window.workHierarchy.statusCounts(workSplit.items)]) {
        assert.equal(counts.review, reviewCount, `${state}: ${text}`);
      }
    }
  }
});

test("liveness probes are gated to executing in-flight work and bounded concurrently", async () => {
  assert.equal(shouldProbeLiveness("working", true), true);
  for (const state of ["done", "paused", "blocked", "waiting", "unknown"]) assert.equal(shouldProbeLiveness(state, true), false);
  assert.equal(shouldProbeLiveness("working", false), false);
  const limit = createConcurrencyLimiter(2);
  let active = 0, maximum = 0;
  await Promise.all(Array.from({ length: 8 }, () => limit(async () => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
  })));
  assert.equal(maximum, 2);
  assert.equal(active, 0);
  assert.throws(() => createConcurrencyLimiter(0), /positive integer/);
});

test("taxonomy is three levels with explicit fallback, distinct repositories and no duplicate slices", async () => {
  const state = taxonomy(); const r = record(); const task = fingerprint("task.v1", r.repositoryPath, r.id);
  state.assignments[task] = { repositoryId: "repo", laneId: "ui", themeId: "r1" };
  const model = await projectWork([r, record({ id: "unknown", repositoryPath: null }), record({ id: "legacy", repositoryPath: "/other/product", workGroup: { kind: "theme", name: "Explicit legacy" } })], state);
  assert.equal(model.repositories.length, 3, "same basename is never repository identity");
  assert.equal(model.repositories[0].lanes[0].themes[0].items[0].id, r.id);
  assert.equal(model.items[1].lane.id, "unclassified");
  assert.equal(model.items[1].repositoryId, "unknown");
  assert.equal(model.items[2].lane.id, "unclassified");
  assert.equal(model.items[2].theme.legacy, true);
  assert.equal(new Set(model.items.map((item) => item.taskFingerprint)).size, 3);
  assert.equal(JSON.stringify(model).includes("/synthetic/product"), false);
  const context = { window: {} }; vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), context);
  const tree = context.window.workHierarchy.groupHierarchy(model.items);
  assert.equal(tree[0].lanes.get("ui").themes.get("r1").items.length, 1);
});

test("acknowledgements persist atomically across owners and renew for exact completion or commit", async (context) => {
  const dir = await temporary(context); const file = path.join(dir, "state.json");
  const owner = createAgentStateOwner(file); await owner.update((state) => Object.assign(state, taxonomy()));
  const first = (await projectWork([record()], await owner.read())).items[0];
  const replies = await Promise.all([owner, createAgentStateOwner(file), owner].map((reader) => reader.acknowledge(first.taskFingerprint, first.completionFingerprint)));
  assert.equal(new Set(replies.map((reply) => reply.acknowledgedAt)).size, 1);
  assert.equal(Object.keys((await createAgentStateOwner(file).read()).acknowledgements).length, 1);
  const refreshed = (await projectWork([record()], await owner.read())).items[0];
  assert.equal(refreshed.status, "previously-done"); assert.equal(refreshed.delivery, "Ready for review · deployment unknown");
  assert.equal(refreshed.evidence[0].badge, "acknowledged");
  for (const next of [record({ completionIdentity: { line: "done [at=2]: ready", occurrence: 4 } }), record({ commit: "a".repeat(40) })]) assert.equal((await projectWork([next], await owner.read(), { durability: async () => [] })).items[0].status, "newly-done");
  await writeFile(file, "malformed"); await assert.rejects(owner.acknowledge(first.taskFingerprint, first.completionFingerprint));
  assert.equal(await readFile(file, "utf8"), "malformed", "never overwrite unreadable state");
});

test("remote containment must verify actual advertised head; merge is not live deployment", async () => {
  const commit = "a".repeat(40), head = "b".repeat(40), repo = { path: "/synthetic", github: "owner/product" };
  const calls = [];
  const run = async (command, args) => { calls.push([command, ...args]);
    if (command === "git" && args[0] === "ls-remote") return { stdout: `${head}\t${args.at(-1)}\n` };
    if (command === "git" && args[0] === "merge-base") return { stdout: "" };
    return { stdout: JSON.stringify({ merged: true, merged_at: "2030-01-01T00:00:00Z", merge_commit_sha: commit, base: { repo: { full_name: repo.github }, ref: "main" }, html_url: "https://github.com/owner/product/pull/1" }) };
  };
  const evidence = await verifyDurability(repo, commit, 1, run);
  assert.deepEqual(evidence.map((entry) => entry.badge), ["remote Main", "remote UAT", "merged PR"]);
  assert.ok(calls.some((args) => args.join(" ") === `git merge-base --is-ancestor ${commit} ${head}`));
  assert.ok(!calls.some((args) => args.some((arg) => ["fetch", "push", "checkout"].includes(arg))));
  const model = await projectWork([record({ commit })], taxonomy(), { durability: async () => evidence });
  assert.equal(model.items[0].status, "previously-done"); assert.match(model.items[0].delivery, /deployment unknown/);
  assert.deepEqual(await verifyDurability(repo, commit, null, async () => { throw new Error("stale local head / unavailable actual remote"); }), []);
  assert.deepEqual(await verifyDurability(repo, "uat-ready", 1, run), []);
});

test("live UAT and production require configured destination plus exact successful deployment", async () => {
  const commit = "a".repeat(40); const repo = { path: "/synthetic", github: "owner/product", destinations: [{ environment: "Review UAT", tier: "uat" }, { environment: "Production", tier: "production" }] };
  const run = async (command, args) => {
    if (command === "git") throw new Error("No remote containment");
    if (args[1].includes("/deployments?")) return { stdout: JSON.stringify(args[1].includes("environment=Production") ? [{ id: 2, sha: "b".repeat(40), environment: "Production" }] : [{ id: 1, sha: commit, environment: "Review UAT" }]) };
    return { stdout: JSON.stringify([{ id: 3, state: "success", environment: "Review UAT" }]) };
  };
  const evidence = await verifyDurability(repo, commit, null, run);
  assert.deepEqual(evidence.map((entry) => entry.badge), ["Live UAT"]);
  const model = await projectWork([record({ commit })], taxonomy(), { durability: async () => evidence });
  assert.match(model.items[0].delivery, /Live UAT · ready for review/);
  assert.equal(model.items[0].status, "previously-done");
  assert.deepEqual(await verifyDurability({ ...repo, destinations: [] }, commit, null, run), [], "unconfigured deployments cannot prove live");
});

test("genuine-active review threshold and Linux liveness retain exact incarnation checks", async () => {
  const boot = "a".repeat(36), proc = `76114 (node test) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 4242 19`;
  const read = async (file) => {
    if (file === "/proc/sys/kernel/random/boot_id") return boot;
    if (file === "/proc/76114/stat") return proc;
    const error = new Error("No such process"); error.code = "ENOENT"; throw error;
  };
  const meta = { worker_pid: "76114", worker_start_ticks: "4242", worker_boot_id: boot };
  assert.equal(await endpointIsLive(meta, { platform: "linux", read }), true);
  assert.equal(await endpointIsLive({ ...meta, worker_start_ticks: "1" }, { platform: "linux", read }), false);
  assert.equal(await endpointIsLive({ ...meta, worker_boot_id: "0".repeat(36) }, { platform: "linux", read }), false);
  assert.equal(await endpointIsLive({ worker_pid: "76114" }, { platform: "linux", read }), null);
  assert.equal(await endpointIsLive(meta, { platform: "freebsd", read }), null);
  const rows = Array.from({ length: 9 }, (_, i) => record({ id: `slice-${i}`, state: "working", inFlight: true, endpointLive: true }));
  assert.equal((await projectWork(rows, emptyAgentState())).activeReviewRequired, true);
  assert.equal((await projectWork(rows.map((row) => ({ ...row, state: "done" })), emptyAgentState())).activeReviewRequired, false);
  const shared = await projectWork(rows.map((row) => ({ ...row, executionFingerprint: "same-incarnation" })), emptyAgentState());
  assert.equal(shared.activeWorkerCount, 1);
  assert.equal(shared.activeReviewRequired, false, "one endpoint copied into nine slices is not nine concurrent workers");
});

test("macOS liveness matches recorded process start identity and distinguishes dead and reused PIDs", async (context) => {
  const originalTimezone = process.env.TZ;
  const originalLocale = process.env.LC_ALL;
  process.env.TZ = "Australia/Brisbane";
  process.env.LC_ALL = "de_DE.UTF-8";
  context.after(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    if (originalLocale === undefined) delete process.env.LC_ALL;
    else process.env.LC_ALL = originalLocale;
  });
  const pid = "76114", lstart = "Sat Oct  3 16:33:10 2026", identity = "2026-10-03T16:33:10.000Z";
  const meta = { worker_pid: pid, worker_start_identity: identity };
  const ps = async (command, args, options) => {
    assert.equal(command, "ps"); assert.equal(options.timeout, 2500);
    assert.deepEqual(args, ["-o", "lstart=", "-o", "stat=", "-p", pid]);
    assert.equal(options.env?.TZ, "UTC", "the ps timestamp uses UTC even when the host uses Brisbane time");
    return { stdout: `${options.env?.LC_ALL === "C" ? lstart : "Sa Okt  3 16:33:10 2026"} S\n` };
  };
  assert.equal(await endpointIsLive(meta, { platform: "darwin", run: ps }), true, "the UTC ps fixture matches the recorded absolute instant on a non-UTC host");
  assert.equal(await endpointIsLive({ worker_pid: pid, worker_start_identity: "2026-10-03T16:33:10" }, { platform: "darwin", run: ps }), null, "a timezone-less timestamp cannot identify an absolute process start");
  assert.equal(await endpointIsLive({ worker_pid: pid, worker_started_at: "2026-10-03T16:33:10" }, { platform: "darwin", run: ps }), null, "the legacy timestamp field also requires an explicit timezone");
  assert.equal(executionFingerprint({ worker_pid: pid, worker_start_identity: "2026-10-03T16:33:10" }, true), null);
  assert.equal(hasProcessIdentity({ worker_pid: pid }), true);
  assert.equal(hasProcessIdentity({ worker_pid: "", worker_start_identity: null }), false);
  assert.equal(await endpointIsLive({ ...meta, worker_start_identity: "2026-10-03T06:33:10.000Z" }, { platform: "darwin", run: ps }), false, "interpreting the UTC ps timestamp as Brisbane local time must not match");
  assert.equal(await endpointIsLive({ ...meta, worker_start_identity: "2020-01-01T00:00:00Z" }, { platform: "darwin", run: ps }), false, "a reused PID with another start time is not the same incarnation");
  assert.equal(await endpointIsLive(meta, { platform: "darwin", run: async () => ({ stdout: "" }) }), false);
  assert.equal(await endpointIsLive({ worker_pid: pid }, { platform: "darwin", run: ps }), null, "a PID without recorded incarnation remains unknown");
  let paneFallbackCalls = 0;
  const withPane = { ...meta, backend: "herdr", herdr_session: "default", herdr_pane_id: "w1:p2" };
  assert.equal(await endpointIsLive(withPane, { platform: "darwin", run: async (...args) => { if (args[0] === "ps") return ps(...args); paneFallbackCalls++; return { stdout: "" }; } }), true);
  assert.equal(paneFallbackCalls, 0, "process identity remains preferred to pane fallback");
  assert.equal(executionFingerprint(meta, true), fingerprint("execution.v1", null, pid, identity));
  for (const [stat, expected] of [["S", true], ["SX", true], ["SX+", true], ["R<X", true], ["TX", true], ["Z", false], ["ZX+", false], ["X", false]]) {
    const endpointLive = await endpointIsLive(meta, { platform: "darwin", run: async () => ({ stdout: `${lstart} ${stat}\n` }) });
    assert.equal(endpointLive, expected, `${stat} is classified by its primary state, not its tracing modifier`);
    const execution = executionFingerprint(meta, endpointLive);
    assert.equal(execution, expected ? fingerprint("execution.v1", null, pid, identity) : null);
    const model = await projectWork([record({ state: "working", inFlight: true, endpointLive, executionFingerprint: execution })], emptyAgentState());
    assert.equal(model.activeWorkerCount, expected ? 1 : 0);
    assert.equal(model.items[0].endpointEvidence, expected ? "live process incarnation" : "endpoint not live");
  }
  const starts = [
    { worker_start_identity: identity },
    { worker_start_identity: "2026-10-04T02:33:10+10:00" },
    { worker_start_identity: "2026-10-03T16:33:10Z" },
    { worker_start_identity: "2026-10-03T16:33:10.999Z" },
    { worker_started_at: identity },
    { worker_started_at: "2026-10-04T02:33:10+10:00" },
    { worker_started_at: "2026-10-03T16:33:10Z" },
    { worker_started_at: "2026-10-03T16:33:10.999Z" },
    { worker_start_identity: identity, worker_started_at: "2020-01-01T00:00:00Z" }
  ];
  const rows = [];
  for (const [index, start] of starts.entries()) {
    const worker = { worker_pid: pid, ...start };
    const endpointLive = await endpointIsLive(worker, { platform: "darwin", run: ps });
    assert.equal(endpointLive, true);
    const execution = executionFingerprint(worker, endpointLive);
    assert.equal(execution, fingerprint("execution.v1", null, pid, identity), "all spellings of the verified start second share the canonical UTC fingerprint");
    rows.push(record({ id: `slice-${index}`, state: "working", inFlight: true, endpointLive, executionFingerprint: execution }));
  }
  const model = await projectWork(rows, emptyAgentState());
  assert.equal(model.items.filter((item) => item.status === "active").length, 9);
  assert.equal(model.activeWorkerCount, 1, "nine slices of the same verified macOS incarnation count as one worker");
  assert.equal(model.activeReviewRequired, false);
  assert.notEqual(executionFingerprint({ ...meta, worker_pid: "76115" }, true), executionFingerprint(meta, true));
  assert.notEqual(executionFingerprint({ ...meta, worker_start_identity: "2026-10-03T16:33:11Z" }, true), executionFingerprint(meta, true));
  assert.equal(executionFingerprint({ ...meta, worker_start_identity: "invalid" }, true), null);
  assert.equal(executionFingerprint({ worker_pid: pid, worker_started_at: "invalid" }, true), null);
});

test("macOS liveness distinguishes both incarnations in a repeated daylight-saving hour", async (context) => {
  const originalTimezone = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  context.after(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });
  const fixtures = [
    { identity: "2020-11-01T08:30:00.000Z", lstart: "Sun Nov  1 08:30:00 2020" },
    { identity: "2020-11-01T09:30:00.000Z", lstart: "Sun Nov  1 09:30:00 2020" }
  ];
  const executions = [];
  for (const fixture of fixtures) {
    const run = async (command, args, options) => {
      assert.equal(command, "ps");
      return { stdout: `${options.env?.TZ === "UTC" ? fixture.lstart : "Sun Nov  1 01:30:00 2020"} S\n` };
    };
    for (const field of ["worker_start_identity", "worker_started_at"]) {
      const meta = { worker_pid: "76114", [field]: fixture.identity };
      const endpointLive = await endpointIsLive(meta, { platform: "darwin", run });
      assert.equal(endpointLive, true, "the two occurrences of 01:30 Los Angeles time have distinct fixed UTC identities");
      const execution = executionFingerprint(meta, endpointLive);
      assert.equal(execution, fingerprint("execution.v1", null, meta.worker_pid, fixture.identity));
      executions.push(execution);
      const other = fixtures.find((entry) => entry !== fixture);
      assert.equal(await endpointIsLive({ ...meta, [field]: other.identity }, { platform: "darwin", run }), false, "a PID from the other occurrence is a different incarnation");
    }
  }
  assert.notEqual(executions[0], executions[2]);
});

test("macOS liveness distinguishes absent PIDs from executable and probe failures", async () => {
  const meta = { worker_pid: "76114", worker_start_identity: "2026-10-03T16:33:10.000Z", backend: "tmux", window: "default:worker" };
  const failures = [
    { error: { code: 1, stdout: "", stderr: "" }, expected: false },
    { error: { code: 1, stdout: " \n", stderr: "" }, expected: false },
    { error: { code: "ENOENT", stdout: "", stderr: "" }, expected: null },
    { error: { code: "ESRCH", stdout: "", stderr: "" }, expected: null },
    { error: { code: "EACCES", stdout: "", stderr: "" }, expected: null },
    { error: { code: 1, stdout: "", stderr: "ps: sysctl failed" }, expected: null },
    { error: { code: 1, stdout: "unparseable row", stderr: "" }, expected: null },
    { error: { code: 2, stdout: "", stderr: "" }, expected: null },
    { error: { code: 1 }, expected: null },
    { error: { code: 1, stdout: "", stderr: "", killed: true, signal: "SIGTERM" }, expected: null }
  ];
  for (const { error, expected } of failures) {
    const commands = [];
    const run = async (command) => {
      commands.push(command);
      throw Object.assign(new Error("Synthetic execFile failure"), error);
    };
    const endpointLive = await endpointIsLive(meta, { platform: "darwin", run });
    assert.equal(endpointLive, expected);
    assert.deepEqual(commands, ["ps"], "process probe failures must not fall back to tmux");
    const model = await projectWork([record({ state: "working", inFlight: true, endpointLive })], emptyAgentState());
    assert.equal(model.items[0].endpointEvidence, expected === false ? "endpoint not live" : "liveness unknown");
    assert.equal("livenessEvidence" in model.items[0], false);
    assert.equal(model.activeWorkerCount, 0);
  }
  assert.equal(await endpointIsLive(meta, { platform: "darwin", run: async () => ({ stdout: "", stderr: "ps: sysctl failed" }) }), null, "a successful exit with probe diagnostics is still inconclusive");
});

test("remote process and pane records stay unknown without local probes or active evidence", async () => {
  const records = [
    { platform: "linux", meta: { worker_pid: "76114", worker_start_ticks: "4242", worker_boot_id: "a".repeat(36) } },
    { platform: "darwin", meta: { worker_pid: "76114", worker_start_identity: "2026-10-03T16:33:10.000Z" } },
    { platform: "darwin", meta: { worker_pid: "76114", worker_started_at: "2026-10-03T16:33:10.000Z" } },
    { platform: "linux", meta: { backend: "herdr", herdr_session: "default", herdr_pane_id: "w2T:p2" } },
    { platform: "darwin", meta: { backend: "tmux", window: "default:worker" } }
  ];
  for (const { platform, meta } of records) {
    let probes = 0;
    const probe = async () => { probes++; throw new Error("Local endpoint unavailable"); };
    const remote = { ...meta, remote_host: "crew-host" };
    const endpointLive = await endpointIsLive(remote, { platform, read: probe, run: probe });
    assert.equal(endpointLive, null);
    assert.equal(probes, 0, `${platform} remote records never inspect local endpoints`);
    const execution = executionFingerprint(remote, endpointLive);
    assert.equal(execution, null);
    const model = await projectWork([record({ state: "working", inFlight: true, endpointLive, executionFingerprint: execution })], emptyAgentState());
    assert.equal(model.items[0].status, "unknown");
    assert.equal(model.items[0].endpointEvidence, "liveness unknown");
    assert.equal("livenessEvidence" in model.items[0], false);
    assert.equal(model.activeWorkerCount, 0);
  }
});

test("legacy pane liveness uses exact read-only backend checks and leaves uncertain endpoints unknown", async () => {
  const herdrMeta = { backend: "herdr", herdr_session: "default", herdr_pane_id: "w2T:p2" };
  const herdrRun = async (command, args, options) => {
    assert.equal(command, "herdr");
    assert.equal(options.timeout, 1500);
    const op = args.slice(0, 2).join(" ");
    if (op === "pane get") return { stdout: JSON.stringify({ result: { pane: { pane_id: "w2T:p2" } } }) };
    if (op === "agent get") return { stdout: JSON.stringify({ result: { agent: { agent_status: "working" } } }) };
    assert.deepEqual(args, ["pane", "process-info", "--pane", "w2T:p2", "--session", "default"]);
    return { stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: { pane_id: "w2T:p2", shell_pid: 99, foreground_processes: [{ pid: 100, name: "node", argv0: "/opt/claude" }] } } }) };
  };
  assert.equal(await endpointIsLive(herdrMeta, { run: herdrRun }), true);

  for (const status of ["working", "idle", "done", "blocked"]) {
    const run = async (command, args, options) => {
      const result = await herdrRun(command, args, options);
      if (args[0] === "agent") return { stdout: JSON.stringify({ result: { agent: { agent_status: status } } }) };
      return result;
    };
    assert.equal(await endpointIsLive(herdrMeta, { run }), true, `${status} registered agents can own a live pane`);
  }
  const allShell = async (command, args, options) => args[0] === "pane" && args[1] === "process-info"
    ? { stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: { pane_id: "w2T:p2", shell_pid: 99, foreground_processes: [{ name: "zsh", argv0: "-zsh" }] } } }) }
    : herdrRun(command, args, options);
  assert.equal(await endpointIsLive(herdrMeta, { run: allShell }), false, "shell-only panes do not prove a worker is alive");
  const foregroundCases = [
    { processes: [{ pid: 99, name: "nu" }], expected: false },
    { processes: [{ pid: 99, name: "custom-shell", argv0: "/opt/custom-shell" }], expected: false },
    { processes: [{ pid: 99 }], expected: false },
    { processes: [{ pid: 100, name: "zsh", argv0: "-zsh" }], expected: false },
    { processes: [{ pid: 100, name: "nu", argv0: "/opt/nu" }], expected: false },
    { processes: [{ pid: 100, argv0: "-nu" }], expected: false },
    { processes: [{ pid: 99, name: "nu" }, { pid: 100, name: "node" }], expected: true },
    { processes: [{ pid: 100, name: "node" }, { pid: 99, name: "nu" }], expected: true }
  ];
  for (const { processes, expected } of foregroundCases) {
    const run = async (command, args, options) => {
      if (args[0] === "agent") return { stdout: JSON.stringify({ result: { agent: { agent_status: "idle" } } }) };
      if (args[0] === "pane" && args[1] === "process-info") return { stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: { pane_id: "w2T:p2", shell_pid: 99, foreground_processes: processes } } }) };
      return herdrRun(command, args, options);
    };
    const endpointLive = await endpointIsLive(herdrMeta, { run });
    assert.equal(endpointLive, expected, "only a foreground process other than the recorded or nested shell can prove worker liveness");
    const execution = executionFingerprint(herdrMeta, endpointLive);
    assert.equal(execution, expected ? fingerprint("execution.pane.v1", "herdr", "default", "w2T:p2") : null);
    const model = await projectWork([record({ state: "working", inFlight: true, endpointLive, executionFingerprint: execution, endpointEvidence: expected ? "live terminal pane (weaker evidence; worker process unverified)" : "endpoint not live" })], emptyAgentState());
    assert.equal(model.activeWorkerCount, 0, "a terminal pane never proves a worker process incarnation");
    assert.equal(model.items[0].status, "unknown");
    assert.equal(model.items[0].endpointEvidence, expected ? "live terminal pane (weaker evidence; worker process unverified)" : "endpoint not live");
    assert.equal("livenessEvidence" in model.items[0], false, "work rows expose one evidence field");
  }
  const unnamedProcess = async (command, args, options) => args[0] === "pane" && args[1] === "process-info"
    ? { stdout: JSON.stringify({ result: { type: "pane_process_info", process_info: { pane_id: "w2T:p2", shell_pid: 99, foreground_processes: [{}] } } }) }
    : herdrRun(command, args, options);
  assert.equal(await endpointIsLive(herdrMeta, { run: unnamedProcess }), null, "missing foreground process identity is inconclusive");
  const missing = async () => { const error = new Error("pane not found"); error.stdout = JSON.stringify({ error: { code: "pane_not_found" } }); throw error; };
  assert.equal(await endpointIsLive(herdrMeta, { run: missing }), false);
  assert.equal(await endpointIsLive(herdrMeta, { run: async () => { throw new Error("Herdr unavailable"); } }), null);
  assert.equal(await endpointIsLive({ ...herdrMeta, worker_pid: "123" }, { run: herdrRun }), null, "partial process identity blocks pane fallback");
  let remoteCalls = 0;
  assert.equal(await endpointIsLive({ ...herdrMeta, remote_host: "crew-host" }, { run: async () => { remoteCalls++; return { stdout: "" }; } }), null);
  assert.equal(remoteCalls, 0, "remote pane state is never probed locally");

  const tmuxMeta = { window: "default:worker" };
  const calls = [];
  const tmuxRun = async (command, args, options) => {
    assert.equal(command, "tmux"); assert.equal(options.timeout, 1500);
    calls.push(args);
    if (args[0] === "list-windows") {
      assert.deepEqual(args, ["list-windows", "-t", "=default", "-F", "#{window_id}\t#{window_name}"]);
      return { stdout: "@1\tother\n@2\tworker\n" };
    }
    assert.deepEqual(args, ["list-panes", "-t", "@2", "-F", "#{pane_current_command}"]);
    return { stdout: "zsh\nnode\n" };
  };
  assert.equal(await endpointIsLive(tmuxMeta, { run: tmuxRun }), true);
  assert.equal(calls.length, 2);
  const tmuxReply = (windows, panes = "node\n") => async (_command, args) => ({ stdout: args[0] === "list-windows" ? windows : panes });
  assert.equal(await endpointIsLive(tmuxMeta, { run: tmuxReply("@1\tother\n") }), false);
  assert.equal(await endpointIsLive(tmuxMeta, { run: tmuxReply("@1\tworker-backup\n@2\tWorker\n") }), false, "the recorded window name must match exactly");
  assert.equal(await endpointIsLive(tmuxMeta, { run: tmuxReply("@2\tworker\n", "zsh\nbash\n") }), false, "shell-only tmux panes do not prove a worker is alive");
  assert.equal(await endpointIsLive(tmuxMeta, { run: tmuxReply("@2\tworker\n", "zsh\nnode\n") }), true);
  assert.equal(await endpointIsLive({ backend: "", window: "default:worker" }, { run: tmuxRun }), true, "an empty backend retains the default-tmux meaning");
  assert.equal(await endpointIsLive(tmuxMeta, { run: async () => { throw new Error("tmux unavailable"); } }), null);
  assert.equal(await endpointIsLive({ backend: "tmux", window: "malformed" }, { run: tmuxRun }), null);
  assert.equal(executionFingerprint(tmuxMeta, true), fingerprint("execution.pane.v1", "tmux", "default:worker"));
  assert.equal(executionFingerprint({ backend: "", window: "default:worker" }, true), fingerprint("execution.pane.v1", "tmux", "default:worker"));
  assert.equal(hasProcessIdentity({ backend: "tmux", window: "default:worker" }), false);
});

test("tmux pane fallback cannot borrow a matching window from a prefix or glob session", async () => {
  for (const session of ["default", "default*"]) {
    const run = async (command, args) => {
      assert.equal(command, "tmux");
      assert.equal(args[0], "list-windows");
      if (args[2] === `=${session}`) return { stdout: "@1\tworker\n" };
      throw new Error("No exact session exists; only default-backup is present");
    };
    assert.equal(await endpointIsLive({ backend: "tmux", window: `${session}:worker` }, { run }), null, "an absent exact session cannot prove liveness");
  }
  const exact = async (_command, args) => args[0] === "list-windows" ? { stdout: "@1\tworker\n" } : { stdout: "node\n" };
  assert.equal(await endpointIsLive({ backend: "tmux", window: "default-backup:worker" }, { run: exact }), true, "the exact surviving session and its pane process provide evidence");
});

test("pane execution fingerprints are stable and shared panes count once", async () => {
  const herdr = { backend: "herdr", herdr_session: "default", herdr_pane_id: "w2T:p2" };
  const first = executionFingerprint(herdr, true);
  assert.equal(first, fingerprint("execution.pane.v1", "herdr", "default", "w2T:p2"));
  assert.equal(first, executionFingerprint({ ...herdr }, true));
  assert.notEqual(first, executionFingerprint({ ...herdr, herdr_pane_id: "w3T:p1" }, true));
  assert.equal(executionFingerprint({ ...herdr, worker_pid: "123" }, true), null, "pane identity cannot replace a partial process identity");
  const linux = { worker_pid: "123", worker_start_ticks: "456", worker_boot_id: "0".repeat(36) };
  assert.equal(executionFingerprint(linux, true), fingerprint("execution.v1", linux.worker_boot_id, linux.worker_pid, linux.worker_start_ticks));
  const tmux = { backend: "tmux", window: "default:worker" };
  assert.equal(executionFingerprint(tmux, true), fingerprint("execution.pane.v1", "tmux", "default:worker"));
  const rows = ["slice-a", "slice-b"].map((id) => record({ id, state: "working", inFlight: true, endpointLive: true, executionFingerprint: first, endpointEvidence: "live terminal pane (weaker evidence; worker process unverified)" }));
  const model = await projectWork(rows, emptyAgentState());
  assert.equal(model.activeWorkerCount, 0);
  assert.equal(model.items.filter((item) => item.status === "active").length, 0);
  assert.equal(model.items[0].endpointEvidence, "live terminal pane (weaker evidence; worker process unverified)");
  assert.equal("livenessEvidence" in model.items[0], false);
});

test("origin-guarded presentation endpoint is idempotent, exact and cannot change Firstmate status", async (context) => {
  const home = await temporary(context); await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Product - Product work\n");
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] one - Slice (repo: /synthetic/product)\n");
  const status = "done [at=1]: ready for review\n"; await writeFile(path.join(home, "state/one.status"), status);
  const stateFile = `${home}-presentation.json`; const owner = createAgentStateOwner(stateFile);
  context.after(() => rm(stateFile, { force: true }));
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: stateFile }, { revisionResolver: { initial: "a".repeat(40), snapshot: async () => "a".repeat(40) } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(() => new Promise((resolve) => server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = async () => (await (await fetch(`${origin}/api/dashboard`)).json()).fleet.workSplit;
  const item = (await get()).items[0];
  const body = { action: "acknowledge", taskFingerprint: item.taskFingerprint, completionFingerprint: item.completionFingerprint };
  const post = (payload, from = origin) => fetch(`${origin}/api/work-state`, { method: "POST", headers: { origin: from, "content-type": "application/json" }, body: JSON.stringify(payload) });
  assert.equal((await post(body, "https://evil.invalid")).status, 403);
  const ack = await (await post(body)).json(); assert.deepEqual(await (await post(body)).json(), ack);
  assert.equal((await get()).items[0].status, "previously-done");
  assert.equal(await readFile(path.join(home, "state/one.status"), "utf8"), status);
  assert.equal((await post({ action: "create-taxonomy", taskFingerprint: item.taskFingerprint, laneName: "UI", themeName: "Iteration 1", kind: "iteration" })).status, 200);
  assert.equal((await get()).items[0].lane.name, "UI");
  assert.equal((await get()).items[0].theme.name, "Iteration 1");
  await writeFile(path.join(home, "state/one.status"), status + "working [at=2]: rerun\ndone [at=3]: renewed\n");
  assert.equal((await post(body)).status, 409); assert.equal((await get()).items[0].status, "newly-done");
  assert.equal(Object.keys((await owner.read()).acknowledgements).length, 1);
  await writeFile(stateFile, "bad");
  const fallback = await get(); assert.match(fallback.warning, /unavailable/); assert.equal(fallback.items[0].lane.id, "unclassified");
  assert.equal(fallback.items[0].completionAttention, "unknown", "unreadable acknowledgements cannot establish freshness");
  assert.equal(fallback.counts["newly-done"], 0);
  assert.equal((await post(body)).status, 409);
  assert.equal(JSON.stringify(fallback).includes(home), false);
});

test("exact alias mappings are explicit, unambiguous and stable across dispatch", async () => {
  const state = taxonomy(); state.repositories[0].aliases = ["Product"];
  const queued = (await projectWork([record({ repositoryPath: "Product", state: "active", queued: true })], state)).items[0];
  const dispatched = (await projectWork([record()], state)).items[0];
  assert.equal(queued.taskFingerprint, dispatched.taskFingerprint);
  assert.equal(queued.repositoryId, dispatched.repositoryId);
  const unknown = (await projectWork([record({ repositoryPath: "Product-feature" })], state)).items[0];
  assert.equal(unknown.repositoryId, "unknown", "never split names or match substrings");
  state.repositories.push({ id: "other", name: "Other", path: "/other", aliases: ["Product"], lanes: [] });
  assert.throws(() => validateAgentState(state), /aliases/);
});

test("keyed resolution folds current work without implicit closure by done or acknowledgement", async () => {
  const lines = ["working [at=1]: run", "needs-decision [at=2]: [key=choice] choose", "done [at=3]: candidate ready"];
  const unresolved = foldStatusLines(lines);
  assert.equal(unresolved.pendingIssues.length, 1);
  const first = record({ state: unresolved.latest.state, pendingIssues: unresolved.pendingIssues });
  const projected = (await projectWork([first], emptyAgentState())).items[0];
  assert.equal(projected.status, "captain-action");
  assert.equal(projected.completionAttention, "newly-done");
  const state = emptyAgentState(); state.acknowledgements[projected.completionFingerprint] = { taskFingerprint: projected.taskFingerprint, acknowledgedAt: new Date().toISOString() };
  const acknowledged = (await projectWork([first], state)).items[0];
  assert.equal(acknowledged.status, "captain-action");
  assert.equal(acknowledged.completionAttention, "previously-done");
  assert.equal(foldStatusLines([...lines, "resolved [at=4]: [key=wrong] other"]).pendingIssues.length, 1);
  const resolved = foldStatusLines([...lines, "resolved [at=5]: [key=choice] answer recorded"]);
  assert.equal(resolved.pendingIssues.length, 0); assert.equal(resolved.latest.state, "done");
  const resumed = foldStatusLines(["working: run", "paused [key=release]: waiting", "resolved [key=release]: released"]);
  assert.equal(resumed.latest.state, "working");
  const preserved = (await projectWork([record({ retained: true })], emptyAgentState())).items[0];
  assert.equal(preserved.status, "cleanup"); assert.equal(preserved.completionAttention, "newly-done");
});

test("completion evidence is bound to the exact source record, never a stale task-level head", async (context) => {
  const home = await temporary(context); await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- product - Work\n");
  await writeFile(path.join(home, "data/backlog.md"), "## In flight\n- [ ] one - Work (repo: /synthetic/product)\n");
  await writeFile(path.join(home, "state/one.status"), "done [at=1]: first\n");
  await writeFile(path.join(home, "state/one.meta"), `project=/synthetic/product\ncompletion_commit=${"a".repeat(40)}\n`);
  const owner = createAgentStateOwner(path.join(home, "presentation.json")); await owner.update((state) => Object.assign(state, taxonomy()));
  let calls = 0;
  const read = async () => (await loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async (repo, commit) => { calls++; return [{ badge: "remote UAT", commit, head: "b".repeat(40), destination: "refs/heads/uat" }]; } })).workSplit;
  const unbound = (await read()).items[0]; assert.equal(unbound.status, "newly-done"); assert.equal(calls, 0); assert.equal(unbound.unboundCommit, true);
  await owner.update((state) => { state.completionRecords = { [unbound.completionSourceFingerprint]: { taskFingerprint: unbound.taskFingerprint, commit: "a".repeat(40) } }; });
  const bound = (await read()).items[0]; assert.equal(bound.status, "previously-done"); assert.equal(calls, 1);
  await writeFile(path.join(home, "state/one.status"), "done [at=1]: first\nworking [at=2]: rerun\ndone [at=3]: second\n");
  const renewed = (await read()).items[0]; assert.equal(renewed.status, "newly-done"); assert.equal(calls, 1, "old bound commit cannot prove the new completion durable");
});

test("latest configured production success is live; older/inactive deployment is not", async () => {
  const commit = "a".repeat(40), repo = { path: "/fixture", github: "owner/product", destinations: [{ environment: "Production", tier: "production" }] };
  const authority = (sha = commit, status = "success") => async (command, args) => {
    if (command === "git") throw new Error("No remote evidence");
    return { stdout: JSON.stringify(args[1].includes("deployments?") ? [{ id: 1, sha, environment: "Production" }] : [{ id: 2, state: status, environment: "Production" }]) };
  };
  const proof = await verifyDurability(repo, commit, null, authority());
  assert.equal(proof[0].badge, "Live production");
  assert.equal((await projectWork([record({ commit })], taxonomy(), { durability: async () => proof })).items[0].delivery, "Live production");
  assert.deepEqual(await verifyDurability(repo, commit, null, authority("b".repeat(40))), []);
  assert.deepEqual(await verifyDurability(repo, commit, null, authority(commit, "inactive")), []);
});

test("work hierarchy statusAbbreviations maps all statusLabels to distinct single-character abbreviations", async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), context);
  const { statusLabels, statusAbbreviations } = context.window.workHierarchy;
  assert.ok(statusAbbreviations);
  const keys = Object.keys(statusLabels);
  assert.equal(Object.keys(statusAbbreviations).length, keys.length);
  for (const k of keys) {
    const abbr = statusAbbreviations[k];
    assert.equal(typeof abbr, "string");
    assert.equal(abbr.length, 1);
    assert.match(abbr, /^[A-Z]$/);
  }
  assert.equal(new Set(Object.values(statusAbbreviations)).size, keys.length);
  assert.equal(statusAbbreviations.active, "A");
  assert.equal(statusAbbreviations.waiting, "W");
  assert.equal(statusAbbreviations["captain-action"], "C");
  assert.equal(statusAbbreviations.cleanup, "R");
  assert.equal(statusAbbreviations.unknown, "U");
  assert.equal(statusAbbreviations.backlog, "B");
  assert.equal(statusAbbreviations["newly-done"], "N");
  assert.equal(statusAbbreviations["previously-done"], "P");
});

test("work hierarchy statusConciseLabels maps all statusLabels to readable concise labels for buttons", async () => {
  const context = { window: {} };
  vm.runInNewContext(await readFile(new URL("../public/work-hierarchy.js", import.meta.url), "utf8"), context);
  const { statusLabels, statusConciseLabels } = context.window.workHierarchy;
  assert.ok(statusConciseLabels);
  const keys = Object.keys(statusLabels);
  assert.equal(Object.keys(statusConciseLabels).length, keys.length);
  for (const k of keys) {
    const concise = statusConciseLabels[k];
    assert.equal(typeof concise, "string");
    assert.ok(concise.length > 0);
  }
  assert.equal(statusConciseLabels.active, "Active");
  assert.equal(statusConciseLabels.waiting, "Waiting");
  assert.equal(statusConciseLabels["captain-action"], "Captain action");
  assert.equal(statusConciseLabels.cleanup, "Cleanup");
  assert.equal(statusConciseLabels.unknown, "Unknown");
  assert.equal(statusConciseLabels.backlog, "Backlog");
  assert.equal(statusConciseLabels["newly-done"], "Newly done");
  assert.equal(statusConciseLabels["previously-done"], "Previously done");
});
