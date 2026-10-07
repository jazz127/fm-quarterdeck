import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parsePreferences } from "../preferences.js";
import { createServer } from "../server.js";

const sample = `# Working preferences
<!-- memory tiers -->

## Careful review (2026-09-23)
Because review context matters, keep the original draft.
Do not publish without approval.

- Keep one record.
- Keep the warning.

Recorded from explicit owner instructions, 2026-09-23.

## Short instruction
Do the small thing.

## Other dating
Owner wants only a local release.
Recorded from explicit owner instructions, 2026-09-19.

## Ambiguous (2026-02-30)
Do not fabricate a date.
Recorded from explicit owner instructions through 2026-09-19 and 2026-09-20.
`;

test("preference parser preserves boundaries and distinguishes dates, evidence, and missing reasons", () => {
  const data = parsePreferences(sample);
  assert.equal(data.source, "data/captain.md");
  assert.equal(data.entries.length, 4);
  assert.deepEqual(data.entries.map((entry) => entry.date), ["2026-09-23", null, "2026-09-19", null]);
  assert.deepEqual(data.entries.map((entry) => entry.addedAt), [null, null, null, null]);
  const explicitlyAdded = parsePreferences("# Working preferences\n## Dated (2026-01-01)\nAdded: 2026-02-02\nKeep safe.\n");
  assert.equal(explicitlyAdded.entries[0].date, "2026-01-01");
  assert.equal(explicitlyAdded.entries[0].addedAt, "2026-02-02");
  assert.equal(parsePreferences("# Working preferences\n## Ambiguous\nAdded: 2026-02-30\nKeep safe.\n").entries[0].addedAt, null);
  assert.equal(data.entries[0].dateBasis, "Dated section heading");
  assert.match(data.entries[2].dateBasis, /not necessarily introduction/);
  assert.equal(data.entries[0].rationale, "Because review context matters, keep the original draft.");
  assert.equal(data.entries[1].rationale, null);
  assert.equal(data.entries[0].content.includes("Do not publish without approval.\n\n- Keep one record.\n- Keep the warning."), true);
  assert.match(data.entries[0].source, /^data\/captain\.md:4-12$/);
});

test("malformed records fail closed; credential-like sections are withheld", () => {
  assert.throws(() => parsePreferences("## Alone\nBody"), /Unrecognized/);
  assert.throws(() => parsePreferences("# Working preferences\nUnstructured text"), /Unrecognized/);
  const data = parsePreferences("# Working preferences\n## Safe\nKeep this.\n## Unsafe\napi_key: test-secret-value\n");
  assert.equal(data.entries.length, 1);
  assert.equal(data.withheld, 1);
  assert.doesNotMatch(JSON.stringify(data), /test-secret-value/);
});

test("preferences API reads only current home record, no write method, and reports unavailable safely", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "quarterdeck-pref-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "data"));
  await writeFile(path.join(home, "data/captain.md"), sample);
  await writeFile(path.join(home, "data/unrelated.txt"), "private unrelated string");
  const server = createServer({ FM_HOME: home });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/preferences`;
  const response = await fetch(url);
  const data = await response.json();
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(data.entries.length, 4);
  assert.doesNotMatch(JSON.stringify(data), /private unrelated string|quarterdeck-pref-/);
  assert.equal((await fetch(url, { method: "POST" })).status, 404);
  await writeFile(path.join(home, "data/captain.md"), sample.replace("# Working preferences", "# Captain preferences"));
  const captainResponse = await fetch(url);
  assert.equal(captainResponse.status, 200);
  assert.deepEqual(await captainResponse.json(), data);
  await writeFile(path.join(home, "data/captain.md"), sample.replace("# Working preferences", "# Unrelated record"));
  assert.equal((await fetch(url)).status, 503);
  await rm(path.join(home, "data/captain.md"));
  await symlink(path.join(home, "data/unrelated.txt"), path.join(home, "data/captain.md"));
  const unavailable = await fetch(url);
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(JSON.stringify(await unavailable.json()), /private unrelated string|quarterdeck-pref-/);
});

test("both supported preference titles tolerate HTML comments below the title", () => {
  const expected = parsePreferences(sample);
  for (const title of ["Working preferences", "Captain preferences"]) {
    const markdown = sample.replace("# Working preferences", `# ${title}`);
    assert.deepEqual(parsePreferences(markdown), expected);
    assert.deepEqual(parsePreferences(markdown.replaceAll("\n", "\r\n")), expected);
    assert.deepEqual(parsePreferences(`# ${title}\n<!-- Synthetic comment -->\n`).entries, []);
  }
});

test("other record titles remain rejected", () => {
  for (const title of ["Preferences", "Captain", "Captain preferences extra", "Working preferences extra"]) {
    assert.throws(() => parsePreferences(`# ${title}\n<!-- Synthetic comment -->\n## Choice\nSynthetic text.\n`), /Unrecognized/);
  }
});

test("commented preference titles cannot authenticate unrelated records", () => {
  for (const title of ["Working preferences", "Captain preferences"]) {
    for (const newline of ["\n", "\r\n"]) {
      const markdown = `# Unrelated record\n<!--\n# ${title}\n-->\n## Choice\nSynthetic text.\n`.replaceAll("\n", newline);
      assert.throws(() => parsePreferences(markdown), /Unrecognized captain preference record/);
    }
  }
});

test("both supported titles accept multiline comment-only records", () => {
  for (const title of ["Working preferences", "Captain preferences"]) {
    for (const newline of ["\n", "\r\n"]) {
      for (const comment of ["<!--\nSynthetic comment\n-->\n", "<!--\n## Hidden choice\nSynthetic text.\n-->\n", "<!--\nSynthetic unfinished comment\n"]) {
        assert.deepEqual(parsePreferences(`# ${title}\n${comment}`.replaceAll("\n", newline)), {
          source: "data/captain.md", entries: [], withheld: 0,
        });
      }
      assert.throws(() => parsePreferences(`# ${title}\n<!--\nSynthetic comment\n-->\nUnstructured text\n`.replaceAll("\n", newline)), /Unrecognized preference sections/);
    }
  }
});

test("commented sections preserve original content, boundaries, and privacy", () => {
  for (const title of ["Working preferences", "Captain preferences"]) {
    for (const newline of ["\n", "\r\n"]) {
      const markdown = `# ${title}\n<!--\n## Hidden preamble\nSynthetic preamble.\n-->\n## Visible choice\nKeep this.\n<!--\n## Hidden boundary\nSynthetic comment.\n-->\nKeep this too.\n## Next choice\nSynthetic text.\n`;
      const data = parsePreferences(markdown.replaceAll("\n", newline));
      assert.deepEqual(data.entries.map((entry) => entry.title), ["Visible choice", "Next choice"]);
      assert.equal(data.entries[0].content, "Keep this.\n<!--\n## Hidden boundary\nSynthetic comment.\n-->\nKeep this too.");
      assert.deepEqual(data.entries.map((entry) => entry.source), ["data/captain.md:6-12", "data/captain.md:13-15"]);
      const unsafe = parsePreferences(markdown.replace("Synthetic comment.", "api_key: synthetic-secret-value").replaceAll("\n", newline));
      assert.deepEqual(unsafe.entries.map((entry) => entry.title), ["Next choice"]);
      assert.equal(unsafe.withheld, 1);
      assert.doesNotMatch(JSON.stringify(unsafe), /synthetic-secret-value/);
    }
  }
});
