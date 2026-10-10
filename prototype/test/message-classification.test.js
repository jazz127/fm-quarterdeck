import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadFirstmateHome } from "../server.js";

async function home(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-classify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(root, "state"), { recursive: true });
  await writeFile(path.join(root, "data/projects.md"), "- Alpha - Synthetic alpha\n- Beta - Synthetic beta\n");
  return root;
}

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join("\n") + "\n";
const messagesOf = (data) => [...new Map(data.lanes.flatMap((lane) => lane.messages).map((message) => [message.recordId || `${message.source}\n${message.text}`, message])).values()];
const lane = (data, id) => data.lanes.find((entry) => entry.id === id);

test("pre-tool narration is hidden-by-default progress; end-of-turn and lane blocks stay replies", async (t) => {
  const root = await home(t);
  const config = await mkdtemp(path.join(os.tmpdir(), "fm-classify-claude-"));
  t.after(() => rm(config, { recursive: true, force: true }));
  const directory = path.join(config, "projects", root.replace(/[^a-zA-Z0-9]/g, "-"));
  await mkdir(directory, { recursive: true });
  const primary = "11111111-2222-3333-4444-555555555555";
  await writeFile(path.join(root, "state/.lock-session"), `${primary}\n`);
  const at = (second) => `2026-10-10T14:05:${String(second).padStart(2, "0")}Z`;
  const assistant = (second, content, stop_reason) => ({
    type: "assistant", timestamp: at(second), sessionId: primary, cwd: root,
    message: { role: "assistant", stop_reason, content },
  });
  await writeFile(path.join(directory, `${primary}.jsonl`), jsonl([
    assistant(1, [{ type: "text", text: "Claude narration before the tool." }], "tool_use"),
    assistant(1, [{ type: "tool_use", id: "tool-1", name: "Bash", input: { command: "ls" } }], "tool_use"),
    assistant(2, [{ type: "text", text: "Claude end of turn reply." }], "end_turn"),
    assistant(3, [{ type: "text", text: "[fm-lane Alpha]\nAlpha lane reply\n[end Alpha]" }], "tool_use"),
    assistant(4, [{ type: "text", text: "Claude prose before a block.\n\n[fm-lane Alpha]\nAlpha progress inside\n[end Alpha]" }], "tool_use"),
    assistant(5, [{ type: "text", text: "[fm-lane Alpha]\nAlpha broken closer\n[end Beta]" }], "tool_use"),
    assistant(6, "Claude string narration.", "tool_use"),
  ]));
  await mkdir(path.join(root, "state/main-session"), { recursive: true });
  await writeFile(path.join(root, "state/main-session/pi.jsonl"), jsonl([
    { type: "message", timestamp: at(10), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Pi narration before the tool." }, { type: "toolCall", name: "bash", arguments: { command: "pwd" } }] } },
    { type: "message", timestamp: at(11), message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "Pi end of turn reply." }] } },
    { type: "message", timestamp: at(12), message: { role: "assistant", content: [{ type: "text", text: "Pi narration from a tool part." }, { type: "toolCall", name: "read", arguments: { path: "a" } }] } },
    { type: "message", timestamp: at(13), message: { role: "assistant", stopReason: "toolUse", content: "Pi string narration." } },
    { type: "message", timestamp: at(14), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "[fm-lane Alpha]\nPi lane reply\n[end Alpha]" }, { type: "toolCall", name: "bash", arguments: {} }] } },
  ]));
  await mkdir(path.join(root, "state/branch-session"), { recursive: true });
  await writeFile(path.join(root, "state/branch-session/crew.jsonl"), jsonl([
    { type: "message", timestamp: at(20), message: { role: "assistant", stopReason: "toolUse", content: [{ type: "text", text: "Branch pre-tool line." }, { type: "toolCall", name: "bash", arguments: { command: "true" } }] } },
  ]));
  // Only the two newest disk sessions load besides the active Claude primary.
  const stamp = (file, hour) => utimes(file, new Date(`2026-10-10T${hour}:00:00Z`), new Date(`2026-10-10T${hour}:00:00Z`));
  await stamp(path.join(root, "state/main-session/pi.jsonl"), "18");
  await stamp(path.join(root, "state/branch-session/crew.jsonl"), "17");
  await stamp(path.join(directory, `${primary}.jsonl`), "16");

  const data = await loadFirstmateHome(root, { claudeConfigDir: config });
  const messages = messagesOf(data);
  const byText = (text) => messages.find((message) => message.text === text);
  assert.deepEqual([byText("Claude narration before the tool.").kind, byText("Claude narration before the tool.").state], ["narration", "working"]);
  assert.equal(byText("Bash\n{\n  \"command\": \"ls\"\n}").kind, "tools");
  assert.equal(byText("Claude end of turn reply.").kind, "conversation");
  assert.equal(byText("[fm-lane Alpha]\nAlpha lane reply\n[end Alpha]").kind, "conversation");
  assert.equal(byText("Claude prose before a block.\n\n[fm-lane Alpha]\nAlpha progress inside\n[end Alpha]").kind, "conversation");
  assert.equal(byText("[fm-lane Alpha]\nAlpha broken closer\n[end Beta]").kind, "narration");
  assert.equal(byText("Claude string narration.").kind, "narration");
  assert.equal(byText("Pi narration before the tool.").kind, "narration");
  assert.equal(byText("bash\n{\n  \"command\": \"pwd\"\n}").kind, "tools");
  assert.equal(byText("Pi end of turn reply.").kind, "conversation");
  assert.equal(byText("Pi narration from a tool part.").kind, "narration");
  assert.equal(byText("Pi string narration.").kind, "narration");
  assert.equal(byText("[fm-lane Alpha]\nPi lane reply\n[end Alpha]").kind, "conversation");
  assert.equal(byText("Branch pre-tool line.").kind, "branch", "crew replies keep their kind");
  const general = lane(data, "general").messages.map((message) => message.text);
  assert.ok(general.indexOf("Claude narration before the tool.") < general.indexOf("Bash\n{\n  \"command\": \"ls\"\n}"), "narration stays ahead of the tool it introduces");
});

test("an inbox reply is a Firstmate conversation in the same lanes as its note", async (t) => {
  const root = await home(t);
  await writeFile(path.join(root, "state/alpha-task.meta"), `project=${path.join(root, "projects", "Alpha")}\n`);
  await mkdir(path.join(root, "state/inbox/handled"), { recursive: true });
  await mkdir(path.join(root, "state/inbox/.replies"), { recursive: true });
  await mkdir(path.join(root, "state/main-session"), { recursive: true });
  const note = (name, headers, body) => writeFile(path.join(root, "state/inbox", ...name), `${headers}\n--\n${body}\n`);
  const reply = (name, headers, body) => writeFile(path.join(root, "state/inbox/.replies", name), `${headers}\n--\n${body}\n`);
  await note(["handled", "1791641035-WPakGQ.note"], "id=1791641035-WPakGQ\nat=2026-10-10T14:00:00Z\nsource=text\ntask_id=alpha-task", "Captain note on the Alpha task.");
  await note(["1791642000-Untask.note"], "id=1791642000-Untask\nat=2026-10-10T14:01:00Z\nsource=text", "Untasked captain note.");
  await reply("1791641035-WPakGQ", "id=1791641035-WPakGQ\nat=2026-10-10T14:07:27Z\nseq=117", "You're right - merging both now.");
  await reply("1791641036-DupID", "id=1791641035-WPakGQ\nat=2026-10-10T14:07:28Z\nseq=118", "Duplicate reply body must not surface.");
  await reply("1791642000-Untask", "id=1791642000-Untask\nat=2026-10-10T14:08:00Z\nseq=119", "Reply to the untasked note.");
  await reply("1791643000-Orphan", "id=1791643000-Orphan\nat=2026-10-10T14:09:00Z\nseq=120", "Orphan reply with no note.");
  await writeFile(path.join(root, "state/inbox/.replies/notes.txt"), "id=notes\nat=2026-10-10T14:09:30Z\n--\nNot a note id.\n");
  await writeFile(path.join(root, "state/inbox/.replies-secret"), "id=1791644000-Secret\nat=2026-10-10T14:09:40Z\n--\nSymlinked reply must stay unread.\n");
  await symlink(path.join(root, "state/inbox/.replies-secret"), path.join(root, "state/inbox/.replies/1791644000-Secret"));
  await writeFile(path.join(root, "state/main-session/same.jsonl"), jsonl([
    { type: "message", timestamp: "2026-10-10T14:10:00Z", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "You're right - merging both now." }] } },
  ]));

  const data = await loadFirstmateHome(root);
  const alpha = lane(data, "alpha").messages;
  const beta = lane(data, "beta").messages;
  const general = lane(data, "general").messages;
  const tasked = alpha.find((message) => message.recordId === "state/inbox/.replies/1791641035-WPakGQ");
  assert.ok(tasked, "the tasked reply is in the note's project lane");
  assert.deepEqual([tasked.author, tasked.role, tasked.kind, tasked.inReplyTo, tasked.taskId, tasked.text],
    ["Firstmate", "firstmate", "conversation", "1791641035-WPakGQ", "alpha-task", "You're right - merging both now."]);
  assert.ok(alpha.findIndex((message) => message.text === "Captain note on the Alpha task.") < alpha.findIndex((message) => message.recordId === tasked.recordId));
  assert.equal(alpha.filter((message) => message.recordId === tasked.recordId).length, 1);
  assert.equal(general.filter((message) => message.recordId === tasked.recordId).length, 1);
  assert.equal(beta.some((message) => message.recordId === tasked.recordId), false);
  assert.equal(beta.some((message) => message.text === "Captain note on the Alpha task."), false);
  for (const messages of [alpha, beta, general]) {
    assert.equal(messages.filter((message) => message.text === "Reply to the untasked note.").length, 1);
  }
  assert.deepEqual(data.lanes.filter((entry) => entry.messages.some((message) => message.text === "Orphan reply with no note.")).map((entry) => entry.id), ["general"]);
  const copies = messagesOf(data).filter((message) => message.text === "You're right - merging both now.");
  assert.equal(copies.length, 2, "the same words in a transcript reply are a different record");
  assert.equal(new Set(copies.map((message) => message.recordId)).size, 2);
  const serialized = JSON.stringify(data);
  assert.equal(serialized.includes("Duplicate reply body must not surface."), false);
  assert.equal(serialized.includes("Symlinked reply must stay unread."), false);
  assert.equal(serialized.includes("Not a note id."), false);
});

test("a symlinked replies directory is not followed", async (t) => {
  const root = await home(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "fm-classify-replies-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await mkdir(path.join(root, "state/inbox"), { recursive: true });
  await writeFile(path.join(outside, "1791645000-Moved"), "id=1791645000-Moved\nat=2026-10-10T15:00:00Z\n--\nReply behind a directory symlink.\n");
  await symlink(outside, path.join(root, "state/inbox/.replies"));
  const data = await loadFirstmateHome(root);
  assert.equal(JSON.stringify(data).includes("Reply behind a directory symlink."), false);
});
