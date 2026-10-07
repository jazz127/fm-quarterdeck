"""Adversarial transfer tests use only synthetic content and isolated repositories."""
import copy
import importlib.util
import io
import os
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("exporter", Path(__file__).resolve().parents[1] / "scripts/source-export.py")
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.blobs = {".gitignore": ("100644", b"ignored/\n*.log\n"), "src/tool.py": ("100755", b"print('synthetic')\n")}
        self.allow = exporter.manifest(self.blobs)
        self.raw = exporter.archive_bytes(self.blobs, self.allow)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def tar(self, change=None, extra=None, **options):
        output = io.BytesIO()
        with tarfile.open(fileobj=output, mode="w", format=options.pop("format", tarfile.USTAR_FORMAT), **options) as archive:
            with tarfile.open(fileobj=io.BytesIO(self.raw)) as original:
                for item in original:
                    data = original.extractfile(item).read() if item.isfile() else b""
                    if change:
                        item, data = change(item, data)
                    if item:
                        archive.addfile(item, io.BytesIO(data))
            if extra:
                archive.addfile(extra, io.BytesIO(b"x" * extra.size))
        return output.getvalue()

    def test_reproducible_and_exact_tree_not_working_directory(self):
        for name, (mode, data) in self.blobs.items():
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(int(mode[-3:], 8))
        exporter.git(self.root, "-c", "init.templateDir=", "init", "-q")
        exporter.git(self.root, "add", ".")
        tree = exporter.git(self.root, "write-tree").decode().strip()
        (self.root / "src/tool.py").write_bytes(b"unreviewed worktree bytes")
        (self.root / "ignored").mkdir()
        (self.root / "ignored/private.log").write_bytes(b"synthetic excluded value")
        self.assertEqual(exporter.tree_blobs(self.root, tree), self.blobs)
        self.assertEqual(exporter.archive_bytes(exporter.tree_blobs(self.root, tree), self.allow), self.raw)
        for value in ["HEAD", tree + "^{tree}", "0" * 40]:
            with self.assertRaises(Exception):
                exporter.tree_blobs(self.root, value)
        exporter.git(self.root, "add", "src/tool.py")
        changed = exporter.git(self.root, "write-tree").decode().strip()
        with self.assertRaises(ValueError):
            exporter.archive_bytes(exporter.tree_blobs(self.root, changed), self.allow)
        exporter.git(self.root, "add", "-f", "ignored/private.log")
        with self.assertRaises(ValueError):
            exporter.tree_blobs(self.root, exporter.git(self.root, "write-tree").decode().strip())

    def test_git_symlinks_submodules_and_ignored_even_when_force_tracked(self):
        exporter.git(self.root, "-c", "init.templateDir=", "init", "-q")
        (self.root / "normal").write_bytes(b"synthetic")
        exporter.git(self.root, "add", "normal")
        oid = exporter.git(self.root, "rev-parse", ":normal").decode().strip()
        for mode in ["120000", "160000"]:
            exporter.git(self.root, "update-index", "--add", "--cacheinfo", mode, oid, "unsafe")
            tree = exporter.git(self.root, "write-tree").decode().strip()
            with self.assertRaises(ValueError):
                exporter.tree_blobs(self.root, tree)
            exporter.git(self.root, "update-index", "--force-remove", "unsafe")
        (self.root / ".gitignore").write_text("normal\n")
        exporter.git(self.root, "add", ".gitignore")
        with self.assertRaises(ValueError):
            exporter.tree_blobs(self.root, exporter.git(self.root, "write-tree").decode().strip())

    def test_path_policy_even_with_a_new_allowlist(self):
        for name in ["/absolute", "../escape", "a/../b", "a//b", "a/./b", "a\\b", "a:stream", "a/.GIT/config",
                     ".git", ".env.example", "a/node_modules/x", "a/__pycache__/x.pyc", "prototype/data/agent-state.json",
                     "prototype/data/review-receipts/x", ".preview-lab/profile/x", ".agentos-controller/x", "capture.har",
                     "a/.ssh/key", "a/.npmrc", "a/Cookies", "a/", "a/last.", "a/\u2603"]:
            with self.subTest(name=name), self.assertRaises(ValueError):
                exporter.validate_manifest(exporter.manifest({name: ("100644", b"")}))
        for names in [["a", "a/b"], ["A/x", "a/y"], ["A", "a"]]:
            with self.assertRaises(ValueError):
                exporter.validate_manifest(exporter.manifest({n: ("100644", b"") for n in names}))

    def test_links_devices_sparse_pax_global_commit_comment_and_gnu_rejected(self):
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE, tarfile.FIFOTYPE,
                     tarfile.GNUTYPE_SPARSE, tarfile.XHDTYPE, tarfile.XGLTYPE, tarfile.GNUTYPE_LONGNAME]:
            info = tarfile.TarInfo("extra")
            info.type = kind
            raw = self.tar(extra=info)
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                exporter.verify_archive(raw, self.allow)
        with self.assertRaises(ValueError):
            exporter.verify_archive(self.tar(format=tarfile.PAX_FORMAT, pax_headers={"comment": "synthetic commit provenance"}), self.allow)
        def pax(info, data):
            info.pax_headers = {"comment": "synthetic"}
            return info, data
        with self.assertRaises(ValueError):
            exporter.verify_archive(self.tar(pax, format=tarfile.PAX_FORMAT), self.allow)

    def test_missing_duplicate_extra_bytes_modes_metadata_and_trailing_archive(self):
        info = tarfile.TarInfo("src/tool.py")
        for name in ["src/tool.py", "surprise", "extra-dir", "../escape", "nested/.git/config"]:
            info.name = name
            with self.assertRaises(Exception):
                exporter.verify_archive(self.tar(extra=info), self.allow)
        def changed(attribute, value):
            def mutate(info, data):
                if info.isfile():
                    setattr(info, attribute, value)
                return info, data
            return mutate
        attacks = [self.tar(lambda i, d: (None, d) if i.name == "src/tool.py" else (i, d)),
                   self.tar(lambda i, d: (i, b"z" * len(d))), self.raw[:1024], self.raw + self.raw]
        attacks += [self.tar(changed(k, v)) for k, v in [("uid", 1), ("uname", "OldAuthor"), ("mtime", 1), ("mode", 0o777)]]
        for raw in attacks:
            with self.assertRaises(Exception):
                exporter.verify_archive(raw, self.allow)
        changed_allow = copy.deepcopy(self.allow)
        changed_allow["files"].append(changed_allow["files"][0])
        with self.assertRaises(ValueError):
            exporter.validate_manifest(changed_allow)

    def test_canonical_order_and_exact_record_padding_are_mandatory(self):
        output = io.BytesIO()
        with tarfile.open(fileobj=io.BytesIO(self.raw)) as source:
            with tarfile.open(fileobj=output, mode="w", format=tarfile.USTAR_FORMAT) as archive:
                for item in reversed(source.getmembers()):
                    data = source.extractfile(item) if item.isfile() else None
                    archive.addfile(item, data)
        for raw in [output.getvalue(), self.raw + b"\0" * 512, self.raw + b"\0" * tarfile.RECORDSIZE, self.raw[:-512]]:
            with self.assertRaises(ValueError):
                exporter.verify_archive(raw, self.allow)
        self.assertEqual(exporter.verify_archive(self.raw, self.allow), self.blobs)

    def test_extraction_and_directory_verification_do_not_follow_or_overlay(self):
        destination = self.root / "export"
        exporter.extract_verified(self.raw, self.allow, destination)
        self.assertEqual(exporter.verify_directory(destination, self.allow), self.blobs)
        with self.assertRaises(FileExistsError):
            exporter.extract_verified(self.raw, self.allow, destination)
        file = destination / "src/tool.py"
        outside = self.root / "outside"
        outside.write_bytes(file.read_bytes())
        file.unlink()
        file.symlink_to(outside)
        with self.assertRaises(ValueError):
            exporter.verify_directory(destination, self.allow)
        file.unlink()
        os.link(outside, file)
        with self.assertRaises(ValueError):
            exporter.verify_directory(destination, self.allow)
        file.unlink()
        os.mkfifo(file)
        with self.assertRaises(ValueError):
            exporter.verify_directory(destination, self.allow)
        link = self.root / "parent-link"
        link.symlink_to(destination, target_is_directory=True)
        with self.assertRaises(ValueError):
            exporter.extract_verified(self.raw, self.allow, link / "child")
        # Verification fails before extraction creates even the output root.
        with self.assertRaises(ValueError):
            exporter.extract_verified(self.raw + b"bad", self.allow, self.root / "not-created")
        self.assertFalse((self.root / "not-created").exists())

    def test_semantic_disclosure_is_not_disabled_by_matching_hashes(self):
        bad = {"expenses/ledger.json": ("100644", b'{"entries":[{"note":"synthetic"}]}')}
        with self.assertRaises(ValueError):
            exporter.archive_bytes(bad, exporter.manifest(bad))
        ignored = {".gitignore": ("100644", b"normal\n"), "normal": ("100644", b"synthetic ignored bytes")}
        with self.assertRaises(ValueError):
            exporter.archive_bytes(ignored, exporter.manifest(ignored))


if __name__ == "__main__":
    unittest.main()
