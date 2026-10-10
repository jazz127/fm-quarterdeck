import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { backlogLandedEvidence, contentRevision, createSnapshotRunner, normalizeSnapshot } from "../bearings.js";
import { createThreadRelay, taggedEnvelope } from "../bearings-thread.js";
import { createLandedAckStore, landedAckPath } from "../landed-ack.js";
import { createServer } from "../server.js";

const fixture = JSON.parse(await readFile(new URL("./fixtures/bearings/two-calls.json", import.meta.url), "utf8"));
const REV = "a".repeat(16);
const uuid = "00000000-0000-4000-8000-000000000009";

test("landed rows become cards with a full link or local main, and only main gets a clock", () => {
  const raw = { ...fixture, landed: [
    { id: "ship-window", what: "Ship the window", artifact: "https://example.invalid/acme/example-app/pull/42", owner: "(main)", repo: "/srv/checkouts/example-app", landedAt: "2026-10-05", backlogLandedAt: "2026-10-01", backlogRepo: "ignored-when-snapshot-has-repo" },
    { id: "local-notes", what: "Land the notes", artifact: "local main", owner: "(main)", backlogRepo: "sample-notes", backlogLandedAt: "2026-10-02" },
    { id: "other-home", what: "Other home landed", artifact: "https://example.invalid/o/r/pull/1", owner: "second-mate", repo: "/srv/other/repo", landedAt: "2026-10-03" },
    { id: "dash", what: "No artifact", artifact: "-", owner: "(main)" },
    { id: "path-art", what: "See /srv/fixture/workspace/data/report.md", artifact: "Report: /srv/fixture/workspace/data/report.md", owner: "(main)" },
    { id: "bad id", what: "nope", artifact: "-", owner: "(main)" },
    { id: "ship-window", what: "duplicate", artifact: "-", owner: "(main)" },
  ] };
  const content = normalizeSnapshot(raw);
  assert.equal(content.cards.length, normalizeSnapshot(fixture).cards.length, "landed rows are not Captain's Call cards");
  assert.equal(contentRevision(normalizeSnapshot(fixture)), contentRevision({ ...normalizeSnapshot(fixture), landed: [] }));
  const ship = content.landed.find((card) => card.task === "ship-window");
  assert.equal(ship.key, "landed:ship-window");
  assert.equal(ship.type, "landed");
  assert.equal(ship.url, "https://example.invalid/acme/example-app/pull/42");
  assert.equal(ship.artifact, null);
  assert.equal(ship.repo, "example-app");
  assert.equal(ship.clock.label, "Landed");
  assert.equal(ship.clock.at, "2026-10-05");
  assert.match(ship.rev, /^[0-9a-f]{16}$/);
  const local = content.landed.find((card) => card.task === "local-notes");
  assert.equal(local.artifact, "local main");
  assert.equal(local.url, null);
  assert.equal(local.repo, "sample-notes");
  assert.equal(local.clock.at, "2026-10-02");
  const other = content.landed.find((card) => card.task === "other-home");
  assert.equal(other.repo, "repo");
  assert.equal(other.clock.at, null, "another home does not supply a clock");
  assert.equal(other.url, "https://example.invalid/o/r/pull/1");
  const plain = content.landed.find((card) => card.task === "dash");
  assert.equal(plain.url, null);
  assert.equal(plain.artifact, null);
  const redacted = content.landed.find((card) => card.task === "path-art");
  assert.match(redacted.what, /…\/report\.md/);
  assert.match(redacted.artifact, /…\/report\.md/);
  assert.equal(redacted.url, null);
  assert.equal(content.omitted.find((entry) => entry.kind === "invalid-landed").count, 2);
  assert.equal(content.omitted.find((entry) => entry.kind === "deferred-holds").count, 2, "call omissions survive");
  const changed = normalizeSnapshot({ ...raw, landed: raw.landed.map((row) => row.id === "local-notes" ? { ...row, backlogLandedAt: "2026-10-09" } : row) });
  assert.notEqual(changed.landed.find((card) => card.task === "local-notes").rev, local.rev);
  assert.notEqual(contentRevision(changed), contentRevision(content));
});

test("a checked main-home backlog line supplies the repository and the newest landing date", async () => {
  const ledger = `- [x] ship-window - Ship it (repo: /synthetic/checkouts/example-app) (done 2026-10-01) (merged 2026-10-03)
- [x] local-notes - Notes (repo: sample-notes) (reported 2026-10-02)
- [x] twin - First (repo: one) (done 2026-10-01)
- [x] twin - Second (repo: two) (done 2026-10-04)
- [ ] ship-window - Open copy (repo: wrong) (done 2026-10-09)
`;
  assert.equal(backlogLandedEvidence(ledger).get("ship-window").backlogRepo, "example-app");
  assert.equal(backlogLandedEvidence(ledger).get("ship-window").landedAt, "2026-10-03");
  assert.equal(backlogLandedEvidence(ledger).get("ship-window").backlogTitle, "Ship it");
  assert.equal(backlogLandedEvidence(ledger).get("local-notes").backlogTitle, "Notes");
  assert.equal(backlogLandedEvidence(ledger).has("twin"), false);
  const home = await mkdtemp(path.join(os.tmpdir(), "qd-landed-src-"));
  try {
    await mkdir(path.join(home, "bin"));
    await mkdir(path.join(home, "data"));
    await writeFile(path.join(home, "data/backlog.md"), ledger);
    const snapshot = { ...fixture, landed: [
      { id: "ship-window", what: "Ship it", artifact: "local main", owner: "(main)" },
      { id: "other-home", what: "Elsewhere", artifact: "local main", owner: "second-mate" },
      { id: "twin", what: "Twin", artifact: "-", owner: "(main)" },
    ] };
    await writeFile(path.join(home, "bin/fm-bearings-snapshot.sh"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(snapshot)}'\n`, { mode: 0o755 });
    const content = normalizeSnapshot(JSON.parse(await createSnapshotRunner(home)()));
    const ship = content.landed.find((card) => card.task === "ship-window");
    assert.equal(ship.repo, "example-app");
    assert.equal(ship.artifact, "local main");
    assert.equal(ship.what, "Ship it");
    assert.equal(ship.backlogTitle, "Ship it");
    assert.equal(ship.clock.at, "2026-10-03");
    assert.equal(content.landed.find((card) => card.task === "other-home").repo, null);
    assert.equal(content.landed.find((card) => card.task === "other-home").clock.at, null);
    assert.equal(content.landed.find((card) => card.task === "other-home").backlogTitle, undefined);
    assert.equal(content.landed.find((card) => card.task === "twin").repo, null);
    assert.equal(content.landed.find((card) => card.task === "twin").backlogTitle, undefined);
    assert.equal(await readFile(path.join(home, "data/backlog.md"), "utf8"), ledger);
    assert.doesNotMatch(JSON.stringify(content.landed), /\/synthetic\//);
  } finally { await rm(home, { recursive: true, force: true }); }
});

test("acknowledge records the current card revision outside the Firstmate home", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "qd-landed-home-"));
  const root = await mkdtemp(path.join(os.tmpdir(), "qd-landed-state-"));
  const statePath = path.join(root, "presentation.json");
  const revision = "c".repeat(40);
  const card = { key: "landed:ship-window", type: "landed", task: "ship-window", rev: REV };
  let state = "ready";
  const landed = [card];
  const bearingsSource = { current: () => ({ state, landed: state === "loading" ? [] : landed, cards: [] }), close() {} };
  const store = createLandedAckStore({ FM_QUARTERDECK_STATE_PATH: statePath });
  const server = createServer({ FM_HOME: home, FM_QUARTERDECK_STATE_PATH: statePath }, {
    revisionResolver: { initial: revision, snapshot: async () => revision },
    bearingsSource,
    landedAcks: store,
    quotaReader: async () => ({ providers: [] }),
    costReader: async () => ({ azure: { status: "unavailable" }, github: { status: "unavailable" } }),
    lanesReader: async () => ({ lanes: [] }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const post = (body, origin = url) => fetch(`${url}/api/bearings/landed/ack`, {
    method: "POST", headers: { "content-type": "application/json", origin }, body: JSON.stringify(body),
  });
  try {
    assert.equal(path.dirname(landedAckPath({ FM_QUARTERDECK_STATE_PATH: statePath })), root);
    assert.equal((await post({ key: card.key, rev: "b".repeat(16) })).status, 400);
    assert.equal((await post({ key: "decision:alpha-call" })).status, 400);
    assert.equal((await post({ key: card.key }, "https://elsewhere.invalid")).status, 403);
    assert.equal((await post({ key: "landed:missing" })).status, 409);
    state = "loading";
    assert.equal((await post({ key: card.key })).status, 409);
    state = "ready";
    const saved = await post({ key: card.key });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).acks[card.key], REV, "the server stores the open card rev");
    const file = path.join(root, "quarterdeck-landed-acknowledgements.json");
    assert.equal(JSON.parse(await readFile(file, "utf8")).acks[card.key], REV);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(path.relative(home, file).startsWith(".."), true);
    const listed = await (await fetch(`${url}/api/bearings/landed/acks`)).json();
    assert.equal(listed.acks[card.key], REV);
    state = "stale";
    card.rev = "b".repeat(16);
    assert.equal((await (await post({ key: card.key })).json()).acks[card.key], card.rev);
    const open = new Set();
    for (let i = 0; i < 199; i += 1) open.add(`landed:keep-${i}`);
    for (const key of open) await store.acknowledge(key, REV, open);
    await store.acknowledge("landed:stale-drop", REV, open);
    open.delete("landed:stale-drop");
    open.add("landed:fresh");
    const capped = await store.acknowledge("landed:fresh", "c".repeat(16), open);
    assert.equal(capped.acks["landed:fresh"], "c".repeat(16));
    assert.equal(capped.acks["landed:stale-drop"], undefined);
    assert.equal(Object.keys(capped.acks).length, 200);
    assert.equal((await store.read()).acks[card.key], undefined, "a stale key drops only at the cap");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

test("a landed follow-up relays a thread note keyed by the landed task id", async () => {
  const card = { key: "landed:ship-window", type: "landed", task: "ship-window", what: "Ship the window", rev: REV };
  const calls = [];
  const relay = createThreadRelay({
    home: "/synthetic/home",
    receipts: async () => ({ pending: [], handled: [], replies: [] }),
    transcript: async () => ({ turns: [], omitted: false }),
    now: () => Date.parse("2026-10-01T00:00:00Z"),
    note: async (_home, id, text) => { calls.push({ id, text }); return { id: "note-9", outcome: "created" }; },
  });
  const body = { requestId: uuid, key: card.key, text: "Follow up on the window" };
  await assert.rejects(relay.submit(body, { cards: [], landed: [] }), (error) => error.code === "gone");
  assert.equal(calls.length, 0);
  const accepted = await relay.submit(body, { cards: [ { key: "decision:ship-window", type: "decision", task: "ship-window" } ], landed: [card] });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.key, card.key);
  assert.equal(calls[0].id, `quarterdeck-thread:landed:ship-window:${uuid}`);
  assert.match(calls[0].text, /Captain asks about Landed ship-window from Quarterdeck: Follow up on the window/);
  assert.match(calls[0].text, /nothing was decided/);
  assert.doesNotMatch(calls[0].text, /fm-bearings-answer/);
  const envelope = taggedEnvelope(calls[0].text, "fm-quarterdeck-thread");
  assert.equal(envelope.schema, "fm-quarterdeck-card-thread.v1");
  assert.equal(envelope.key, "landed:ship-window");
  assert.equal(envelope.type, "landed");
  assert.equal(envelope.task, "ship-window");
  assert.equal(envelope.question, "Follow up on the window");
  const history = await relay.history(card.key, { cards: [], landed: [card] });
  assert.equal(history.task, "ship-window");
  await assert.rejects(relay.submit({ ...body, requestId: "00000000-0000-4000-8000-000000000010", key: "lane:x" }, { landed: [card] }), (error) => error.code === "invalid");
});

test("a checked backlog title and a continued landing link stay whole", async () => {
  const long = `https://example.invalid/${"a".repeat(420)}`;
  const cut = "https://example.invalid/acme/example-app/pull/…";
  const shorter = "https://example.invalid/acme/example-app/pull/4";
  const full = "https://example.invalid/acme/example-app/pull/42";
  assert.ok(long.length > 400 && long.length <= 2000);
  const content = normalizeSnapshot({ ...fixture, landed: [
    { id: "ship-window", what: "Ship the example-app release…", artifact: cut, owner: "(main)", backlogTitle: "Ship the example-app release window", backlogUrls: [shorter, full, "https://example.invalid/other"] },
    { id: "local-notes", what: "Notes from the other ledger…", artifact: "local main", owner: "(main)", backlogTitle: "Land the sample notes on local main" },
    { id: "long-link", what: "Long link", artifact: long, owner: "(main)" },
    { id: "other-home", what: "Elsewhere…", artifact: cut, owner: "second-mate", backlogTitle: "Do not use this title", backlogUrls: [full] },
    { id: "plain-cut", what: "See the notes…", artifact: "Report…", owner: "(main)", backlogUrls: [full] },
    { id: "too-long", what: "Too long", artifact: `https://example.invalid/${"b".repeat(2100)}`, owner: "(main)" },
  ] });
  const ship = content.landed.find((card) => card.task === "ship-window");
  assert.equal(ship.what, "Ship the example-app release…");
  assert.equal(ship.backlogTitle, "Ship the example-app release window");
  assert.equal(ship.url, full);
  assert.equal(ship.artifact, null);
  assert.equal(ship.backlogUrls, undefined);
  const local = content.landed.find((card) => card.task === "local-notes");
  assert.equal(local.artifact, "local main");
  assert.equal(local.url, null);
  assert.equal(local.backlogTitle, "Land the sample notes on local main");
  assert.equal(content.landed.find((card) => card.task === "long-link").url, long);
  const other = content.landed.find((card) => card.task === "other-home");
  assert.equal(other.backlogTitle, undefined);
  assert.equal(other.url, null);
  assert.match(other.artifact, /…$/);
  const plain = content.landed.find((card) => card.task === "plain-cut");
  assert.equal(plain.url, null);
  assert.equal(plain.artifact, "Report…");
  const overflow = content.landed.find((card) => card.task === "too-long");
  assert.equal(overflow.url, null);
  assert.match(overflow.artifact, /…$/);
  const home = await mkdtemp(path.join(os.tmpdir(), "qd-landed-title-"));
  try {
    await mkdir(path.join(home, "bin"));
    await mkdir(path.join(home, "data"));
    const ledger = `- [x] ship-window - Ship the example-app release window (repo: example-app) (done 2026-10-01) ${full}.
- [ ] ship-window - Open copy (repo: wrong) (done 2026-10-09)
- [x] local-notes - Land the sample notes on local main (repo: sample-notes) (merged 2026-10-02)
`;
    await writeFile(path.join(home, "data/backlog.md"), ledger);
    const snapshot = { ...fixture, landed: [
      { id: "ship-window", what: "Ship the example-app release…", artifact: cut, owner: "(main)", backlogTitle: "Forged title", backlogUrls: ["https://example.invalid/forged"] },
      { id: "local-notes", what: "Notes from the other ledger…", artifact: "Notes…", owner: "(main)", backlogUrls: [full] },
      { id: "other-home", what: "Elsewhere…", artifact: cut, owner: "second-mate", backlogTitle: "Foreign title", backlogUrls: [full] },
    ] };
    await writeFile(path.join(home, "bin/fm-bearings-snapshot.sh"), `#!/bin/sh\nprintf '%s' '${JSON.stringify(snapshot)}'\n`, { mode: 0o755 });
    const served = normalizeSnapshot(JSON.parse(await createSnapshotRunner(home)()));
    const servedShip = served.landed.find((card) => card.task === "ship-window");
    assert.equal(servedShip.backlogTitle, "Ship the example-app release window");
    assert.equal(servedShip.url, full);
    assert.equal(servedShip.artifact, null);
    assert.equal(servedShip.backlogUrls, undefined);
    const servedLocal = served.landed.find((card) => card.task === "local-notes");
    assert.equal(servedLocal.backlogTitle, "Land the sample notes on local main");
    assert.equal(servedLocal.url, null);
    assert.equal(servedLocal.artifact, "Notes…");
    const servedOther = served.landed.find((card) => card.task === "other-home");
    assert.equal(servedOther.backlogTitle, undefined);
    assert.equal(servedOther.url, null);
    assert.equal(await readFile(path.join(home, "data/backlog.md"), "utf8"), ledger);
  } finally { await rm(home, { recursive: true, force: true }); }
});
