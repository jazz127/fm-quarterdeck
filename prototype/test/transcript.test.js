import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, dashboardData, loadFirstmateHome } from "../server.js";
import { createHistoryReader } from "../history-reader.js";

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-transcript-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state/branch-session"), { recursive: true });
  await writeFile(path.join(home, "data/projects.md"), "- Alpha - Test transcript\n");
  return home;
}
const turn = (role, content, timestamp = "2026-01-01T00:00:00Z") => ({ type: "message", timestamp, message: { role, content } });
const jsonl = (records) => records.map(JSON.stringify).join("\n");

test("oversized transcript and legacy status fail explicitly instead of assembling unbounded history", async (t) => {
  const home = await fixture(t);
  const file = path.join(home, "state/branch-session/large.jsonl");
  await writeFile(file, jsonl([turn("assistant", "Alpha " + "x".repeat(2048))]));
  await assert.rejects(loadFirstmateHome(home, { reader: createHistoryReader({ maxFileBytes: 1024 }) }), /history exceeds safe read limits/i);
  await rm(file);
  await writeFile(path.join(home, "state/old.meta"), "project=Alpha\n");
  await writeFile(path.join(home, "state/old.status"), "working: " + "x".repeat(2048));
  await assert.rejects(loadFirstmateHome(home, { reader: createHistoryReader({ maxFileBytes: 1024 }) }), /history exceeds safe read limits/i);
});

test("one JSONL record cannot expand into unbounded message parts", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/branch-session/parts.jsonl"), jsonl([turn("assistant", Array.from({ length: 11 }, () => ({ type: "text", text: "Alpha part" })))]));
  await assert.rejects(loadFirstmateHome(home, { reader: createHistoryReader({ maxMessages: 10 }) }), /history exceeds safe read limits/i);
});

test("all sessions, user turns, main replies, thinking and crew history survive old caps", async (t) => {
  const home = await fixture(t);
  const old = [turn("user", "Alpha ordinary captain chat"),
    turn("user", [{ type: "text", text: "<skill name=\"x\">noise</skill>" }, { type: "text", text: "Alpha keep this ordinary part" }]),
    turn("user", "FIRSTMATE_OP: noise"), turn("user", "FIRSTMATE SUPERVISION WAKE: noise"),
    { type: "custom_message", customType: "fm-main-mirror", timestamp: "2026-01-01", content: "[main] Alpha main reply" },
    ...Array.from({ length: 90 }, (_, i) => turn("assistant", [{ type: "thinking", thinking: `Alpha thought ${i}` }, { type: "text", text: `Alpha reply ${i}` }]))];
  await writeFile(path.join(home, "state/branch-session/old.jsonl"), jsonl(old));
  await writeFile(path.join(home, "state/branch-session/z-new.jsonl"), jsonl([turn("assistant", "Alpha latest", "2026-02-01")]) + '\n{"partial":');
  await writeFile(path.join(home, "state/.branch-session"), path.join(home, "state/branch-session/z-new.jsonl"));
  await writeFile(path.join(home, "state/alpha.meta"), "project=Alpha\n");
  await writeFile(path.join(home, "state/alpha.status"), Array.from({ length: 45 }, (_, i) => `working: crew ${i}`).join("\n"));
  const data = await loadFirstmateHome(home);
  const alpha = data.lanes[0].messages;
  assert.equal(alpha.filter((m) => m.kind === "crew").length, 45);
  assert.equal(alpha.filter((m) => m.kind === "thinking").length, 90);
  assert.equal(alpha.filter((m) => m.role === "captain").length, 2);
  assert.equal(alpha.filter((m) => m.transcriptSessionId).length, 184);
  assert.ok(alpha.some((m) => m.text === "Alpha main reply" && m.transcriptOrigin === "main mirror" && m.kind === "conversation"));
  assert.ok(alpha.some((m) => m.text === "Alpha reply 0" && m.kind === "branch"), "branch assistant text is not a main reply");
  assert.ok(alpha.some((m) => m.text === "Alpha latest"));
  assert.equal(data.transcript.sessions.length, 2, "pointer does not double-load a file");
  assert.equal(data.transcript.sessions.reduce((n, s) => n + s.skippedRecords, 0), 1);
  assert.equal(new Set(alpha.filter((m) => m.recordId).map((m) => m.recordId)).size, 184);
  assert.equal(JSON.stringify(data).includes(home), false);
});

test("zero and one active tasks retain the same two recent sessions without duplicating older pages", async (t) => {
  const home = await fixture(t);
  for (const [n, state] of ["done", "done", "done", "done"].entries()) {
    await writeFile(path.join(home, "state", `task-${n}.meta`), "project=Alpha\n");
    const file = path.join(home, "state", `task-${n}.status`);
    await writeFile(file, `${state}: task-${n}\n`);
    await utimes(file, new Date(`2026-03-0${n + 1}T00:00:00Z`), new Date(`2026-03-0${n + 1}T00:00:00Z`));
  }
  const none = await loadFirstmateHome(home);
  assert.deepEqual(none.lanes[0].sessions.filter((s) => s.loaded).map((s) => s.id), ["task-3", "task-2"]);
  await writeFile(path.join(home, "state", "task-0.status"), "working: old active\n");
  await utimes(path.join(home, "state", "task-0.status"), new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
  const one = await loadFirstmateHome(home);
  assert.deepEqual(one.lanes[0].sessions.filter((s) => s.loaded).map((s) => s.id), ["task-3", "task-2", "task-0"]);
  const page = await loadFirstmateHome(home, { older: 1, sessionIds: ["task-0", "task-1"] });
  assert.equal(page.lanes[0].sessions.filter((s) => s.loaded).length, 4);
  assert.equal(new Set(page.lanes[0].messages.filter((m) => m.kind === "crew").map((m) => m.taskId)).size, 4);
});

test("default session union keeps all active and newest two; older and direct links read exact sources", async (t) => {
  const home = await fixture(t);
  const tasks = [
    ["active-old", "working", 1], ["paused-old", "paused", 2], ["active-mid", "needs-decision", 3],
    ["done-old", "done", 4], ["done-new", "done", 5], ["done-newest", "done", 6],
  ];
  for (const [id, state, day] of tasks) {
    await writeFile(path.join(home, "state", `${id}.meta`), "project=Alpha\n");
    const status = path.join(home, "state", `${id}.status`);
    await writeFile(status, `${state}: ${id}\n`);
    await utimes(status, new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`), new Date(`2026-01-${String(day).padStart(2, "0")}T00:00:00Z`));
  }
  const first = await loadFirstmateHome(home);
  assert.deepEqual(first.lanes[0].sessions.filter((s) => s.loaded).map((s) => s.id).sort(),
    ["active-old", "paused-old", "active-mid", "done-new", "done-newest"].sort());
  assert.equal(first.lanes[0].messages.some((m) => m.taskId === "done-old"), false);
  const linked = await loadFirstmateHome(home, { sessionIds: ["done-old"] });
  assert.ok(linked.lanes[0].messages.some((m) => m.taskId === "done-old"));
  const older = await loadFirstmateHome(home, { older: 1 });
  assert.ok(older.lanes[0].sessions.every((s) => s.loaded));

  // Disk inventory is not an invitation to parse or transfer all files.
  for (let n = 0; n < 5; n++) {
    const file = path.join(home, "state/branch-session", `${n}.jsonl`);
    await writeFile(file, jsonl([turn("assistant", `Alpha disk ${n}`)]));
    await utimes(file, new Date(`2026-02-0${n + 1}T00:00:00Z`), new Date(`2026-02-0${n + 1}T00:00:00Z`));
  }
  const recent = await loadFirstmateHome(home);
  assert.deepEqual(recent.transcript.sessions.filter((s) => s.loaded).map((s) => s.id), ["state/branch-session/4.jsonl", "state/branch-session/3.jsonl"]);
  assert.equal(recent.lanes[0].messages.some((m) => m.text === "Alpha disk 0"), false);
  const historical = await loadFirstmateHome(home, { diskIds: ["state/branch-session/0.jsonl"], diskOlder: 1 });
  assert.ok(historical.lanes[0].messages.some((m) => m.text === "Alpha disk 0"));
  assert.equal(new Set(historical.transcript.sessions.map((s) => s.id)).size, 5);
});

test("large history stays accessible while Overview transfer excludes it", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/alpha.meta"), "project=Alpha\n");
  await writeFile(path.join(home, "state/alpha.status"), "working: active\n");
  const records = Array.from({ length: 5000 }, (_, i) => turn("assistant", `Alpha historical message ${i} ${"x".repeat(100)}`));
  await writeFile(path.join(home, "state/branch-session/history.jsonl"), jsonl(records));
  const compact = await dashboardData({ FM_HOME: home });
  assert.equal(compact.fleet.projects[0].agents, 0, "unverified process is not active");
  assert.ok(JSON.stringify(compact).length < 10000, "dashboard response must not include transcript history");
  assert.doesNotMatch(JSON.stringify(compact), /historical message 4999/);
  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dashboard = await (await fetch(`${base}/api/dashboard`)).json();
  assert.equal(dashboard.fleet.projects[0].agents, 0);
  const full = await (await fetch(`${base}/api/lanes`)).json();
  assert.equal(full.lanes[0].messages.filter((message) => message.transcriptSessionId).length, 5000);
  assert.ok(full.lanes[0].messages.some((message) => message.text.includes("historical message 4999")));
});

test("native main replies replace duplicate main mirrors without collapsing later repeated replies", async (t) => {
  const home = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "fm-pi-dedupe-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const directory = path.join(external, `--${home.replace(/^\/+/, "").replaceAll("/", "-")}--`);
  await mkdir(directory);
  const header = { type: "session", cwd: home };
  await writeFile(path.join(directory, "main.jsonl"), jsonl([
    header,
    turn("assistant", "Alpha same captain-facing reply", "2026-01-01T00:00:00Z"),
    turn("assistant", "Alpha same captain-facing reply", "2026-01-01T00:02:00Z"),
  ]));
  await writeFile(path.join(home, "state/branch-session/mirror-a.jsonl"), jsonl([
    { type: "custom_message", customType: "fm-main-mirror", timestamp: "2026-01-01T00:00:02Z", content: "[main] Alpha same captain-facing reply" },
  ]));
  await writeFile(path.join(home, "state/branch-session/mirror-b.jsonl"), jsonl([
    { type: "custom_message", customType: "fm-main-mirror", timestamp: "2026-01-01T00:00:03Z", content: "[main] Alpha same captain-facing reply" },
  ]));
  await writeFile(path.join(home, "state/.branch-mirror-cursor"), JSON.stringify({ file: path.join(directory, "main.jsonl"), index: 3 }));

  const data = await loadFirstmateHome(home);
  const replies = data.lanes.at(-1).messages.filter((message) => message.text === "Alpha same captain-facing reply");
  assert.equal(replies.length, 2, "duplicate sources collapse but the later genuine repeated turn survives");
  assert.ok(replies.every((message) => message.transcriptOrigin === "main Pi"));
  assert.equal(new Set(replies.map((message) => message.recordId)).size, 2);
});

test("main-session and local pointer transcripts load; external pointers and symlinks are not followed", async (t) => {
  const home = await fixture(t);
  await mkdir(path.join(home, "state/main-session"));
  await writeFile(path.join(home, "state/main-session/main.jsonl"), jsonl([turn("user", "Main captain turn")]));
  await mkdir(path.join(home, "archive"));
  await writeFile(path.join(home, "archive/saved.jsonl"), jsonl([turn("assistant", "Historical main turn")]));
  await writeFile(path.join(home, "state/.main-session"), "archive/saved.jsonl");
  await writeFile(path.join(home, "state/.branch-mirror-cursor"), JSON.stringify({ file: "/outside-private-home/main.jsonl", index: 50 }));
  await symlink("/outside-private-home/main.jsonl", path.join(home, "state/branch-session/link.jsonl"));
  const data = await loadFirstmateHome(home);
  assert.equal(data.transcript.sessions.length, 2);
  assert.equal(data.lanes.at(-1).messages.length, 2);
  assert.equal(data.transcript.warnings.length, 1);
  assert.equal(JSON.stringify(data).includes("outside-private-home"), false);
});

test("home-specific Pi cursor loads all matching main sessions, never another cwd", async (t) => {
  const home = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "fm-pi-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const directory = path.join(external, `--${home.replace(/^\/+/, "").replaceAll("/", "-")}--`);
  await mkdir(directory);
  const header = { type: "session", cwd: home };
  await writeFile(path.join(directory, "main.jsonl"), jsonl([header, turn("user", "Real captain"), turn("assistant", [{ type: "thinking", thinking: "Native stock thinking" }, { type: "toolCall", name: "read", arguments: { path: "test" } }]), turn("toolResult", [{ type: "text", text: "Real tool result" }])]));
  await writeFile(path.join(directory, "older.jsonl"), jsonl([header, turn("assistant", "Older main reply")]));
  await writeFile(path.join(directory, "wrong-home.jsonl"), jsonl([{ type: "session", cwd: "/other/home" }, turn("user", "Must not leak")]));
  await writeFile(path.join(home, "state/.branch-mirror-cursor"), JSON.stringify({ file: path.join(directory, "main.jsonl"), index: 10 }));
  const data = await loadFirstmateHome(home);
  const messages = data.lanes.at(-1).messages;
  assert.equal(data.transcript.sessions.length, 2);
  assert.equal(messages.length, 5);
  assert.equal(messages.filter((m) => m.kind === "thinking").length, 1);
  assert.equal(messages.filter((m) => m.kind === "tools").length, 2);
  assert.equal(data.transcript.warnings.length, 1);
  assert.ok(messages.every((m) => m.source.startsWith("main-pi-session/") && m.transcriptOrigin === "main Pi"));
  assert.equal(JSON.stringify(data).includes(external), false);
  assert.equal(JSON.stringify(data).includes("Must not leak"), false);
});

test("fleet notes use the durable ledger, real epoch, project routing and no silent or duplicate notices", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/alpha-task.meta"), "project=Alpha\n");
  await writeFile(path.join(home, "state/branch-outcomes.jsonl"), jsonl([
    { seq: 1, epoch: 1700000000, task: "alpha-task", summary: "Underway", verdict: "routine", silent: false },
    { seq: 2, epoch: 1700000001, task: "alpha-task", summary: "Internal only", silent: true },
    { seq: 3, epoch: 1700000002, task: "unknown", summary: "Unrouted real note" },
  ]));
  await writeFile(path.join(home, "state/branch-session/a.jsonl"), jsonl([{ type: "custom_message", customType: "fm-branch-merge", display: true, timestamp: "2026-01-01", content: "⛵ alpha-task: Underway" }]));
  await writeFile(path.join(home, "state/terminal-outcomes.jsonl"), jsonl([{ epoch: 1700000003, task_id: "alpha-task", summary: "Terminal outcome" }]));
  const data = await loadFirstmateHome(home);
  const notes = data.lanes.at(-1).messages;
  assert.equal(notes.length, 3);
  assert.equal(data.lanes[0].messages.length, 2);
  assert.equal(notes[0].occurredAt, new Date(1700000000000).toISOString());
  assert.ok(notes.every((m) => m.kind === "supervision"));
  assert.equal(data.transcript.outcomeSources.length, 2);
});
