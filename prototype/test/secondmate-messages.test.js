import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm, symlink, appendFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registeredSecondmates, readSecondmateMessages } from "../secondmate-messages.js";
import { loadFirstmateHome } from "../server.js";
import { createHistoryReader } from "../history-reader.js";

const registration = (id, projects = "example-app") => `- ${id} - Example (notes; complete) (home: /example/${id}; scope: Work (bounded); read only; projects: ${projects}; added 2026-10-10)`;
async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-mates-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data")); await mkdir(path.join(home, "state"));
  await writeFile(path.join(home, "data/projects.md"), "- example-app - Example app\n- acme - Acme\n");
  await writeFile(path.join(home, "data/secondmates.md"), [registration("mate-alpha"),
    "- mate-beta - Remote example (host: example-host; root: /example/code; home: /example/mate-beta; scope: Investigation; projects: acme; added 2026-10-10)", registration("mate-empty")].join("\n"));
  await writeFile(path.join(home, "state/mate-alpha.status"), "working [at=1791667528] [corr=0123456789abcdef]: Example first\nblocked [key=example-choice] [at=1791667540]: Example last\ndone: Legacy undated\ndone: body mentions [at=1791667550]\n");
  await writeFile(path.join(home, "state/mate-beta.status"), "done [at=1791667530]: Comparing mate-alpha with baseline\n");
  await writeFile(path.join(home, "state/unregistered.status"), "done [at=1791667531]: Example unknown\n");
  return home;
}

test("registry suffix grammar permits prose punctuation and excludes duplicate/malformed identities", () => {
  const valid = registration("mate-alpha");
  assert.deepEqual(registeredSecondmates(valid), [{ id: "mate-alpha", projects: ["example-app"] }]);
  assert.deepEqual(registeredSecondmates(`${valid}\n- mate-alpha invalid`), []);
  assert.deepEqual(registeredSecondmates(`${valid}\n${valid}`), []);
  assert.deepEqual(registeredSecondmates(registration("../mate-alpha")), []);
  assert.deepEqual(registeredSecondmates("- mate-alpha - Example (home: relative; scope: Example; projects: example-app; added 2026-10-10)"), []);
});

test("registered parent sources establish origin, interleave by real clock and preserve byte identity", async t => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/mate-alpha.meta"), "project=example-app\n");
  const data = await loadFirstmateHome(home);
  const general = data.lanes.find(lane => lane.id === "general").messages;
  assert.deepEqual(general.map(message => message.secondmateId), ["mate-alpha", "mate-beta", "mate-alpha"]);
  assert.match(general[1].text, /mate-alpha/);
  assert.equal(general[1].author, "mate-beta");
  assert.equal(general[0].occurredAt, new Date(1791667528000).toISOString());
  assert.equal(data.lanes.find(lane => lane.id === "example-app").messages.length, 2);
  assert.equal(data.lanes.find(lane => lane.id === "acme").messages.length, 1);
  assert.equal(data.transcript.secondmateSources.find(source => source.id === "mate-empty").loaded, false);
  assert.equal(data.transcript.secondmateSources[0].skippedRecords, 2);
  assert.match(data.transcript.warnings.join(" "), /undated.*no event time was invented/);
  assert.equal(JSON.stringify(data).includes("/example/"), false, "registry route paths do not leak");
  await appendFile(path.join(home, "state/mate-alpha.status"), "done [at=1791667560]: Example first\n");
  const next = await loadFirstmateHome(home);
  const rows = next.lanes.find(lane => lane.id === "general").messages;
  assert.deepEqual(rows.slice(0, 3).map(row => row.recordId), general.map(row => row.recordId));
  assert.equal(new Set(rows.map(row => row.recordId)).size, 4);
});

test("symlinks, missing sources and ambiguous registrations never mint mate messages", async t => {
  const home = await fixture(t);
  await rm(path.join(home, "state/mate-beta.status"));
  await symlink(path.join(home, "state/unregistered.status"), path.join(home, "state/mate-beta.status"));
  let data = await readSecondmateMessages(home, value => value);
  assert.equal(data.messages.some(message => message.secondmateId === "mate-beta"), false);
  assert.equal(data.sources.find(source => source.id === "mate-beta").loaded, false);
  await appendFile(path.join(home, "data/secondmates.md"), "\n- mate-alpha malformed\n");
  data = await readSecondmateMessages(home, value => value);
  assert.equal(data.messages.length, 0);
  assert.match(data.warnings.join(" "), /duplicate/);
  await rm(path.join(home, "data/secondmates.md"));
  await symlink(path.join(home, "state/unregistered.status"), path.join(home, "data/secondmates.md"));
  assert.equal((await readSecondmateMessages(home, value => value)).messages.length, 0);
});

test("bounded reader retains repeated real lines and reports omitted history", async t => {
  const home = await fixture(t);
  await writeFile(path.join(home, "state/mate-alpha.status"), ("done [at=1791667528]: Example repeated " + "sample ".repeat(25) + "\n").repeat(10000));
  const data = await readSecondmateMessages(home, value => value, { windowBytes: 1024 * 1024 });
  assert.ok(data.sources[0].omittedBytes > 0);
  const alpha = data.messages.filter(message => message.secondmateId === "mate-alpha");
  assert.ok(alpha.length > 1);
  assert.equal(new Set(alpha.map(message => message.recordId)).size, alpha.length);
  await assert.rejects(readSecondmateMessages(home, value => value, { reader: createHistoryReader({ maxMessages: 1 }) }), /safe read limits/);
});
