import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyLegacySkill } from "../../skills/fmqd-lanes/verify-legacy.mjs";

const repo = new URL("../../", import.meta.url);
const file = (name) => new URL(name, repo);

test("fmqd-lanes canonical skill keeps flat routing and bounded semantic taxonomy", async () => {
  const skill = await readFile(file("skills/fmqd-lanes/SKILL.md"), "utf8");
  assert.equal((await stat(file("skills/fmqd-lanes/SKILL.md"))).isFile(), true);
  assert.match(skill, /Unconditional Wrapping:.*Every single message.*MUST be wrapped/);
  assert.match(skill, /\[fm-lane <LaneName>\].*\[end <LaneName>\]/);
  assert.match(skill, /at most \*\*two semantic levels\*\*: project\/repository first, then a coherent feature or capability theme/);
  assert.match(skill, /One level.*too broad.*three levels.*implementation slices/);
  assert.match(skill, /implementation slice, worker, branch, task ID, or isolated copy is not a third lane level/);
  assert.match(skill, /syntactically flat: nested tags are not supported.*streaming, routing, and closure ambiguous/);
  assert.match(skill, /single continuous descriptive string.*registered lane name for explicit UI routing/);
  assert.match(skill, /one user outcome, target, state owner, authority level, validation matrix, and rollback unit/);
  assert.match(skill, /semantic dependencies and shared mutable external state.*files differ.*files overlap/);
  assert.match(skill, /each worker keeps its own editable copy/);
  assert.match(skill, /Before assigning a ninth simultaneously active worker to one theme lane.*consolidation or serialization.*sibling themes.*completed workers should be closed/);
  assert.match(skill, /review trigger, not an automatic split or merge.*historical completed workers do not count as active.*retained unresolved slices.*cleanup pressure/);
  assert.match(skill, /Never share an editable copy, delete preserved work, merge unrelated scope, or add a deeper lane level/);
  assert.match(skill, /\[fm-lane General\][\s\S]*\[end General\]/);
});

test("read-only preflight refuses changed legacy bytes or entry without overwriting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fmqd-lanes-legacy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const legacy = path.join(root, "legacy");
  // Contract: legacy rollback preflight accepts only the caller-approved bytes
  // in a standalone directory containing one regular SKILL.md. A synthetic
  // baseline makes the oracle independent of the current skill's wording.
  const expected = Buffer.from("# Approved synthetic legacy skill\n");
  await mkdir(legacy);
  await writeFile(path.join(legacy, "SKILL.md"), expected);
  const hash = createHash("sha256").update(expected).digest("hex");
  assert.equal((await verifyLegacySkill(legacy, hash)).ok, true);
  const changed = Buffer.concat([expected, Buffer.from("unexpected\n")]);
  await writeFile(path.join(legacy, "SKILL.md"), changed);
  assert.equal((await verifyLegacySkill(legacy, hash)).ok, false);
  assert.deepEqual(await readFile(path.join(legacy, "SKILL.md")), changed);
  await writeFile(path.join(legacy, "SKILL.md"), expected);
  await writeFile(path.join(legacy, "extra"), "retained");
  assert.equal((await verifyLegacySkill(legacy, hash)).ok, false);
  assert.equal(await readFile(path.join(legacy, "extra"), "utf8"), "retained");
  await rm(path.join(legacy, "extra"));
  const redirected = path.join(root, "redirected");
  await symlink(legacy, redirected);
  assert.equal((await verifyLegacySkill(redirected, hash)).ok, false);
  assert.deepEqual(await readFile(path.join(legacy, "SKILL.md")), expected);
  const target = path.join(root, "approved.md");
  await writeFile(target, expected);
  await rm(path.join(legacy, "SKILL.md"));
  await symlink(target, path.join(legacy, "SKILL.md"));
  assert.equal((await verifyLegacySkill(legacy, hash)).ok, false);
  assert.deepEqual(await readFile(target), expected);
});
