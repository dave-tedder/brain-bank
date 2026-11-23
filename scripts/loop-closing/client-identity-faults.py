#!/usr/bin/env python3
"""Loop-closing Task 5.3: the planted faults of client-identity-sql-test.sh.

    python3 scripts/loop-closing/client-identity-faults.py <name> <migration copy>

Applies one planted fault to a COPY of 20261121b_action_items_client_id.sql:
every replacement must match exactly once, or the script exits 1 and the
runner reports NEVER-RAN. "append" adds a statement at the end. The check that
must report each fault is named in the runner's MUTATION_CHECK.
"""
import sys

READ_HEAD = "  event_title text, event_date date, proposed_at timestamptz, pending_total bigint\n)\nlanguage sql\nstable\n"
LIMIT = "  limit least(greatest(coalesce(p_limit, 200), 1), 500)"
COL = "  add column client_id uuid null references public.clients(id) on delete set null;"

FAULTS = {
    # The column (M01, M02) and the index (M05).
    "mig_no_fk": [(COL, "  add column client_id uuid null;")],
    "mig_cascade": [(COL, COL.replace("on delete set null", "on delete cascade"))],
    "mig_no_action": [(COL, COL.replace(" on delete set null", ""))],
    "mig_not_null": [("  add column client_id uuid null references", "  add column client_id uuid not null references")],
    "mig_default": [("  add column client_id uuid null references",
                     "  add column client_id uuid null default '00000000-0000-4000-8000-000000000000' references")],
    "mig_no_index": [("create index action_items_client_open_idx\n  on public.action_items (client_id)\n  where client_id is not null and status = 'open';", "")],
    "mig_index_all_rows": [("  where client_id is not null and status = 'open';", ";")],
    # The support table (T01, G01) and an existing grant (MIG).
    "support_no_cascade": [("  decision_id uuid primary key references public.auto_resolve_decisions(id) on delete cascade,",
                            "  decision_id uuid primary key references public.auto_resolve_decisions(id),")],
    "support_no_rls": [("alter table public.calendar_proposal_support enable row level security;\n", "")],
    "support_anon_select": [("append", "grant select on table public.calendar_proposal_support to anon;")],
    "record_decisions_revoked": [("append", "revoke execute on function public.record_decisions(jsonb) from service_role;")],
    # The snapshot and the booking identity (K01, Y07a).
    "snapshot_no_status": [("    'status', coalesce(e.metadata->'status', 'null'::jsonb),\n", "")],
    "gcal_no_suffix_strip": [("    when right(k, 11) = '@google.com' then nullif(left(k, length(k) - 11), '')\n", "")],
    "gcal_no_trim": [("nullif(lower(btrim(e.metadata->>'gcal_event_id')), '')", "nullif(lower(e.metadata->>'gcal_event_id'), '')")],
    "same_booking_by_date_only": [("    when public.booking_gcal_key(a) is not null and public.booking_gcal_key(b) is not null\n",
                                   "    when false\n")],
    "same_booking_ignores_key_mismatch": [("      then public.booking_gcal_key(a) = public.booking_gcal_key(b)",
                                           "      then a.date_start is not distinct from b.date_start")],
    # Support (Y03, Y05, Y06, Y07, P02).
    "supported_no_client_check": [("      and s.client_id = a.client_id\n", "")],
    "supported_no_snapshot_check": [("      and s.event_snapshot = public.booking_event_snapshot(e)\n", "")],
    "sync_no_withdraw": [("  delete from public.calendar_proposal_support s\n  using public.auto_resolve_decisions d\n  where s.decision_id = d.id\n",
                          "  delete from public.calendar_proposal_support s\n  using public.auto_resolve_decisions d\n  where false and s.decision_id = d.id\n")],
    "sync_no_same_booking_skip": [("      and public.booking_same(e, v_event)\n", "      and false\n")],
    "sync_skip_ignores_support": [("      and public.calendar_proposal_supported(d.id)\n  );", "  );")],
    # The guard (Y05b, R02).
    "guard_dropped": [("create trigger auto_resolve_decisions_calendar_support_guard\n  before insert or update on public.auto_resolve_decisions\n"
                       "  for each row execute function public.calendar_support_guard();", "")],
    "guard_update_only": [("  before insert or update on public.auto_resolve_decisions", "  before update on public.auto_resolve_decisions")],
    "guard_reads_stored_row": [("     and not public.calendar_support_holds(new.id, new.item_id, new.evidence_event_id) then",
                                "     and not public.calendar_proposal_supported(new.id) then")],
    "sync_no_stale_check": [("  if public.booking_event_snapshot(v_event) is distinct from p_snapshot then\n    return -1;\n  end if;\n", "")],
    # Correction 3: support for another item of the client, or after the item's
    # text changed (H01, H02a); an older sync withdrawing newer support (Y11b);
    # rows accepted without a read time (Y11d); the reads not capped, not
    # filtered to open items, or without the the CRM key (B01, B02;
    # correction 4); the sync table open to anon (T01).
    "holds_ignores_pair": [("      and s.item_id = p_item_id\n      and s.event_id = p_event_id\n", ""),
                           ("    join public.action_items a on a.id = s.item_id\n    join public.business_events e on e.id = s.event_id\n",
                            "    join public.action_items a on a.id = p_item_id\n    join public.business_events e on e.id = p_event_id\n")],
    "holds_ignores_text": [("      and s.item_description = a.description\n", "")],
    "sync_no_read_order": [("    if v_last > p_read_at then\n      return -2;\n    end if;\n", "")],
    "sync_read_at_optional": [("  if p_read_at is null and jsonb_array_length(p_rows) > 0 then\n", "  if false then\n")],
    "roster_no_cap": [("    'clients', case when count(*) <= p_max\n", "    'clients', case when true\n")],
    "match_read_items_any_status": [("      from public.action_items a\n      where a.client_id is not null and a.status = 'open'\n",
                                     "      from public.action_items a\n      where a.client_id is not null\n")],
    "match_read_no_client_key": [("                                                   'crm_id', c.metadata->>'crm_id') order by c.id)",
                                  "                                                   'crm_id', null) order by c.id)")],
    "match_read_no_cap": [("      select case when count(*) <= p_max_clients\n", "      select case when true\n")],
    "sync_table_no_rls": [("alter table public.calendar_event_sync enable row level security;\n", "")],
    "guard_on_kept": [("  if new.layer = 'calendar' and new.outcome = 'accepted'\n", "  if new.layer = 'calendar' and new.outcome in ('accepted', 'kept')\n")],
    # The pending read (P01 to P05, Y05a, R02b).
    "pend_no_generation": [("      and d.item_generation = a.reopen_generation\n      and public.calendar_proposal_supported(d.id)",
                            "      and public.calendar_proposal_supported(d.id)")],
    "pend_any_outcome": [("    where d.layer = 'calendar'\n      and d.outcome = 'proposed'\n      and d.reason = 'booking_match'\n      and a.status = 'open'",
                          "    where d.layer = 'calendar'\n      and d.outcome in ('proposed', 'kept', 'accepted')\n      and d.reason = 'booking_match'\n      and a.status = 'open'")],
    "pend_includes_deferred": [("      and d.reason = 'booking_match'\n      and a.status = 'open'",
                                "      and d.reason = 'booking_match'\n      and a.status in ('open', 'deferred')")],
    "pend_unsupported_listed": [("      and d.item_generation = a.reopen_generation\n      and public.calendar_proposal_supported(d.id)",
                                 "      and d.item_generation = a.reopen_generation")],
    "pend_order_desc": [("  order by p.proposed_at, p.item_id, p.decision_id", "  order by p.proposed_at desc, p.item_id, p.decision_id")],
    "pend_limit_unclamped": [(LIMIT, "  limit coalesce(p_limit, 200)")],
    "pend_limit_default": [("coalesce(p_limit, 200)", "coalesce(p_limit, 1)")],
    "pend_cap_lowered": [(LIMIT, LIMIT.replace("500)", "4)"))],
    "pend_cap_raised": [(LIMIT, LIMIT.replace("500)", "1000)"))],
    "pend_total_row_number": [("         p.event_date, p.proposed_at, count(*) over ()",
                               "         p.event_date, p.proposed_at, row_number() over (order by p.proposed_at, p.item_id, p.decision_id)")],
    # Grants and shape (G01, S01).
    "grant_anon": [("append", "grant execute on function public.calendar_pending_proposals(integer) to anon;")],
    "grant_authenticated": [("append", "grant execute on function public.sync_booking_proposals(uuid, jsonb, timestamptz, jsonb) to authenticated;")],
    "security_definer": [(READ_HEAD, READ_HEAD + "security definer\n")],
    "volatile_read": [(READ_HEAD, READ_HEAD.replace("stable", "volatile"))],
    "no_search_path": [(READ_HEAD + "set search_path = pg_catalog, public\n", READ_HEAD)],
}


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[1] not in FAULTS:
        print(f"unknown planted fault: {sys.argv[1:]}", file=sys.stderr)
        return 1
    path = sys.argv[2]
    s = open(path).read()
    for old, new in FAULTS[sys.argv[1]]:
        if old == "append":
            s += "\n" + new + "\n"
            continue
        if s.count(old) != 1:
            print(f"site matches {s.count(old)} times: {old[:80]!r}", file=sys.stderr)
            return 1
        s = s.replace(old, new)
    open(path, "w").write(s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
