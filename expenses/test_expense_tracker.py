import copy
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import expense_tracker


class ExpenseTrackerTests(unittest.TestCase):
    def setUp(self):
        self.ledger = {
            "version": 1,
            "default_currency": "USD",
            "entries": [
                {
                    "id": "2025-01-01-quarterdeck-001",
                    "date": "2025-01-01",
                    "amount": "12.50",
                    "project_id": "quarterdeck",
                    "project_name": "Quarterdeck",
                    "note": "Model usage",
                },
                {
                    "id": "2025-01-02-quarterdeck-001",
                    "date": "2025-01-02",
                    "amount": "-2.50",
                    "project_id": "quarterdeck",
                    "note": "Credit",
                },
                {
                    "id": "2025-01-03-other-001",
                    "date": "2025-01-03",
                    "amount": "7.00",
                    "currency": "EUR",
                    "project_id": "other",
                    "note": "Hosting",
                },
            ],
        }

    def test_rollup_totals_by_currency_and_project(self):
        expense_tracker.validate_ledger(self.ledger)
        rendered = expense_tracker.render_rollup(self.ledger)
        self.assertIn("- EUR 7.00\n- USD 10.00", rendered)
        self.assertIn("### Quarterdeck (`quarterdeck`)\n\n- USD 10.00", rendered)
        self.assertIn("### other\n\n- EUR 7.00", rendered)

    def test_rollup_preserves_large_amount_precision(self):
        ledger = copy.deepcopy(self.ledger)
        ledger["entries"] = [
            {
                "id": "2025-01-01-large-001",
                "date": "2025-01-01",
                "amount": "10000000000000000000000000000.01",
                "project_id": "large",
                "note": "Large charge",
            },
            {
                "id": "2025-01-02-large-001",
                "date": "2025-01-02",
                "amount": "0.01",
                "project_id": "large",
                "note": "Small charge",
            },
        ]
        rendered = expense_tracker.render_rollup(ledger)
        self.assertIn("- USD 10000000000000000000000000000.02", rendered)

    def test_accepts_zero_amount_as_unknown_rate_placeholder(self):
        ledger = copy.deepcopy(self.ledger)
        ledger["entries"][0]["amount"] = "0.00"
        ledger["entries"][0]["note"] = "Subscription rate unknown/TBD"
        expense_tracker.validate_ledger(ledger)
        self.assertIn("- USD -2.50", expense_tracker.render_rollup(ledger))

    def test_accepts_optional_category_and_confidence(self):
        ledger = copy.deepcopy(self.ledger)
        ledger["entries"][0]["category"] = "AI services"
        ledger["entries"][0]["confidence"] = "invoice verified"
        expense_tracker.validate_ledger(ledger)

    def test_rejects_duplicate_ids(self):
        invalid = copy.deepcopy(self.ledger)
        invalid["entries"][1]["id"] = invalid["entries"][0]["id"]
        with self.assertRaisesRegex(expense_tracker.LedgerError, "duplicate entry id"):
            expense_tracker.validate_ledger(invalid)

    def test_rejects_conflicting_project_names(self):
        invalid = copy.deepcopy(self.ledger)
        invalid["entries"][1]["project_name"] = "Different name"
        with self.assertRaisesRegex(expense_tracker.LedgerError, "project_name conflicts"):
            expense_tracker.validate_ledger(invalid)

    def test_generated_id_advances(self):
        self.assertEqual(
            expense_tracker.generated_id(self.ledger, "2025-01-01", "quarterdeck"),
            "2025-01-01-quarterdeck-002",
        )

    def test_cli_rejects_compact_date(self):
        tracker = self.make_tracker()
        result = subprocess.run(
            [
                sys.executable,
                tracker,
                "add",
                "--date",
                "20250131",
                "--amount",
                "1.00",
                "--project",
                "quarterdeck",
                "--note",
                "Model usage",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("date must use YYYY-MM-DD form", result.stderr)

    def test_cli_rejects_boolean_version(self):
        tracker = self.make_tracker({"version": True, "default_currency": "USD", "entries": []})
        result = subprocess.run(
            [sys.executable, tracker, "check"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(result.returncode, 1)
        self.assertIn("ledger version must be 1", result.stderr)

    def test_cli_rejects_custom_id(self):
        tracker = self.make_tracker()
        result = subprocess.run(
            [
                sys.executable,
                tracker,
                "add",
                "--date",
                "2025-01-31",
                "--amount",
                "1.00",
                "--project",
                "quarterdeck",
                "--note",
                "Model usage",
                "--id",
                "custom-id",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        ledger = json.loads((tracker.parent / "ledger.json").read_text(encoding="utf-8"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("unrecognized arguments: --id custom-id", result.stderr)
        self.assertEqual(ledger["entries"], [])

    def test_cli_rejects_multiline_project_name(self):
        tracker = self.make_tracker()
        command = [
            sys.executable,
            tracker,
            "add",
            "--date",
            "2025-01-31",
            "--amount",
            "1.00",
            "--project",
            "quarterdeck",
            "--project-name",
            "Alpha\n\n## Overall total\n\n- USD 999.00",
            "--note",
            "Model usage",
        ]
        result = subprocess.run(command, text=True, capture_output=True, check=False)
        ledger = json.loads((tracker.parent / "ledger.json").read_text(encoding="utf-8"))
        self.assertEqual(result.returncode, 1)
        self.assertIn("project_name must be a single line", result.stderr)
        self.assertEqual(ledger["entries"], [])

    def test_cli_updates_entry_under_ledger_transaction(self):
        tracker = self.make_tracker(self.ledger)
        result = subprocess.run(
            [
                sys.executable,
                tracker,
                "update",
                "2025-01-01-quarterdeck-001",
                "--amount",
                "15.00",
                "--note",
                "Corrected model usage",
                "--project-name",
                "Firstmate Quarterdeck",
            ],
            text=True,
            capture_output=True,
            check=False,
        )
        ledger = json.loads((tracker.parent / "ledger.json").read_text(encoding="utf-8"))
        updated = next(entry for entry in ledger["entries"] if entry["id"] == "2025-01-01-quarterdeck-001")
        project_entries = [entry for entry in ledger["entries"] if entry["project_id"] == "quarterdeck"]
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(updated["amount"], "15.00")
        self.assertEqual(updated["note"], "Corrected model usage")
        self.assertTrue(all(entry["project_name"] == "Firstmate Quarterdeck" for entry in project_entries))

    def test_concurrent_adds_preserve_every_entry(self):
        tracker = self.make_tracker()
        command = [
            sys.executable,
            tracker,
            "add",
            "--date",
            "2025-01-31",
            "--amount",
            "1.00",
            "--project",
            "quarterdeck",
            "--note",
            "Model usage",
        ]
        processes = [subprocess.Popen(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE) for _ in range(8)]
        results = [process.communicate() + (process.returncode,) for process in processes]
        self.assertTrue(all(returncode == 0 for _, _, returncode in results), results)

        ledger = json.loads((tracker.parent / "ledger.json").read_text(encoding="utf-8"))
        self.assertEqual(len(ledger["entries"]), 8)
        self.assertEqual(
            {entry["id"] for entry in ledger["entries"]},
            {f"2025-01-31-quarterdeck-{number:03d}" for number in range(1, 9)},
        )
        check = subprocess.run(
            [sys.executable, tracker, "check"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(check.returncode, 0, check.stderr)
        rollup = subprocess.run(
            [sys.executable, tracker, "rollup"],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(rollup.returncode, 0, rollup.stderr)
        self.assertIn("- USD 8.00", rollup.stdout)

    def make_tracker(self, ledger=None):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        directory = Path(temporary.name)
        tracker = directory / "expense_tracker.py"
        shutil.copy2(Path(expense_tracker.__file__), tracker)
        if ledger is None:
            ledger = {"version": 1, "default_currency": "USD", "entries": []}
        (directory / "ledger.json").write_text(json.dumps(ledger), encoding="utf-8")
        return tracker


if __name__ == "__main__":
    unittest.main()
