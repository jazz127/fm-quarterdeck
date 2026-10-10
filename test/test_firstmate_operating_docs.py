"""Offline lint for the public operating-policy entry point (no home reads)."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class FirstmateOperatingDocsTests(unittest.TestCase):
    def test_entry_point_is_discoverable_without_changing_project_memory(self):
        for name, link in [("README.md", "(FIRSTMATE.md)"),
                           ("docs/FIRSTMATE-INTEGRATIONS.md", "(../FIRSTMATE.md)")]:
            self.assertIn(link, (ROOT / name).read_text())

    def test_relative_policy_links_resolve_inside_source(self):
        text = (ROOT / "FIRSTMATE.md").read_text()
        links = re.findall(r"\]\(([^)]+)\)", text)
        self.assertTrue(links)
        for link in links:
            with self.subTest(link=link):
                target = (ROOT / link).resolve()
                self.assertTrue(target.is_relative_to(ROOT))
                self.assertTrue(target.is_file())

    def test_policy_keeps_protocol_markers_and_authority_boundaries(self):
        text = (ROOT / "FIRSTMATE.md").read_text()
        for required in [
            "Quarterdeck operating rules: read <approved Quarterdeck checkout>/FIRSTMATE.md",
            "private local override", "[fm-lane <LaneName>]", "[end <LaneName>]",
            "ACTION NEEDED", "APPROVAL NEEDED", "DECISION NEEDED", "[task:<id>]",
            "After **every local landing**",
            "reply succeeds", "Never merge from free text", "**one text box**",
            "Semi-away", "Mechanical surfacing", "Before **every public push**",
            "maintainer/captain owns their merge", "Mobile friendliness",
            "Reading this file installs nothing", "Without such an override",
            "byte/version ownership contract",
        ]:
            with self.subTest(required=required):
                self.assertIn(required, text)

    def test_policy_has_no_literal_installation_details(self):
        text = (ROOT / "FIRSTMATE.md").read_text()
        # Shapes, not a private-name denylist copied into public tests. This lint
        # supplements review; it cannot detect every private product/name.
        for pattern in [r"/(?:home|Users)/", r"[A-Z]:\\", r"https?://",
                        r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}",
                        r"\b\d{1,3}(?:\.\d{1,3}){3}\b", r"\b\d{4,5}\b",
                        r"\b[a-f0-9]{40}\b", r"\b[\w.-]+\.ts\.net\b"]:
            with self.subTest(pattern=pattern):
                self.assertIsNone(re.search(pattern, text))


if __name__ == "__main__":
    unittest.main()
