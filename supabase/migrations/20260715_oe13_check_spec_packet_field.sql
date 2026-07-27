-- OE-13 Sub-phase B — immutable executed-check packet field.
--
-- check_spec is set ONLY at intake (create_agent_task_intake). No worker,
-- receipt, hold, or admin verb writes it (spec §3 — check authorship is the
-- load-bearing safety rule). Nullable + additive: drop-safe, and NULL leaves
-- the task on the existing human-read gate byte-for-byte (spec §0).

alter table public.agent_tasks
  add column if not exists check_spec jsonb;

comment on column public.agent_tasks.check_spec is
  'OE-13 Sub-phase B: packet-authored executable check ({runner, args[]}, allowlist-validated at intake). Immutable after intake (trigger-enforced); the closeout controller re-runs it in an isolated cred-scrubbed no-network worktree and gates Agent Review -> Agent Done on its OWN exit 0 (Fork A). NULL = normal human-read gate.';

-- Immutability is structural, not conventional: ANY change to a non-null
-- check_spec (including nulling it out) raises. Nulling is deliberately
-- blocked too — clearing the check would drop the task back to the weaker
-- receipt-only gate, which is the wrong direction for a "correction". The
-- honest correction path for a bad check_spec is: archive the task and
-- re-intake it with the right check (packets are immutable by design), or a
-- guarded SQL ops session that disables and re-enables this trigger loudly
-- in one transaction.
-- Plain invoker rights (no SECURITY DEFINER — the trigger only raises).
create or replace function public.oe13_check_spec_immutable()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.check_spec is distinct from old.check_spec then
    raise exception 'agent_tasks.check_spec is immutable after intake (OE-13 spec §3). Archive + re-intake to change the check.';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_oe13_check_spec_immutable on public.agent_tasks;
create trigger trg_oe13_check_spec_immutable
  before update on public.agent_tasks
  for each row
  execute function public.oe13_check_spec_immutable();
