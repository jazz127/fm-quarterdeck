# Private runtime ownership and preservation

## Explicit home, separate source

Product source belongs at `FM_HOME/projects/fm-quarterdeck`; private Quarterdeck input belongs at `FM_HOME/data/agentos`. **`FM_HOME` is an explicit normalized absolute startup input**, not an inferred `$HOME`, saved pointer inside the home, overlay override or repository-local private default. Selected homes never share implicit data. Temporary homes used by tests are synthetic only.

```text
$FM_HOME/data/agentos/
  expenses/
    ledger.json                # private current records
    costs.json                 # versioned Azure key and attribution map
    migration-manifest.json    # initial-copy provenance, not a current-edit lock
    .expense_tracker.lock      # Python helper's private lock
```

Dashboard and Python helper select this bundle before the empty public `expenses/ledger.json`. If no bundle exists, the fallback stays empty; if the canonical file is absent the dashboard labels its synthetic demo. An existing partial, malformed, symlinked, oversized, nonregular, hardlinked or insufficiently private bundle fails closed, never silently falling back. Browser source labels expose no absolute home or manifest.

`costs.json` is authoritative for both tag key and value-to-label mapping, even for explicit `null`/empty configuration. It supersedes `FM_COST_ATTRIBUTION_TAG` in overlay mode. Readers recheck configuration and discard provider caches when it changes. Invalid configuration prevents account-tool calls. Successful, partial, unclassified and unavailable rows use the same selected labels. Public defaults have no portfolio mapping.

Synthetic configuration example:

```json
{
  "schema": "fm-agentos-costs.v1",
  "azureTag": "cost-center",
  "attribution": {"example-store": "Example Store", "shared": "Shared costs"}
}
```

Matching is case-insensitive; labels may combine tags. Unmatched values remain unclassified and tag totals must reconcile before allocation. Keys/labels are bounded and reserved object names are rejected. This is not executable configuration or a credential store.

## Copy and verification semantics

Existing preserved bundles must stay in place. **Never rerun copy to reconcile differences after source sanitization or private edits.** The public source's empty ledger and neutral configuration intentionally differ from an earlier preserved bundle.

`FM_HOME="$FM_HOME" node prototype/scripts/private-overlay.mjs --verify` compares the bundle to that script checkout's exact ledger/configuration and initial manifest, read-only. It is appropriate only when verifying a copy against its actual source. The preservation-foundation verifier must succeed before replacing source defaults. No original private values, hashes or historical source pins belong in public source.

`--verify-preserved` instead validates the selected bundle and checks its ledger/configuration bytes against its own initial manifest, without comparing public defaults. It prints only pass/refusal. It proves initial copy integrity, not correctness of later intentional edits. A changed private ledger correctly fails this initial-copy check; never overwrite edits or delete the overlay to make it pass. Runtime validates schema/path/permissions, not eternal byte equality to an initial copy.

For a new empty installation only, `--copy` can initialize the bundle from the empty public source. Explicit home selection, existing home/data ownership and separate operator authorization are required. Customize private records/configuration deliberately afterward, not tracked source. The Python helper edits under its colocated lock; even `check`/`rollup` use that lock, so do not use them for a strictly read-only real-home verification.

### Safety

- Copy, never move or recursively harvest a home. No credentials, account reads, historic documents, browser profiles or Git mutation.
- Preflight every destination. Unequal existing files refuse; equal files remain untouched. Manifest is private provenance, published last, never tracked.
- POSIX directories are `0700`, files/locks `0600`; existing private permissions must already be safe. Never chmod user records to bypass refusal. Selected home and existing `data/` are not chmodded.
- Every ancestor is checked for symlinks. Bounded regular files (4 MiB) cannot have hardlinks. Migration refuses a home inside the source checkout, but source inside an external selected home is permitted.
- Complete temporary files are fsynced and published without replacement. Migration locks are exclusive, never stolen. Crash leftovers/partial bundles require exact separately authorized recovery after proving the writer stopped; do not automatically delete locks or temporary links.
- Python edits atomically replace current private ledger under a lock; initial provenance stays unchanged. No copy tool overwrites intentional edits.
- These checks assume trusted owner-controlled ancestors, not an adversarial same-UID filesystem sandbox. Host/Origin, revision, inbox and preview guards remain intact.

## Existing owners outside this expense bundle

Source cleanup preserves access in place; it does not authorize retiring the old checkout or promise cross-device state migration.

| Input | Retained owner and boundary |
| --- | --- |
| Lanes, backlog, statuses/briefs, transcripts, preferences, inbox/outbox | Existing selected-home guarded readers; no duplicate home or endpoint namespace |
| Taxonomy/acknowledgements/completion bindings | Existing `FM_QUARTERDECK_STATE_PATH`, currently required **outside FM_HOME**. If source is nested under the home, supply that explicit external owner because checkout default would violate the guard. Do not relax the guard or move/reset data in source cleanup; a reviewed namespace migration remains separate. |
| Review receipts/sidecars/status and Lavish bindings | Existing private receipt store and explicit status/session bindings; preserve IDs and idempotency before separately changing checkout ownership. Never replay delivery as migration. |
| Browser layout/filter storage and unsent drafts | Existing browser/tab; profiles/cookies/cache are excluded, not copied/decrypted/deleted. Cross-device retention needs separate authority. |
| Review origin, preview registry/root and deployment/completion evidence | Operator-owned launch bindings; new Git identity needs deliberate rebinding, not old metadata or invented publication proof. |
| Quota/billing tools and authentication | External authorized installation/account context; no snapshots/tokens copied or account APIs used for preservation. |
| Custom `FM_STATUS_PATH`, skill projections | Keep exact existing owners; no implicit projection, repinning or preference rewrite. |
| Historical docs/evidence and ignored labs/logs/caches/Git | Not runtime authority. Public docs describe contracts; private evidence stays private. Exclude T01–T04 from transfer, never migrate/delete to clean source. |

## Offline checks

The [public-source gate](PUBLIC-SOURCE.md) uses synthetic temporary homes under an ignored worktree-local scratch directory, explicitly clears inherited home/account configuration and injects account readers. Tests cover byte-preserving copy, independent homes, conflict/partial/race/path/permission refusal, empty defaults, custom attribution, cache rebinding, browser projection and Python private edits. Real selected-home checks are bounded and read-only, report booleans only, and never launch account tools or another home's endpoints.
