#!/usr/bin/env python3
"""Temporary offline first-commit acceptance from a verified source archive.

Requires Linux /proc, Python 3.10+, Git 2.29+, Node 24 LTS, npm and POSIX tools.
No install, network, remotes, old Git objects, signing, account or live-home access.
Every temporary file lives under the explicit --scratch directory and is removed.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

spec = importlib.util.spec_from_file_location("exporter", Path(__file__).with_name("source-export.py"))
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)
LOG = None


def run(args, cwd, env):
    result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=240)
    if LOG:
        LOG.write(result.stdout)
        LOG.flush()
    # The fixture is entirely synthetic, but don't forward arbitrary tool diagnostics.
    if result.returncode:
        raise ValueError(f"fixture command failed: {Path(args[0]).name} (exit {result.returncode})")
    return result.stdout.decode()


def prove_history(repo, env, head=None):
    def git(*args):
        return run(["git", *args], repo, env).strip()
    current = git("rev-parse", "HEAD")
    exporter.require(head is None or head == current)
    exporter.require(git("rev-list", "--parents", "--all") == current)
    exporter.require(git("for-each-ref", "--format=%(refname)") == "refs/heads/fixture-main")
    exporter.require(git("remote") == "")
    exporter.require(git("log", "-1", "--format=%an <%ae>|%cn <%ce>") == "Fixture <fixture@example.invalid>|Fixture <fixture@example.invalid>")
    reachable = {row.split()[0] for row in git("rev-list", "--objects", "--all").splitlines()}
    stored = set(git("cat-file", "--batch-all-objects", "--batch-check=%(objectname)").splitlines())
    exporter.require(reachable == stored)
    exporter.require(not (repo / ".git/objects/info/alternates").exists())
    exporter.require(not (repo / ".git/shallow").exists())
    exporter.require(not git("status", "--porcelain", "--untracked-files=all"))
    return current, len(stored)


def main():
    global LOG
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--allowlist", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--audit", type=Path, help="Optional explicit private disclosure report; never copied")
    parser.add_argument("--log", type=Path, help="New private synthetic diagnostics file under --scratch")
    parser.add_argument("--runtime-only", action="store_true", help="Skip full suites; NOT complete release acceptance")
    args = parser.parse_args()
    try:
        exporter.require(sys.platform == "linux" and Path("/proc/self/stat").exists())
        scratch = exporter.no_symlink_parents(args.scratch)
        if args.log:
            parent = exporter.no_symlink_parents(args.log.parent)
            exporter.require(parent == scratch or scratch in parent.parents)
            LOG = args.log.open("xb")
            os.fchmod(LOG.fileno(), 0o600)
        # Keep even ignore-matcher temporary repositories under the supplied root.
        tempfile.tempdir = str(scratch)
        raw = exporter.regular_bytes(args.archive)
        allow = exporter.validate_manifest(json.loads(exporter.regular_bytes(args.allowlist)))
        blobs = exporter.verify_archive(raw, allow)
        if args.audit:
            markers, blocked = exporter.disclosure.private_signatures(exporter.regular_bytes(args.audit).decode())
            exporter.require(not exporter.disclosure.scan([(n, data) for n, (_, data) in blobs.items()], markers, blocked))
            print("PASS: private disclosure tables applied to verified archive (redacted)", flush=True)
        with tempfile.TemporaryDirectory(prefix="history-free-", dir=scratch) as temporary:
            root = Path(temporary)
            repo = root / "home/projects/fm-quarterdeck"
            repo.parent.mkdir(parents=True)
            exporter.extract_verified(raw, allow, repo)
            for name in ["os-home", "tmp", "config", "cache", "bin", "previews"]:
                (root / name).mkdir()
            # Restrict PATH to installed language/POSIX tools, not account CLIs.
            for name in ["git", "node", "npm", "python3", "sh", "bash", "cat", "dirname", "uname"]:
                target = shutil.which(name)
                exporter.require(target is not None)
                (root / "bin" / name).symlink_to(target)
            env = {"PATH": str(root / "bin"), "HOME": str(root / "os-home"), "TMPDIR": str(root / "tmp"),
                   "XDG_CONFIG_HOME": str(root / "config"), "XDG_CACHE_HOME": str(root / "cache"), "LC_ALL": "C",
                   "NPM_CONFIG_OFFLINE": "true", "NPM_CONFIG_UPDATE_NOTIFIER": "false", "NPM_CONFIG_AUDIT": "false",
                   "NPM_CONFIG_FUND": "false", "NPM_CONFIG_USERCONFIG": "/dev/null",
                   "PYTHONDONTWRITEBYTECODE": "1", "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": "/dev/null",
                   "GIT_TEMPLATE_DIR": "", "GIT_CONFIG_COUNT": "2",
                   "GIT_CONFIG_KEY_0": "core.hooksPath", "GIT_CONFIG_VALUE_0": "/dev/null",
                   "GIT_CONFIG_KEY_1": "commit.gpgSign", "GIT_CONFIG_VALUE_1": "false",
                   "GIT_AUTHOR_NAME": "Fixture", "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
                   "GIT_COMMITTER_NAME": "Fixture", "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
                   "GIT_AUTHOR_DATE": "2000-01-01T00:00:00Z", "GIT_COMMITTER_DATE": "2000-01-01T00:00:00Z"}
            print(run(["node", str(repo / "prototype/scripts/check-validation-runtime.mjs")], repo, env).strip(), flush=True)
            # Deliberately supply a real synthetic parent repository. No ceiling
            # hides parent discovery: production root-binding must reject it.
            run(["git", "init", "-q", "--object-format=sha1", "--initial-branch=fixture-parent"], root, env)
            run(["git", "commit", "--allow-empty", "-qm", "Synthetic unrelated parent repository"], root, env)
            script = str(repo / "prototype/scripts/history-free-acceptance.mjs")
            redirected = {**env, "GIT_DIR": str(root / ".git"), "GIT_WORK_TREE": str(repo),
                          "GIT_INDEX_FILE": str(root / ".git/index"), "GIT_COMMON_DIR": str(root / ".git")}
            for selected in [env, redirected]:
                print(run(["node", script, str(root), "no-git"], repo, selected).strip(), flush=True)
            # No clone, fetch, object alternates, templates, source parent or original authors.
            run(["git", "init", "-q", "--object-format=sha1", "--initial-branch=fixture-main"], repo, env)
            run(["git", "add", "."], repo, env)
            run(["git", "commit", "-qm", "Synthetic first source commit"], repo, env)
            head, objects = prove_history(repo, env)
            for name in ["one", "bad"]:
                exporter.extract_verified(raw, allow, root / "previews" / name)
            print(run(["node", script, str(root), "first-commit", head], repo, env).strip(), flush=True)
            print(run(["node", script, str(root), "identity-only", head], repo, redirected).strip(), flush=True)
            if not args.runtime_only:
                commands = [(["npm", "test", "--", "--test-reporter=tap"], repo / "prototype"),
                            (["python3", "-m", "unittest", "discover", "-s", "expenses"], repo),
                            (["python3", "-m", "unittest", "discover", "-s", "test", "-p", "test_*.py"], repo),
                            (["node", "--test", "--test-reporter=tap", *[str(p) for p in sorted((repo / "test").glob("*.test.mjs"))]], repo),
                            (["python3", "scripts/check-source-syntax.py"], repo)]
                for command, cwd in commands:
                    output = run(command, cwd, env)
                    summaries = [line for line in output.splitlines() if line.startswith(("# tests ", "# pass ", "# fail ", "Ran ", "PASS: "))]
                    print(f"PASS: {' '.join(command[:4])}: {'; '.join(summaries)}", flush=True)
            prove_history(repo, env, head)
            # Tests may create ignored scratch, but no source or tracked-tree drift.
            exporter.require(exporter.manifest(exporter.tree_blobs(repo, run(["git", "rev-parse", "HEAD^{tree}"], repo, env).strip())) == allow)
            print(f"PASS: single synthetic commit {head}; {objects} reachable-only objects; no remotes/old authors; archive sha256 {hashlib.sha256(raw).hexdigest()}", flush=True)
        print("PASS: all temporary repositories, homes and owned services cleaned", flush=True)
        return 0
    except Exception as error:
        # Only our generic command category, never captured stdout or private inputs.
        detail = str(error) if isinstance(error, ValueError) and str(error).startswith("fixture command failed:") else "verification or runtime boundary"
        print(f"REFUSED: {detail}", file=sys.stderr)
        return 1
    finally:
        if LOG:
            LOG.close()


if __name__ == "__main__":
    sys.exit(main())
