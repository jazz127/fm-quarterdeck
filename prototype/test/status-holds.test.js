import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { foldStatusLines } from "../work-model.js";
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
    const home = await fixture(t, `## Queued\n- [ ] undated - Synthetic choice (repo: product) ${hold(reason)}\n${body}- [ ] deferred - Synthetic deferral blocked-by: dependency-a,dependency-b (repo: product) ${hold(reason)} (hold-until: 2099-11-01)\n${body}- [ ] blocked - Synthetic blocker blocked-by: dependency-a (repo: product)\n${body}- [ ] expired - Synthetic expired (repo: product) ${hold(reason)} (hold-until: 2020-01-01)\n${body}## Done\n- [x] closed - Synthetic closed (repo: product) ${hold(reason)}\n${body}`);
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
