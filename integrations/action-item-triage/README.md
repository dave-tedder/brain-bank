# Action Item Triage

This CLI sorts open `action_items` into keep, resolve, archive, review, or pending buckets. Deterministic rules run first, then an optional OpenRouter classifier handles ambiguous items.

Safety is the main design constraint:

- Dry run is the default.
- `--apply` refuses while any item is pending.
- Apply changes statuses only, through the guarded `transition_action_item` RPC. It never deletes rows.
- Every close carries an explicit close reason; a decision that cannot justify one stays open in review.
- Each answer the RPC gave is recorded in a disposition CSV.
- Protected phrases win before project matching, deduplication, or classification.
- Missing OpenRouter credentials produce a classification-input file.

## Setup

Copy `config.example.json` to `config.json`, then adjust protected phrases, work-shape terms, done statuses, and project aliases for your installation.

Provide these variables through a local `.env` file or the ambient environment:

```text
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
NOTION_TOKEN=<optional-notion-token>
OPENROUTER_API_KEY=<optional-openrouter-key>
```

`config.json`, `.env`, and generated `out/` files are ignored by git.

## Usage

```bash
node triage.mjs
node triage.mjs --decisions=out/decisions.json
node triage.mjs --apply --decisions=out/decisions.json
```

Without `OPENROUTER_API_KEY`, ambiguous items remain pending and are written to `out/triage-classify-input-<date>.json`. Classify them with any LLM or agent, write a decisions file in the shape below, and re-run with `--decisions=<file>`. Review the generated report before any apply run.

`--apply` calls `transition_action_item` once per item, with actor `action-item-triage`, from-status `open`, and the decision's explicit close reason: `done` (status `resolved`), `fragment` (status `archived`, never a real task), or `duplicate` with the survivor, which only the cascade's dedup can name. A row that left `open` since classification is skipped, not overwritten, and recorded as `skipped_status_changed`. That is a status guard, not a generation check: a row closed and reopened since classification reads as open and is closed. A run is per-item, not atomic, and safe to re-run. It needs the `20261106_action_items_close_reason.sql` migration; without the RPC the first call fails, the run exits nonzero, and nothing is written.

The cascade's own closes carry their reasons too. A matching project whose status is a done status resolves as `done`, with evidence `project-status:<source>:<project display name>`, where the source is `notion` or `projects-table`: open that project there to check it. An older copy of a newer item is archived as `duplicate`, naming the newer one as its survivor.

### The decision contract

```json
{
  "<id>": {"bucket": "KEEP", "reason": "a real commitment"},
  "<id>": {"bucket": "REVIEW", "reason": "not sure"},
  "<id>": {"bucket": "ARCHIVE", "close_reason": "fragment", "reason": "Consider a nicer report someday"},
  "<id>": {"bucket": "RESOLVE", "close_reason": "done", "evidence": "commit:abc1234", "reason": "the migration shipped"}
}
```

The close reason is an explicit field, never read out of `reason`. Evidence for `done` is one of `commit:<sha>`, `pr:<owner>/<repo>#<n>`, `card:<id>`, `thought:<uuid>` or `url:<http(s) url>`. The tool checks that a pointer has that shape, not that the claim is true, so whoever writes the file is attesting that they checked it. The pointer goes on the event payload and in the CSV. Only a person or agent that has checked should write `done`; the built-in classifier cannot produce it. It judges each item alone, and it cannot verify that anything shipped, so an item that may be finished goes to REVIEW, not ARCHIVE.

**Anything else stays open in REVIEW,** and the report says why (`decision held for review: ...`): a missing or unknown `close_reason`, `done` under ARCHIVE, `done` with no valid evidence, a blank reason, an unknown bucket. **Existing decisions files:** an ARCHIVE written before this contract has no `close_reason`, so it is held rather than guessed. Re-running an old file closes nothing it used to close as a fragment; add the field to the decisions you still stand behind. A decisions file cannot name a duplicate: only the cascade's dedup can.

Dry-run reports can mark command-derived rows with `external-command-completed dry-run only` when a `brain-channel` operation command has conservative evidence in `projects` or mirrored `business_events`. Those rows stay in `REVIEW`, and `--apply` ignores the signal. Resolve them only after exact action item IDs are approved in a separate live-write pass.

For an offline verification with synthetic data:

```bash
node triage.mjs --fixture=/path/to/fixture.json --out-dir=/tmp/triage-check
```

Fixture mode never connects to external services and refuses `--apply`.

## Reverting

Each answer the RPC gave is in `out/triage-disposition-<date>.csv`, which is appended to across same-day runs. Before any database write, `--apply` checks that file. A seven-column file (close reason and outcome, no evidence) is migrated in place: every record is kept, prior rows gain an empty `evidence` field, and the original is left beside it as `<file>.pre-evidence-<ms>-<uuid>.bak`. Any other header (including this tool's original `id,old_status,new_status,bucket,reason,description`), a record of the wrong width (seven fields under the current header included, since nothing says which field is missing), or text a standard CSV parser would read differently or reject refuses the run with nothing closed; move that file aside and re-run.

Each run also holds a claim file beside the CSV from that check through its final append. A second run on the same file refuses before any write; run it again when the first finishes. A dead process's claim on this machine is recovered automatically, but one from another host or an unreadable one needs a person to confirm that process is gone and delete it. This covers runs sharing a local directory, not a file synced between machines. A file whose last record has no line ending is kept and named in a note, since a spreadsheet saves files that way and a cut-short write looks the same.

A call that throws has no row, and a lost response or a killed process can leave a committed change with no row, so the `action_item_events` row with actor `action-item-triage` is the durable record. To undo a row, use the `restore_action_item` MCP tool by id, which reopens it and records the event. Never a raw `UPDATE`: that records actor `sql`, which the `action_item_events_by_actor` measure in `scripts/loop-closing/metrics.sql` counts as a defect.

## Tests

```bash
node --test integrations/action-item-triage/*.test.mjs
node --check integrations/action-item-triage/triage.mjs
node --check integrations/action-item-triage/triage-lib.mjs
node scripts/loop-closing/triage-apply-mutations.mjs        # each --apply guard, mutated, must fail a test
bash scripts/loop-closing/action-item-events-sql-test.sh    # the real --apply into a throwaway local Postgres
```

The unit and CLI tests need `python3` (a differential check against Python's strict CSV reader). The SQL harness needs a local PostgreSQL (`initdb`, `pg_ctl`, `psql` on `PATH`); add `--all-mutations` to prove every check can fail.

The pure library has no file, network, environment, or process side effects.

## Unknown-project reroute report

`reroute-report.mjs` is a READ-ONLY companion: it lists every open action item
whose source thought has a null/`unknown` `metadata.project`, applies the
`projects.route_phrases` route map in dry run (same unique-match semantics the
capture paths use live via `_shared/metadata-validation.ts`), and writes an
approval packet to `out/reroute-report-<date>.md` with exact thought IDs and
the apply-shape SQL. Nothing is written to the database; applying requires the
operator running the approved UPDATE lines. Pure helpers live in
`reroute-lib.mjs` (`node --test reroute.test.mjs`). Same `.env` as `triage.mjs`
(only the Supabase pair is needed).
