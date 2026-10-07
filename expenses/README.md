# Expense tracking

The helper and dashboard prefer `FM_HOME/data/agentos/expenses/ledger.json` when a complete guarded bundle exists in the explicitly selected home. The tracked [`ledger.json`](ledger.json) is an empty valid public fallback, not personal data or a billing feed. Keep real records in the private overlay; never commit them here. The helper calculates currency-separated overall and per-project views on demand. See [private runtime ownership](../docs/PRIVATE-RUNTIME.md) for configuration and preservation checks. Source cleanup does not edit existing private records. The commands below use wholly synthetic example values.

## Record an expense

From the repository root, use the dependency-free Python 3 helper. Keep the same explicit `FM_HOME` exported as the server to edit its private overlay rather than the repository fallback. The helper refuses incomplete/unsafe overlays, locks beside the selected ledger and writes private atomic replacements. `add`/`update` intentionally change current data, not the initial migration manifest:


```bash
python3 expenses/expense_tracker.py add \
  --date 2025-01-31 \
  --amount 12.34 \
  --project fm-quarterdeck \
  --project-name "Firstmate Quarterdeck" \
  --category "AI services" \
  --confidence "invoice verified" \
  --note "January model usage"
```

The command appends the entry and generates a stable ID such as `2025-01-31-fm-quarterdeck-001`. `--currency` defaults to the ledger's `default_currency` (`USD`).

Amounts are decimal strings with exactly two places. Record expenses as positive amounts and refunds or credits as negative amounts. A zero amount is allowed for a known subscription whose rate is still unknown; explain that it is unknown or TBD in the note. Different currencies are deliberately totaled separately rather than converted at an unstated exchange rate.

To correct an existing entry, update it by its stable ID. Supply only the fields that should change:

```bash
python3 expenses/expense_tracker.py update 2025-01-31-fm-quarterdeck-001 \
  --amount 10.00 \
  --note "Corrected January model usage"
```

The update command supports `--date`, `--amount`, `--project`, `--project-name`, `--category`, `--confidence`, `--note`, and `--currency`, and uses the same lock as additions. Run `python3 expenses/expense_tracker.py check` in validation or CI to catch malformed entries and duplicate IDs.

To inspect totals (output is private; the helper also creates/uses its colocated lock):

```bash
python3 expenses/expense_tracker.py rollup
```

## Ledger fields

Each entry uses:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Unique, stable lowercase slug |
| `date` | yes | Expense date in `YYYY-MM-DD` form |
| `amount` | yes | Decimal string with two places; negative for a credit |
| `project_id` | yes | Stable lowercase project slug used for grouping |
| `note` | yes | Brief description of the charge |
| `currency` | no | ISO-style three-letter code; defaults to `default_currency` |
| `project_name` | no | Human-readable project label |
| `category` | no | Human-readable reporting category; the UI derives a display category or uses `Uncategorized` when omitted |
| `confidence` | no | Confidence or cost-basis label such as `invoice verified` or `estimate` |
