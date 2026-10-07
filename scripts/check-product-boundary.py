#!/usr/bin/env python3
"""Offline tracked-tree gate for retired product integrations, not private data.

Scan current bytes of indexed regular files. Stage additions/deletions first.
Dependency lock metadata may name unrelated transitive packages; it is not a
product integration claim. Rule/fixture content is exempt, never its path.
"""
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

RULE_FILES = {"scripts/check-product-boundary.py", "test/test_product_boundary.py"}
RETIRED_NAMES = re.compile(rb"(?<![a-z0-9_])(?:obsidian|firstmate[- ]lanes)(?![a-z0-9_])", re.I)
RETIRED_DOCS = re.compile(rb"(?<![a-z0-9_])docs/fm-lanes(?:/|\b)", re.I)


def findings(name, data):
    issues = []
    encoded = name.encode("utf-8")
    if RETIRED_NAMES.search(encoded) or RETIRED_DOCS.search(encoded):
        issues.append("retired integration path")
    # No whole-directory or test-suite exemptions. Third-party package metadata
    # is not first-party prose; package.json declarations remain checked.
    if name in RULE_FILES or PurePosixPath(name).name.lower() == "package-lock.json":
        return issues
    if RETIRED_NAMES.search(data) or RETIRED_DOCS.search(data):
        issues.append("retired integration reference")
    return issues


def scan_worktree(root):
    names = subprocess.check_output(["git", "ls-files", "-z"], cwd=root).decode("utf-8").split("\0")
    failures = []
    count = 0
    for name in filter(None, names):
        count += 1
        file = root / name
        if file.is_symlink() or not file.is_file():
            failures.append((name, "nonregular/missing tracked file; stage deletions first"))
            continue
        failures.extend((name, issue) for issue in findings(name, file.read_bytes()))
    return count, failures


def main():
    root = Path(__file__).resolve().parent.parent
    count, failures = scan_worktree(root)
    for name, issue in failures:
        print(f"FAIL: {name}: {issue}")
    if failures:
        return 1
    print(f"PASS: {count} tracked paths; standalone product boundary clean")
    return 0


if __name__ == "__main__":
    sys.exit(main())
