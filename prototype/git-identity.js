// Shared startup/request-time source proof. Never inherit Git redirection or
// accept a parent repository merely because Git can discover it from cwd.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const run = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;

export function sourceGitEnvironment() {
  return { PATH: process.env.PATH, LC_ALL: "C", HOME: "/nonexistent",
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0" };
}

export function createGitIdentity(root, { git = async (args) => {
  const { stdout } = await run("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root, env: sourceGitEnvironment(), timeout: 2000, maxBuffer: 1024 * 1024,
  });
  return stdout.trim();
} } = {}) {
  if (!path.isAbsolute(root) || path.normalize(root) !== root) throw new Error("Exact source root required");
  const proveRoot = async () => {
    if (await git(["rev-parse", "--show-toplevel"]) !== root) throw new Error("Git source root mismatch");
  };
  return {
    async snapshot() {
      try {
        await proveRoot();
        const head = await git(["rev-parse", "--verify", "HEAD^{commit}"]);
        if (!SHA.test(head)) throw new Error("Invalid serving revision");
        if (await git(["status", "--porcelain", "--untracked-files=no"])) throw new Error("Serving checkout is changing");
        await proveRoot();
        if (head !== await git(["rev-parse", "--verify", "HEAD^{commit}"])) throw new Error("Serving identity changed during probe");
        return head;
      } catch { return null; }
    },
    async isAncestor(ancestor, head) {
      if (!SHA.test(ancestor) || !SHA.test(head)) return false;
      try {
        await proveRoot();
        await git(["merge-base", "--is-ancestor", ancestor, head]);
        return true;
      } catch { return false; }
    },
  };
}
