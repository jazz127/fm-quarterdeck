import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { answerEnvelope, validateAnswer } from "../bearings-answer.js";
import { applyBoardDecisionOptions, contentRevision, createSnapshotRunner, extractBoardPayload, normalizeSnapshot, readBearingsBoard } from "../bearings.js";

const fixture = async () => JSON.parse(await readFile(new URL("./fixtures/bearings/two-calls.json", import.meta.url), "utf8"));
const uuid = "00000000-0000-4000-8000-000000000010";
const choice = (value, label, hint) => ({ value, label, ...(hint === undefined ? {} : { hint }) });
const board = (extra = {}) => ({
  schema: "fm-bearings-board.v1",
  home: "synthetic-home",
  generated: "2026-06-01T12:00:00Z",
  prs_live: false,
  captains_call: [],
  underway: [],
  landed: [],
  charted: [],
  ...extra,
});
const decisionCard = (extra = {}) => ({
  key: "alpha-call",
  type: "decision",
  repo: "example-app",
  title: "Choose a window",
  options: [
    choice("staged", "Staged rollout", "Fewer users at once"),
    choice("now", "Ship now"),
    choice("reconcile", "Reconcile", "Re-check"),
  ],
  recommend_value: "staged",
  close: "done",
  ...extra,
});
const page = (payload) => `<!doctype html><script>globalThis.__boardExecuted = true</script><script id="bearings-data" type="application/json">\n${JSON.stringify(payload).replaceAll("<", "\\u003c")}\n</script>`;
const answerFor = (raw, key = "decision:alpha-call") => normalizeSnapshot(raw).cards.find((card) => card.key === key).answer;

test("board text obeys the public path-redaction contract for local and read-only decisions", async () => {
  const raw = await fixture();
  const fields = {
    title: "Title: /home/example/projects/sample/title.md",
    about: "About: /home/example/projects/sample/about.md",
    decide: "Decide: /home/example/projects/sample/decide.md",
    detail: "Report: /home/example/projects/sample/report.md",
    freeform_hint: "Read /home/example/projects/sample/hint.md",
    pr_url: "file:///home/example/projects/sample/report.md",
    close: { report: "/home/example/projects/sample/report.md" },
    allow_freeform: true,
  };
  applyBoardDecisionOptions(raw, board({ captains_call: [
    decisionCard(fields),
    decisionCard({ ...fields, key: "gamma-credential", type: "credential" }),
  ] }));
  const model = normalizeSnapshot(raw);
  for (const key of ["decision:alpha-call", "decision:gamma-credential"]) {
    const card = model.cards.find((entry) => entry.key === key);
    assert.equal(card.boardTitle, "Title: …/title.md");
    assert.equal(card.boardAbout, "About: …/about.md");
    assert.equal(card.boardDecide, "Decide: …/decide.md");
    assert.equal(card.boardDetail, "Report: …/report.md");
    assert.equal(card.boardFreeformHint, "Read …/hint.md");
    assert.equal(card.boardPrUrl, null);
    assert.equal(card.boardClose, null);
    assert.equal(card.boardAllowFreeform, true);
  }
  const local = model.cards.find((entry) => entry.key === "decision:alpha-call");
  assert.equal(local.answer.freeform_hint, "Read …/hint.md");
  const remote = model.cards.find((entry) => entry.key === "decision:gamma-credential");
  assert.equal(remote.readOnly, true);
  assert.equal(remote.answer, null);
  assert.doesNotMatch(JSON.stringify(model), /\/home\/example/);

  const firstRev = contentRevision(model);
  for (const row of raw.decisions_open) {
    for (const field of ["board_title", "board_about", "board_decide", "board_detail", "board_freeform_hint"]) {
      row[field] = row[field].replaceAll("/home/example/projects/sample", "/home/example/other/checkout");
    }
  }
  const relocated = normalizeSnapshot(raw);
  assert.deepEqual(relocated.cards.map((card) => card.rev), model.cards.map((card) => card.rev));
  assert.equal(contentRevision(relocated), firstRev);
});

test("public board metadata preserves full safe context and snapshot answer authority", async () => {
  const raw = await fixture();
  raw.decisions_open[0].close = "release";
  const detail = `Full context ${"rollout evidence ".repeat(40)}final evidence`;
  const fields = { title: "Choose a window", about: "Example application", decide: "Tuesday or Friday?", detail,
    pr_url: "https://example.invalid/pr/42", freeform_hint: "Explain the timing", allow_freeform: true, close: "done" };
  applyBoardDecisionOptions(raw, board({ captains_call: [decisionCard(fields)] }));
  const card = normalizeSnapshot(raw).cards.find((entry) => entry.key === "decision:alpha-call");
  assert.equal(card.boardTitle, fields.title);
  assert.equal(card.boardAbout, fields.about);
  assert.equal(card.boardDecide, fields.decide);
  assert.equal(card.boardDetail, detail);
  assert.equal(card.boardPrUrl, fields.pr_url);
  assert.equal(card.boardFreeformHint, fields.freeform_hint);
  assert.equal(card.boardAllowFreeform, true);
  assert.equal(card.boardClose, "done");
  assert.equal(card.answer.close, "release");
});

test("public board metadata rejects untyped text, unsafe URLs and invalid close modes", async () => {
  const raw = await fixture();
  const row = raw.decisions_open[0];
  for (const value of [{ path: "/home/example/report.md" }, ["/home/example/report.md"], 42, true, null, ""]) {
    for (const field of ["board_title", "board_about", "board_decide", "board_detail", "board_freeform_hint"]) row[field] = value;
    const card = normalizeSnapshot(raw).cards.find((entry) => entry.key === "decision:alpha-call");
    for (const field of ["boardTitle", "boardAbout", "boardDecide", "boardDetail", "boardFreeformHint"]) assert.equal(card[field], null);
    assert.equal(card.answer.freeform_hint, null);
  }
  for (const value of ["/home/example/report.md", "file:///home/example/report.md", "http://example.invalid/pr/42", "javascript:alert(1)", "https://example:secret@example.invalid/pr/42", {}, []]) {
    row.board_pr_url = value;
    assert.equal(normalizeSnapshot(raw).cards.find((entry) => entry.key === "decision:alpha-call").boardPrUrl, null);
  }
  for (const value of ["/home/example/report.md", "unknown", {}, [], true, 42, null]) {
    row.board_close = value;
    const card = normalizeSnapshot(raw).cards.find((entry) => entry.key === "decision:alpha-call");
    assert.equal(card.boardClose, null);
  }
  for (const value of ["true", "done", {}, [], 42, null, false]) {
    row.board_allow_freeform = value;
    assert.equal(normalizeSnapshot(raw).cards.find((entry) => entry.key === "decision:alpha-call").boardAllowFreeform, false);
  }
  for (const value of ["done", "release"]) {
    row.board_close = value;
    assert.equal(normalizeSnapshot(raw).cards.find((entry) => entry.key === "decision:alpha-call").boardClose, value);
  }
});

test("a fresh board decision supplies its options and recommendation, and the answer relay is unchanged", async () => {
  const raw = await fixture();
  raw.decisions_open[0].updated_at = "2026-06-01T11:00:00Z";
  raw.decisions_open[0].close = "release";
  const payload = board({ captains_call: [decisionCard(), { key: "alpha-call", type: "merge", repo: "example-app", title: "Do not use", risk: "high", options: [choice("merge", "Merge from the board")] }] });
  applyBoardDecisionOptions(raw, extractBoardPayload(page(payload)));
  const answer = answerFor(raw);
  assert.deepEqual(answer.options, [
    { value: "staged", label: "Staged rollout", hint: "Fewer users at once" },
    { value: "now", label: "Ship now", hint: null },
  ]);
  assert.equal(answer.recommend, "staged");
  assert.equal(answer.close, "release", "board close is not an answer mode");
  assert.equal(answer.options.some((option) => option.value === "reconcile"), false);
  assert.equal(JSON.stringify(raw).includes("synthetic-home"), false);
  const model = { schema: "fm-quarterdeck-call.v1", rev: "model-rev-1", state: "ready", ...normalizeSnapshot(raw) };
  const card = model.cards.find((entry) => entry.key === "decision:alpha-call");
  assert.equal(validateAnswer({ requestId: uuid, key: card.key, cardRev: card.rev, ...(card.holdVersion ? { holdVersion: card.holdVersion } : {}), selection: "staged", note: "Tuesday" }, model).selection, "staged");
  assert.equal(answerEnvelope({ card, selection: "staged", note: "Tuesday" }, model.rev).selection, "staged");
  assert.deepEqual(answerFor(raw, "merge:beta-merge").options.map((option) => option.value), ["merge"]);
});

test("a missing board, an unmatched task, and a hold with no clock keep the snapshot answer", async () => {
  const raw = await fixture();
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  applyBoardDecisionOptions(raw, null);
  assert.equal(answerFor(raw).recommend, "later");
  applyBoardDecisionOptions(raw, board({ captains_call: [decisionCard({ key: "other-task" })] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["later"]);
  delete raw.decisions_open[0].updated_at;
  delete raw.decisions_open[0].hold_set_at;
  delete raw.decisions_open[0].created;
  applyBoardDecisionOptions(raw, board({ captains_call: [decisionCard()] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["staged", "now"], "no durable update does not make the board stale");
});

test("a board generated before the hold's latest update leaves snapshot options in place", async () => {
  const raw = await fixture();
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  raw.decisions_open[0].updated_at = "2026-05-01T00:00:00Z";
  raw.decisions_open[0].hold_set_at = "2026-06-02T00:00:00Z";
  applyBoardDecisionOptions(raw, board({ generated: "2026-06-01T12:00:00Z", captains_call: [decisionCard()] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["later"]);
  raw.decisions_open[0].hold_set_at = "2026-05-01T00:00:00Z";
  raw.decisions_open[0].updated_at = "2026-06-01T12:00:00Z";
  applyBoardDecisionOptions(raw, board({ generated: "2026-06-01T11:00:00Z", captains_call: [decisionCard()] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["later"]);
  applyBoardDecisionOptions(raw, board({ generated: "2026-06-01T12:00:00Z", captains_call: [decisionCard()] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["staged", "now"], "a board at the same instant is current");
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  raw.decisions_open[0].updated_at = "2026-06-01";
  applyBoardDecisionOptions(raw, board({ generated: "2026-06-01T12:00:00Z", captains_call: [decisionCard()] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["staged", "now"], "a date-only update is UTC midnight");
});

test("malformed board text and an invalid payload do not change options or run the page", async () => {
  const raw = await fixture();
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  const before = JSON.stringify(raw.decisions_open[0].options);
  assert.equal(extractBoardPayload("<p>no board</p>"), null);
  assert.equal(extractBoardPayload(`${page(board())}</script><script>throw new Error("executed")</script>`).schema, "fm-bearings-board.v1");
  assert.equal(globalThis.__boardExecuted, undefined);
  const earlyClose = `<script id="bearings-data" type="application/json">{"schema":"fm-bearings-board.v1"</script><script>throw new Error("executed")</script>`;
  assert.equal(extractBoardPayload(earlyClose), null);
  assert.equal(globalThis.__boardExecuted, undefined);
  const withMarkup = page(board()).replace("fm-bearings-board.v1", "fm-bearings-board.v1<");
  assert.equal(extractBoardPayload(withMarkup), null);
  for (const payload of [
    board({ schema: "fm-bearings-board.v0" }),
    board({ generated: "yesterday" }),
    board({ home: "" }),
    board({ captains_call: "alpha-call" }),
    null,
    [],
  ]) {
    applyBoardDecisionOptions(raw, payload);
    assert.equal(JSON.stringify(raw.decisions_open[0].options), before);
  }
});

test("reconcile, a merge card, and an invalid board set are ignored", async () => {
  const raw = await fixture();
  raw.decisions_open[0].updated_at = "2026-06-01T11:00:00Z";
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  applyBoardDecisionOptions(raw, board({ captains_call: [decisionCard({ options: [choice("reconcile", "Reconcile")], recommend_value: "reconcile" })] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["later"]);
  raw.decisions_open[0].options = [choice("later", "Later")];
  applyBoardDecisionOptions(raw, board({ captains_call: [{ key: "alpha-call", type: "merge", repo: "example-app", title: "Merge", risk: "low", options: [choice("ship", "Ship it")], recommend_value: "ship" }] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["later"]);
  const duplicate = choice("staged", "Staged");
  applyBoardDecisionOptions(raw, board({ captains_call: [decisionCard({ options: [duplicate, choice("staged", "Again"), choice("reconcile", "Reconcile")], recommend_value: "staged" })] }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["later"], "one invalid option voids the board set");
  applyBoardDecisionOptions(raw, board({
    captains_call: [
      { key: "alpha-call", type: "credential", repo: "example-app", title: "Credential", options: [choice("rotate", "Rotate")], recommend_value: "rotate" },
      decisionCard(),
    ],
  }));
  assert.deepEqual(answerFor(raw).options.map((option) => option.value), ["staged", "now"]);
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  applyBoardDecisionOptions(raw, board({ captains_call: [{ key: "alpha-call", type: "credential", repo: "example-app", title: "Credential", options: [choice("rotate", "Rotate")], recommend_value: "missing" }] }));
  assert.deepEqual(answerFor(raw).options, [{ value: "rotate", label: "Rotate", hint: null }]);
  assert.equal(answerFor(raw).recommend, null);
  const pathLabel = "/srv/synthetic/home/data/secret";
  applyBoardDecisionOptions(raw, board({ captains_call: [decisionCard({ options: [choice("staged", pathLabel)], recommend_value: "staged" })] }));
  assert.equal(answerFor(raw).options[0].label.includes("synthetic"), false);
  assert.match(answerFor(raw).options[0].label, /secret/);
});

test("the snapshot runner reads only a regular bounded board file from the selected home", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-board-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "bin"));
  await mkdir(path.join(root, ".lavish"));
  const raw = await fixture();
  raw.decisions_open[0].updated_at = "2026-06-01T11:00:00Z";
  const snapshot = path.join(root, "snapshot.json");
  await writeFile(snapshot, JSON.stringify(raw));
  await writeFile(path.join(root, "bin", "fm-bearings-snapshot.sh"), "#!/bin/sh\ncat \"$FM_HOME/snapshot.json\"\n", { mode: 0o755 });
  const boardPath = path.join(root, ".lavish", "bearings-board.html");
  const fresh = board({ generated: "2026-06-01T12:00:00Z", captains_call: [decisionCard()] });
  await writeFile(boardPath, page(fresh));
  const matched = JSON.parse(await createSnapshotRunner(root)());
  assert.deepEqual(answerFor(matched).options.map((option) => option.value), ["staged", "now"]);
  assert.equal(globalThis.__boardExecuted, undefined);

  await writeFile(boardPath, "<html>not a board</html>");
  raw.decisions_open[0].options = [choice("later", "Later")];
  raw.decisions_open[0].recommend_value = "later";
  await writeFile(snapshot, JSON.stringify(raw));
  const absent = JSON.parse(await createSnapshotRunner(root)());
  assert.deepEqual(answerFor(absent).options.map((option) => option.value), ["later"]);

  await writeFile(path.join(root, "real-board.html"), page(fresh));
  await rm(boardPath);
  await symlink(path.join(root, "real-board.html"), boardPath);
  assert.equal(await readBearingsBoard(root), null);
  const linked = JSON.parse(await createSnapshotRunner(root)());
  assert.deepEqual(answerFor(linked).options.map((option) => option.value), ["later"]);

  await rm(boardPath);
  await writeFile(boardPath, `x${"y".repeat(1024 * 1024)}`);
  assert.equal(await readBearingsBoard(root), null);
});
