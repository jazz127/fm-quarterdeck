import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { foldStatusLines, projectWork } from "../work-model.js";
import { readSecondmates } from "../secondmates.js";
import { loadFirstmateHome, dashboardData } from "../server.js";
import { emptyAgentState } from "../agent-state.js";
import { parseStatusLine, parseTaskHold, decodeHoldReason } from "../firstmate-records.js";

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

test("ship terminal declarations clear decisions while second mate terminal reports preserve them", () => {
  const lines = ["needs-decision [at=1] [key=route]: Choose", "done [corr=0123456789abcdef] [at=2]: Delivered"];
  assert.equal(foldStatusLines(lines, { kind: "ship" }).pendingIssues.length, 0);
  assert.equal(foldStatusLines(lines, { kind: "scout" }).pendingIssues.length, 0);
  assert.equal(foldStatusLines(lines, { kind: "secondmate" }).pendingIssues.length, 1);
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
  assert.equal(parseTaskHold(metadata, false, "2026-10-31").holdActive, true);
  assert.equal(parseTaskHold(metadata, false, "2026-11-01").holdActive, false);
  assert.equal(parseTaskHold(metadata.replace("external", "captain"), false, "2026-11-01").holdActive, true);
  for (const date of ["2099-13-01", "2099-02-30", "invalid"]) assert.equal(parseTaskHold(`(hold-until: ${date})`, false).holdUntil, null);
  for (const reason of ["fm-hold-v1:/w==", "fm-hold-v1:YQ", "plain (reason)"]) assert.equal(decodeHoldReason(reason), reason);
  const nested = "fm-hold-v1:U2FtcGxl";
  assert.equal(decodeHoldReason(`fm-hold-v1:${Buffer.from(nested).toString("base64")}`), nested, "decode only once");
});

test("structured review promotion remains available while backlog gates retain priority", async (t) => {
  const home = await fixture(t, `## In flight\n- [ ] held - Synthetic held review (repo: product) ${hold("Await the captain")} (hold-until: 2099-11-01)\n- [ ] review - Synthetic ordinary review (repo: product)\n`);
  for (const id of ["held", "review"]) {
    await writeFile(path.join(home, `state/${id}.meta`), "project=product\nvalidation_state=running\n");
    await writeFile(path.join(home, `state/${id}.status`), "paused [corr=0123456789abcdef] [at=1791635123]: Review gate\n");
  }
  const items = Object.fromEntries((await read(home)).workSplit.items.map((item) => [item.id, item]));
  assert.equal(items.held.status, "waiting");
  assert.equal(items.review.status, "review");
});

test("repeated canonical hold fields retain every edge and use producer scalar precedence", () => {
  const reason = "Choose the final route";
  const metadata = `(hold: Old reason) (hold-kind: external) (hold-until: 2020-01-01) ${hold(reason)} (hold-until: 2099-11-01) blocked-by: a blocked-by: b,c blocked-by: a`;
  const parsed = parseTaskHold(metadata, false, "2026-11-01");
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
    assert.equal(parseTaskHold(metadata, false).holdDeferred, true, timezone);
    assert.equal(parseTaskHold(metadata, false).holdActive, true, timezone);
    t.mock.timers.setTime(Date.parse(after));
    assert.equal(parseTaskHold(metadata, false).holdDeferred, false, timezone);
    assert.equal(parseTaskHold(metadata, false).holdActive, false, timezone);
    assert.equal(parseTaskHold(metadata.replace("external", "captain"), false).holdActive, true, timezone);
  }
});

for (const large of [false, true]) {
  test(`complete backlog resolves dependencies for ${large ? "large" : "ordinary"} work`, async (t) => {
    const body = large ? "  Large project\n" : "";
    const backlog = (finishedA, finishedB) => `## Queued\n- [ ] dependent - Synthetic dependent blocked-by: a blocked-by: b blocked-by: missing (repo: obsolete) (repo: product)\n${body}- [ ] review - Synthetic review blocked-by: a blocked-by: b (repo: product)\n${body}- [ ] dangling - Synthetic legacy edge blocked-by: missing (repo: product)\n${body}${finishedA ? "" : "- [ ] a - Synthetic prerequisite (repo: product)\n"}## In flight\n${finishedB ? "" : "- [ ] b - Synthetic prerequisite (repo: product)\n"}## Done\n${finishedA ? "- [x] a - Synthetic prerequisite (repo: product)\n" : ""}${finishedB ? "- [x] b - Synthetic prerequisite (repo: product)\n" : ""}- [x] closed - Synthetic closed blocked-by: a (repo: product) (theme: Old) (theme: Final) (done 2020-01-01) (reported 2020-02-01)\n${body}`;
    const home = await fixture(t, backlog(false, false));
    await mkdir(path.join(home, "projects/product"), { recursive: true });
    await writeFile(path.join(home, "state/review.meta"), "project=product\nvalidation_state=running\n");
    await writeFile(path.join(home, "state/review.status"), "paused: Review gate\n");
    for (const [finishedA, finishedB, activeBlockers] of [[false, false, ["a", "b"]], [true, false, ["b"]], [true, true, []], [false, false, ["a", "b"]]]) {
      await writeFile(path.join(home, "data/backlog.md"), backlog(finishedA, finishedB));
      const split = (await read(home)).workSplit;
      const items = Object.fromEntries(split.items.map((item) => [item.id, item]));
      assert.deepEqual(items.dependent.blockers, ["a", "b", "missing"]);
      assert.deepEqual(items.dependent.activeBlockers, activeBlockers);
      assert.equal(items.dependent.repository, "product");
      assert.equal(items.dependent.status, activeBlockers.length ? "waiting" : "backlog");
      assert.equal(items.review.status, activeBlockers.length ? "waiting" : "review");
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
    await writeFile(path.join(home, "state/worker.meta"), "project=product\nvalidation_state=running\n");
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
    for (const kind of ["ship", "scout", "secondmate", "unknown"]) {
      const folded = foldStatusLines((prefix + transfer).trim().split("\n"), { kind });
      const verified = await projectWork([{ id: "worker", state: folded.latest.state, pendingIssues: folded.pendingIssues,
        inFlight: true, endpointLive: true, endpointEvidence: "live process incarnation", reviewRun: true }], emptyAgentState());
      assert.equal(verified.items[0].status, "waiting");
      assert.equal(verified.items[0].isLive, false);
      assert.equal(verified.activeWorkerCount, 0);
    }
    await writeFile(path.join(home, "state/worker.status"), prefix + transfer + "working [at=3]: Resumed\nresolved [key=other] [at=4]: Unrelated answer\n");
    const resumed = (await read(home)).workSplit.items[0];
    assert.equal(resumed.sourceState, "working");
    assert.equal(resumed.status, "review");
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

test("captain-held second mates display idle and stay separate from task work", async (t) => {
  const home = await fixture(t, "## In flight\n- [ ] mate - Synthetic supervisor (repo: product)\n- [ ] task - Synthetic task (repo: product)\n");
  await writeFile(path.join(home, "state/mate.meta"), "kind=secondmate\n");
  const prefix = "working: Reviewing\nneeds-decision [key=route]: Choose\n";
  await writeFile(path.join(home, "state/mate.status"), prefix + "captain-held [key=route]: Tracked by captain choice\n");
  const options = { reader: { text: (file) => readFile(file, "utf8") }, parseMeta: (text) => Object.fromEntries(text.trim().split("\n").map((line) => line.split("="))), probe: async () => true };
  const held = await readSecondmates(home, ["mate.meta", "mate.status"], options);
  assert.equal(held.view.items[0].state, "idle");
  assert.deepEqual((await read(home)).workSplit.items.map((item) => item.id), ["task"]);
  await writeFile(path.join(home, "state/mate.status"), prefix + "captain-held [key=route]: Tracked by captain choice\nworking: Resumed\n");
  const resumed = await readSecondmates(home, ["mate.meta", "mate.status"], options);
  assert.equal(resumed.view.items[0].state, "live");
});
