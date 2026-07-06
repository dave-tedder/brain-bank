# Open Engine Scripts

## OE-8 closeout controller

`closeout-controller.mjs` is a local evaluator for `Agent Review` task
receipts. In dry-run mode it validates receipt quality, routes each task by
`project_slug`, and prints the tracker/session-log/capture drafts it would use
in a later apply phase — without connecting to Supabase, calling
`apply_agent_task_review`, editing trackers/session logs, capturing thoughts,
promoting tasks, firing cron, deploying, or mutating live systems.

Print the read-only SQL bundle for gathering evidence:

```bash
node scripts/open-engine/closeout-controller.mjs --sql
```

Run the synthetic fixtures (all use the fixture-only registry at
`scripts/open-engine/fixtures/test-registry.json`, whose route paths point at
files that exist in every clone):

```bash
REG="--registry scripts/open-engine/fixtures/test-registry.json"
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-applyable.json $REG --expect APPLYABLE
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-held-missing-sections.json $REG --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-held-standing-risk.json $REG --expect HELD
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-mixed.json $REG --expect MIXED
node scripts/open-engine/closeout-controller.mjs --fixture scripts/open-engine/fixtures/closeout-controller-unknown-route.json $REG --expect HELD
```

A receipt must carry the canonical 8 sections, in the order the queue-runner
skill documents (`Work summary:`, `Verification:`, `Touched files or
records:`, `Limitations:`, `Tracker draft:`, `Session-log draft:`, `Brain Bank
capture draft:`, `Follow-up recommendation:`). A receipt missing a section is
held out of auto-closeout, not guessed at.

### Review-note augmentation

A human review note stored on the task row (`agent_tasks.review_reason`) may
supply sections the `AGENT DONE` receipt is missing. The controller parses the
note with the same heading grammar and merges ONLY the missing sections — the
immutable `AGENT DONE` event stays authoritative for every section it already
carries, and the 8-section gate is unchanged (all 8 must be present
somewhere). Merged tasks report `augmented_sections` and carry the note text
into apply `closeout_evidence` so the augmentation is durable on the
`AGENT APPLIED` event even though `review_reason` is a mutable column.

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
          "agent_code": "local-codex",
          "payload": {
            "reason": "Work summary:\n... (8-section receipt markdown)",
            "status": "Agent Review",
            "from_status": "Agent Working"
          },
          "created_at": "2026-07-01T12:00:00.000000+00:00"
        }
      ]
    }
  ],
  "actionItems": [],
  "generated_at": "2026-07-01T00:00:00.000Z"
}
```

The project route registry is
`scripts/open-engine/project-closeout-registry.json`. It holds operator-local
workspace paths, so it is gitignored — copy
`scripts/open-engine/project-closeout-registry.example.json` and fill in real
paths (same pattern as `integrations/*/config.json`). Missing or unresolved
routes hold the task; the controller never guesses from the current working
directory.

### Draft writer (`--write-drafts`)

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
  route paths, receipt gaps) produce NO file — they stay in the `hold` array
  of the printed JSON as the held-exception report.
- An existing draft with identical content reports `action: "unchanged"`; with
  different content it reports `DRAFT_CONFLICT` and exits non-zero — drafts
  are never overwritten.
- Still zero mutations elsewhere: no `apply_agent_task_review`, no task status
  changes, no tracker/session-log edits, no captures, no Supabase connection.
  Generated drafts are gitignored (they embed registry paths).

### Live modes (`--live-check`, `--apply`)

Both need `BRAIN_BANK_MCP_URL` and `BRAIN_BANK_MCP_KEY` in the environment
(never stored in files) and a `--task-id` — live modes run single-task until
the exception rate earns batching.

```bash
node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --live-check
node scripts/open-engine/closeout-controller.mjs --task-id <uuid> --apply
```

- `--live-check` fetches the task packet read-only through the guarded MCP
  `get_agent_task` and prints the evaluation. Zero mutations — run it before
  every `--apply`.
- `--apply` refuses anything not APPLYABLE (the held-exception report prints
  and it exits non-zero). For an APPLYABLE task, in contract order:
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
     `capture_tag` plus `open_engine` (explicit tags are normalized to
     hyphenated slugs at capture time, so it lands as `open-engine`).
- The controller never runs git. Committing closeout writes stays
  human/session-side.
