import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { foldStatusLines, projectWork, classifyCurrent } from "../work-model.js";
import { loadFirstmateHome, dashboardData } from "../server.js";
import { emptyAgentState } from "../agent-state.js";
import { parseStatusLine, parseBacklogTask, decodeHoldReason } from "../firstmate-records.js";

const owner = { read: async () => emptyAgentState() };
async function fixture(t, backlog) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-qd-status-grammar-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- product - Synthetic product\n");
  await writeFile(path.join(home, "data/backlog.md"), backlog);
  return home;
}
const read = (home) => loadFirstmateHome(home, { includeHistory: false, agentStateOwner: owner, durability: async () => [] });
const hold = (reason) => `(hold: fm-hold-v1:${Buffer.from(reason).toString("base64")}) (hold-kind: captain)`;

const distinctWaitPhases = [
  { name: "keyless pause and header resolution", pause: "paused: Await vendor", resolution: "resolved [key=default]: Chose A", matching: "resolved: Vendor cleared" },
  { name: "keyless pause and note-head resolution", pause: "paused: Await vendor", resolution: "resolved: [key=default] Chose A", matching: "resolved: Vendor cleared" },
  { name: "header pause and keyless resolution", pause: "paused [key=default]: Await vendor", resolution: "resolved: Chose A", matching: "resolved: [key=default] Vendor cleared" },
  { name: "note-head pause and keyless resolution", pause: "paused: [key=default] Await vendor", resolution: "resolved: Chose A", matching: "resolved [key=default]: Vendor cleared" },
];

const rejectedDeclarations = [
  { name: "invalid header key", suffix: " [key=bad key]: Await access", reason: "Await access" },
  { name: "invalid note-head key", suffix: ": [key=bad key] Await access", reason: "[key=bad key] Await access" },
  { name: "empty header key", suffix: " [key=]: Await access", reason: "Await access" },
  { name: "empty note-head key", suffix: ": [key=] Await access", reason: "[key=] Await access" },
  { name: "rejected reserved header key", suffix: " [key=pending-reply-example]: Await access", reason: "Await access" },
  { name: "rejected reserved note-head key", suffix: ": [key=pending-reply-example] Await access", reason: "Await access" },
];

for (const state of ["needs-decision", "blocked", "paused", "waiting", "captain-held"]) {
  test(`rejected keys preserve current ${state} declarations without keyed mutations`, async () => {
    for (const scenario of rejectedDeclarations) {
      const declaration = `${state}${scenario.suffix}`;
      assert.equal(parseStatusLine(declaration).transitionAllowed, false, scenario.name);
      const lines = ["working: Run", declaration];
      for (const following of [[], ["Continuation prose"], ["resolved: Answered"], ["resolved [key=bad key]: Answered"], ["resolved [key=pending-reply-example]: Answered"], ["resolved [key=pending-reply-example]: pending-reply-example: Answered"], ["working: Resumed"], ["paused [key=vendor]: Await vendor"]]) {
        const folded = foldStatusLines([...lines, ...following]);
        const expectedState = following[0]?.startsWith("working:") || (state === "captain-held" && following[0]?.startsWith("resolved")) ? "working"
          : following[0]?.startsWith("paused") ? "paused" : state;
        const expectedReason = expectedState === "working" ? following[0]?.startsWith("working:") ? "Resumed" : "Run" : following[0]?.startsWith("paused") ? "Await vendor" : scenario.reason;
        assert.equal(folded.latest.state, expectedState, scenario.name);
        assert.equal(folded.latest.text, expectedReason, scenario.name);
        assert.deepEqual(folded.pendingIssues, [], scenario.name);
        const model = await projectWork([{ id: "worker", state: folded.latest.state, pendingIssues: folded.pendingIssues,
          waitingOn: expectedState === "working" ? null : folded.latest.text, inFlight: true, endpointLive: true, endpointEvidence: "live process incarnation" }], emptyAgentState());
        assert.equal(model.items[0].status, expectedState === "working" ? "active" : expectedState === "needs-decision" ? "captain-action" : "waiting", scenario.name);
        assert.equal(model.items[0].waitingOn, expectedState === "working" ? null : expectedReason, scenario.name);
        assert.equal(model.activeWorkerCount, expectedState === "working" ? 1 : 0, scenario.name);
      }
      for (const [opener, key] of [["needs-decision: Original choice", "default"], ["needs-decision [key=route]: Original choice", "route"], ["needs-decision [key=pending-reply-example]: pending-reply-example: Original choice", "pending-reply-example"]]) {
        const original = [{ key, state: "needs-decision", text: key === "pending-reply-example" ? "pending-reply-example: Original choice" : "Original choice" }];
        const folded = foldStatusLines([opener, declaration]);
        assert.deepEqual(folded.pendingIssues, original, scenario.name);
        for (const closer of ["resolved", "captain-held"]) {
          assert.deepEqual(foldStatusLines([opener, `${closer}${scenario.suffix}`]).pendingIssues, original, scenario.name);
        }
        const matching = key === "pending-reply-example" ? `resolved [key=${key}]: pending-reply-example: Answered` : `resolved [key=${key}]: Answered`;
        assert.deepEqual(foldStatusLines([opener, declaration, matching]).pendingIssues, [], scenario.name);
      }
    }
  });
}

for (const scenario of distinctWaitPhases) {
  test(`decision closure preserves ${scenario.name} with live process evidence`, async () => {
    for (const kind of ["ship", "scout", "unknown"]) {
      for (const waitState of ["paused", "waiting"]) {
        for (const decision of ["needs-decision: Choose", "needs-decision [key=default]: Choose", "blocked: Choose", "blocked: [key=default] Choose"]) {
          const lines = ["working: Run", decision, scenario.pause.replace("paused", waitState), scenario.resolution];
          const folded = foldStatusLines(lines, { kind });
          assert.equal(folded.latest.state, waitState);
          assert.equal(folded.latest.text, "Await vendor");
          assert.deepEqual(folded.pendingIssues, []);
          const model = await projectWork([{ id: "worker", state: folded.latest.state, pendingIssues: folded.pendingIssues,
            waitingOn: folded.latest.text, inFlight: true, endpointLive: true, endpointEvidence: "live process incarnation" }], emptyAgentState());
          assert.equal(model.items[0].status, "waiting");
          assert.equal(model.items[0].waitingOn, "Await vendor");
          assert.equal(model.activeWorkerCount, 0);
          const transferred = foldStatusLines([...lines.slice(0, -1), scenario.resolution.replace("resolved", "captain-held"), "resolved [key=other]: Unrelated answer"], { kind });
          assert.equal(transferred.latest.state, waitState);
          assert.equal(transferred.latest.text, "Await vendor");
          assert.deepEqual(transferred.pendingIssues, []);
          const resumed = foldStatusLines([...lines, scenario.matching], { kind });
          assert.equal(resumed.latest.state, "working");
          assert.deepEqual(resumed.pendingIssues, []);
          assert.equal(classifyCurrent({ state: resumed.latest.state, pendingIssues: resumed.pendingIssues, inFlight: true, endpointLive: true }), "active");
        }
      }
    }
  });
}

test("multi-field producer decisions open, resolve by exact key, and retain completion", () => {
  const lines = ["working: implementing", "needs-decision [at=1791635123] [key=route] [corr=0123456789abcdef]: Choose a route"];
  assert.equal(foldStatusLines(lines).latest.state, "needs-decision");
  assert.equal(foldStatusLines(lines).pendingIssues.length, 1);
  const wrong = [...lines, "resolved [key=other] [at=1791635124]: Unrelated answer"];
  assert.equal(foldStatusLines(wrong).pendingIssues.length, 1);
  const resolved = foldStatusLines([...wrong, "resolved [corr=0123456789abcdef] [at=1791635125] [key=route]: Choose A", "done [corr=0123456789abcdef] [at=1791635126]: Ready"]);
  assert.equal(resolved.pendingIssues.length, 0);
  assert.equal(resolved.latest.state, "done");
  assert.ok(resolved.completion);
});

test("status fields retain their order and note-head keys cannot override a header key", () => {
  const event = parseStatusLine("needs-decision [key=route] [corr=0123456789abcdef] [at=10:30] [extra=value]: [key=other] Choose");
  assert.deepEqual(event.fields, [{ name: "key", value: "route" }, { name: "corr", value: "0123456789abcdef" }, { name: "at", value: "10:30" }, { name: "extra", value: "value" }]);
  assert.equal(event.key, "route");
  assert.equal(event.text, "[key=other] Choose");
  assert.equal(parseStatusLine("resolved corr=short [key=route]: Invalid token").state, "update");
  assert.equal(parseStatusLine("resolved x=1 [key=route]: Prose").state, "update");
  assert.equal(foldStatusLines(["needs-decision [at=1] [key=route]: Choose", "resolved [at=2] [key=route]: Answered", "needs-decision [key=route] [at=3]: Choose again"]).pendingIssues.length, 1);
});

test("keyless decisions, note-head keys and captain-held transfers follow producer semantics", () => {
  assert.equal(foldStatusLines(["needs-decision [at=10:30]: Choose", "working: resumed"]).pendingIssues.length, 1);
  assert.equal(foldStatusLines(["needs-decision: Choose", "resolved: Answered"]).pendingIssues.length, 0);
  assert.equal(foldStatusLines(["needs-decision corr=0123456789abcdef [at=1791635123]: [key=route] Choose", "captain-held [at=1791635124] [key=route]: Tracked by durable task"]).pendingIssues.length, 0);
  assert.equal(foldStatusLines(["needs-decision [key=route]: Choose", "resolved: Prose mentions [key=route]"]).pendingIssues.length, 1);
  assert.equal(foldStatusLines(["needs-decision [key=bad key]: Choose"]).pendingIssues.length, 0);
  assert.equal(foldStatusLines(["needs-decision [key=pending-reply-example]: Unrelated prose"]).pendingIssues.length, 0);
});

test("ship terminal declarations clear decisions while unknown kinds preserve them", () => {
  for (const terminal of ["done", "failed"]) {
    const lines = ["needs-decision [at=1] [key=route]: Choose", `${terminal} [corr=0123456789abcdef] [at=2]: Worker outcome`];
    assert.equal(foldStatusLines(lines, { kind: "ship" }).pendingIssues.length, 0);
    assert.equal(foldStatusLines(lines, { kind: "scout" }).pendingIssues.length, 0);
    assert.equal(foldStatusLines(lines, { kind: "unknown" }).pendingIssues.length, 1);
  }
});

for (const kind of ["ship", "scout", "unknown"]) {
  for (const terminal of ["done", "failed"]) {
    for (const separator of [false, true]) {
      for (const timeTag of ["", " [at=10:30]"]) {
        const line = `${terminal} [key=other]${timeTag}${separator ? ": Worker outcome" : ""}`;
        test(`${kind} decision fold after ${line}`, () => {
          assert.equal(parseStatusLine(line).hasSeparator, separator);
          const folded = foldStatusLines(["working: Implementing", "needs-decision [key=route]: Choose route", line], { kind });
          const clearsDecision = separator && ["ship", "scout"].includes(kind);
          assert.deepEqual(folded.pendingIssues, clearsDecision ? [] : [{ key: "route", state: "needs-decision", text: "Choose route" }]);
          if (!clearsDecision) {
            assert.equal(classifyCurrent({ state: folded.latest.state, pendingIssues: folded.pendingIssues }), "captain-action");
          }
        });
      }
    }
  }
}

test("colonless keyed decisions and resolutions retain their separate transition grammar", () => {
  for (const kind of ["ship", "scout", "unknown"]) {
    for (const timeTag of ["", " [at=10:30]"]) {
      for (const decision of ["needs-decision", "blocked"]) {
        const opener = `${decision} [key=route]${timeTag}`;
        const folded = foldStatusLines([opener, `resolved [key=other]${timeTag}`], { kind });
        assert.deepEqual(folded.pendingIssues, [{ key: "route", state: decision, text: opener }]);
        for (const closer of ["resolved", "captain-held"]) {
          assert.deepEqual(foldStatusLines([opener, `${closer} [key=route]${timeTag}`], { kind }).pendingIssues, []);
        }
      }
    }
  }
});

test("home adapter and dashboard count a multi-field decision and close only its matching key", async (t) => {
  const home = await fixture(t, "## In flight\n- [ ] route - Synthetic work (repo: product)\n");
  const status = "working: Implementing\nneeds-decision [at=1791635123] [key=route-choice]: Choose a route\n";
  await writeFile(path.join(home, "state/route.status"), status);
  const data = await read(home);
  assert.equal(data.workSplit.items[0].status, "captain-action");
  assert.equal(data.workSplit.items[0].waitingOn, "Choose a route");
  const history = await loadFirstmateHome(home, { agentStateOwner: owner, durability: async () => [] });
  assert.ok(history.lanes[0].messages.some((message) => message.text === "needs-decision: Choose a route"));
  assert.equal((await dashboardData({ FM_HOME: home }, owner, undefined, async () => ({}))).fleet.summary.openDecisions, 1);
  await writeFile(path.join(home, "state/route.status"), status + "resolved [key=route-choice] [at=1791635124]: Choose A\nworking [corr=0123456789abcdef] [at=1791635125]: Implementing A\n");
  const resumed = await read(home);
  assert.equal(resumed.workSplit.items[0].status, "unknown");
  assert.equal(resumed.workSplit.items[0].waitingOn, null);
});

for (const large of [false, true]) {
  test(`rejected-key current declarations retain reasons for ${large ? "large" : "ordinary"} Work Split`, async (t) => {
    const states = ["needs-decision", "blocked", "paused", "waiting", "captain-held"];
    const home = await fixture(t, `## In flight\n${states.map((state) => `- [ ] ${state} - Synthetic ${state} (repo: product)\n${large ? "  Large project\n" : ""}`).join("")}`);
    for (const state of states) await writeFile(path.join(home, `state/${state}.meta`), "project=product\n");
    for (const scenario of rejectedDeclarations) {
      for (const following of [[], ["Continuation prose"], ["resolved [key=pending-reply-example]: Answered"], ["working: Resumed"]]) {
        for (const state of states) await writeFile(path.join(home, `state/${state}.status`), ["working: Run", `${state}${scenario.suffix}`, ...following].join("\n") + "\n");
        const data = await read(home);
        const split = data.workSplit;
        const displayed = large ? split.large.projects : split.tight.inProgress.items;
        for (const state of states) {
          const item = split.items.find((entry) => entry.id === state);
          const current = !following[0]?.startsWith("working:") && !(state === "captain-held" && following[0]?.startsWith("resolved"));
          const reason = current ? scenario.reason : large ? "Nothing recorded" : null;
          assert.equal(item.sourceState, current ? state : "working", scenario.name);
          assert.equal(item.status, current ? state === "needs-decision" ? "captain-action" : "waiting" : "unknown", scenario.name);
          assert.equal(item.waitingOn, reason, scenario.name);
          assert.deepEqual(item.pendingIssues, [], scenario.name);
          assert.equal(displayed.find((entry) => entry.id === state).waitingOn, reason, scenario.name);
          if (large) assert.equal(displayed.find((entry) => entry.id === state).stage, current ? state.replaceAll("-", " ") : "In progress");
        }
        assert.equal(split.activeWorkerCount, 0);
        assert.equal(split.counts.active, 0);
        assert.equal(data.summary.openDecisions, following[0]?.startsWith("working:") ? 0 : 1);
      }
      const history = await loadFirstmateHome(home, { agentStateOwner: owner, durability: async () => [] });
      for (const state of states) assert.ok(history.lanes[0].messages.some((message) => message.taskId === state && message.text === `${state}: ${scenario.reason}`), scenario.name);
    }
  });

  test(`distinct default wait phases remain Waiting for ${large ? "large" : "ordinary"} Work Split`, async (t) => {
    const home = await fixture(t, `## In flight\n- [ ] worker - Synthetic worker (repo: product)\n${large ? "  Large project\n" : ""}`);
    await writeFile(path.join(home, "state/worker.meta"), "project=product\n");
    for (const scenario of distinctWaitPhases) {
      const lines = ["working: Run", "needs-decision: Choose", scenario.pause, scenario.resolution];
      await writeFile(path.join(home, "state/worker.status"), lines.join("\n") + "\n");
      const data = await read(home);
      const split = data.workSplit;
      const item = split.items[0];
      assert.equal(item.sourceState, "paused", scenario.name);
      assert.equal(item.status, "waiting", scenario.name);
      assert.equal(item.waitingOn, "Await vendor", scenario.name);
      assert.deepEqual(item.pendingIssues, []);
      assert.equal(split.activeWorkerCount, 0);
      assert.equal(split.counts.active, 0);
      assert.equal(split.counts.waiting, 1);
      assert.equal(data.summary.openDecisions, 0);
      const displayed = large ? split.large.projects[0] : split.tight.inProgress.items[0];
      assert.equal(displayed.waitingOn, "Await vendor", scenario.name);
      if (large) assert.equal(displayed.stage, "paused");
      await writeFile(path.join(home, "state/worker.status"), [...lines, scenario.matching].join("\n") + "\n");
      const resumed = (await read(home)).workSplit;
      assert.equal(resumed.items[0].sourceState, "working");
      assert.equal(resumed.items[0].status, "unknown");
      assert.equal(resumed.items[0].waitingOn, large ? "Nothing recorded" : null);
      assert.equal((large ? resumed.large.projects[0] : resumed.tight.inProgress.items[0]).waitingOn, large ? "Nothing recorded" : null);
    }
  });

  test(`encoded captain holds retain reasons, dates and blockers for ${large ? "large" : "ordinary"} work`, async (t) => {
    const reason = "Choose (A or B)\nThen confirm café rollout";
    const body = large ? "  Large project\n" : "";
    const home = await fixture(t, `## Queued\n- [ ] undated - Synthetic choice (repo: product) ${hold(reason)}\n${body}- [ ] deferred - Synthetic deferral blocked-by: dependency-a,dependency-b (repo: product) ${hold(reason)} (hold-until: 2099-11-01)\n${body}- [ ] blocked - Synthetic blocker blocked-by: dependency-a (repo: product)\n${body}- [ ] expired - Synthetic expired (repo: product) ${hold(reason)} (hold-until: 2020-01-01)\n${body}- [ ] dependency-a - Synthetic prerequisite (repo: product)\n- [ ] dependency-b - Synthetic prerequisite (repo: product)\n## Done\n- [x] closed - Synthetic closed (repo: product) ${hold(reason)}\n${body}`);
    await writeFile(path.join(home, "state/deferred.status"), "done [corr=0123456789abcdef] [at=1791635123]: Worker candidate ready\n");
    const split = (await read(home)).workSplit;
    const items = Object.fromEntries(split.items.map((item) => [item.id, item]));
    assert.equal(items.undated.status, "captain-action");
    assert.equal(items.undated.holdKind, "captain");
    assert.equal(items.undated.holdReason, reason);
    assert.match(items.undated.waitingOn, /Choose \(A or B\)/);
    assert.equal(items.deferred.status, "waiting");
    assert.equal(items.deferred.holdUntil, "2099-11-01");
    assert.deepEqual(items.deferred.blockers, ["dependency-a", "dependency-b"]);
    assert.match(items.deferred.waitingOn, /Deferred until 2099-11-01/);
    assert.match(items.deferred.waitingOn, /dependency-a, dependency-b/);
    assert.equal(items.deferred.completionAttention, "newly-done");
    assert.equal(items.blocked.status, "waiting");
    assert.match(items.blocked.waitingOn, /dependency-a/);
    assert.equal(items.expired.status, "captain-action");
    assert.equal(items.closed.status, "newly-done");
    if (!large) assert.match(split.tight.backlog.items.find((item) => item.id === "undated").waitingOn, /Choose/);
  });
}

test("malformed encoded reasons remain literal and sensitive decoded notes remain withheld", async (t) => {
  const home = await fixture(t, `## Queued\n- [ ] malformed - Synthetic malformed (repo: product) (hold: fm-hold-v1:invalid!) (hold-kind: captain)\n- [ ] sensitive - Synthetic sensitive (repo: product) ${hold("password=synthetic-value")}\n`);
  const items = Object.fromEntries((await read(home)).workSplit.items.map((item) => [item.id, item]));
  assert.equal(items.malformed.holdReason, "fm-hold-v1:invalid!");
  assert.equal(items.sensitive.holdReason, "Sensitive operational detail withheld");
});

test("hold date boundaries and reason decoding match producer rules", () => {
  const metadata = "(hold: Waiting) (hold-kind: external) (hold-until: 2026-11-01)";
  assert.equal(parseBacklogTask(metadata, false, "2026-10-31").holdActive, true);
  assert.equal(parseBacklogTask(metadata, false, "2026-11-01").holdActive, false);
  assert.equal(parseBacklogTask(metadata.replace("external", "captain"), false, "2026-11-01").holdActive, true);
  for (const date of ["2099-13-01", "2099-02-30", "invalid"]) assert.equal(parseBacklogTask(`(hold-until: ${date})`, false).holdUntil, null);
  for (const reason of ["fm-hold-v1:/w==", "fm-hold-v1:YQ", "plain (reason)"]) assert.equal(decodeHoldReason(reason), reason);
  const nested = "fm-hold-v1:U2FtcGxl";
  assert.equal(decodeHoldReason(`fm-hold-v1:${Buffer.from(nested).toString("base64")}`), nested, "decode only once");
});

test("repeated canonical hold fields retain every edge and use producer scalar precedence", () => {
  const reason = "Choose the final route";
  const metadata = `(hold: Old reason) (hold-kind: external) (hold-until: 2020-01-01) ${hold(reason)} (hold-until: 2099-11-01) blocked-by: a blocked-by: b,c blocked-by: a`;
  const parsed = parseBacklogTask(metadata, false, "2026-11-01");
  assert.deepEqual(parsed.blockers, ["a", "b", "c"]);
  assert.equal(parsed.holdReason, reason);
  assert.equal(parsed.holdKind, "captain");
  assert.equal(parsed.holdUntil, "2099-11-01");
  assert.equal(parsed.holdDeferred, true);
});

test("default hold clock expires at local midnight on both sides of UTC", (t) => {
  const previousTimezone = process.env.TZ;
  t.after(() => {
    if (previousTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimezone;
  });
  const metadata = "(hold: Waiting) (hold-kind: external) (hold-until: 2026-11-01)";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-31T13:59:00Z") });
  for (const [timezone, before, after] of [
    ["Australia/Brisbane", "2026-10-31T13:59:00Z", "2026-10-31T14:30:00Z"],
    ["America/Los_Angeles", "2026-11-01T06:59:00Z", "2026-11-01T07:30:00Z"],
  ]) {
    process.env.TZ = timezone;
    t.mock.timers.setTime(Date.parse(before));
    assert.equal(parseBacklogTask(metadata, false).holdDeferred, true, timezone);
    assert.equal(parseBacklogTask(metadata, false).holdActive, true, timezone);
    t.mock.timers.setTime(Date.parse(after));
    assert.equal(parseBacklogTask(metadata, false).holdDeferred, false, timezone);
    assert.equal(parseBacklogTask(metadata, false).holdActive, false, timezone);
    assert.equal(parseBacklogTask(metadata.replace("external", "captain"), false).holdActive, true, timezone);
  }
});

for (const large of [false, true]) {
  test(`complete backlog resolves dependencies for ${large ? "large" : "ordinary"} work`, async (t) => {
    const body = large ? "  Large project\n" : "";
    const backlog = (finishedA, finishedB) => `## Queued\n- [ ] dependent - Synthetic dependent blocked-by: a blocked-by: b blocked-by: missing (repo: obsolete) (repo: product)\n${body}- [ ] paused - Synthetic paused work blocked-by: a blocked-by: b (repo: product)\n${body}- [ ] dangling - Synthetic legacy edge blocked-by: missing (repo: product)\n${body}${finishedA ? "" : "- [ ] a - Synthetic prerequisite (repo: product)\n"}## In flight\n${finishedB ? "" : "- [ ] b - Synthetic prerequisite (repo: product)\n"}## Done\n${finishedA ? "- [x] a - Synthetic prerequisite (repo: product)\n" : ""}${finishedB ? "- [x] b - Synthetic prerequisite (repo: product)\n" : ""}- [x] closed - Synthetic closed blocked-by: a (repo: product) (theme: Old) (theme: Final) (done 2020-01-01) (reported 2020-02-01)\n${body}`;
    const home = await fixture(t, backlog(false, false));
    await mkdir(path.join(home, "projects/product"), { recursive: true });
    await writeFile(path.join(home, "state/paused.meta"), "project=product\n");
    await writeFile(path.join(home, "state/paused.status"), "paused: Await external proof\n");
    for (const [finishedA, finishedB, activeBlockers] of [[false, false, ["a", "b"]], [true, false, ["b"]], [true, true, []], [false, false, ["a", "b"]]]) {
      await writeFile(path.join(home, "data/backlog.md"), backlog(finishedA, finishedB));
      const split = (await read(home)).workSplit;
      const items = Object.fromEntries(split.items.map((item) => [item.id, item]));
      assert.deepEqual(items.dependent.blockers, ["a", "b", "missing"]);
      assert.deepEqual(items.dependent.activeBlockers, activeBlockers);
      assert.equal(items.dependent.repository, "product");
      assert.equal(items.dependent.status, activeBlockers.length ? "waiting" : "backlog");
      assert.equal(items.paused.status, "waiting");
      assert.equal(items.dangling.status, "backlog");
      assert.deepEqual(items.dangling.blockers, ["missing"]);
      assert.deepEqual(items.dangling.activeBlockers, []);
      assert.equal(items.closed.status, "newly-done");
      assert.equal(items.closed.theme.name, "Final");
      assert.equal(items.closed.completionAt, "2020-02-01");
      assert.deepEqual(items.closed.activeBlockers, []);
      assert.equal(items.closed.waitingOn, large ? "Nothing recorded" : null);
      const displayed = large ? split.large.projects.find((item) => item.id === "dependent") : split.tight.backlog.items.find((item) => item.id === "dependent");
      for (const waitingOn of [items.dependent.waitingOn, displayed.waitingOn]) {
        if (!activeBlockers.length) assert.doesNotMatch(String(waitingOn), /Dependency:/);
        else assert.equal(waitingOn, finishedA ? "Dependency: b" : "Dependency: a, b");
      }
    }
  });

  test(`captain-held transfers retain current wait for ${large ? "large" : "ordinary"} work`, async (t) => {
    const home = await fixture(t, `## In flight\n- [ ] worker - Synthetic worker (repo: product)\n${large ? "  Large project\n" : ""}`);
    const prefix = "working: Implementing\nneeds-decision [at=1] [key=route]: Choose\n";
    const transfer = "captain-held [key=route] [at=2]: Tracked by captain choice\n";
    await writeFile(path.join(home, "state/worker.meta"), "project=product\n");
    await writeFile(path.join(home, "state/worker.status"), prefix + transfer);
    const split = (await read(home)).workSplit;
    const item = split.items[0];
    assert.equal(item.status, "waiting");
    assert.equal(item.sourceState, "captain-held");
    assert.equal(item.waitingOn, "Tracked by captain choice");
    assert.deepEqual(item.pendingIssues, []);
    assert.equal(split.activeWorkerCount, 0);
    const displayed = large ? split.large.projects[0] : split.tight.inProgress.items[0];
    assert.equal(displayed.waitingOn, "Tracked by captain choice");
    if (large) assert.equal(displayed.stage, "captain held");
    for (const kind of ["ship", "scout", "unknown"]) {
      const folded = foldStatusLines((prefix + transfer).trim().split("\n"), { kind });
      const projected = await projectWork([{ id: "worker", state: folded.latest.state, pendingIssues: folded.pendingIssues,
        inFlight: true, endpointLive: true, endpointEvidence: "live process incarnation" }], emptyAgentState());
      assert.equal(projected.items[0].status, "waiting");
      assert.equal(projected.activeWorkerCount, 0);
    }
    await writeFile(path.join(home, "state/worker.status"), prefix + transfer + "working [at=3]: Resumed\nresolved [key=other] [at=4]: Unrelated answer\n");
    const resumed = (await read(home)).workSplit.items[0];
    assert.equal(resumed.sourceState, "working");
    assert.equal(resumed.status, "unknown");
    assert.equal(resumed.waitingOn, large ? "Nothing recorded" : null);
  });
}

test("captain-held closes only its exact decision and remains current only until the next event", () => {
  const prefix = ["working: Implementing", "needs-decision [key=route]: Choose", "needs-decision [key=other]: Another choice"];
  const transfer = "captain-held [key=route]: Tracked by captain choice";
  const folded = foldStatusLines([...prefix, transfer, "Continuation prose"]);
  assert.equal(folded.latest.state, "captain-held");
  assert.deepEqual(folded.pendingIssues.map((issue) => issue.key), ["other"]);
  assert.equal(foldStatusLines(["working: Implementing", "needs-decision [key=route]: Choose", transfer, "resolved [key=other]: Answered"]).latest.state, "working");
  assert.equal(foldStatusLines([...prefix, transfer, "done: Delivered"], { kind: "ship" }).pendingIssues.length, 0);
});

test("trailing backlog fields preserve repeated tags and dependency reasons without scanning their values", () => {
  const prose = "Implement (hold: Use blocked-by: ghost) (hold-kind: captain) (repo: obsolete) (repo: product) (epic: Old) (theme: Final) (kind: ship) (priority: 3) (since 2026-11-01) (hold-until: 2099-11-01) blocked-by: a - Await approval parent: parent-id - Parent note discovered-from: origin-id blocked-by: b,c - Depends on both";
  const parsed = parseBacklogTask(prose, false, "2026-11-01");
  assert.equal(parsed.title, "Implement");
  assert.equal(parsed.repositoryPath, "product");
  assert.deepEqual(parsed.workGroup, { kind: "theme", name: "Final" });
  assert.deepEqual(parsed.blockers, ["a", "b", "c"]);
  assert.equal(parsed.holdReason, "Use blocked-by: ghost");
  assert.equal(parsed.holdKind, "captain");
  assert.equal(parsed.holdUntil, "2099-11-01");
  assert.equal(parsed.holdDeferred, true);
  const unknownTail = "Document (hold-kind: captain) (repo: product) (unknown: prose)";
  const plain = parseBacklogTask(unknownTail, false);
  assert.equal(plain.title, unknownTail);
  assert.equal(plain.holdKind, null);
  assert.equal(plain.repositoryPath, null);
  assert.deepEqual(plain.blockers, []);
});

for (const large of [false, true]) {
  test(`trailing backlog boundary keeps field-shaped prose for ${large ? "large" : "ordinary"} work`, async (t) => {
    const titles = [
      "Document (hold-kind: captain) syntax",
      "Document (hold: Await the captain) syntax",
      "Document (hold-until: 2099-11-01) syntax",
      "Document blocked-by: blocker syntax",
      "Document (repo: obsolete) syntax",
      "Document (epic: Phantom) syntax",
      "Document (theme: Phantom) syntax",
      "Document (reported 2099-11-01) syntax",
      "Document (done 2099-11-01) syntax",
      "Document (merged 2099-11-01) syntax",
      "Document (closed 2099-11-01) syntax",
    ];
    const body = large ? "  Large project\n" : "";
    const backlog = `## Queued\n${titles.map((title, index) => `- [ ] prose-${index} - ${title} (repo: product)\n${body}`).join("")}- [ ] blocker - Synthetic prerequisite (repo: product)\n`;
    const home = await fixture(t, backlog);
    await mkdir(path.join(home, "projects/product"), { recursive: true });
    const data = await read(home);
    const items = new Map(data.workSplit.items.map((item) => [item.id, item]));
    const displayed = large ? data.workSplit.large.projects : data.workSplit.tight.backlog.items;
    for (const [index, title] of titles.entries()) {
      const item = items.get(`prose-${index}`);
      assert.equal(item.name, title);
      assert.equal(item.status, "backlog");
      assert.equal(item.repository, "product");
      assert.equal(item.theme.id, "unclassified");
      assert.equal(item.holdKind, null);
      assert.equal(item.holdReason, null);
      assert.equal(item.holdUntil, null);
      assert.equal(item.holdActive, false);
      assert.equal(item.holdDeferred, false);
      assert.deepEqual(item.blockers, []);
      assert.deepEqual(item.activeBlockers, []);
      assert.equal(item.completionAt, null);
      assert.equal(item.waitingOn, large ? "Nothing recorded" : null);
      assert.equal(displayed.find((entry) => entry.id === item.id).name, title);
    }
    assert.equal(data.summary.openDecisions, 0);
  });

  test(`explicit unresolved decisions precede gates for ${large ? "large" : "ordinary"} work`, async (t) => {
    const gates = [
      { id: "dependency", metadata: "blocked-by: a blocked-by: b", status: "waiting", reason: "Dependency: a, b", blockers: ["a", "b"], holdKind: null, holdReason: null, holdUntil: null, holdActive: false, holdDeferred: false },
      { id: "external", metadata: "(hold: Await vendor) (hold-kind: external)", status: "waiting", reason: "Await vendor", blockers: [], holdKind: "external", holdReason: "Await vendor", holdUntil: null, holdActive: true, holdDeferred: false },
      { id: "deferred", metadata: `${hold("Await approval")} (hold-until: 2099-11-01) blocked-by: a`, status: "waiting", reason: "Deferred until 2099-11-01 · Await approval · Dependency: a", blockers: ["a"], holdKind: "captain", holdReason: "Await approval", holdUntil: "2099-11-01", holdActive: true, holdDeferred: true },
      { id: "captain", metadata: hold("Await approval"), status: "captain-action", reason: "Captain · Await approval", blockers: [], holdKind: "captain", holdReason: "Await approval", holdUntil: null, holdActive: true, holdDeferred: false },
    ];
    const body = large ? "  Large project\n" : "";
    const home = await fixture(t, `## In flight\n${gates.map((gate) => `- [ ] ${gate.id} - Synthetic ${gate.id} (repo: product) ${gate.metadata}\n${body}`).join("")}## Queued\n- [ ] a - Prerequisite A (repo: product)\n- [ ] b - Prerequisite B (repo: product)\n`);
    await mkdir(path.join(home, "projects/product"), { recursive: true });
    for (const gate of gates) await writeFile(path.join(home, `state/${gate.id}.meta`), "project=product\n");
    for (const transition of ["open", "wrong-key", "resolved", "reopened"]) {
      for (const gate of gates) {
        let status = `working: Implementing\nneeds-decision [at=1791635123] [key=route]: Choose ${gate.id}\n`;
        if (gate.id !== "dependency") status += "working: Progress on another step\n";
        if (transition === "wrong-key") status += "resolved [key=other]: Unrelated answer\n";
        if (["resolved", "reopened"].includes(transition)) status += "resolved [key=route]: Answered\nworking: Resumed\n";
        if (transition === "reopened") status += `needs-decision [key=route] [at=1791635124]: Choose ${gate.id}\n`;
        await writeFile(path.join(home, `state/${gate.id}.status`), status);
      }
      const data = await read(home);
      const split = data.workSplit;
      const items = new Map(split.items.map((item) => [item.id, item]));
      const displayed = large ? split.large.projects : split.tight.inProgress.items;
      for (const gate of gates) {
        const item = items.get(gate.id);
        assert.equal(item.status, transition === "resolved" ? gate.status : "captain-action");
        assert.equal(item.waitingOn, transition === "resolved" ? gate.reason : `Choose ${gate.id}`);
        assert.equal(displayed.find((entry) => entry.id === gate.id).waitingOn, item.waitingOn);
        assert.deepEqual(item.pendingIssues.map((issue) => issue.key), transition === "resolved" ? [] : ["route"]);
        assert.deepEqual(item.blockers, gate.blockers);
        assert.deepEqual(item.activeBlockers, gate.blockers);
        for (const field of ["holdKind", "holdReason", "holdUntil", "holdActive", "holdDeferred"]) assert.equal(item[field], gate[field]);
        assert.equal(item.holdOpen, true);
      }
      assert.equal(split.activeWorkerCount, 0);
      for (const counts of [split.counts, split.repositories[0].counts, split.repositories[0].lanes[0].counts, split.repositories[0].lanes[0].themes[0].counts]) {
        assert.equal(counts["captain-action"], transition === "resolved" ? 1 : 4);
      }
      assert.equal(data.summary.openDecisions, transition === "resolved" ? 1 : 4);
      assert.equal((await dashboardData({ FM_HOME: home }, owner, undefined, async () => ({}))).fleet.summary.openDecisions, transition === "resolved" ? 1 : 4);
    }
    assert.equal(classifyCurrent({ state: "needs-decision", holdOpen: true, holdDeferred: true, pendingIssues: [{ state: "paused" }] }), "captain-action");
    assert.equal(classifyCurrent({ state: "working", holdOpen: true, activeBlockers: ["a"], pendingIssues: [{ state: "needs-decision" }, { state: "blocked" }] }), "captain-action");
  });
}
