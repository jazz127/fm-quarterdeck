#!/usr/bin/env python3
"""Offline tree-only publication boundary. An inventory is a review candidate, not approval.

The external allowlist binds regular paths, modes, lengths and SHA-256 bytes, not
old commits/authors. Never copy a working directory or use tar.extractall().
"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

spec = importlib.util.spec_from_file_location("disclosure", Path(__file__).with_name("check-public-source.py"))
disclosure = importlib.util.module_from_spec(spec)
spec.loader.exec_module(disclosure)
SCHEMA = "fm-agentos-source-allowlist.v1"
MAX_FILE = 20 * 1024 * 1024
MAX_TOTAL = 128 * 1024 * 1024


def require(condition):
    if not condition:
        raise ValueError("source boundary refused")


def safe_path(name):
    require(isinstance(name, str) and len(name) <= 240)
    require(re.fullmatch(r"[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*", name))
    parts = name.split("/")
    require(all(p not in {".", ".."} and not p.endswith(".") for p in parts))
    require(not disclosure.semantic_findings(name.lower(), b"") & {"T01-T04: forbidden transfer path"})
    require(not any(p.lower() in {".gitmodules", ".gitattributes", ".ssh", ".aws", ".azure", ".npmrc", "cookies", "local storage", "session storage"} for p in parts))
    require(not name.lower().endswith((".pem", ".key")))
    return name


def directories(names):
    return {name.rsplit("/", n)[0] for name in names for n in range(1, name.count("/") + 1)}


def manifest(blobs):
    return {"schema": SCHEMA, "files": [
        {"path": name, "mode": mode, "size": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for name, (mode, data) in sorted(blobs.items())]}


def validate_manifest(value):
    require(isinstance(value, dict) and set(value) == {"schema", "files"} and value["schema"] == SCHEMA)
    require(isinstance(value["files"], list) and 0 < len(value["files"]) <= 10000)
    names = []
    for row in value["files"]:
        require(isinstance(row, dict) and set(row) == {"path", "mode", "size", "sha256"})
        names.append(safe_path(row["path"]))
        require(row["mode"] in ("100644", "100755") and type(row["size"]) is int and 0 <= row["size"] <= MAX_FILE)
        require(isinstance(row["sha256"], str) and re.fullmatch(r"[a-f0-9]{64}", row["sha256"]))
    require(names == sorted(set(names)) and len({n.lower() for n in names}) == len(names))
    require(not set(names) & directories(names))
    # Case-insensitive directory collisions are also ambiguous on other filesystems.
    all_names = set(names) | directories(names)
    require(len({n.lower() for n in all_names}) == len(all_names))
    require(sum(row["size"] for row in value["files"]) <= MAX_TOTAL)
    return value


def git_env():
    # No Git redirection, global excludes, hooks, alternate objects or replace refs.
    return {"PATH": os.environ.get("PATH", os.defpath), "LC_ALL": "C", "HOME": "/nonexistent",
            "GIT_CONFIG_GLOBAL": "/dev/null", "GIT_CONFIG_NOSYSTEM": "1", "GIT_OPTIONAL_LOCKS": "0",
            "GIT_NO_REPLACE_OBJECTS": "1"}


def git(root, *args):
    return subprocess.check_output(["git", "-c", "core.fsmonitor=false", *args], cwd=root,
                                   env=git_env(), stderr=subprocess.DEVNULL, timeout=30)


def check_content(blobs):
    require(not disclosure.scan([(name, data) for name, (_, data) in sorted(blobs.items())], {}, set()))
    check_ignored(blobs)


def tree_blobs(root, tree):
    # An exact tree object, not a ref, commit, tag or expression. No archive attributes.
    require(re.fullmatch(r"[a-f0-9]{40}", tree) is not None)
    require(git(root, "cat-file", "-t", tree).strip() == b"tree")
    blobs, seen_dirs, total = {}, set(), 0
    for row in git(root, "ls-tree", "-rtz", "--full-tree", tree).split(b"\0"):
        if not row:
            continue
        meta, raw = row.split(b"\t", 1)
        mode, kind, oid = meta.decode("ascii").split()
        name = safe_path(raw.decode("ascii"))
        if mode == "040000" and kind == "tree":
            require(name not in seen_dirs)
            seen_dirs.add(name)
            continue
        require(mode in ("100644", "100755") and kind == "blob" and name not in blobs)
        size = int(git(root, "cat-file", "-s", oid))
        total += size
        require(size <= MAX_FILE and total <= MAX_TOTAL and len(blobs) < 10000)
        blobs[name] = (mode, git(root, "cat-file", "blob", oid))
    require(seen_dirs == directories(blobs))
    validate_manifest(manifest(blobs))
    check_content(blobs)
    return blobs


def check_ignored(blobs):
    # Evaluate only ignore rules from this tree, never working/global/info excludes.
    # Git's matcher needs a repository; this private temporary one has no objects.
    with tempfile.TemporaryDirectory(prefix="quarterdeck-ignore-") as scratch:
        git(scratch, "-c", "init.templateDir=", "init", "-q")
        for name, (_, data) in blobs.items():
            if name.split("/")[-1] == ".gitignore":
                target = Path(scratch) / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
        checked = subprocess.run(["git", "-c", "core.excludesFile=/dev/null", "check-ignore", "--no-index", "-z", "--stdin"],
                                 cwd=scratch, env=git_env(), input=b"\0".join(n.encode() for n in blobs) + b"\0",
                                 stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30)
        require(checked.returncode == 1 and not checked.stdout)


def archive_bytes(blobs, allow):
    require(manifest(blobs) == validate_manifest(allow))
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name in sorted(directories(blobs) | set(blobs)):
            info = tarfile.TarInfo(name)
            info.uid = info.gid = info.mtime = 0
            if name in blobs:
                mode, data = blobs[name]
                info.mode = int(mode[-3:], 8)
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
            else:
                info.type = tarfile.DIRTYPE
                info.mode = 0o755
                archive.addfile(info)
    result = output.getvalue()
    verify_archive(result, allow)
    return result


def verify_archive(raw, allow):
    validate_manifest(allow)
    require(len(raw) <= MAX_TOTAL + 16 * 1024 * 1024 and len(raw) % 512 == 0)
    expected = {row["path"]: row for row in allow["files"]}
    dirs = directories(expected)
    seen, blobs = set(), {}
    order = iter(sorted(set(expected) | dirs))
    offset = 0
    # Inspect physical headers: tarfile's iterator hides global PAX/GNU headers.
    # Reject ALL extended metadata (including commit comments), links and devices.
    while offset + 512 <= len(raw) and raw[offset:offset + 512] != b"\0" * 512:
        header = raw[offset:offset + 512]
        require(header[156:157] in (tarfile.REGTYPE, tarfile.DIRTYPE))
        require(header[257:265] == b"ustar\x0000")
        info = tarfile.TarInfo.frombuf(header, "ascii", "strict")
        require(header == info.tobuf(format=tarfile.USTAR_FORMAT, encoding="ascii", errors="strict"))
        name = safe_path(info.name)
        require(name == next(order, None))
        require(name not in seen and info.uid == info.gid == info.mtime == 0)
        require(not info.uname and not info.gname and not info.linkname and not info.devmajor and not info.devminor)
        seen.add(name)
        offset += 512
        if info.isdir():
            require(name in dirs and info.size == 0 and info.mode == 0o755)
        else:
            require(name in expected)
            row = expected[name]
            require(info.size == row["size"] and info.mode == int(row["mode"][-3:], 8))
            data = raw[offset:offset + info.size]
            require(len(data) == info.size and hashlib.sha256(data).hexdigest() == row["sha256"])
            blobs[name] = (row["mode"], data)
        padded = (info.size + 511) // 512 * 512
        require(not any(raw[offset + info.size:offset + padded]))
        offset += padded
    canonical_size = ((offset + 1024 + tarfile.RECORDSIZE - 1) // tarfile.RECORDSIZE) * tarfile.RECORDSIZE
    require(len(raw) == canonical_size and len(raw) - offset >= 1024 and not any(raw[offset:]))
    require(seen == set(expected) | dirs and manifest(blobs) == allow)
    check_content(blobs)
    return blobs


def no_symlink_parents(directory):
    directory = Path(os.path.abspath(directory))
    for part in [*reversed(directory.parents), directory]:
        require(stat.S_ISDIR(part.lstat().st_mode))
    return directory


def regular_bytes(file, limit=MAX_TOTAL + 16 * 1024 * 1024):
    no_symlink_parents(Path(file).parent)
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        before = os.fstat(handle.fileno())
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_size <= limit)
        data = handle.read(limit + 1)
        after = os.fstat(handle.fileno())
        require(len(data) == before.st_size and (before.st_mtime_ns, before.st_ctime_ns) == (after.st_mtime_ns, after.st_ctime_ns))
        return data


def verify_directory(directory, allow):
    root = no_symlink_parents(directory)
    expected = {row["path"]: row for row in validate_manifest(allow)["files"]}
    dirs, found, blobs = directories(expected), set(), {}
    for base, subdirs, files in os.walk(root, followlinks=False):
        for name in subdirs + files:
            file = Path(base) / name
            relative = safe_path(file.relative_to(root).as_posix())
            info = file.lstat()
            require(relative not in found)
            found.add(relative)
            if stat.S_ISDIR(info.st_mode):
                require(relative in dirs and stat.S_IMODE(info.st_mode) == 0o755)
            else:
                require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and relative in expected)
                row = expected[relative]
                require(stat.S_IMODE(info.st_mode) == int(row["mode"][-3:], 8))
                blobs[relative] = (row["mode"], regular_bytes(file, MAX_FILE))
    require(found == set(expected) | dirs and manifest(blobs) == allow)
    check_content(blobs)
    return blobs


def extract_verified(raw, allow, destination):
    blobs = verify_archive(raw, allow)  # complete verification before any writes
    destination = no_symlink_parents(Path(destination).parent) / Path(destination).name
    destination.mkdir(mode=0o700)  # exclusive: never reuse/overlay a directory
    for name in sorted(directories(blobs), key=lambda n: (n.count("/"), n)):
        (destination / name).mkdir(mode=0o755)
        (destination / name).chmod(0o755)
    for name, (mode, data) in blobs.items():
        with (destination / name).open("xb") as handle:
            handle.write(data)
        (destination / name).chmod(int(mode[-3:], 8))
    verify_directory(destination, allow)


def audit_blobs(blobs, report):
    if report:
        markers, blocked = disclosure.private_signatures(regular_bytes(report).decode())
        require(not disclosure.scan([(n, data) for n, (_, data) in sorted(blobs.items())], markers, blocked))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["inventory", "export", "verify", "extract", "verify-directory"])
    parser.add_argument("--repo", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--tree")
    parser.add_argument("--allowlist", type=Path)
    parser.add_argument("--archive", type=Path)
    parser.add_argument("--destination", type=Path)
    parser.add_argument("--audit", type=Path, help="Optional explicit private report; redacted known-marker gate")
    args = parser.parse_args()
    try:
        if args.action == "inventory":
            blobs = tree_blobs(args.repo, args.tree)
            audit_blobs(blobs, args.audit)
            print(json.dumps(manifest(blobs), indent=2))
            return 0
        allow = validate_manifest(json.loads(regular_bytes(args.allowlist)))
        if args.action == "export":
            blobs = tree_blobs(args.repo, args.tree)
            audit_blobs(blobs, args.audit)
            raw = archive_bytes(blobs, allow)
            no_symlink_parents(args.archive.parent)
            with args.archive.open("xb") as handle:
                os.fchmod(handle.fileno(), 0o600)
                handle.write(raw)
        elif args.action == "verify-directory":
            audit_blobs(verify_directory(args.destination, allow), args.audit)
        else:
            raw = regular_bytes(args.archive)
            audit_blobs(verify_archive(raw, allow), args.audit)
            if args.action == "extract":
                extract_verified(raw, allow, args.destination)
        print(f"PASS: {args.action}; {len(allow['files'])} exact reviewed regular files")
        return 0
    except Exception:
        print("REFUSED: source export boundary; no file contents or private diagnostics emitted", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
