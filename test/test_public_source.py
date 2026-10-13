"""Synthetic-only regression tests for the public-source gate."""
import hashlib
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

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

    def test_plain_text_identifiers_use_complete_case_insensitive_tokens(self):
        marker = b"vent"
        markers = {len(marker): {sha(marker): "home-user"}}
        for data in [b"latestEvent", b"preventable", b"LATESTEVENT"]:
            self.assertEqual(gate.scan([("fixture.txt", data)], markers, set()), [])
        for data in [marker, marker.upper(), b"say vent here"]:
            self.assertIn((1, "private marker: home-user"), gate.scan([("fixture.txt", data)], markers, set()))
        for category, value in self.values.items():
            for data in [value, value.upper(), b"say " + value + b" here"]:
                with self.subTest(category=category, data=data):
                    self.assertIn((1, "private marker: " + category), gate.scan([("fixture.txt", data)], self.markers, self.blocked))

    def test_structured_and_binary_identity_substrings_remain_blocked(self):
        for category, value in self.values.items():
            cases = [
                ("fixture.txt", b"/srv/team" + value + b"/files"),
                ("fixture.txt", b"https://team" + value + b".example.test.evil/x"),
                ("fixture.txt", b"https://" + value + b"@example.test/x"),
                ("fixture.txt", b"prefix_" + value + b"_suffix"),
                ("fixture.txt", b"prefix-" + value + b"-suffix"),
                ("fixture.txt", b"%2Fhome%2F" + value + b"%2Ffiles"),
                ("fixture.txt", b"\\\\srv\\\\team" + value + b"\\\\files"),
                ("fixture.bin", b"\xffprefix" + value + b"suffix\x00"),
                ((b"prefix" + value + b"suffix").decode(), b"safe"),
                ((b"prefix" + value + b"suffix.txt").decode(), b"safe"),
            ]
            for name, data in cases:
                with self.subTest(category=category, name=name, data=data):
                    self.assertIn((1, "private marker: " + category), gate.scan([(name, data)], self.markers, self.blocked))

    def public_identity(self):
        # Public source identity, not a private audit value or a new audit table.
        repository = b"sthi-1005/fm-quarterdeck"
        owner = repository.split(b"/")[0]
        return repository, owner, {len(owner): {sha(owner): "github-owner"}}

    def test_exact_own_public_coordinate_and_url_representations_clear(self):
        repository, owner, markers = self.public_identity()
        root = b"https://github.com/" + repository
        for url in [root, root + b"/issues/83", root + b"/pull/1", root + b"/actions/runs/1/job/2",
                    root + b"?tab=readme", root + b"#readme"]:
            for data in [url, url.replace(b"/", b"\\/")]:
                with self.subTest(data=data):
                    self.assertEqual(gate.scan([("neutral.txt", b'"' + data + b'"')], markers, set()), [])
        self.assertEqual(gate.scan([("neutral.txt", repository)], markers, set()), [])
        # Recognition never exempts transfer filenames or binary ASCII identities.
        for name, data in [(repository.decode(), b"safe"), ("fixture.bin", b"\xff" + root)]:
            self.assertIn((1, "private marker: github-owner"), gate.scan([(name, data)], markers, set()))

    def test_foreign_lookalike_and_encoded_public_identities_remain_blocked(self):
        repository, owner, markers = self.public_identity()
        root = b"https://github.com/" + repository
        bad = [
            owner, owner + b"/foreign-repository", repository + b"/extra", b"prefix" + repository,
            b"https://github.com/" + owner + b"/foreign-repository",
            root + b"-evil", b"https://github.com/" + owner + b"/prefix-fm-quarterdeck",
            b"https://foreign.example.test/" + repository,
            b"https://github.com.evil/" + repository,
            b"https://github.com@evil.example.test/" + repository,
            b"https://" + owner + b"@github.com/fm-quarterdeck",
            b"https://user@github.com/" + repository,
            b"http://github.com/" + repository,
            b"https://github.com:443/" + repository,
            b"x" + root, b"https://foreign.example.test/redirect/" + root,
            root + b"/../foreign", root + b"/./issues/83",
            root + b"/%2e%2e/foreign", root + b"%2Fissues/83",
            b"https://github.com/" + owner + b"/%66m-quarterdeck",
            b"https:%2F%2Fgithub.com%2F" + owner + b"%2Ffm-quarterdeck",
            root + b"?next=%2Fforeign", root + b"\\evil",
            root + "\u200b.evil".encode(), "\u200b".encode() + root,
            root + b"\x00.evil", b"[" + repository + b"]",
            root + b";evil", root + b",evil", root + b"!evil", root + b")evil",
            repository + b";extra", repository + b")extra",
            b"https:\\/\\/github.com\\/" + owner + b"\\/fm-quarterdeck-evil",
            root.replace(b"/", b"\\/") + b"\\/..\\/foreign",
            root.replace(b"/", b"\\/") + b"?next=%2Fforeign",
            root.replace(b"/", b"\\\\/"),
            b"https://github.com/" + repository.replace(b"/", b"\\/"),
        ]
        for data in bad:
            with self.subTest(data=data):
                self.assertIn((1, "private marker: github-owner"), gate.scan([("neutral.txt", data)], markers, set()))

    def test_public_owner_exception_is_exact_category_and_occurrence_only(self):
        repository, owner, public_markers = self.public_identity()
        root = b"https://github.com/" + repository
        for category, value in self.values.items():
            markers = {length: dict(group) for length, group in self.markers.items()}
            markers.setdefault(len(owner), {}).update(public_markers[len(owner)])
            for separator in [b"/team", b"?key=team", b"#team", b" "]:
                for base in [root, root.replace(b"/", b"\\/")]:
                    with self.subTest(category=category, separator=separator, base=base):
                        self.assertIn((1, "private marker: " + category), gate.scan(
                            [("neutral.txt", base + separator + value)], markers, set()))
        for suffix in [b"/" + owner, b"?owner=" + owner, b"#" + owner, b" " + owner]:
            self.assertIn((1, "private marker: github-owner"), gate.scan([("neutral.txt", root + suffix)], public_markers, set()))
        for category in gate.CATEGORIES - {"github-owner"}:
            markers = {len(owner): {sha(owner): category}}
            self.assertIn((1, "private marker: " + category), gate.scan([("neutral.txt", root)], markers, set()))
        # A marker overlapping but not equal to the reviewed owner span is not exempt.
        fragment = owner[:4]
        markers = {len(fragment): {sha(fragment): "github-owner"}}
        self.assertIn((1, "private marker: github-owner"), gate.scan([("neutral.txt", root)], markers, set()))

    def test_public_identity_keeps_original_fingerprint_and_semantic_gates(self):
        repository, owner, markers = self.public_identity()
        data = b"https://github.com/" + repository
        self.assertIn((1, "F01/F05/F06/F10: original private/evidence blob"), gate.scan([("neutral.txt", data)], markers, {sha(data)}))
        copied = sha(owner).encode()
        self.assertIn((1, "private audit fingerprint copied into source"), gate.scan([("neutral.txt", data + b" " + copied)], markers, set()))
        token = ("gh" + "p_" + "z" * 36).encode()
        self.assertIn((1, "provider token"), gate.scan([("neutral.txt", data + b" " + token)], markers, set()))
        self.assertIn((1, "T01-T04: forbidden transfer path"), gate.scan([("capture.har", data)], markers, set()))

    def test_source_export_uses_the_same_scan_contract(self):
        source = Path(__file__).resolve().parents[1] / "scripts/source-export.py"
        spec = importlib.util.spec_from_file_location("public_exporter", source)
        exporter = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(exporter)
        repository, owner, _ = self.public_identity()
        values = dict(self.values, **{"github-owner": owner, "home-user": b"vent"})
        report = "\n".join(f"{category}\t{len(value)}\t{sha(value)}" for category, value in values.items())
        report += "\n" + "\n".join(f"{name}\t{sha(value)}" for name, value in self.originals.items())
        # Exercise the actual exporter consumer without creating an audit/export artifact.
        with patch.object(exporter, "regular_bytes", return_value=report.encode()):
            clean = {"neutral.txt": ("100644", b"latestEvent https://github.com/" + repository)}
            self.assertIsNone(exporter.audit_blobs(clean, "synthetic-input"))
            for data in [owner, b"/srv/team" + values["private-project"], *self.originals.values()]:
                with self.subTest(data=data), self.assertRaises(ValueError):
                    exporter.audit_blobs({"neutral.txt": ("100644", data)}, "synthetic-input")

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
