import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSyntheticHistory, fixtureGit } from "../scripts/synthetic-history.mjs";
import { commitRelation } from "../previews.js";

test("lifecycle provisioning owns synthetic parent/child history, never the source repository parent", async (t) => {
  const checkout = await mkdtemp(path.join(os.tmpdir(), "synthetic-history-"));
  t.after(() => rm(checkout, { recursive: true, force: true }));
  await writeFile(path.join(checkout, "source.txt"), "Synthetic reviewed bytes\n");
  const { ancestor, head } = await createSyntheticHistory(checkout);
  assert.notEqual(ancestor, head);
  assert.equal(fixtureGit(checkout, "rev-list", "--count", "--all"), "2");
  assert.equal(fixtureGit(checkout, "rev-list", "--parents", "-n", "1", head), `${head} ${ancestor}`);
  assert.equal(fixtureGit(checkout, "rev-list", "--parents", "-n", "1", ancestor), ancestor);
  assert.equal(fixtureGit(checkout, "remote"), "");
  assert.equal(fixtureGit(checkout, "status", "--porcelain"), "");
  assert.equal(await commitRelation(head, ancestor, checkout), "local-ahead");
  const sibling = fixtureGit(checkout, "commit-tree", `${head}^{tree}`, "-p", ancestor, "-m", "Synthetic sibling");
  assert.equal(await commitRelation(head, sibling, checkout), "diverged");
  await assert.rejects(createSyntheticHistory(checkout), /Fresh export required/);
});
