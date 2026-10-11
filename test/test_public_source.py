"""Synthetic-only regression tests for the public-source gate."""
import hashlib
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("public_gate", Path(__file__).resolve().parents[1] / "scripts/check-public-source.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
sha = lambda value: hashlib.sha256(value).hexdigest()


class PublicGateTests(unittest.TestCase):
    def setUp(self):
        self.values = {category: ("syntheticblocked" + category.replace("-", "")).encode() for category in gate.CATEGORIES}
        self.originals = {name: ("synthetic evidence " + name).encode() for name in gate.EVIDENCE_PATHS}
        self.report = "\n".join(f"{category}\t{len(value)}\t{sha(value)}" for category, value in self.values.items())
        self.report += "\n" + "\n".join(f"{name}\t{sha(value)}" for name, value in self.originals.items())
        self.markers, self.blocked = gate.private_signatures(self.report)

    def test_all_marker_categories_in_encoded_paths_binary_and_deceptive_origins(self):
        for category, value in self.values.items():
            with self.subTest(category=category):
                for name, data in [("fixture.txt", b"--" + value.upper() + b"--"), ("fixture.bin", b"\xffhttps://user@" + value + b".example.test.evil"), (value.decode() + ".txt", b"safe")]:
                    failures = gate.scan([(name, data)], self.markers, self.blocked)
                    self.assertIn((1, "private marker: " + category), failures)
                    self.assertNotIn(value.decode(), str(failures))

    def test_every_original_blob_is_blocked_even_if_renamed(self):
        for value in self.originals.values():
            self.assertIn((1, "F01/F05/F06/F10: original private/evidence blob"), gate.scan([("renamed.txt", value)], self.markers, self.blocked))

    def test_private_fingerprints_are_not_publishable(self):
        self.assertIn((1, "private audit fingerprint copied into source"), gate.scan([("audit.txt", self.report.encode())], self.markers, self.blocked))

    def test_incomplete_or_duplicate_tables_refuse(self):
        for report in ["", self.report.split("\n", 1)[1], self.report + "\n" + self.report]:
            with self.assertRaises(ValueError):
                gate.private_signatures(report)

    def test_public_policies(self):
        cases = [
            ("expenses/ledger.json", b'{"entries":[{"amount":"1.00"}]}', "F01:"),
            ("prototype/scripts/example-browser-pass.mjs", b'FM_HOME: process.env.FM_HOME || "/synthetic/home"', "F03:"),
            ("docs/example.md", ("/" + "home/" + "syntheticperson/firstmate").encode(), "F04:"),
            ("docs/example.md", ("session 2000-01-01T00-00-00Z_" + "a" * 36 + ".jsonl").encode(), "F05:"),
            ("docs/example.md", b"Old revision `abc1234`", "F10:"),
            ("fixture.js", (".cache/ms-playwright/chromium-" + "9999/chrome").encode(), "F12:"),
            ("prototype/cost-config.js", b"export const defaultAttribution = { example: 'Example' };", "F08:"),
            ("prototype/public/cost-view-model.js", b"source?.attribution || { Example: null }", "F08:"),
        ]
        for name, data, category in cases:
            self.assertTrue(any(item.startswith(category) for item in gate.semantic_findings(name, data)), category)

    def test_no_blanket_test_or_binary_exceptions(self):
        token = ("gh" + "p_" + "z" * 36).encode()
        for name in ["test/sentinel.js", "package-lock.json", *gate.RETIRED_ASSETS]:
            self.assertIn("provider token", gate.semantic_findings(name, token))
        self.assertIn("unreviewed binary", gate.semantic_findings("asset.bin", b"\xff\x00"))
        for name in gate.RETIRED_ASSETS:
            self.assertIn("retired artwork requires a new rights review", gate.semantic_findings(name, b"synthetic"))
            self.assertIn("unreviewed binary", gate.semantic_findings(name, b"\xff\x00"))

    def test_transfer_exclusions_at_any_depth(self):
        for name in [".git", "nested/.git/config", ".preview-lab/profile/Cookies", "nested/__pycache__/file.pyc", "prototype/data/review-receipts/receipt.json", ".env.example", "nested/.agentos-runtime/state", "capture.har"]:
            self.assertIn("T01-T04: forbidden transfer path", gate.semantic_findings(name, b""))

    def test_safe_defaults_and_upstream_metadata(self):
        safe = [
            ("expenses/ledger.json", b'{"version":1,"default_currency":"USD","entries":[]}'),
            ("docs/setup.md", b"FM_HOME=/absolute/path/to/firstmate; http://127.0.0.1:4173; https://github.com/kunchenguid/gh-axi; bounded 1800000 milliseconds"),
            ("test/sentinel.js", b'const token = "TOPSECRET"; const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";'),
        ]
        self.assertEqual(gate.scan(safe, self.markers, self.blocked), [])

    def test_reviewed_baseline_is_quiet(self):
        root = Path(__file__).resolve().parents[1]
        self.assertEqual(gate.scan(gate.tracked_blobs(root, worktree=True), self.markers, self.blocked), [])

    def test_fixture_review_is_confined_to_exact_files_and_complete_paths(self):
        private_path = ("/" + "home/" + "acme-private/data/report.md").encode()
        category = (1, "F04: nonexample absolute home")
        self.assertIn(category, gate.scan([("test/new-private-path.txt", private_path)], self.markers, self.blocked))
        for name, paths in gate.REVIEWED_FIXTURE_PATHS.items():
            for path in paths:
                data = path.encode()
                with self.subTest(name=name, path=path):
                    self.assertIn(category[1], gate.semantic_findings(name, data))
                    self.assertEqual(gate.scan([(name, data)], self.markers, self.blocked), [])
                    for unreviewed_name, unreviewed_data in [
                        ("test/new-fixture.txt", data),
                        (name, data + b"-new"),
                        (name, data + b"/new"),
                        (name, b"/new" + data),
                        (name, data + b"\n" + private_path),
                    ]:
                        self.assertIn(category, gate.scan([(unreviewed_name, unreviewed_data)], self.markers, self.blocked))
                    self.assertIn((1, "private marker: home-user"), gate.scan(
                        [(name, data + b"\n" + self.values["home-user"])], self.markers, self.blocked))
                    token = ("gh" + "p_" + "z" * 36).encode()
                    self.assertIn((1, "provider token"), gate.scan([(name, data + b"\n" + token)], self.markers, self.blocked))

    def test_icon_review_requires_exact_name_and_bytes_and_keeps_private_checks(self):
        root = Path(__file__).resolve().parents[1]
        for name in gate.REVIEWED_BINARY_DIGESTS:
            data = (root / name).read_bytes()
            with self.subTest(name=name):
                self.assertIn("unreviewed binary", gate.semantic_findings(name, data))
                self.assertEqual(gate.scan([(name, data)], self.markers, self.blocked), [])
                for other_name, other_data in [("new-icon.png", data), (name, data + b"\x00")]:
                    self.assertIn((1, "unreviewed binary"), gate.scan([(other_name, other_data)], self.markers, self.blocked))
                markers = {3: {sha(b"png"): "private-project"}}
                self.assertIn((1, "private marker: private-project"), gate.scan([(name, data)], markers, self.blocked))
                self.assertIn((1, "F01/F05/F06/F10: original private/evidence blob"), gate.scan([(name, data)], self.markers, {sha(data)}))


if __name__ == "__main__":
    unittest.main()
