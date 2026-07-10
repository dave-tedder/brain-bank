# Open Engine Scripts

## OE-8 closeout-controller dry run

`closeout-controller.mjs` is a local read-only evaluator for `Agent Review`
task receipts. It validates receipt quality, routes each task by
`project_slug`, and prints the tracker/session-log/Brain Bank capture drafts it
would use in a later apply phase.

It does not connect to Supabase, call `apply_agent_task_review`, edit
trackers/session logs, capture to Brain Bank, promote tasks, fire cron, deploy,
or mutate live systems.

Print the read-only SQL bundle:

```bash
node scripts/open-engine/closeout-controller.mjs --sql
```

Run the OE-8A fixtures (all rebuilt from real event shapes in Session 266):

```bash
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-c29a181d.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-held-648e6e1c.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-applyable-projected.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-mixed.json --expect MIXED
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-inline-headings.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-operator-action.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-operator-action-only.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-operator-marker-outside-followup.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-marker-injection.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-duplicate-heading.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-duplicate-done-latest-wins.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-task-not-found.json --task-id 9708e713-6f98-420a-9a39-22bbae011ec1 --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-needs-operator-status.json --expect HELD
```

Heading grammar (Session 274): a canonical heading is matched at line start,
case-insensitive, with the section content either inline after the colon
("Limitations: none beyond ...") or on the following lines. A heading string
appearing mid-sentence never opens a section — that anchor is what keeps the
2026-07-02 false runner receipt (inline "... task. Verification: claimed ...")
parsing as zero sections. `closeout-controller-inline-headings.json` is the
real Session 270 honest receipt (md5-verified) whose two inline-content
headings the 2026-07-06 OE-8D live-check misparsed as missing.

`closeout-controller-c29a181d.json` is the real manual-rep row: its receipt
carries 6 of the 8 canonical sections (`Limitations` and `Follow-up
recommendation` are absent), so it classifies HELD until the receipt is
augmented via the review-note path. `closeout-controller-applyable-projected.json`
is the one projection: no real 8-section `AGENT DONE` exists yet, so it carries
the real Session 265 8-section hold receipt projected onto the honest
`AGENT DONE` shape (see its `_note`).

### Review-note augmentation (Session 268)

A human review note stored on the task row (`agent_tasks.review_reason`) may
supply sections the `AGENT DONE` receipt is missing. The controller parses the
note with the same heading grammar and merges ONLY the missing sections — the
immutable `AGENT DONE` event stays authoritative for every section it already
carries, and the 8-section gate is unchanged (all 8 must be present somewhere).
Merged tasks report `augmented_sections` and carry the note text into apply
`closeout_evidence` so the augmentation is durable on the `AGENT APPLIED`
event even though `review_reason` is a mutable column.

```bash
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-c29a181d-augmented.json --expect APPLYABLE
```

Expected copied-result input shape — the receipt lives in `payload.reason`
(what `move_agent_task_status` writes and the `--sql` bundle selects); real
events have no `text` field:

```json
{
  "tasks": [
    {
      "id": "uuid",
      "status": "Agent Review",
      "risk": "low",
      "project_slug": "brain-bank",
      "explicit_approval": false,
      "linked_action_item_id": null,
      "events": [
        {
          "event_type": "AGENT DONE",
          "agent_code": "codex",
          "payload": {
            "reason": "Work summary:\n... (8-section receipt markdown)",
            "status": "Agent Review",
            "from_status": "Agent Working"
          },
          "created_at": "2026-07-02T14:08:15.847445+00:00"
        }
      ]
    }
  ],
  "actionItems": [],
  "generated_at": "2026-07-02T00:00:00.000Z"
}
```

The project route registry is
`scripts/open-engine/project-closeout-registry.json`. It holds operator-local
workspace paths, so it is gitignored — copy
`scripts/open-engine/project-closeout-registry.example.json` and fill in real
paths (same pattern as `integrations/*/config.json`). Missing or unresolved
routes hold the task; the controller never guesses from the current working
directory.

### OE-8B draft writer (`--write-drafts`)

`--write-drafts` writes one pending-closeout draft per APPLYABLE project batch
to `docs/handoffs/pending-closeouts/YYYY-MM-DD-<project-slug>.md` (anchored to
this repo via the script location, never cwd; override with `--drafts-dir`).
The file bytes are exactly the `projects[].pending_closeout.content` string
that the same input prints in dry-run mode, so a dry run followed by
`--write-drafts` on the same input is byte-for-byte verifiable. The date comes
from the input's `generated_at` (falling back to today), so the same evidence
file always produces the same file name and bytes.

```bash
node scripts/open-engine/closeout-controller.mjs --input /tmp/agent-review-evidence.json --write-drafts
```

Rules:

- Held tasks (wrong status/risk, missing or unknown `project_slug`, unresolved
  route paths, receipt gaps) produce NO file — they stay in the `hold` array of
  the printed JSON as the held-exception report. See the
  `closeout-controller-unknown-route.json` fixture:

  ```bash
  node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-unknown-route.json --expect HELD
  ```

- An existing draft with identical content reports `action: "unchanged"`; with
  different content it reports `DRAFT_CONFLICT` and exits non-zero — drafts are
  never overwritten.
- Still zero mutations elsewhere: no `apply_agent_task_review`, no task status
  changes, no tracker/session-log edits, no Brain Bank captures, no Supabase
  connection. Generated drafts are gitignored (they embed registry paths);
  `docs/handoffs/pending-closeouts/README.md` documents the folder.

### OE-8C live modes (`--live-check`, `--apply`)

Both need `BB_MCP_URL` and `BB_MCP_KEY` in the environment
(never stored in files) and a `--task-id` — OE-8C runs single-task until the
exception rate earns batching (OE-8D).

```bash
node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --live-check
node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --apply
```

- `--live-check` fetches the task packet read-only through the guarded MCP
  `get_agent_task` and prints the evaluation. Zero mutations — run it before
  every `--apply`.
- `--apply` refuses anything not APPLYABLE (the held-exception report prints
  and it exits non-zero). For an APPLYABLE task, in contract order:
  0. Write a local intent journal to
     `docs/handoffs/pending-closeouts/journal/<task-id>.json` before the board
     apply. If apply succeeds but a later file/capture step fails, rerun:

     ```bash
     node scripts/open-engine/closeout-controller.mjs --resume <uuid>
     ```

     `--resume` confirms the live task has an `AGENT APPLIED` event, then
     replays only the marker-guarded file appends and capture phase from the
     journal. It consults journal state: a `complete` journal reports
     `ALREADY_COMPLETE` and replays nothing, and any project batch whose
     capture is already journaled is skipped instead of re-captured.

     Completed journals are kept in place as the audit trail for each apply
     (retention decision, Fix Session A 2026-07-10). Do not delete them as
     routine cleanup; they are small JSON files and the only local record of
     what the controller did between the board apply and the file/capture
     phase.
  1. `apply_agent_task_review` per task — exactly one `AGENT APPLIED`,
     `resolution: accepted`, `applied_by: closeout-controller`, never resolves
     linked action items, and passes NO `note` (a note would overwrite
     `review_reason`); the review-note augmentation travels durably in the
     event's `closeout_evidence` instead.
  2. One tracker + one session-log append per project batch, routed by the
     registry. Appends are marker-guarded (`open-engine closeout <date>
     tasks: …`) so re-runs report `unchanged`; existing content is never
     rewritten.
  3. One `capture_thought` per project batch, tagged with the route's
     `capture_tag` plus `open_engine`.
- The controller never runs git. Committing closeout writes stays
  human/session-side (locked decision, Session 268).

### OE-8D run-summary capture

After the daily OE-8D automation has checked every non-archived Agent Review
task, run one summary capture so OE-11 briefings can see that the closeout
pass happened, including no-op runs. This is additive logging only: it does not
apply tasks, change the receipt/risk gates, edit project trackers/session logs,
or resolve linked action items.

```bash
node scripts/open-engine/closeout-controller.mjs \
  --capture-run-summary \
  --applied-task-ids "17d39373,d08fffac" \
  --held-tasks "c460d0cd:UNKNOWN_PROJECT_ROUTE" \
  --remaining-agent-review 1 \
  --notable "one route missing"
```

The controller writes exactly one `capture_thought` with tags
`["open-engine","closeout","oe-8d"]` and content shaped like:

```text
OE-8D closeout run 2026-07-08T08:22:14.000Z: applied 2 [17d39373, d08fffac], held 1 [c460d0cd: UNKNOWN_PROJECT_ROUTE], 1 Agent Review rows remaining. one route missing.
```

For a normal no-op run, pass empty task lists and the final remaining count:

```bash
node scripts/open-engine/closeout-controller.mjs \
  --capture-run-summary \
  --remaining-agent-review 0
```

Use `--summary-preview` during local verification to print the payload without
capturing it.

## OE-5 watch helper

`verify-oe5-watch.mjs` is frozen as the local read-only evaluator for the completed 2026-06-30 through 2026-07-06 natural job `9` watch. It is intentionally not a current-board validator. Future watches should get a new helper or a renamed current-generation verifier instead of widening this one.

It does not connect to Supabase, read secrets, fire cron, mutate task state, change Slack behavior, or touch Brain Bank PR #11.

Print the SQL bundle:

```bash
node scripts/open-engine/verify-oe5-watch.mjs --sql
```

Run a fixture or copied-result JSON file:

```bash
node scripts/open-engine/verify-oe5-watch.mjs --fixture scripts/open-engine/fixtures/oe5-watch-pass.json
node scripts/open-engine/verify-oe5-watch.mjs --input /tmp/oe5-watch-results.json
```

Expected copied-result keys are `job`, `cronRuns`, `mcpInvocations`, `ledgerRows`, `taskEvents`, `taskRows`, `netResponses`, `scheduledDataChanges`, and optional `pr`. `job` may be either the single row or the SQL result array. `scheduledDataChanges` may be an object like `{ "thoughts": 0, "action_items": 0 }` or the rows from the source-table review query.

For fixture verification, use `--expect`:

```bash
node scripts/open-engine/verify-oe5-watch.mjs --fixture scripts/open-engine/fixtures/oe5-watch-pass.json --expect PASS
node scripts/open-engine/verify-oe5-watch.mjs --fixture scripts/open-engine/fixtures/oe5-watch-fail-missing-day.json --expect INCONCLUSIVE
node scripts/open-engine/verify-oe5-watch.mjs --fixture scripts/open-engine/fixtures/oe5-watch-fail-risk.json --expect FAIL
node scripts/open-engine/verify-oe5-watch.mjs --fixture scripts/open-engine/fixtures/oe5-watch-fail-duplicate-ledger.json --expect FAIL
node scripts/open-engine/verify-oe5-watch.mjs --fixture scripts/open-engine/fixtures/oe5-watch-pass-pr-head-warning.json --expect PASS
```

The post-watch checklist remains the source of truth. If this helper disagrees with `docs/handoffs/2026-06-30-brain-bank-pr11-post-watch-merge-checklist.md`, fix the helper.

## Agent Done archive cadence

Board hygiene policy, selected in WS-6: archive unarchived `Agent Done` rows after they are at least 7 days past `completed_at`, unless a row is on an explicit keep-list for an active review, training example, or incident investigation. This is a small operator SQL pass, not a sentinel responsibility. The sentinel stays read-only; the closeout controller remains the preferred home if this later becomes automated.

Recommended weekly preview:

```sql
select id, title, project_slug, completed_at
from public.agent_tasks
where status = 'Agent Done'
  and archived_at is null
  and completed_at < now() - interval '7 days'
order by completed_at;
```

Recommended weekly apply after the preview is accepted:

```sql
update public.agent_tasks
set archived_at = now(),
    updated_at = now()
where status = 'Agent Done'
  and archived_at is null
  and completed_at < now() - interval '7 days'
  and id <> all(array[
    -- '00000000-0000-0000-0000-000000000000'
  ]::uuid[]);
```
