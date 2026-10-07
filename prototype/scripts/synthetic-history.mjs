// Test/lab provisioning only. No source history, configuration, remotes or authors
// are inherited. Call only on a freshly verified export in an exclusive temp root.
import { execFileSync } from "node:child_process";
import { writeFile, lstat } from "node:fs/promises";
import path from "node:path";

export function fixtureGit(checkout, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], {
    cwd: checkout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { PATH: process.env.PATH, HOME: checkout, LC_ALL: "C", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" },
  }).trim();
}

export async function createSyntheticHistory(checkout) {
  await lstat(path.join(checkout, ".git")).then(() => { throw new Error("Fresh export required"); }, (error) => { if (error.code !== "ENOENT") throw error; });
  fixtureGit(checkout, "-c", "init.templateDir=", "init", "-q", "--object-format=sha1", "--initial-branch=fixture-main");
  fixtureGit(checkout, "add", ".");
  fixtureGit(checkout, "commit", "-qm", "Synthetic root");
  const ancestor = fixtureGit(checkout, "rev-parse", "HEAD");
  await writeFile(path.join(checkout, ".fixture-generation"), "Synthetic child\n", { flag: "wx" });
  fixtureGit(checkout, "add", ".fixture-generation");
  fixtureGit(checkout, "commit", "-qm", "Synthetic child");
  return { ancestor, head: fixtureGit(checkout, "rev-parse", "HEAD") };
}
