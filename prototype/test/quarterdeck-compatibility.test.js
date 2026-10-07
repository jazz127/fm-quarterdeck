import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../server.js";
import { emptyAgentState } from "../agent-state.js";

const commit = "a".repeat(40);
const revisionResolver = { initial: commit, snapshot: async () => commit };
async function serve(t, env, options = {}) {
  const server = createServer(env, { revisionResolver, ...options });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("new and legacy state variables read the same existing owner; conflicting owners fail startup", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-compatibility-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "existing-state.json");
  const state = emptyAgentState();
  state.acknowledgements["b".repeat(64)] = { taskFingerprint: "c".repeat(64), acknowledgedAt: "2026-01-01T00:00:00Z" };
  const bytes = JSON.stringify(state);
  await writeFile(file, bytes);
  for (const env of [{ FM_QUARTERDECK_STATE_PATH: file }, { FM_AGENTOS_STATE_PATH: file }, { FM_QUARTERDECK_STATE_PATH: file, FM_AGENTOS_STATE_PATH: file }]) {
    let childOwner;
    const base = await serve(t, env, {
      lanesReader: async (_, { agentStateOwner }) => ({ lanes: [{ id: "synthetic", acknowledgements: (await agentStateOwner.read()).acknowledgements }] }),
      lifecycleFactory: (_, options) => { childOwner = options.env.FM_QUARTERDECK_STATE_PATH; return { close: async () => {} }; },
    });
    const response = await fetch(`${base}/api/lanes`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).lanes[0].acknowledgements, state.acknowledgements);
    assert.equal(childOwner, file);
    assert.deepEqual(await (await fetch(`${base}/api/health`)).json(), { ok: true, service: "fm-quarterdeck" });
    assert.equal(await readFile(file, "utf8"), bytes);
  }
  assert.throws(() => createServer({ FM_QUARTERDECK_STATE_PATH: file, FM_AGENTOS_STATE_PATH: path.join(root, "other.json") }, { revisionResolver }), /Conflicting Quarterdeck state owners/);
});

for (const registered of ["fm-quarterdeck", "fm-AgentOS"]) test(`old and new lane envelopes preserve records under registered ${registered}`, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-lane-compatibility-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await mkdir(path.join(home, "state/main-session"), { recursive: true });
  await writeFile(path.join(home, "data/projects.md"), `- ${registered} - Synthetic product\n`);
  const labels = ["fm-quarterdeck", "Quarterdeck", "Firstmate Quarterdeck", "fm-AgentOS", "AgentOS", "Agent-OS", "Agent OS"];
  const texts = labels.map((label) => `[fm-lane ${label}]\nSynthetic labeled update ${label}.\n[end ${label}]`);
  const file = path.join(home, "state/main-session/session.jsonl");
  const bytes = texts.map((text, i) => JSON.stringify({ type: "message", timestamp: `2026-01-01T00:00:0${i}Z`, message: { role: "assistant", content: [{ type: "text", text }] } })).join("\n");
  await writeFile(file, bytes);
  const base = await serve(t, { FM_HOME: home, FM_QUARTERDECK_STATE_PATH: `${home}-state.json` });
  const response = await fetch(`${base}/api/lanes`);
  assert.equal(response.status, 200);
  const { lanes } = await response.json();
  const product = lanes.find((lane) => lane.id === registered.toLowerCase());
  const messages = product.messages.filter((message) => message.transcriptSessionId);
  for (const text of texts) assert(messages.some((message) => message.text === text));
  assert.equal(new Set(messages.map((message) => message.recordId)).size, texts.length);
  assert(!lanes.find((lane) => lane.id === "general").messages.some((message) => texts.includes(message.text)));
  assert.equal(await readFile(file, "utf8"), bytes);
});
