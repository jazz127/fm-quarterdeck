#!/usr/bin/env python3
"""Validate, add to, and summarize the fm-quarterdeck expense ledger."""

from __future__ import annotations

import argparse
import datetime as dt
import fcntl
import json
import os
import re
import stat
import sys
import tempfile
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
DEFAULT_LEDGER = HERE / "ledger.json"
ROOT_KEYS = {"version", "default_currency", "entries"}
REQUIRED_ENTRY_KEYS = {"id", "date", "amount", "project_id", "note"}
ENTRY_KEYS = REQUIRED_ENTRY_KEYS | {
    "category",
    "confidence",
    "currency",
    "project_name",
}
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")
CURRENCY_RE = re.compile(r"^[A-Z]{3}$")
AMOUNT_RE = re.compile(r"^-?[0-9]+\.[0-9]{2}$")
DATE_RE = re.compile(r"^[0-9]{4}-[0-9]{2}-[0-9]{2}$")


class LedgerError(ValueError):
    pass


def selected_ledger() -> Path:
    """Use only an explicitly selected home; incomplete/unsafe overlays fail closed."""
    home = os.environ.get("FM_HOME")
    if not home:
        return DEFAULT_LEDGER
    if not os.path.isabs(home) or os.path.normpath(home) != home or home.startswith("//") or home == os.path.sep:
        raise LedgerError("FM_HOME must be an explicit normalized absolute home")
    root = Path(home) / "data" / "agentos"
    directory = root / "expenses"

    def inspect(path: Path, is_directory=False):
        for current in [*reversed(path.parents), path]:
            try:
                info = current.lstat()
            except FileNotFoundError:
                return False
            if stat.S_ISLNK(info.st_mode) or (not stat.S_ISDIR(info.st_mode) if current != path or is_directory else not stat.S_ISREG(info.st_mode)):
                raise LedgerError("unsafe private expense path")
            if current == root or root in current.parents:
                if info.st_mode & 0o077 or (hasattr(os, "getuid") and info.st_uid != os.getuid()):
                    raise LedgerError("private expense permissions required")
            if current == path and not is_directory and (info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024):
                raise LedgerError("unsupported private expense file")
        return True

    if not inspect(directory, is_directory=True):
        return DEFAULT_LEDGER
    for name in ("ledger.json", "costs.json", "migration-manifest.json"):
        if not inspect(directory / name):
            raise LedgerError("incomplete private expense overlay")
    try:
        manifest = json.loads((directory / "migration-manifest.json").read_text(encoding="utf-8"))
        files = manifest.get("files")
        categories = ("repository-expense-ledger", "runtime-cost-configuration")
        destinations = ("expenses/ledger.json", "expenses/costs.json")
        if manifest.get("schema") != "fm-agentos-private-copy.v1" or not isinstance(files, list) or len(files) != 2:
            raise ValueError()
        for index, entry in enumerate(files):
            if entry.get("sourceCategory") != categories[index] or entry.get("destination") != destinations[index] or not re.fullmatch(r"[a-f0-9]{64}", entry.get("sha256", "")):
                raise ValueError()
        costs = json.loads((directory / "costs.json").read_text(encoding="utf-8"))
        if set(costs) != {"schema", "azureTag", "attribution"} or costs["schema"] != "fm-agentos-costs.v1":
            raise ValueError()
        if costs["azureTag"] is not None and not re.fullmatch(r"[A-Za-z][\w-]{0,50}", costs["azureTag"], re.ASCII):
            raise ValueError()
        mapping = costs["attribution"]
        if not isinstance(mapping, dict) or len(mapping) > 100:
            raise ValueError()
        reserved = {"__proto__", "prototype", "constructor", "unclassified"}
        for tag, label in mapping.items():
            if not re.fullmatch(r"[a-z0-9][a-z0-9 .:/+-]{0,89}", tag) or tag in reserved or not isinstance(label, str) or not re.fullmatch(r"[\w .:/+-]{1,90}", label, re.ASCII) or label.strip() != label or label.lower() in reserved:
                raise ValueError()
    except (OSError, ValueError, TypeError, AttributeError, KeyError) as error:
        raise LedgerError("invalid private expense manifest or cost configuration") from error
    return directory / "ledger.json"


def load_ledger(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise LedgerError(f"cannot read {path}: {error}") from error
    validate_ledger(data)
    return data


def validate_ledger(data: Any) -> None:
    if not isinstance(data, dict):
        raise LedgerError("ledger root must be an object")
    unknown = set(data) - ROOT_KEYS
    missing = ROOT_KEYS - set(data)
    if unknown or missing:
        raise LedgerError(f"ledger keys: missing={sorted(missing)}, unknown={sorted(unknown)}")
    if type(data["version"]) is not int or data["version"] != 1:
        raise LedgerError("ledger version must be 1")
    validate_currency(data["default_currency"], "default_currency")
    if not isinstance(data["entries"], list):
        raise LedgerError("entries must be an array")

    seen_ids: set[str] = set()
    project_names: dict[str, str] = {}
    for index, entry in enumerate(data["entries"]):
        where = f"entries[{index}]"
        if not isinstance(entry, dict):
            raise LedgerError(f"{where} must be an object")
        missing = REQUIRED_ENTRY_KEYS - set(entry)
        unknown = set(entry) - ENTRY_KEYS
        if missing or unknown:
            raise LedgerError(f"{where} keys: missing={sorted(missing)}, unknown={sorted(unknown)}")
        for key in ("id", "project_id"):
            value = entry[key]
            if not isinstance(value, str) or not SLUG_RE.fullmatch(value):
                raise LedgerError(f"{where}.{key} must be a lowercase slug")
        if entry["id"] in seen_ids:
            raise LedgerError(f"duplicate entry id: {entry['id']}")
        seen_ids.add(entry["id"])
        if not isinstance(entry["date"], str) or not DATE_RE.fullmatch(entry["date"]):
            raise LedgerError(f"{where}.date must use YYYY-MM-DD form")
        try:
            dt.date.fromisoformat(entry["date"])
        except (TypeError, ValueError) as error:
            raise LedgerError(f"{where}.date must use YYYY-MM-DD form") from error
        amount = entry["amount"]
        if not isinstance(amount, str) or not AMOUNT_RE.fullmatch(amount):
            raise LedgerError(f"{where}.amount must be a string with two decimal places")
        if "currency" in entry:
            validate_currency(entry["currency"], f"{where}.currency")
        for key in ("note", "project_name", "category", "confidence"):
            if key in entry and (not isinstance(entry[key], str) or not entry[key].strip()):
                raise LedgerError(f"{where}.{key} must be a non-empty string")
            if key in entry and ("\r" in entry[key] or "\n" in entry[key]):
                raise LedgerError(f"{where}.{key} must be a single line")
        if "project_name" in entry:
            if "\r" in entry["project_name"] or "\n" in entry["project_name"]:
                raise LedgerError(f"{where}.project_name must be a single line")
            previous_name = project_names.setdefault(entry["project_id"], entry["project_name"])
            if previous_name != entry["project_name"]:
                raise LedgerError(f"{where}.project_name conflicts with another entry for this project")


def validate_currency(value: Any, where: str) -> None:
    if not isinstance(value, str) or not CURRENCY_RE.fullmatch(value):
        raise LedgerError(f"{where} must be a three-letter uppercase currency code")


def amount_to_cents(amount: str) -> int:
    negative = amount.startswith("-")
    whole, fraction = amount.removeprefix("-").split(".")
    cents = int(whole) * 100 + int(fraction)
    return -cents if negative else cents


def totals(data: dict[str, Any]) -> tuple[dict[str, int], dict[str, tuple[str, dict[str, int]]]]:
    overall: dict[str, int] = defaultdict(int)
    project_amounts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    project_names: dict[str, str] = {}
    default_currency = data["default_currency"]
    for entry in data["entries"]:
        currency = entry.get("currency", default_currency)
        cents = amount_to_cents(entry["amount"])
        overall[currency] += cents
        project_id = entry["project_id"]
        project_amounts[project_id][currency] += cents
        if "project_name" in entry:
            project_names[project_id] = entry["project_name"]
    projects = {
        project_id: (project_names.get(project_id, project_id), dict(values))
        for project_id, values in project_amounts.items()
    }
    return dict(overall), projects


def format_cents(cents: int) -> str:
    whole, fraction = divmod(abs(cents), 100)
    sign = "-" if cents < 0 else ""
    return f"{sign}{whole}.{fraction:02d}"


def money_lines(values: dict[str, int], default_currency: str) -> list[str]:
    currencies = sorted(values) if values else [default_currency]
    return [f"- {currency} {format_cents(values.get(currency, 0))}" for currency in currencies]


def render_rollup(data: dict[str, Any]) -> str:
    overall, projects = totals(data)
    lines = [
        "# Expense rollup",
        "",
        "Calculated from the canonical `ledger.json` expense ledger.",
        "Currencies are totaled separately; no exchange-rate conversion is implied.",
        "",
        "## Overall total",
        "",
        *money_lines(overall, data["default_currency"]),
        "",
        "## By project",
        "",
    ]
    if not projects:
        lines.append("_No expenses recorded._")
    else:
        for project_id, (project_name, values) in sorted(projects.items()):
            label = project_name if project_name == project_id else f"{project_name} (`{project_id}`)"
            lines.extend([f"### {label}", "", *money_lines(values, data["default_currency"]), ""])
        lines.pop()
    return "\n".join(lines) + "\n"


def generated_id(data: dict[str, Any], date: str, project_id: str) -> str:
    prefix = f"{date}-{project_id}-"
    used = {entry["id"] for entry in data["entries"]}
    number = 1
    while f"{prefix}{number:03d}" in used:
        number += 1
    return f"{prefix}{number:03d}"


def write_text(path: Path, contents: str) -> None:
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", dir=path.parent, prefix=".expense-", suffix=".tmp", delete=False) as handle:
            temporary = Path(handle.name)  # exclusive creation with mode 0600
            handle.write(contents)
            handle.flush()
            os.fsync(handle.fileno())
        temporary.replace(path)
    except OSError as error:
        raise LedgerError(f"cannot write {path}: {error}") from error
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)


def write_json(path: Path, data: dict[str, Any]) -> None:
    write_text(path, json.dumps(data, indent=2, ensure_ascii=False) + "\n")


@contextmanager
def ledger_lock(path: Path):
    try:
        fd = os.open(path.parent / ".expense_tracker.lock", os.O_WRONLY | os.O_CREAT | os.O_APPEND | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            os.close(fd)
            raise LedgerError("unsafe expense ledger lock")
        lock = os.fdopen(fd, "a", encoding="utf-8")
    except OSError as error:
        raise LedgerError(f"cannot open expense ledger lock: {error}") from error
    with lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX)
        except OSError as error:
            raise LedgerError(f"cannot lock expense ledger: {error}") from error
        yield


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(description=__doc__)
    commands = result.add_subparsers(dest="command", required=True)
    commands.add_parser("check", help="validate the ledger")
    commands.add_parser("rollup", help="print the current rollup")

    add = commands.add_parser("add", help="append an expense")
    add.add_argument("--date", required=True, help="ISO date (YYYY-MM-DD)")
    add.add_argument("--amount", required=True, help="decimal amount with two places; negative for credits")
    add.add_argument("--project", dest="project_id", required=True, help="stable lowercase project slug")
    add.add_argument("--note", required=True)
    add.add_argument("--project-name")
    add.add_argument("--category", help="optional reporting category")
    add.add_argument("--confidence", help="optional confidence or cost basis label")
    add.add_argument("--currency", help="three-letter code; defaults to ledger default")

    update = commands.add_parser("update", help="update an expense by ID")
    update.add_argument("entry_id")
    update.add_argument("--date", help="ISO date (YYYY-MM-DD)")
    update.add_argument("--amount", help="decimal amount with two places; negative for credits")
    update.add_argument("--project", dest="project_id", help="stable lowercase project slug")
    update.add_argument("--note")
    update.add_argument("--project-name")
    update.add_argument("--category", help="reporting category")
    update.add_argument("--confidence", help="confidence or cost basis label")
    update.add_argument("--currency", help="three-letter currency code")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        ledger_path = selected_ledger()
        with ledger_lock(ledger_path):
            if selected_ledger() != ledger_path:
                raise LedgerError("expense source changed; retry")
            data = load_ledger(ledger_path)
            if args.command == "rollup":
                print(render_rollup(data), end="")
            elif args.command == "check":
                print(f"valid: {len(data['entries'])} expense entries")
            elif args.command == "add":
                entry = {
                    "id": generated_id(data, args.date, args.project_id),
                    "date": args.date,
                    "amount": args.amount,
                    "project_id": args.project_id,
                    "note": args.note,
                }
                optional = {
                    "project_name": args.project_name,
                    "category": args.category,
                    "confidence": args.confidence,
                    "currency": args.currency,
                }
                entry.update({key: value for key, value in optional.items() if value is not None})
                data["entries"].append(entry)
                validate_ledger(data)
                write_json(ledger_path, data)
                print(f"added {entry['id']}")
            elif args.command == "update":
                fields = {
                    "date": args.date,
                    "amount": args.amount,
                    "project_id": args.project_id,
                    "note": args.note,
                    "currency": args.currency,
                    "project_name": args.project_name,
                    "category": args.category,
                    "confidence": args.confidence,
                }
                if not any(value is not None for value in fields.values()):
                    raise LedgerError("update requires at least one field")
                entry = next((item for item in data["entries"] if item["id"] == args.entry_id), None)
                if entry is None:
                    raise LedgerError(f"unknown expense id: {args.entry_id}")
                if args.project_id is not None and args.project_id != entry["project_id"]:
                    entry["project_id"] = args.project_id
                    entry.pop("project_name", None)
                    existing_name = next(
                        (
                            item["project_name"]
                            for item in data["entries"]
                            if item is not entry
                            and item["project_id"] == args.project_id
                            and "project_name" in item
                        ),
                        None,
                    )
                    if existing_name is not None:
                        entry["project_name"] = existing_name
                for key in ("date", "amount", "note", "currency", "category", "confidence"):
                    if fields[key] is not None:
                        entry[key] = fields[key]
                if args.project_name is not None:
                    for item in data["entries"]:
                        if item["project_id"] == entry["project_id"]:
                            item["project_name"] = args.project_name
                validate_ledger(data)
                write_json(ledger_path, data)
                print(f"updated {entry['id']}")
    except LedgerError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
