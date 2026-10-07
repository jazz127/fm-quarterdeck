#!/usr/bin/env python3
"""Read-only tracked-tree disclosure gate; private fingerprints are input, never source.

Use --audit /explicit/private/report.md for the complete owner audit's digest tables.
Default scans exact HEAD blobs. --worktree scans indexed paths' current bytes for development.
No exports, Git writes, home discovery, network, private values or hashes in output.
"""
import argparse
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from collections import defaultdict

CATEGORIES = {"home-user", "github-owner", "private-project", "private-company", "device", "tailnet", *(f"session-{n}" for n in range(1, 5))}
EVIDENCE_PATHS = {
    "expenses/ledger.json", "docs/parked-work.md", "docs/dev-branch-inventory.md",
    "prototype/SESSION-WINDOW.md", "prototype/TRANSCRIPTS.md", "prototype/test/LANE-REPRO.md",
    "prototype/LAYOUT-CORRECTION.md", "docs/FEATURE-PLAN.md",
}
FORBIDDEN_PARTS = {".git", "node_modules", "__pycache__", ".preview-lab", ".taxonomy-lab", ".sanitization-lab",
                   ".agentos-controller", ".agentos-runtime", "review-receipts", "preview-acceptance", "browser-profile"}
RETIRED_ASSETS = {f"prototype/public/assets/providers/{name}.svg" for name in ("grok", "openai", "gemini", "anthropic")}


def private_signatures(report):
    markers = defaultdict(dict)
    found = set()
    for category, length, digest in re.findall(r"^([\w-]+)\t(\d+)\t([a-f0-9]{64})$", report, re.M):
        if category in CATEGORIES:
            if category in found or not 1 <= int(length) <= 256:
                raise ValueError("ambiguous marker table")
            markers[int(length)][digest] = category
            found.add(category)
    blobs = {}
    for name, digest in re.findall(r"^([^\t\n]+)\t([a-f0-9]{64})$", report, re.M):
        if name in EVIDENCE_PATHS:
            if name in blobs:
                raise ValueError("ambiguous blob table")
            blobs[name] = digest
    if found != CATEGORIES or set(blobs) != EVIDENCE_PATHS:
        raise ValueError("complete private audit tables required")
    return markers, set(blobs.values())


def semantic_findings(name, data):
    """Public-safe policy independent of any particular owner's private markers."""
    findings = set()
    parts = pathlib.PurePosixPath(name).parts
    if (not parts or name.startswith("/") or ".." in parts or any(p in FORBIDDEN_PARTS for p in parts)
            or any(p.startswith((".frontend-matrix-chrome-", "onboarding-test-")) for p in parts)
            or pathlib.PurePosixPath(name).suffix.lower() in {".pyc", ".pyo", ".log", ".har", ".sqlite", ".db"}
            or parts[-1].startswith((".env", "agent-state.json", ".expense_tracker.lock"))):
        findings.add("T01-T04: forbidden transfer path")
    if name in RETIRED_ASSETS:
        findings.add("retired artwork requires a new rights review")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        findings.add("unreviewed binary")
        text = data.decode("ascii", errors="ignore")
    # Shapes, not owner-specific fingerprints. No blanket test/lockfile exemption.
    for label, pattern in {
        "credential header": rb"-----BEGIN (?:[A-Z ]*PRIVATE KEY|CERTIFICATE)-----",
        "provider token": rb"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{20,}|sk-[A-Za-z0-9]{32,})",
        "JWT": rb"eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}",
    }.items():
        if re.search(pattern, data):
            findings.add(label)
    if re.search(r"/home/(?!example/|user/|fixture/)[A-Za-z0-9][A-Za-z0-9_-]*/", text):
        findings.add("F04: nonexample absolute home")
    if re.search(r"\.cache/ms-playwright/chromium-\d+", text):
        findings.add("F12: browser cache installation pin")
    if name.endswith(".md"):
        if any(re.search(r"[a-f]", pin) for pin in re.findall(r"(?<![a-zA-Z0-9])[a-f0-9]{7,40}(?![a-zA-Z0-9])", text)):
            findings.add("F10: literal historical revision in documentation")
        if re.search(r"\d{4}-\d\d-\d\dT[\dZ:_-]+[a-f0-9-]{36}\.jsonl", text):
            findings.add("F05: recorded session filename")
    if name == "expenses/ledger.json":
        try:
            if json.loads(text) != {"version": 1, "default_currency": "USD", "entries": []}:
                findings.add("F01: public ledger must be empty")
        except ValueError:
            findings.add("F01: invalid public ledger")
    if name.endswith("browser-pass.mjs") and re.search(r"FM_HOME\s*\|\|\s*[\"'`]", text):
        findings.add("F03: implicit browser home")
    if name == "prototype/cost-config.js" and not re.search(r"defaultAttribution\s*=\s*Object\.freeze\(\{\}\)", text):
        findings.add("F08: nonempty public attribution default")
    if name == "prototype/public/cost-view-model.js" and not re.search(r"source\?\.attribution \|\| \{ unclassified: null \}", text):
        findings.add("F08: browser must not invent project labels")
    return findings


def scan(blobs, markers, blocked):
    failures = []
    for index, (name, data) in enumerate(blobs, 1):
        found = semantic_findings(name, data)
        if hashlib.sha256(data).hexdigest() in blocked:
            found.add("F01/F05/F06/F10: original private/evidence blob")
        if any(digest.encode() in data.lower() for group in markers.values() for digest in group) or any(digest.encode() in data.lower() for digest in blocked):
            found.add("private audit fingerprint copied into source")
        # Include filenames and ASCII runs in binary assets; substrings catch
        # encoded paths, mixed case, userinfo and deceptive host suffixes.
        for match in re.finditer(rb"[A-Za-z0-9_.:/@-]+", name.encode() + b"\n" + data):
            text = match.group().lower()
            for length, hashes in markers.items():
                for start in range(len(text) - length + 1):
                    category = hashes.get(hashlib.sha256(text[start:start + length]).hexdigest())
                    if category:
                        found.add("private marker: " + category)
        # Only ordinals/categories: a filename itself could contain private values.
        failures.extend((index, category) for category in sorted(found))
    return failures


def tracked_blobs(root, worktree=False):
    def git(*args):
        return subprocess.check_output(["git", "-c", "core.fsmonitor=false", *args], cwd=root, stderr=subprocess.DEVNULL)
    if worktree:
        records = git("ls-files", "-s", "-z").split(b"\0")
    else:
        records = git("ls-tree", "-rz", "--full-tree", "HEAD").split(b"\0")
    blobs = []
    for record in filter(None, records):
        meta, raw_name = record.split(b"\t", 1)
        mode, kind, obj = meta.split() if not worktree else (meta.split()[0], b"blob", meta.split()[1])
        if mode not in (b"100644", b"100755") or kind != b"blob":
            raise ValueError("only regular tracked blobs permitted")
        name = raw_name.decode("utf-8")
        target = root / name
        if worktree and (target.is_symlink() or not target.is_file()):
            raise ValueError("nonregular worktree path")
        blobs.append((name, target.read_bytes() if worktree else git("cat-file", "blob", obj.decode())))
    return blobs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--audit", required=True, type=pathlib.Path)
    parser.add_argument("--worktree", action="store_true")
    args = parser.parse_args()
    try:
        markers, blocked = private_signatures(args.audit.read_text())
        root = pathlib.Path(__file__).resolve().parent.parent
        blobs = tracked_blobs(root, args.worktree)
        failures = scan(blobs, markers, blocked)
        for index, category in failures:
            print(f"FAIL file {index}: {category}")
        if failures:
            return 1
        print(f"PASS: {len(blobs)} tracked regular blobs; all 10 private marker categories and 8 original evidence blobs rejected; semantic gates clean")
        return 0
    except Exception:
        print("REFUSED: inspect explicit audit input and tracked-tree boundary; no private diagnostics emitted", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
