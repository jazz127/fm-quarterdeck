import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { verifyLegacySkill } from "../../skills/fm-lanes/verify-legacy.mjs";

test("read-only preflight refuses changed legacy bytes or entry without overwriting", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fm-lanes-legacy-"));
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
