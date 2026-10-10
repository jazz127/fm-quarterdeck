import assert from "node:assert/strict";
import { appendFile, mkdtemp, mkdir, writeFile, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createServer, dashboardData, loadFirstmateHome } from "../server.js";
import { createHistoryReader, HistoryLimitError } from "../history-reader.js";
import { claudeProjectDirectory } from "../claude-transcript.js";

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

test("an oversized transcript loads its newest whole records with a coverage warning; legacy status still fails", async (t) => {
  const home = await fixture(t);
  const file = path.join(home, "state/branch-session/large.jsonl");
  const records = Array.from({ length: 40 }, (_, i) => turn("assistant", `Alpha record ${i} ${"x".repeat(80)}`, `2026-01-01T00:00:${String(i).padStart(2, "0")}Z`));
  await writeFile(file, jsonl(records) + "\n");
  await writeFile(path.join(home, "state/.branch-session"), file);
  const reader = () => createHistoryReader({ maxFileBytes: 1024, maxLineBytes: 512 });
  const data = await loadFirstmateHome(home, { reader: reader() });
  const texts = data.lanes[0].messages.map((m) => m.text);
  assert.ok(texts.includes("Alpha record 39 " + "x".repeat(80)), "newest record is shown");
  assert.equal(texts.some((text) => text.startsWith("Alpha record 0 ")), false, "older history is not loaded");
  assert.ok(texts.length > 0 && texts.length < 40);
  const session = data.transcript.sessions.find((s) => s.id === "state/branch-session/large.jsonl");
  assert.ok(session.loaded && session.omittedBytes > 0 && session.skippedRecords === 0, "the partial leading record is dropped, not counted or parsed");
  assert.ok(data.transcript.warnings.some((w) => /large\.jsonl.*only its newest .*older history in this source is not shown/.test(w)));
  // Appending moves the window forward without renaming records already shown.
  await writeFile(file, jsonl([...records, turn("assistant", "Alpha appended", "2026-01-01T00:01:00Z")]) + "\n");
  const later = await loadFirstmateHome(home, { reader: reader() });
  const id = (snapshot) => snapshot.lanes[0].messages.find((m) => m.text.startsWith("Alpha record 39 ")).recordId;
  assert.equal(id(later), id(data));
  assert.ok(later.lanes[0].messages.some((m) => m.text === "Alpha appended"));
  await rm(file);
  await rm(path.join(home, "state/.branch-session"));
  await writeFile(path.join(home, "state/old.meta"), "project=Alpha\n");
  await writeFile(path.join(home, "state/old.status"), "working: " + "x".repeat(2048));
  await assert.rejects(loadFirstmateHome(home, { reader: createHistoryReader({ maxFileBytes: 1024 }) }), /history exceeds safe read limits/i);
});

test("one JSONL record cannot expand into unbounded message parts", async (t) => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/branch-session/parts.jsonl"), jsonl([turn("assistant", Array.from({ length: 11 }, () => ({ type: "text", text: "Alpha part" })))]));
  await assert.rejects(loadFirstmateHome(home, { reader: createHistoryReader({ maxMessages: 10 }) }), /history exceeds safe read limits/i);
});

test("all sessions, unverified user input, main replies, thinking and crew history survive old caps", async (t) => {
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
  assert.equal(alpha.filter((m) => m.role === "captain").length, 0, "a transcript role=user entry is never the Captain's");
  assert.deepEqual(alpha.filter((m) => m.kind === "input").map((m) => [m.author, m.role, m.text]),
    [["Pi session input", "input", "Alpha ordinary captain chat"], ["Pi session input", "input", "Alpha keep this ordinary part"]]);
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

test("oversized sources share the request budget: newest active windows load, a starved source is reported unloaded", async (t) => {
  const home = await fixture(t);
  for (const [n, day] of [["a", 1], ["b", 2], ["c", 3]]) {
    const file = path.join(home, "state/branch-session", `${n}.jsonl`);
    await writeFile(file, jsonl(Array.from({ length: 30 }, (_, i) => turn("assistant", `Alpha ${n} ${i} ${"x".repeat(80)}`))) + "\n");
    await utimes(file, new Date(`2026-01-0${day}T00:00:00Z`), new Date(`2026-01-0${day}T00:00:00Z`));
  }
  await writeFile(path.join(home, "state/.branch-session"), path.join(home, "state/branch-session/a.jsonl"));
  const data = await loadFirstmateHome(home, { reader: createHistoryReader({ maxFileBytes: 1024, maxLineBytes: 512, maxTotalBytes: 2600, windowReserveBytes: 400 }) });
  const loaded = Object.fromEntries(data.transcript.sessions.map((s) => [s.id.split("/").at(-1), s.loaded]));
  assert.deepEqual(loaded, { "a.jsonl": true, "b.jsonl": false, "c.jsonl": true }, "active pointer and newest file win the budget");
  assert.ok(data.transcript.warnings.some((w) => /b\.jsonl was not loaded: this request's read budget/.test(w)));
  const deepLink = await loadFirstmateHome(home, { diskIds: ["state/branch-session/b.jsonl"], reader: createHistoryReader({ maxFileBytes: 1024, maxLineBytes: 512, maxTotalBytes: 2600, windowReserveBytes: 400 }) });
  assert.ok(deepLink.lanes[0].messages.some((m) => m.text.startsWith("Alpha b 29 ")), "an explicit selection is read first");
});

const claudeHome = async (t, home) => {
  const config = await mkdtemp(path.join(os.tmpdir(), "fm-claude-config-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const directory = path.join(config, "projects", home.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(directory, { recursive: true });
  return { config, directory };
};
const claudeRecord = (type, content, extra = {}) => ({ type, timestamp: "2026-10-06T12:00:00Z", sessionId: "primary", cwd: "/home", message: { role: type, content }, ...extra });

test("Claude Code primary transcript maps dialogue, tools and harness for this home only", async (t) => {
  const home = await fixture(t);
  const { config, directory } = await claudeHome(t, home);
  const primary = "11111111-2222-3333-4444-555555555555";
  await writeFile(path.join(home, "state/.lock-session"), `${primary}\n`);
  const at = (second) => ({ timestamp: `2026-10-06T12:00:${String(second).padStart(2, "0")}Z` });
  await writeFile(path.join(directory, `${primary}.jsonl`), jsonl([
    { type: "last-prompt", leafUuid: "x", sessionId: primary },
    { type: "permission-mode", permissionMode: "auto", sessionId: primary },
    claudeRecord("user", "Alpha captain asks for status", { ...at(1), origin: { kind: "human" } }),
    claudeRecord("assistant", [{ type: "thinking", thinking: "", signature: "redacted" }], at(2)),
    claudeRecord("assistant", [{ type: "thinking", thinking: "Alpha native thought" }], at(3)),
    claudeRecord("assistant", [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }], at(4)),
    claudeRecord("user", [{ type: "tool_result", tool_use_id: "tool-1", content: "Alpha tool output" }], at(5)),
    claudeRecord("assistant", [{ type: "text", text: "[fm-lane Alpha]\nAlpha reply in a lane block\n[end Alpha]" }], at(6)),
    { type: "attachment", ...at(7), attachment: { type: "hook_success", content: "Alpha hook noise" } },
    { type: "attachment", ...at(8), attachment: { type: "queued_command", prompt: "Alpha queued captain prompt", commandMode: "prompt", origin: { kind: "human" } } },
    { type: "attachment", ...at(8), attachment: { type: "queued_command", prompt: "<task-notification>Alpha queued wake</task-notification>", origin: { kind: "task-notification" } } },
    claudeRecord("user", "<task-notification>\n<summary>Stop hook feedback</summary>\n</task-notification>\n<system-reminder>\nAlpha stop hook wake\n</system-reminder>", { ...at(9), origin: { kind: "task-notification" } }),
    claudeRecord("user", "<task-notification>\n<summary>Alpha background agent finished</summary>\n</task-notification>", { ...at(10), origin: { kind: "task-notification" } }),
    claudeRecord("user", "Base directory for this skill: Alpha skill dump", { ...at(11), isMeta: true }),
    claudeRecord("user", "Alpha compaction summary", { ...at(12), isCompactSummary: true }),
    claudeRecord("user", "<command-name>/quiet</command-name>\n<command-message>quiet</command-message>\n<command-args>Alpha</command-args>", at(13)),
    claudeRecord("user", "<local-command-stdout>Alpha command output</local-command-stdout>", at(14)),
    claudeRecord("user", [{ type: "text", text: "[Request interrupted by user]" }], at(15)),
    claudeRecord("user", "Alpha captain with reminder<system-reminder>hidden Alpha reminder</system-reminder>", { ...at(16), origin: { kind: "human" } }),
    claudeRecord("user", "FIRSTMATE_OP: Alpha envelope", { ...at(17), origin: { kind: "human" } }),
    claudeRecord("assistant", [{ type: "text", text: "Alpha sidechain" }], { ...at(18), isSidechain: true }),
    { type: "system", subtype: "turn_duration", ...at(19) },
  ]) + "\n");
  await writeFile(path.join(directory, "other-newer.jsonl"), jsonl([claudeRecord("user", "Alpha must not load from a non-primary session", { origin: { kind: "human" } })]));
  const sibling = path.join(config, "projects", `${home.replace(/[^a-zA-Z0-9]/g, "-")}-other`);
  await mkdir(sibling);
  await writeFile(path.join(sibling, `${primary}.jsonl`), jsonl([claudeRecord("user", "Alpha other home must not leak", { origin: { kind: "human" } })]));

  assert.equal((await loadFirstmateHome(home)).transcript.sessions.length, 0, "no Claude config directory, no Claude source");
  const data = await loadFirstmateHome(home, { claudeConfigDir: config });
  const messages = [...new Map(data.lanes.flatMap((lane) => lane.messages).filter((m) => m.transcriptOrigin === "main Claude").map((m) => [m.recordId, m])).values()];
  const byText = (text) => messages.find((m) => m.text === text);
  assert.deepEqual(data.transcript.sessions.map((s) => [s.id, s.loaded]), [[`claude-main-session/${primary}.jsonl`, true]]);
  // Claude Code's origin.kind=human marks terminal input, which injected text shares: not proof of the Captain.
  for (const text of ["Alpha captain asks for status", "Alpha queued captain prompt", "/quiet Alpha", "Alpha captain with reminder"]) {
    assert.deepEqual([byText(text).author, byText(text).role, byText(text).kind], ["Claude session input", "input", "input"], text);
  }
  assert.equal(messages.some((m) => m.role === "captain" || m.author === "Captain"), false);
  assert.equal(byText("Alpha native thought").kind, "thinking");
  assert.equal(messages.filter((m) => m.kind === "thinking").length, 1, "redacted thinking is never shown or invented");
  assert.equal(byText("Bash\n{\n  \"command\": \"ls\"\n}").kind, "tools");
  assert.deepEqual([byText("Alpha tool output").kind, byText("Alpha tool output").author], ["tools", "Bash"]);
  const laneReply = messages.find((m) => m.text.includes("Alpha reply in a lane block"));
  assert.deepEqual([laneReply.kind, laneReply.author, laneReply.role], ["conversation", "Firstmate", "firstmate"], "lane blocks route as Firstmate replies");
  for (const text of ["<task-notification>\n<summary>Alpha background agent finished</summary>\n</task-notification>", "Alpha command output", "[Request interrupted by user]"]) {
    assert.equal(byText(text)?.kind, "harness", text);
  }
  const serialized = JSON.stringify(data);
  for (const hidden of ["hook noise", "queued wake", "stop hook wake", "skill dump", "compaction summary", "hidden Alpha reminder", "Alpha envelope", "Alpha sidechain", "non-primary", "other home", config]) {
    assert.equal(serialized.includes(hidden), false, hidden);
  }
  assert.equal(messages.length, 11);
  assert.ok(messages.every((m) => m.recordId.startsWith(`claude-main-session/${primary}.jsonl@`)));
  assert.equal(new Set(messages.map((m) => m.recordId)).size, messages.length);
  assert.match(data.transcript.note, /Claude Code primary session included\./);
});

test("Claude Code primary is inferred from the newest non-wake session and never followed through symlinks", async (t) => {
  const home = await fixture(t);
  const { config, directory } = await claudeHome(t, home);
  const write = async (name, records, day) => {
    const file = path.join(directory, name);
    await writeFile(file, jsonl(records));
    await utimes(file, new Date(`2026-10-0${day}T00:00:00Z`), new Date(`2026-10-0${day}T00:00:00Z`));
  };
  await write("old-primary.jsonl", [claudeRecord("user", "Alpha older primary", { origin: { kind: "human" } })], 1);
  await write("primary.jsonl", [{ type: "last-prompt", leafUuid: "x" }, claudeRecord("user", "Alpha inferred primary", { origin: { kind: "human" } })], 2);
  await write("secondary.jsonl", [{ type: "queue-operation", operation: "enqueue", content: "MAIN DIALOG MIRROR (read-only context)" }, claudeRecord("user", "Alpha secondary wake")], 3);
  await write("wake.jsonl", [{ type: "queue-operation", operation: "enqueue", content: "FIRSTMATE SUPERVISION WAKE: check" }, claudeRecord("user", "Alpha wake session")], 4);
  const data = await loadFirstmateHome(home, { claudeConfigDir: config });
  const texts = data.lanes[0].messages.map((m) => m.text);
  assert.deepEqual(texts, ["Alpha inferred primary"]);
  assert.match(data.transcript.note, /inferred as the newest non-wake session/);

  await writeFile(path.join(home, "state/.lock-session"), "../escape\n");
  const invalid = await loadFirstmateHome(home, { claudeConfigDir: config });
  assert.ok(invalid.transcript.warnings.some((w) => /state\/\.lock-session names no Claude Code transcript/.test(w)));
  assert.deepEqual(invalid.lanes[0].messages.map((m) => m.text), ["Alpha inferred primary"]);

  const outside = await mkdtemp(path.join(os.tmpdir(), "fm-claude-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFile(path.join(outside, "linked.jsonl"), jsonl([claudeRecord("user", "Alpha linked outside", { origin: { kind: "human" } })]));
  await symlink(path.join(outside, "linked.jsonl"), path.join(directory, "linked.jsonl"));
  await writeFile(path.join(home, "state/.lock-session"), "linked\n");
  const linked = await loadFirstmateHome(home, { claudeConfigDir: config });
  assert.equal(JSON.stringify(linked).includes("linked outside"), false, "a symlinked session file is not followed");

  const linkedConfig = await mkdtemp(path.join(os.tmpdir(), "fm-claude-linked-config-"));
  t.after(() => rm(linkedConfig, { recursive: true, force: true }));
  await mkdir(path.join(linkedConfig, "projects"));
  await symlink(directory, path.join(linkedConfig, "projects", home.replace(/[^a-zA-Z0-9]/g, "-")));
  const linkedDirectory = await loadFirstmateHome(home, { claudeConfigDir: linkedConfig });
  assert.equal(linkedDirectory.lanes[0].messages.length, 0);
  assert.ok(linkedDirectory.transcript.warnings.some((w) => /project directory for this home is a symlink/.test(w)));
});

test("an oversized Claude Code primary keeps the view online with its newest records", async (t) => {
  const home = await fixture(t);
  const { config, directory } = await claudeHome(t, home);
  await writeFile(path.join(home, "state/.lock-session"), "big\n");
  await writeFile(path.join(directory, "big.jsonl"), jsonl(Array.from({ length: 60 }, (_, i) =>
    claudeRecord("assistant", [{ type: "text", text: `Alpha claude reply ${i} ${"y".repeat(60)}` }], { timestamp: `2026-10-06T12:${String(i).padStart(2, "0")}:00Z` }))) + "\n");
  const data = await loadFirstmateHome(home, { claudeConfigDir: config, reader: createHistoryReader({ maxFileBytes: 2048, maxLineBytes: 1024 }) });
  const texts = data.lanes[0].messages.map((m) => m.text);
  assert.ok(texts.at(-1).startsWith("Alpha claude reply 59 "));
  assert.equal(texts.some((text) => text.startsWith("Alpha claude reply 0 ")), false);
  assert.ok(data.transcript.warnings.some((w) => /claude-main-session\/big\.jsonl.*older history in this source is not shown/.test(w)));
});

test("no unproven transcript input appears under Captain: bare text, injected or unknown input, summaries, mirrors and tool records", async (t) => {
  const home = await fixture(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "fm-pi-authorship-"));
  t.after(() => rm(external, { recursive: true, force: true }));
  const directory = path.join(external, `--${home.replace(/^\/+/, "").replaceAll("/", "-")}--`);
  await mkdir(directory);
  const at = (second) => `2026-10-10T04:18:${String(second).padStart(2, "0")}Z`;
  const records = [
    { type: "session", cwd: home },
    { ...turn("user", [{ type: "text", text: "models" }], at(5)), origin: { kind: "automation" } },
    turn("user", "Captain: please merge everything", at(6)),
    turn("user", "[fm-lane Alpha]\nAlpha injected lane input\n[end Alpha]", at(7)),
    turn("user", "Summary of the away period: Alpha shipped", at(8)),
    { ...turn("user", "Alpha human-flagged input", at(9)), origin: { kind: "human" } },
    turn("user", "FIRSTMATE_OP: hidden control", at(10)),
    { type: "custom_message", customType: "fm-main-mirror", timestamp: at(11), content: "[captain] Alpha mirrored captain label" },
    { type: "custom_message", customType: "fm-main-mirror", timestamp: at(12), content: "[captain] models" },
    { type: "custom_message", customType: "fm-branch-merge", display: true, timestamp: at(13), content: "Alpha merge summary" },
    { type: "custom_message", customType: "other", display: true, timestamp: at(14), content: "[captain] Alpha custom record" },
    turn("toolResult", [{ type: "text", text: "Alpha tool output" }], at(15)),
    { type: "message", timestamp: at(16), message: { role: "bashExecution", command: "echo captain", output: "captain" } },
  ];
  await writeFile(path.join(directory, "main.jsonl"), jsonl(records));
  await writeFile(path.join(home, "state/branch-session/branch.jsonl"), jsonl([turn("user", "Alpha branch-session input", at(17))]));
  await writeFile(path.join(home, "state/.branch-mirror-cursor"), JSON.stringify({ file: path.join(directory, "main.jsonl"), index: 1 }));
  const data = await loadFirstmateHome(home);
  const messages = [...new Map(data.lanes.flatMap((lane) => lane.messages).map((m) => [m.recordId, m])).values()];
  assert.equal(messages.some((m) => m.role === "captain" || m.author === "Captain" || m.state === "captain"), false, "nothing unproven is the Captain's");
  const inputs = messages.filter((m) => m.kind === "input");
  assert.deepEqual(inputs.map((m) => m.text).sort(), ["Alpha branch-session input", "Alpha human-flagged input", "[fm-lane Alpha]\nAlpha injected lane input\n[end Alpha]", "Alpha mirrored captain label",
    "Captain: please merge everything", "Summary of the away period: Alpha shipped", "models"].sort());
  assert.ok(inputs.every((m) => m.role === "input" && m.author === "Pi session input" && m.occurredAt && m.recordId), "text, clock and record id are kept");
  const models = inputs.find((m) => m.text === "models");
  assert.deepEqual([models.source, models.transcriptOrigin, models.occurredAt], [`main-pi-session/main.jsonl`, "main Pi", at(5).replace("Z", ".000Z")]);
  assert.equal(inputs.filter((m) => m.text === "models").length, 1, "the [captain] mirror of a native input deduplicates instead of reappearing");
  assert.equal(messages.some((m) => m.text.includes("hidden control")), false);
  assert.ok(messages.some((m) => m.text === "Alpha merge summary" && m.author === "Fleet"));
  assert.ok(messages.some((m) => m.text === "[captain] Alpha custom record" && m.kind === "harness" && m.role === "firstmate"));
  assert.ok(messages.filter((m) => m.kind === "tools").every((m) => m.role === "firstmate"));
  assert.ok(inputs.every((m) => !m.author.startsWith("Firstmate")), "unverified input is not relabelled Firstmate");
});

const MiB = 1024 * 1024;
const largeTurn = (text, timestamp = "2026-10-01T00:00:00Z") => JSON.stringify({ type: "assistant", timestamp,
  message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
// Ignored ordinary metadata keeps size independent of message count/content.
const paddingBase = JSON.stringify({ type: "system", padding: "" });
const paddingRecord = paddingBase.slice(0, -2) + "x".repeat(4096 - Buffer.byteLength(paddingBase) - 1) + '"}\n';
function largeTranscript(size) {
  const newest = largeTurn("acme retained reply") + largeTurn("acme newest reply", "2026-10-01T00:01:00Z");
  const old = paddingRecord.repeat(Math.floor((size - Buffer.byteLength(newest)) / 4096));
  const gap = size - Buffer.byteLength(old) - Buffer.byteLength(newest);
  return old + " ".repeat(gap - 1) + "\n" + newest;
}
async function largeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-large-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), config = path.join(root, "claude");
  await mkdir(path.join(home, "data"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- acme - example-app\n");
  await writeFile(path.join(home, "state/.lock-session"), "synthetic-main\n");
  const directory = claudeProjectDirectory(config, home);
  await mkdir(directory, { recursive: true });
  return { home, config, file: path.join(directory, "synthetic-main.jsonl") };
}

const largeEntries = async (window) => {
  const result = [];
  for await (const entry of window.lines) if (entry.line.trim()) result.push(entry);
  return result;
};

test("actual 8 MiB reader boundary retains newest whole records within byte and record budgets", async (t) => {
  const { file } = await largeFixture(t);
  for (const size of [8 * MiB - 1, 8 * MiB, Math.floor(8.6 * MiB)]) {
    const source = largeTranscript(size);
    const sourceBytes = Buffer.from(source);
    await writeFile(file, source);
    for (const budget of [MiB, 8 * MiB]) {
      // The real per-file/line/record bounds, with an observable total-byte budget.
      const reader = createHistoryReader({ maxTotalBytes: 8 * MiB, windowReserveBytes: 0 });
      const window = await reader.recent(file, budget);
      assert.equal(8 * MiB - reader.windowBudget(), Math.min(size, budget), "actual bytes charged are bounded");
      assert.equal(window.totalBytes, size);
      assert.equal(window.omittedBytes > 0, size > budget);
      const retained = await largeEntries(window);
      assert.equal(JSON.parse(retained.at(-1).line).message.content[0].text, "acme newest reply");
      assert.ok(retained.length <= 20000);
      for (const { line, offset } of retained) {
        assert.equal(sourceBytes.subarray(offset, offset + Buffer.byteLength(line)).toString(), line);
        assert.ok(Buffer.byteLength(line) <= MiB);
      }
    }
    if (size > 8 * MiB) await assert.rejects(createHistoryReader().text(file), HistoryLimitError);
    else assert.equal(Buffer.byteLength(await createHistoryReader().text(file)), size);
  }
  await writeFile(file, largeTurn("x".repeat(MiB)));
  await assert.rejects(createHistoryReader().recent(file), HistoryLimitError, "retained oversized single records still fail");
  await writeFile(file, "{}\n".repeat(20001));
  await assert.rejects(createHistoryReader().recent(file), HistoryLimitError, "retained records still obey the request bound");
});

test("actual Claude /api/lanes stays fresh at and above 8 MiB, including append and partial-tail rereads", async (t) => {
  const { home, config, file } = await largeFixture(t);
  const server = createServer({ FM_HOME: home, CLAUDE_CONFIG_DIR: config });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/api/lanes`;
  const read = async (query = "") => {
    const response = await fetch(base + query);
    const data = await response.json();
    assert.equal(response.status, 200, data.error);
    const messages = data.messages || data.lanes.flatMap(lane => lane.messages);
    return { data, messages: [...new Map(messages.map(message => [message.recordId, message])).values()] };
  };
  let recordId;
  for (const size of [8 * MiB - 1, 8 * MiB, Math.floor(8.6 * MiB)]) {
    await writeFile(file, largeTranscript(size));
    for (const query of ["", "?windowBytes=1048576&format=refs.v1", "?windowBytes=8388608"]) {
      const { data, messages } = await read(query);
      assert.deepEqual(messages.map(message => message.text), ["acme retained reply", "acme newest reply"]);
      const session = data.transcript.sessions[0];
      assert.equal(session.id, "claude-main-session/synthetic-main.jsonl");
      assert.equal(session.loaded, true);
      assert.equal(session.skippedRecords, 0);
      assert.equal(session.omittedBytes > 0, size > (query.includes("1048576") ? MiB : 8 * MiB));
      if (session.omittedBytes) assert.ok(data.transcript.warnings.some(w => /older history in this source is not shown/.test(w)));
      assert.equal(data.transcript.expandable, query.includes("1048576"));
      recordId = messages.at(-1).recordId;
    }
  }
  const appended = largeTurn("acme appended reply", "2026-10-01T00:02:00Z");
  await appendFile(file, appended.slice(0, -10));
  const partial = await read("?windowBytes=1048576&format=refs.v1");
  assert.equal(partial.data.transcript.sessions[0].skippedRecords, 1, "partial JSON is skipped, never reconstructed");
  assert.equal(partial.messages.at(-1).recordId, recordId);
  await appendFile(file, appended.slice(-10));
  const completed = await read("?windowBytes=1048576&format=refs.v1");
  assert.equal(completed.data.transcript.sessions[0].skippedRecords, 0);
  assert.equal(completed.messages.at(-1).text, "acme appended reply");
  assert.equal(completed.messages.find(m => m.text === "acme newest reply").recordId, recordId);
  await writeFile(file, largeTurn("x".repeat(MiB)));
  let response = await fetch(base);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /History exceeds safe read limits/);
  await writeFile(file, "{}\n".repeat(20001));
  response = await fetch(base);
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /History exceeds safe read limits/);
});
