import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { createServer } from "../server.js";
import { readConversationTranscript } from "../transcript.js";
import { claudeProjectDirectory } from "../claude-transcript.js";

const mixed = "[fm-lane Example Store]\nSynthetic store update.\n\nSynthetic PR: https://github.com/example/store/pull/7\n[end Example Store]\n\n[fm-lane fm-quarterdeck]\nSynthetic Quarterdeck update.\n[end fm-quarterdeck]";
const wrapped = "[fm-lane Example Store]\nSynthetic launch update.\n\nAnother **Markdown** paragraph.\n\nSynthetic PR: https://github.com/example/store/pull/42\n[end Example Store]";
// Synthetic alias coverage: two complete blocks, one blank separator, no surrounding prose.
const visibleShape = "[fm-lane Quarterdeck]\nSynthetic Quarterdeck update.\n[end Quarterdeck]\n\n[fm-lane Lavish]\nSynthetic Lavish update.\n[end Lavish]";
const generalShape = "[fm-lane General]\nSynthetic fleet update.\n[end General]\n\n[fm-lane Quarterdeck]\nSynthetic alternate Quarterdeck update.\n[end Quarterdeck]";
const turn = (text, seconds) => JSON.stringify({
  type: "message", timestamp: `2026-01-01T00:00:${String(seconds).padStart(2, "0")}Z`,
  message: { role: "assistant", content: [{ type: "text", text }] },
});

test("canonical fmqd-lanes examples survive transcript ingestion and safe render preparation", async (t) => {
  const skill = await readFile(new URL("../../skills/fmqd-lanes/SKILL.md", import.meta.url), "utf8");
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
  const extraction = (await readFile(new URL("../public/chat-ask-extraction.js", import.meta.url), "utf8")).replace(/^export /gm, "");
  const renderCode = script.slice(0, script.indexOf("function orderedProjectLanes()")).replace(/^import \{ extractAskSections \} from "\.\/chat-ask-extraction\.js";\n/m, "");
  const context = vm.createContext({ window: {}, localStorage: { getItem: () => null, setItem() {} } });
  vm.runInContext(fontPrefs, context);
  vm.runInContext(messageKinds, context);
  vm.runInContext(extraction, context);
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

test("Claude primary multi-block theme labels resolve to registered parents, longest first", async (t) => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "fm-claude-themed-lanes-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const home = path.join(scratch, "home"), config = path.join(scratch, "claude");
  await mkdir(path.join(home, "data"), { recursive: true });
  await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- Example-Store - Synthetic parent\n- Example-Store-Tools - Synthetic nested registered parent\n- fm-quarterdeck - Current product\n- fm-AgentOS - Historical product\n");
  await writeFile(path.join(home, "state/.lock-session"), "primary-fixture\n");
  const directory = claudeProjectDirectory(config, home);
  await mkdir(directory, { recursive: true });
  const block = (name) => `[fm-lane ${name}]\nSynthetic ${name} update.\n[end ${name}]`;
  const text = [block("General"), block("Example-Store-UI"), block("Example-Store-Tools-CLI"), block("fm-quarterdeck-UI")].join("\n\n");
  const exact = [block("Example-Store-Tools"), block("General")].join("\n\n");
  const unknown = [block("Unregistered-UI"), block("General")].join("\n\n");
  const single = "[fm-lane Example-Store-UI]\nExample-Store-Tools is mentioned here only as context.\n[end Example-Store-UI]";
  const productSingle = "[fm-lane fm-quarterdeck-UI]\nExample-Store is mentioned here only as context.\n[end fm-quarterdeck-UI]";
  const ambiguousAlias = [block("Quarterdeck-UI"), block("General")].join("\n\n");
  const malformed = text.replace("[end Example-Store-UI]", "[end Wrong]");
  await writeFile(path.join(directory, "primary-fixture.jsonl"), [text, exact, unknown, single, malformed, productSingle, ambiguousAlias].map((text, index) => JSON.stringify({
    type: "assistant", uuid: `fixture-${index}`, sessionId: "primary-fixture", timestamp: `2030-01-01T12:00:0${index}Z`,
    message: { role: "assistant", model: "fixture-model", content: [{ type: "text", text }] },
  })).join("\n") + "\n");
  const server = createServer({ FM_HOME: home, CLAUDE_CONFIG_DIR: config });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lanes`);
  assert.equal(response.status, 200);
  const { lanes } = await response.json();
  const messages = (id) => lanes.find((lane) => lane.id === id).messages;
  const parent = messages("example-store").find((m) => m.mixedLaneMessage?.text === text);
  assert.ok(parent, "the primary Claude reply has display context after parent-fleet filtering");
  assert.equal(parent.transcriptOrigin, "main Claude");
  assert.match(parent.mixedLaneMessage.recordId, /^claude-main-session\/primary-fixture.jsonl@\d+:0$/);
  assert.deepEqual(parent.mixedLaneMessage.blocks.map(({ projectId }) => projectId), ["general", "example-store", "example-store-tools", "fm-quarterdeck"]);
  assert.equal(parent.text, block("Example-Store-UI"));
  assert.equal(messages("example-store-tools").find((m) => m.mixedLaneMessage?.text === text).text, block("Example-Store-Tools-CLI"));
  assert.equal(messages("example-store-tools").find((m) => m.mixedLaneMessage?.text === exact).text, block("Example-Store-Tools"), "exact registered label wins over a shorter parent");
  assert.ok(messages("general").some((m) => m.text === unknown && !m.mixedLaneMessage), "unknown parents retain conservative fallback");
  assert.ok(messages("general").some((m) => m.text === malformed && !m.mixedLaneMessage), "malformed blocks remain ordinary text");
  assert.ok(messages("example-store").some((m) => m.text === single && !m.mixedLaneMessage), "single-lane themes route to their declared parent without acquiring disclosures");
  assert.ok(!messages("example-store-tools").some((m) => m.text === single), "body mentions cannot override a single-lane theme envelope");
  assert.ok(!messages("general").some((m) => m.text === single || m.text === productSingle), "valid single theme blocks do not leak to General");
  assert.ok(messages("fm-quarterdeck").some((m) => m.text === productSingle), "the current registered product ID outranks historical aliases");
  assert.ok(!messages("example-store").some((m) => m.text === productSingle), "an unrelated mentioned project cannot receive the current product's single-theme reply");
  assert.ok(!messages("fm-agentos").some((m) => m.text === productSingle || m.mixedLaneMessage?.text === text), "historical aliases cannot claim the current registered product ID");
  assert.ok(messages("general").some((m) => m.text === ambiguousAlias && !m.mixedLaneMessage), "genuinely shared aliases remain ambiguous rather than guessed");
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
    selectedSessionId: null, selectedTranscriptSession: "", selectedSecondmate: "", transcriptQuery: "",
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
  assert.equal(store.mixedLaneMessage.text, mixed);
  assert.deepEqual(store.mixedLaneMessage.blocks.map(({ projectId }) => projectId), ["example-store", "fm-quarterdeck"]);
  assert.deepEqual(store.mixedLaneMessage, agent.mixedLaneMessage, "projections carry the same exact display context");
  for (const ids of [["general", "fm-quarterdeck"], ["general", "lavish-axi"], ["general", "fm-quarterdeck", "lavish-axi"]]) {
    context.selectedLaneIds = new Set(ids);
    const replies = selection().filter((message) => message.text === visibleShape);
    assert.equal(replies.length, 1, "selected projections merge into one original message");
    assert.equal(replies[0].recordId, agentEntry.mixedLaneMessage.recordId);
    assert.deepEqual([...replies[0].laneNames], ids.filter((id) => id !== "general"));
  }
  context.selectedLaneIds = new Set(["general"]);
  assert.ok(selection().some((message) => message.text === generalShape));
  assert.ok(!selection().some((message) => message.text === visibleShape), "unselected whole messages stay excluded");
  context.selectedLaneIds = new Set(["alpha", "general", "fm-quarterdeck"]);
  assert.ok(selection().some((message) => message.text === mixed), "unchecked sibling context remains available without changing routing");
  context.selectedLaneIds = new Set(["example-store"]);
  const selected = selection().find((message) => message.text === wrapped);
  assert.ok(selected);
  assert.deepEqual([...selected.laneNames], ["Example Store"]);
  assert.equal(selected.kind, "conversation");
  assert.match(selected.text, /\*\*Markdown\*\* paragraph\.\n\nSynthetic PR: https:\/\/github.com\/example\/store\/pull\/42/);
  assert.ok(selection().some((message) => message.text === mixed));
  assert.ok(!selection().some((message) => message.text === agentBlock));
  assert.ok(!byId("example-store").find((message) => message.text === wrapped).mixedLaneMessage, "single-block replies keep their existing shape");
});
