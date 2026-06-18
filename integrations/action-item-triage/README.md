# Action Item Triage

This CLI sorts open `action_items` into keep, resolve, archive, review, or pending buckets. Deterministic rules run first, then an optional OpenRouter classifier handles ambiguous items.

Safety is the main design constraint:

- Dry run is the default.
- `--apply` refuses while any item is pending.
- Apply changes statuses only. It never deletes rows.
- Every applied change is recorded in a disposition CSV.
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

Without `OPENROUTER_API_KEY`, ambiguous items remain pending and are written to `out/triage-classify-input-<date>.json`. Review the generated report before any apply run.

Dry-run reports can mark command-derived rows with `external-command-completed dry-run only` when a `brain-channel` operation command has conservative evidence in `projects` or mirrored `business_events`. Those rows stay in `REVIEW`, and `--apply` ignores the signal. Resolve them only after exact action item IDs are approved in a separate live-write pass.

For an offline verification with synthetic data:

```bash
node triage.mjs --fixture=/path/to/fixture.json --out-dir=/tmp/triage-check
```

Fixture mode never connects to external services and refuses `--apply`.

## Tests

```bash
node --test integrations/action-item-triage/*.test.mjs
node --check integrations/action-item-triage/triage.mjs
node --check integrations/action-item-triage/triage-lib.mjs
```

The pure library has no file, network, environment, or process side effects.
