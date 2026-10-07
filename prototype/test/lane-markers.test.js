import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "../server.js";
import { readConversationTranscript } from "../transcript.js";

const mixed = "[fm-lane Example Store]\nSynthetic store update.\n\nSynthetic PR: https://github.com/example/store/pull/7\n[end Example Store]\n\n[fm-lane fm-quarterdeck]\nSynthetic Quarterdeck update.\n[end fm-quarterdeck]";
const wrapped = "[fm-lane Example Store]\nSynthetic launch update.\n\nAnother **Markdown** paragraph.\n\nSynthetic PR: https://github.com/example/store/pull/42\n[end Example Store]";
// Synthetic alias coverage: two complete blocks, one blank separator, no surrounding prose.
const visibleShape = "[fm-lane Quarterdeck]\nSynthetic Quarterdeck update.\n[end Quarterdeck]\n\n[fm-lane Lavish]\nSynthetic Lavish update.\n[end Lavish]";
const generalShape = "[fm-lane General]\nSynthetic fleet update.\n[end General]\n\n[fm-lane Quarterdeck]\nSynthetic alternate Quarterdeck update.\n[end Quarterdeck]";
const turn = (text, seconds) => JSON.stringify({
  type: "message", timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("canonical fm-lanes examples survive transcript ingestion and safe render preparation", async (t) => {
  const skill = await readFile(new URL("../../skills/fm-lanes/SKILL.md", import.meta.url), "utf8");
  // Use the skill's actual multi-lane example, not a separately maintained tag template.
  const example = skill.slice(skill.indexOf("[fm-lane General]\nAll crewmates"), skill.indexOf("**Incorrect (trailing cross-project line):**"));
  assert.match(example, /^\[fm-lane General\]\n/);
  assert.match(example, /\[end General\]\n\n\[fm-lane Database-Migration\]/);
  const hostile = "[fm-lane Example-Store-UI]\nVisible <img src=x onerror=alert(1)> **update**.\n[end Example-Store-UI]";
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-skill-lanes-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state", "main-session"), { recursive: true });
  await writeFile(path.join(home, "data", "projects.md"), "- Example-Store-UI - Synthetic UI\n- Database-Migration - Synthetic database\n");
  await writeFile(path.join(home, "state", "main-session", "session.jsonl"), [turn(example, 0), turn(hostile, 1)].join("\n"));
  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lanes`);
  assert.equal(response.status, 200);
  const { lanes } = await response.json();
  const messages = (id) => lanes.find((lane) => lane.id === id).messages.filter((message) => message.transcriptSessionId);
  const generalBlock = example.slice(0, example.indexOf("\n\n[fm-lane Database-Migration]"));
  const databaseBlock = example.slice(example.indexOf("[fm-lane Database-Migration]")).trimEnd();
  assert.ok(messages("general").some((message) => message.text === generalBlock));
  assert.ok(messages("database-migration").some((message) => message.text === databaseBlock));
  assert.ok(!messages("general").some((message) => message.text === databaseBlock || message.text === hostile));
  assert.ok(messages("example-store-ui").some((message) => message.text === hostile));
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const fontPrefs = await readFile(new URL("../public/message-font-size.js", import.meta.url), "utf8");
  const messageKinds = await readFile(new URL("../public/message-kinds.js", import.meta.url), "utf8");
  const renderCode = script.slice(0, script.indexOf("function orderedProjectLanes()"));
  const context = vm.createContext({ window: {}, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(fontPrefs, context);
  vm.runInContext(messageKinds, context);
  vm.runInContext(renderCode, context);
  for (const block of [generalBlock, databaseBlock, hostile]) {
    context.block = block;
    for (const format of ["renderMarkdown(block)", "escapeHtml(block)"]) {
      const html = vm.runInContext(format, context);
      assert.match(html, /\[fm-lane /);
      assert.match(html, /\[end /);
      assert.doesNotMatch(html, /<img\b/);
    }
  }
  assert.match(vm.runInContext("renderMarkdown(block)", context), /&lt;img src=x onerror=alert\(1\)&gt;/);
  const original = await readConversationTranscript(home, ({ text, ...rest }) => ({ text, ...rest }));
  assert.ok(original.messages.some((message) => message.text === example.trimEnd()));
});

test("explicit transcript lane wins over text, file name and General; lane filter excludes the turn", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "fm-markers-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state", "main-session"), { recursive: true });
  await writeFile(path.join(home, "data", "projects.md"), "- Example Store - Synthetic lane\n- Alpha - Other lane\n- fm-quarterdeck - Second marked lane\n- lavish-axi - Third marked lane\n");
  await writeFile(path.join(home, "state", "main-session", "Alpha.jsonl"), [
    turn(wrapped, 0),
    turn("[fm-lane Example Store]\nAlpha context\n[end Example Store]", 1),
    turn("Example Store mentioned without markers", 2),
    turn("[fm-lane Example Store]\nAlpha malformed closing\n[end Alpha]", 3),
    turn("An unattributed reply", 4),
    JSON.stringify({ type: "custom_message", customType: "fm-main-mirror", timestamp: "2026-01-01T00:00:05Z", content: "[main] [fm-lane Example Store]\nAlpha mirror reply\n[end Example Store]" }),
    turn(mixed, 6),
    turn(visibleShape, 7),
    turn(generalShape, 8),
  ].join("\n"));
  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lanes`);
  assert.equal(response.status, 200);
  const { lanes } = await response.json();
  const byId = (id) => lanes.find((lane) => lane.id === id).messages;
  const includes = (id, text) => byId(id).some((message) => message.text === text);
  assert.ok(includes("example-store", wrapped));
  assert.ok(!includes("alpha", wrapped), "explicit lane overrides project mentioned in source or body");
  assert.ok(!includes("general", wrapped), "explicit lane must not leak through General");
  assert.ok(includes("example-store", "[fm-lane Example Store]\nAlpha context\n[end Example Store]"));
  assert.ok(!includes("alpha", "[fm-lane Example Store]\nAlpha context\n[end Example Store]"));
  assert.ok(includes("example-store", "[fm-lane Example Store]\nAlpha mirror reply\n[end Example Store]"), "main mirrors use the same explicit marker routing");
  assert.ok(!includes("general", "[fm-lane Example Store]\nAlpha mirror reply\n[end Example Store]"));
  assert.ok(includes("general", "An unattributed reply"));
  const storeBlock = mixed.slice(0, mixed.indexOf("\n\n[fm-lane fm-quarterdeck]"));
  const agentBlock = mixed.slice(mixed.indexOf("[fm-lane fm-quarterdeck]"));
  const store = byId("example-store").find((message) => message.text === storeBlock);
  const agent = byId("fm-quarterdeck").find((message) => message.text === agentBlock);
  assert.ok(store && agent, "both blocks are separately routed with exact content");
  assert.notEqual(store.recordId, agent.recordId, "block identities must not merge in the client");
  assert.ok(!byId("general").some((message) => message.recordId === store.recordId || message.recordId === agent.recordId));
  assert.ok(!includes("example-store", mixed) && !includes("fm-quarterdeck", mixed) && !includes("general", mixed), "no lane exposes the unfiltered whole mixed message");
  const agentAlias = visibleShape.slice(0, visibleShape.indexOf("\n\n[fm-lane Lavish]"));
  const lavishAlias = visibleShape.slice(visibleShape.indexOf("[fm-lane Lavish]"));
  const agentEntry = byId("fm-quarterdeck").find((message) => message.text === agentAlias);
  const lavishEntry = byId("lavish-axi").find((message) => message.text === lavishAlias);
  assert.ok(agentEntry && lavishEntry, "live display aliases project to their registered lanes");
  assert.equal(agentEntry.source, lavishEntry.source);
  assert.equal(agentEntry.occurredAt, lavishEntry.occurredAt);
  assert.equal(agentEntry.transcriptSessionId, lavishEntry.transcriptSessionId);
  assert.equal(agentEntry.recordId.replace(/:block:\d+$/, ""), lavishEntry.recordId.replace(/:block:\d+$/, ""));
  assert.notEqual(agentEntry.recordId, lavishEntry.recordId);
  assert.ok(!byId("general").some((message) => message.text === visibleShape || message.text === agentAlias || message.text === lavishAlias));
  assert.ok(!includes("fm-quarterdeck", lavishAlias) && !includes("lavish-axi", agentAlias));
  const generalBlock = generalShape.slice(0, generalShape.indexOf("\n\n[fm-lane Quarterdeck]"));
  assert.ok(includes("general", generalBlock), "explicit General block stays in General");
  assert.ok(!includes("general", generalShape) && !includes("general", generalShape.slice(generalShape.indexOf("[fm-lane Quarterdeck]"))));
  // The original Pi record remains intact; projections never alter the source text.
  const transcript = await readConversationTranscript(home, ({ text, ...rest }) => ({ text, ...rest }));
  assert.ok(transcript.messages.some((message) => message.text === mixed));
  assert.ok(transcript.messages.some((message) => message.text === visibleShape), "original response is intact on disk");
  assert.ok(!includes("alpha", "An unattributed reply"), "a source filename alone is not project attribution");
  assert.ok(includes("general", "Example Store mentioned without markers"), "preserve legacy unmarked matching behavior");
  assert.ok(includes("general", "[fm-lane Example Store]\nAlpha malformed closing\n[end Alpha]"), "malformed envelopes retain legacy routing");

  // Exercise the real selection and merge functions with the actual API lane arrays.
  const script = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  const bulkControls = await readFile(new URL("../public/bulk-controls.js", import.meta.url), "utf8");
  const messageKinds = await readFile(new URL("../public/message-kinds.js", import.meta.url), "utf8");
  const filterView = await readFile(new URL("../public/filter-view.js", import.meta.url), "utf8");
  const selectionCode = script.slice(script.indexOf("function liveLanes()"), script.indexOf("function renderMessageTypeFilters()"));
  const context = vm.createContext({
    window: {}, lanes, feedLaneOverrideId: null, allLanesSelected: false, laneStatusFilter: "all",
    selectedLaneIds: new Set(["alpha", "general"]),
    selectedMessageTypes: new Set(["captain", "conversation", "supervision"]),
    selectedSessionId: null, selectedTranscriptSession: "", transcriptQuery: "",
  });
  vm.runInContext(bulkControls, context);
  vm.runInContext(messageKinds, context);
  vm.runInContext(filterView, context);
  // messageTypeId is destructured at app.js top-level, outside this selection slice.
  vm.runInContext("var messageTypeId = window.messageKinds.typeId; var MESSAGE_TYPES = window.messageKinds.TYPES;", context);
  vm.runInContext(selectionCode, context);
  const selection = () => vm.runInContext("messagesForSelection()", context);
  assert.ok(!selection().some((message) => message.text === wrapped), "General + Alpha must hide unchecked Example Store");
  assert.ok(!selection().some((message) => message.text === agentAlias || message.text === lavishAlias), "General never contains either deselected block");
  context.selectedLaneIds = new Set(["general", "fm-quarterdeck"]);
  assert.ok(selection().some((message) => message.text === agentAlias));
  assert.ok(!selection().some((message) => message.text === lavishAlias || message.text === visibleShape), "Lavish remains hidden when deselected");
  context.selectedLaneIds = new Set(["general", "lavish-axi"]);
  assert.ok(selection().some((message) => message.text === lavishAlias));
  assert.ok(!selection().some((message) => message.text === agentAlias || message.text === visibleShape), "Quarterdeck remains hidden when deselected");
  context.selectedLaneIds = new Set(["general", "fm-quarterdeck", "lavish-axi"]);
  assert.deepEqual([...selection().filter((message) => [agentAlias, lavishAlias].includes(message.text)).map((message) => message.text)], [agentAlias, lavishAlias]);
  context.selectedLaneIds = new Set(["fm-quarterdeck", "lavish-axi"]);
  assert.ok(!selection().some((message) => message.text === generalBlock), "deselecting General hides its own block");
  context.selectedLaneIds = new Set(["general"]);
  assert.ok(selection().some((message) => message.text === generalBlock));
  assert.ok(!selection().some((message) => message.text === agentAlias || message.text === lavishAlias));
  context.selectedLaneIds = new Set(["alpha", "general", "fm-quarterdeck"]);
  assert.ok(selection().some((message) => message.text === agentBlock));
  assert.ok(!selection().some((message) => message.text.includes("Synthetic store update.")), "unchecking Example Store hides its block even if Quarterdeck remains selected");
  context.selectedLaneIds = new Set(["example-store"]);
  const selected = selection().find((message) => message.text === wrapped);
  assert.ok(selected);
  assert.deepEqual([...selected.laneNames], ["Example Store"]);
  assert.equal(selected.kind, "conversation");
  assert.match(selected.text, /\*\*Markdown\*\* paragraph\.\n\nSynthetic PR: https:\/\/github.com\/example\/store\/pull\/42/);
  assert.ok(selection().some((message) => message.text === storeBlock));
  assert.ok(!selection().some((message) => message.text === agentBlock));
});
