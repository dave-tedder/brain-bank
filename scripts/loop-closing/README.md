# scripts/loop-closing

Test harnesses, measurement queries and operator tools for the loop-closing work:
the decisions table, the work-report gate, close reasons, supersede, proposal
review, archive proposals, the aged-item re-check, the fragment gate, semantic
dedup, client identity and booking matches.

Nothing here runs in production and nothing here deploys anything. The Edge
Functions and migrations these scripts exercise live under `supabase/`.

## What needs what

| Kind | Examples | Needs |
|---|---|---|
| Deno unit suites | `archive-proposals-diff.test.ts` | Deno (`--allow-read --allow-env --allow-run --allow-write`) |
| Probe harnesses | `ingest-probe-harness.ts`, `closeout-capture-probe-harness.ts` | Deno; the capture functions run in-process against a stubbed database and model, no network |
| SQL contracts | `*-sql-test.sh` + `*-sql-test.sql` | a local PostgreSQL 16 (`initdb`, `pg_ctl`, `psql` on `PATH`) |
| Mutation sweeps | `*-sql-test.sh --all-mutations`, `*-ts-mutants.*` | as the contract they mutate |
| Read-only measurement | `metrics.sql`, `*-backtest.*`, `sentinel-reads-reference.sql` | read access to YOUR project; they never write |

Every SQL contract builds a throwaway cluster in a temp directory, applies only
the migrations it names onto a stub schema, runs its checks, and removes the
cluster on exit. None of them touches a real Supabase project. Local clusters
have no pgvector and no PostgREST, so anything that depends on real vector
size, PostgREST argument casting or the hosted statement timeout is first
exercised in your own staging project.

## Three outcomes, always

Every runner exits with one of three codes, and a sweep counts them separately:

- **0** passed.
- **1** a check ran to completion and did not hold. Only this counts as a caught
  mutant.
- **2** NEVER-RAN: the harness could not reach a verdict (a syntax error, a
  missing function, a statement timeout, a cluster that would not start, the
  outer deadline). A NEVER-RAN is a broken harness, never a pass and never a
  catch.

Before trusting an all-caught sweep, confirm the unmutated run passes. A broken
baseline makes every mutant look caught.

## One local cluster at a time

Builders, reviewers and harnesses serialize their throwaway clusters through one
lock, `db-lock.py`, an `flock(2)` on `/tmp/ob-db.flock`. The operating system
releases it when the holder dies, so nobody ever removes a lock file by hand.

```bash
python3 scripts/loop-closing/db-lock.py run --label <who> -- bash scripts/loop-closing/<harness>.sh
```

A script can take it for its own lifetime with `source db-lock.sh` and
`ob_db_lock_acquire <label>`. A waiter that times out (150 minutes) prints who
holds it and removes nothing. `bash scripts/loop-closing/db-lock-selftest.sh`
proves the lock (23 checks; `--all-mutations` plants 8 faults).

## After applying a migration to a real project

Compare `md5(prosrc)` of every function the migration creates with the md5 of
the same body in the file. A tool that relays SQL text can decode `\uXXXX`
escapes into literal characters on the way, which changes the bytes of a body
without changing the file; the hash check is what catches it.
