import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createGitIdentity, sourceGitEnvironment } from "../git-identity.js";
import { createRevisionResolver } from "../revision.js";
import { fixtureGit } from "../scripts/synthetic-history.mjs";

async function repository(root) {
  await mkdir(root, { recursive: true });
  fixtureGit(root, "-c", "init.templateDir=", "init", "-q", "--object-format=sha1", "--initial-branch=fixture-main");
  await writeFile(path.join(root, "source.txt"), "Synthetic source\n");
  fixtureGit(root, "add", "."); fixtureGit(root, "commit", "-qm", "Synthetic root");
  return fixtureGit(root, "rev-parse", "HEAD");
}

test("real Git identity binds the exact root, not a clean parent or sibling repository", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "git-identity-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = await repository(root);
  const nested = path.join(root, "git-free", "source"); await mkdir(nested, { recursive: true });
  await writeFile(path.join(nested, "source.txt"), "Unreviewed exported bytes\n");
  assert.equal(fixtureGit(nested, "rev-parse", "HEAD"), parent); // reproduce Git's ordinary discovery
  assert.equal(await createGitIdentity(nested).snapshot(), null);
  assert.equal(await createRevisionResolver(nested, parent).snapshot(), null);
  assert.equal(await createGitIdentity(root).snapshot(), parent); // first commit: no parent needed
  const sibling = path.join(root, "other"); const siblingHead = await repository(sibling);
  const script = `import {createGitIdentity} from ${JSON.stringify(new URL("../git-identity.js", import.meta.url).href)};
    process.stdout.write(JSON.stringify(await createGitIdentity(process.argv[1]).snapshot()));`;
  const redirects = {
    GIT_DIR: path.join(sibling, ".git"), GIT_WORK_TREE: nested,
    GIT_COMMON_DIR: path.join(sibling, ".git"), GIT_INDEX_FILE: path.join(sibling, ".git/index"),
    GIT_OBJECT_DIRECTORY: path.join(sibling, ".git/objects"), GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(root, ".git/objects"),
    GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.worktree", GIT_CONFIG_VALUE_0: nested,
    GIT_CONFIG_PARAMETERS: "'core.bare=false'", GIT_CEILING_DIRECTORIES: path.dirname(root),
  };
  for (const overrides of [redirects, { GIT_DIR: path.join(sibling, ".git"), GIT_WORK_TREE: nested }]) {
    const probe = (location) => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", script, location], {
      env: { PATH: process.env.PATH, ...overrides }, encoding: "utf8",
    }));
    assert.equal(probe(nested), null);
    assert.equal(probe(root), parent);
    assert.equal(probe(sibling), siblingHead);
  }
  await writeFile(path.join(root, "source.txt"), "Dirty tracked source\n");
  assert.equal(await createGitIdentity(root).snapshot(), null);
});

test("request proof rejects moving roots/HEAD and non-fast-forward history; environment is an allowlist", async () => {
  const first = "a".repeat(40), second = "b".repeat(40), root = "/synthetic/source";
  let roots = 0;
  assert.equal(await createGitIdentity(root, { git: async (args) => {
    if (args.includes("--show-toplevel")) return ++roots === 1 ? root : "/synthetic/other";
    return args[0] === "status" ? "" : first;
  } }).snapshot(), null);
  let heads = 0;
  assert.equal(await createGitIdentity(root, { git: async (args) => {
    if (args.includes("--show-toplevel")) return root;
    return args[0] === "status" ? "" : ++heads === 1 ? first : second;
  } }).snapshot(), null);
  const resolver = createRevisionResolver(root, first, { intervalMs: 0, git: async (args) => {
    if (args.includes("--show-toplevel")) return root;
    if (args[0] === "merge-base") throw new Error("Synthetic divergent history");
    return args[0] === "status" ? "" : second;
  } });
  assert.equal(await resolver.snapshot(), null);
  assert.deepEqual(Object.keys(sourceGitEnvironment()).sort(), ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_NO_REPLACE_OBJECTS", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "HOME", "LC_ALL", "PATH"]);
});
