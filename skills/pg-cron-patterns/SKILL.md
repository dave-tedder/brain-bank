---
name: pg-cron-patterns
description: Use when writing or editing a pg_cron job, especially a one-shot, cleanup, backfill, or confirm-once job that needs to report a verdict a human will actually see. Also fires when deciding how a scheduled job should surface what it did, or when a job "succeeded" but nobody can tell what it actually decided.
type: skill
---

# pg_cron Patterns

## Alarms must land on a read surface. Never `RAISE NOTICE`.

A pg_cron job's `RAISE NOTICE` goes to the Postgres log, which nobody reads. The
job still reports as "succeeded", so it **looks fine while telling you nothing**.

This is not hypothetical. A one-shot cleanup job was written to delete a set of
junk wiki pages, then verify a day later that they had stayed deleted and drop
its backup tables. It ran. It behaved perfectly: it detected that some rows had
been recreated overnight, correctly took its "keep and warn" branch, and
deliberately did NOT drop the backups. Then it announced that decision via
`RAISE NOTICE`.

For a full day the tracker read "cleanup succeeded" while half its work had been
quietly undone, and the backup tables it had correctly kept sat there as
unexplained `rls_disabled_in_public` advisor ERRORs with nothing anywhere saying
why. The job was right. The reporting was invisible, which made being right
worthless.

**The rule:** any one-shot, cleanup, backfill, or confirm-once job must write its
verdict where a human already looks:

- a row in a run-log table the operator or a digest reads,
- a `capture_thought`,
- a ledger `last_queue_result` that a daily digest surfaces,
- or a board event.

Pick the surface **before** writing the job, and **state which branch it took**,
not merely that it ran. A job whose only output is its own exit status is not
reporting, it is hiding.

## Corollary: assert the END STATE, not the exit code.

"Succeeded" describes that a job ran. It does not describe that the job did the
thing. A verification step must assert the advertised outcome.

Same failure family, different costume: a scheduled lane's ledger row had a
`last_successful_run` field that its prompt never set. Heartbeats advanced daily
while that field sat frozen weeks in the past. Nothing was broken, nothing
errored, and the field was a signal that lied to anyone who gated on it. The
root cause was not a schema gap (the write verb had always accepted the field);
the prompt simply never wrote it, and no check compared the two.

When a job or lane reports a status field, something must verify that field
against the reality it claims to describe, or it will drift and no error will
ever fire.

## Related

- `docs/architecture/` for the digest and scheduling surfaces a job can report into.
