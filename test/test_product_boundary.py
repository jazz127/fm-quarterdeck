"""Deterministic retired-integration and current-tree regressions."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("product_boundary", ROOT / "scripts/check-product-boundary.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)


class ProductBoundaryTests(unittest.TestCase):
    def test_retired_names_and_doc_links_are_case_insensitive(self):
        for reference in [b"ObSiDiAn plugin", b"requires obsidian", b"firstmate-lanes UI",
                          b"Firstmate Lanes plugin", b"[index](docs/FM-LANES/00-Architecture-Index.md)"]:
            for name in ["README.md", "prototype/app.js", "package.json", "test/ordinary.py"]:
                with self.subTest(name=name, reference=reference):
                    self.assertEqual(gate.findings(name, reference), ["retired integration reference"])

    def test_paths_are_checked_even_for_exempt_content(self):
        for name in [".Obsidian/plugins/example/package-lock.json", "docs/FM-LANES/index.md",
                     "nested/obsidian.md", "firstmate-lanes/package.json"]:
            with self.subTest(name=name):
                self.assertIn("retired integration path", gate.findings(name, b""))

    def test_generic_markdown_and_live_lane_skill_remain_allowed(self):
        for name, text in [("skills/fmqd-lanes/SKILL.md", b"Quarterdeck lane envelopes"),
                           ("docs/ARCHITECTURE.md", b"Markdown files and document readers"),
                           ("LICENSE", b"Generic historical attribution"),
                           ("vendor/example.txt", b"myobsidianhelper; obsidianite")]:
            self.assertEqual(gate.findings(name, text), [])

    def test_narrow_rule_fixture_and_dependency_metadata_exceptions(self):
        for name in [*gate.RULE_FILES, "prototype/package-lock.json"]:
            self.assertEqual(gate.findings(name, b"obsidian"), [])
        for name in ["scripts/other.py", "test/other.py", "prototype/package.json", "THIRD-PARTY-NOTICES.md"]:
            self.assertEqual(gate.findings(name, b"Obsidian dependency"), ["retired integration reference"])

    def test_tracked_product_tree_is_clean(self):
        count, failures = gate.scan_worktree(ROOT)
        self.assertGreater(count, 0)
        self.assertEqual(failures, [])


if __name__ == "__main__":
    unittest.main()
