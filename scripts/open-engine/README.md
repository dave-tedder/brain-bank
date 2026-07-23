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

Run the fixtures. Every fixture is synthetic (zeroed UUIDs, generic slugs) and
routes through the shipped `fixtures/test-registry.json`, so these run from a
clean clone with no operator registry:

```bash
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-applyable.json --registry scripts/open-engine/fixtures/test-registry.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-held-missing-sections.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-held-standing-risk.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-mixed.json --registry scripts/open-engine/fixtures/test-registry.json --expect MIXED
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-inline-headings.json --registry scripts/open-engine/fixtures/test-registry.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-operator-action.json --registry scripts/open-engine/fixtures/test-registry.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-operator-action-only.json --registry scripts/open-engine/fixtures/test-registry.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-operator-marker-outside-followup.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-marker-injection.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-duplicate-heading.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-duplicate-done-latest-wins.json --registry scripts/open-engine/fixtures/test-registry.json --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-task-not-found.json --registry scripts/open-engine/fixtures/test-registry.json --task-id 9708e713-6f98-420a-9a39-22bbae011ec1 --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-needs-operator-status.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-protocol-relative-target.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-unknown-route.json --registry scripts/open-engine/fixtures/test-registry.json --expect HELD
```

Heading grammar: a canonical heading is matched at line start,
case-insensitive, with the section content either inline after the colon
("Limitations: none beyond ...") or on the following lines. A heading string
appearing mid-sentence never opens a section — that anchor is what keeps a
dishonest receipt that name-drops headings inside prose (inline "... task.
Verification: claimed ...") parsing as zero sections.
`closeout-controller-inline-headings.json` covers the honest inverse: a
receipt whose inline-content headings a line-only parser would misparse as
missing.

`closeout-controller-held-missing-sections.json` is the incomplete-receipt
case: its receipt carries 6 of the 8 canonical sections (`Limitations` and
`Follow-up recommendation` are absent), so it classifies HELD until the
receipt is augmented via the review-note path.

### Review-note augmentation

A human review note stored on the task row (`agent_tasks.review_reason`) may
supply sections the `AGENT DONE` receipt is missing. The controller parses the
note with the same heading grammar and merges ONLY the missing sections — the
immutable `AGENT DONE` event stays authoritative for every section it already
carries, and the 8-section gate is unchanged (all 8 must be present somewhere).
Merged tasks report `augmented_sections` and carry the note text into apply
`closeout_evidence` so the augmentation is durable on the `AGENT APPLIED`
event even though `review_reason` is a mutable column.

```bash
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-held-augmented.json --registry scripts/open-engine/fixtures/test-registry.json --expect APPLYABLE
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

Because the registry is gitignored, it does NOT exist in a fresh git worktree —
only in the main checkout. Running closeout from a worktree therefore dies with
`ENOENT: ... project-closeout-registry.json` before it can route anything. Run
closeout from the main checkout (which is where the scheduled lanes run), or
pass an absolute path to the main checkout's `closeout-run.sh`. This is working
as intended, not a bug: the registry points at real project trackers outside
this repo, and a worktree has no business writing to them under a stale route.

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
  connection. Generated drafts are gitignored (they embed registry paths), and
  the whole `docs/handoffs/pending-closeouts/` folder is operator-local for
  the same reason — it exists only in a working deployment, never in this
  repo.

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
  3. Plan-doc sync per plan-doc-seeded task in the batch. A task carrying a
     `plan-doc: <path>` source entry has its plan-doc folder grepped for the
     task short-id tag `[OE:<shortid>]`; every carded line is flipped
     (`[ ]`->`[x]` where a checkbox is present, `carded <date>`->`done
     <apply-date>`), across both the plan doc and the co-located tracker todo.
     Session logs are skipped (append-only history). The gate refuses to apply
     a plan-doc task whose tagged line cannot be located
     (`PLAN_DOC_LINE_NOT_FOUND`) or whose path cannot be resolved
     (`PLAN_DOC_PATH_UNRESOLVED`) — no apply without doc sync. The flip is
     idempotent, so `--resume` replays it harmlessly.
  4. One `capture_thought` per project batch, tagged with the route's
     `capture_tag` plus `open_engine`.
- The controller never runs git. Committing closeout writes stays
  human/session-side (locked design decision).

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

## OE-5 watch (historical)

Before the scheduled queue-runner lane was promoted, it ran a seven-day
"natural watch": the cron fired daily with no manual help, and a frozen
read-only evaluator (fed by a read-only SQL bundle) graded each day —
lane fired once, one ledger row per day, low-risk claims only, no
scheduled-lane writes to canonical tables — with any missing day reading
as INCONCLUSIVE rather than a pass. The watch passed 7/7 and the lane was
promoted. The evaluator and its fixtures were deliberately frozen to that
completed watch and are not shipped here; the pattern to reuse for your
own promotion gates is the query-backed watch surface that superseded it
(`oe_triage_watch_days` / `oe_triage_watch_streak` views, see the
migrations), where clean-day evidence is computed from immutable run
records instead of copied query results. A future watch should get a
current-generation verifier with its own dates and invariants.

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
