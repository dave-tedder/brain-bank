#!/usr/bin/env python3
"""Negative controls for 20261119c_action_items_recheck.sql and
20261119ca_action_items_recheck_cold_start.sql (loop-closing Task 4.1).

    python3 recheck-sql-mutants.py --list
    python3 recheck-sql-mutants.py <copy of 20261119c> <copy of 20261119ca> <mutant name>

Each mutant is a list of literal edits to a COPY of ONE of the two migrations:
20261119ca for the names in COLD (recheck_eligible_items, which that file
replaces, and the two functions it adds), 20261119c for every other. Every edit
must match exactly one site of its file, or the mutant did not apply (exit 1)
and the runner reports NEVER-RAN. Exit 3: unknown mutant. Run only by
recheck-sql-test.sh, which then judges the mutated migration with the contract
and the schedules; a mutant is CAUGHT only by a completed failed check.
"""
import sys

MAX = "'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid"
ZERO = "'00000000-0000-0000-0000-000000000000'::uuid"

# The two bound lines of match_thoughts_bounded (six spaces) and of
# recheck_candidates (two/four spaces), each with enough context to be unique.
B_LO = f"      and (t.created_at, t.id) > (p_lower_at, coalesce(p_lower_id, {MAX}))\n"
B_UP = "      and (t.created_at, t.id) <= (p_upper_at, p_upper_id)\n  )\n"
C_LO = f"  where (t.created_at, t.id) > (p_lower_at, coalesce(p_lower_id, {MAX}))\n"
C_UP = "    and (t.created_at, t.id) <= (p_upper_at, p_upper_id)\n    and (\n"
STALE = ("  if v_item.recheck_cursor_at is distinct from p_expected_cursor_at\n"
         "     or v_item.recheck_cursor_id is distinct from p_expected_cursor_id then")
CURSOR_OK = ("    if not ((p_cursor_at, p_cursor_id) > (v_lower_at, v_lower_id))\n"
             "       or (p_cursor_at, p_cursor_id) > (v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id) then")
ELIG_GAP = ("      and (a.recheck_scan_id is not null\n"
            "           or a.last_rechecked_at is null\n"
            "           or a.last_rechecked_at < p_now - interval '168 hours')\n")
CAND_ORDER = "  order by t.created_at, t.id\n  limit least(greatest(coalesce(p_limit, 10), 1), 50)"
PENDING_TAIL = "  order by d.created_at, d.id\n  limit least(greatest(coalesce(p_limit, 200), 1), 500)"
COMMIT_SIG = "uuid, uuid, timestamptz, uuid, timestamptz, uuid, jsonb, boolean"
# The page-boundary guard of recheck_commit_page (review finding F3).
PAGE_GUARD = ("    if not exists (\n      select 1\n"
              "      from public.recheck_candidates(p_item_id, v_lower_at, v_lower_id,")


# The second ORDER BY key of recheck_eligible_items as 20261119ca replaces it.
ATTEMPT = "greatest(a.last_rechecked_at, a.recheck_last_error_at)"


def check_block(name):
    """The whole `alter table ... add constraint <name> check (...);` statement."""
    return ("CHECK", name)


M = {
    # ----- match_thoughts_bounded -----
    "bounded_no_lower": [(B_LO, "")],
    "bounded_no_upper": [(B_UP, "  )\n")],
    "bounded_lower_inclusive": [(B_LO, B_LO.replace(" > (", " >= ("))],
    "bounded_upper_exclusive": [(B_UP, B_UP.replace(" <= (", " < ("))],
    "bounded_null_lower_id_min": [(B_LO, B_LO.replace(MAX, ZERO))],
    # The bug the plan names: five global neighbours first, the window afterwards.
    "bounded_filter_after_limit": [
        (B_LO + B_UP, "    order by t.embedding <=> query_embedding, t.created_at, t.id\n"
                      "    limit greatest(coalesce(match_count, 0), 0)\n  )\n"),
        ("  from windowed w\n  order by", f"  from windowed w\n  where (w.created_at, w.id) > (p_lower_at, coalesce(p_lower_id, {MAX}))"
                                          " and (w.created_at, w.id) <= (p_upper_at, p_upper_id)\n  order by"),
    ],
    "bounded_farthest_first": [("  order by w.embedding <=> query_embedding, w.created_at, w.id\n",
                                "  order by w.embedding <=> query_embedding desc, w.created_at, w.id\n")],
    "bounded_count_ignored": [("  limit greatest(coalesce(match_count, 0), 0)\n$$;", "  limit 5\n$$;")],
    "bounded_null_query_matches": [("    where query_embedding is not null\n      and t.embedding is not null\n",
                                    "    where true\n")],
    # ----- recheck_eligible_items -----
    "elig_includes_deferred": [("    where a.status = 'open'\n      and not (low.d like", "    where a.status in ('open', 'deferred')\n      and not (low.d like")],
    "elig_any_status": [("    where a.status = 'open'\n      and not (low.d like", "    where true\n      and not (low.d like")],
    "elig_no_canary": [("      and not (low.d like '%perpetual%' and (low.d like '%canary%' or low.d like '%tripwire%'))\n", "")],
    "elig_canary_no_tripwire": [("(low.d like '%canary%' or low.d like '%tripwire%')", "(low.d like '%canary%')")],
    "elig_canary_no_canary_word": [("(low.d like '%canary%' or low.d like '%tripwire%')", "(low.d like '%tripwire%')")],
    "elig_canary_case_sensitive": [("select translate(a.description, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') as d", "select a.description as d")],
    "elig_canary_or": [("low.d like '%perpetual%' and (", "low.d like '%perpetual%' or (")],
    "elig_age_inclusive": [("      and a.created_at < p_now - interval '168 hours'", "      and a.created_at <= p_now - interval '168 hours'")],
    "elig_age_6_days": [("      and a.created_at < p_now - interval '168 hours'", "      and a.created_at < p_now - interval '143 hours'")],
    "elig_no_age": [("      and a.created_at < p_now - interval '168 hours'\n", "")],
    "elig_gap_inclusive": [("           or a.last_rechecked_at < p_now - interval '168 hours')", "           or a.last_rechecked_at <= p_now - interval '168 hours')")],
    "elig_no_gap": [(ELIG_GAP, "")],
    "elig_no_scan_arm": [("      and (a.recheck_scan_id is not null\n           or a.last_rechecked_at is null", "      and (a.last_rechecked_at is null")],
    "elig_no_never_arm": [("           or a.last_rechecked_at is null\n           or a.last_rechecked_at <", "           or a.last_rechecked_at <")],
    "elig_scan_not_first": [("    order by (a.recheck_scan_id is null) asc,\n", "    order by\n")],
    "elig_nulls_last": [(ATTEMPT + " asc nulls first,", ATTEMPT + " asc nulls last,")],
    "elig_newest_check_first": [(ATTEMPT + " asc nulls first,", ATTEMPT + " desc nulls first,")],
    # ----- cold-start correction: the order by last attempt (20261119ca) -----
    # The order 20261119c had: an item that errored keeps the head of the queue.
    "elig_order_ignores_error": [(ATTEMPT, "a.last_rechecked_at")],
    "elig_order_ignores_recheck": [(ATTEMPT, "a.recheck_last_error_at")],
    "elig_order_earliest_attempt": [(ATTEMPT, "least(a.last_rechecked_at, a.recheck_last_error_at)")],
    "elig_order_error_first": [(ATTEMPT, "coalesce(a.recheck_last_error_at, a.last_rechecked_at)")],
    # An error stamp that takes the item out of the queue instead of moving it back.
    "elig_error_makes_ineligible": [("      and a.created_at < p_now - interval '168 hours'\n      and (a.recheck_scan_id is not null",
                                     "      and a.created_at < p_now - interval '168 hours'\n      and a.recheck_last_error_at is null\n      and (a.recheck_scan_id is not null")],
    "elig_error_week_gap": [("      and a.created_at < p_now - interval '168 hours'\n      and (a.recheck_scan_id is not null",
                             "      and a.created_at < p_now - interval '168 hours'\n      and (a.recheck_last_error_at is null or a.recheck_last_error_at < p_now - interval '168 hours')\n      and (a.recheck_scan_id is not null")],
    "elig_error_makes_eligible": [("           or a.last_rechecked_at < p_now - interval '168 hours')", "           or a.last_rechecked_at < p_now - interval '168 hours'\n           or a.recheck_last_error_at is not null)")],
    # ----- cold-start correction: recheck_warm_embeddings (20261119ca) -----
    "warm_reads_no_embedding": [("         count(c.embedding <=> c.embedding)::integer,\n", "         0,\n")],
    "warm_includes_null_embeddings": [("    where t.embedding is not null\n      and (t.created_at, t.id) > (v_from_at, v_from_id)", "    where (t.created_at, t.id) > (v_from_at, v_from_id)")],
    "warm_lower_inclusive": [("      and (t.created_at, t.id) > (v_from_at, v_from_id)", "      and (t.created_at, t.id) >= (v_from_at, v_from_id)")],
    "warm_no_lower": [("    where t.embedding is not null\n      and (t.created_at, t.id) > (v_from_at, v_from_id)", "    where t.embedding is not null")],
    "warm_newest_first": [("    order by t.created_at asc, t.id asc\n    limit p_limit", "    order by t.created_at desc, t.id desc\n    limit p_limit")],
    "warm_no_id_tiebreak": [("    order by t.created_at asc, t.id asc\n    limit p_limit", "    order by t.created_at asc, t.id desc\n    limit p_limit")],
    "warm_limit_ignored": [("    order by t.created_at asc, t.id asc\n    limit p_limit", "    order by t.created_at asc, t.id asc")],
    "warm_last_is_first": [("         (array_agg(c.created_at order by c.created_at desc, c.id desc))[1],\n         (array_agg(c.id order by c.created_at desc, c.id desc))[1]",
                            "         (array_agg(c.created_at order by c.created_at asc, c.id asc))[1],\n         (array_agg(c.id order by c.created_at asc, c.id asc))[1]")],
    "warm_last_id_unordered": [("         (array_agg(c.id order by c.created_at desc, c.id desc))[1]", "         (array_agg(c.id order by c.id asc))[1]")],
    # Correction 1 (review F2): a statement that reads four chunks' worth of embeddings while
    # reporting one. The contract counts distance evaluations (T17); the cold step counts the
    # simulated pages each warm-up statement first read, in place of timing it.
    "warm_reads_four_chunks": [("  return query select v_rows, v_last_at, v_last_id, v_rows < p_limit;",
                                "  perform count(x.embedding <=> x.embedding) from (select t.embedding from public.thoughts t where t.embedding is not null and (t.created_at, t.id) > (v_from_at, v_from_id) order by t.created_at asc, t.id asc limit p_limit * 4) x;\n  return query select v_rows, v_last_at, v_last_id, v_rows < p_limit;")],
    "warm_done_on_full_chunk": [("  return query select v_rows, v_last_at, v_last_id, v_rows < p_limit;", "  return query select v_rows, v_last_at, v_last_id, v_rows <= p_limit;")],
    "warm_never_done": [("  return query select v_rows, v_last_at, v_last_id, v_rows < p_limit;", "  return query select v_rows, v_last_at, v_last_id, v_rows = 0;")],
    "warm_ignores_cursor": [("  select coalesce(a.recheck_cursor_at, a.created_at), coalesce(a.recheck_cursor_id, c_max)\n  into v_from_at, v_from_id", "  select a.created_at, c_max\n  into v_from_at, v_from_id")],
    "warm_null_cursor_id_min": [("  select coalesce(a.recheck_cursor_at, a.created_at), coalesce(a.recheck_cursor_id, c_max)\n  into v_from_at, v_from_id", f"  select coalesce(a.recheck_cursor_at, a.created_at), coalesce(a.recheck_cursor_id, {ZERO})\n  into v_from_at, v_from_id")],
    "warm_latest_lower": [("  order by 1 asc, 2 asc\n  limit 1;", "  order by 1 desc, 2 desc\n  limit 1;")],
    "warm_lower_id_unordered": [("  order by 1 asc, 2 asc\n  limit 1;", "  order by 1 asc, 2 desc\n  limit 1;")],
    "warm_for_closed_items": [("    and a.status = 'open'\n    and a.recheck_scan_id is null\n", "    and a.recheck_scan_id is null\n")],
    "warm_for_midscan_items": [("    and a.status = 'open'\n    and a.recheck_scan_id is null\n", "    and a.status = 'open'\n")],
    "warm_for_sources_without_embedding": [("    and a.created_at is not null\n    and src.embedding is not null\n", "    and a.created_at is not null\n")],
    "warm_for_items_without_source": [("  join public.thoughts src on src.id = a.source_thought_id\n  where a.id = any(coalesce(p_item_ids, '{}'::uuid[]))", "  left join public.thoughts src on src.id = a.source_thought_id\n  where a.id = any(coalesce(p_item_ids, '{}'::uuid[]))"),
                                      ("    and a.created_at is not null\n    and src.embedding is not null\n", "    and a.created_at is not null\n")],
    "warm_for_every_item": [("  where a.id = any(coalesce(p_item_ids, '{}'::uuid[]))\n    and a.status = 'open'", "  where true\n    and a.status = 'open'")],
    "warm_position_ignored": [("  if p_after_at is not null and (p_after_at, p_after_id) > (v_from_at, v_from_id) then", "  if false then")],
    "warm_position_unclamped": [("  if p_after_at is not null and (p_after_at, p_after_id) > (v_from_at, v_from_id) then", "  if p_after_at is not null then")],
    "warm_limit_unchecked": [("  if p_limit is null or p_limit < 1 or p_limit > 1000 then", "  if false then")],
    "warm_limit_2000": [("  if p_limit is null or p_limit < 1 or p_limit > 1000 then", "  if p_limit is null or p_limit < 1 or p_limit > 2000 then")],
    "warm_pair_unchecked": [("  if (p_after_at is null) <> (p_after_id is null) then\n    raise exception 'recheck_warm_embeddings", "  if false then\n    raise exception 'recheck_warm_embeddings")],
    "warm_volatile": [("returns table (rows_read integer, last_at timestamptz, last_id uuid, done boolean)\nlanguage plpgsql\nstable", "returns table (rows_read integer, last_at timestamptz, last_id uuid, done boolean)\nlanguage plpgsql\nvolatile")],
    "warm_left_public": [("revoke execute on function public.recheck_warm_embeddings(uuid[], timestamptz, uuid, integer) from public, anon, authenticated;\n", "")],
    "warm_not_granted": [("grant execute on function public.recheck_warm_embeddings(uuid[], timestamptz, uuid, integer) to service_role;\n", "")],
    # ----- cold-start correction: recheck_note_error (20261119ca) -----
    "note_no_lock": [("  select a.status into v_status from public.action_items a where a.id = p_item_id for no key update;", "  select a.status into v_status from public.action_items a where a.id = p_item_id;")],
    "note_any_status": [("  if v_status <> 'open' then\n    return false;\n  end if;\n", "")],
    "note_closed_answers_true": [("  if v_status <> 'open' then\n    return false;", "  if v_status <> 'open' then\n    return true;")],
    "note_writes_nothing": [("  update public.action_items a\n  set recheck_last_error_at = now()\n  where a.id = p_item_id;\n  return true;", "  return true;")],
    "note_stamps_recheck": [("  set recheck_last_error_at = now()\n", "  set recheck_last_error_at = now(), last_rechecked_at = now()\n")],
    "note_clears_scan": [("  set recheck_last_error_at = now()\n", "  set recheck_last_error_at = now(), recheck_scan_id = null, recheck_scan_upper_at = null, recheck_scan_upper_id = null, recheck_scan_embedding_ids = null, recheck_scan_proposed = false\n")],
    "note_moves_cursor": [("  set recheck_last_error_at = now()\n", "  set recheck_last_error_at = now(), recheck_cursor_at = null, recheck_cursor_id = null\n")],
    "note_unknown_ignored": [("  if not found then\n    raise exception 'unknown_item: no action item %', p_item_id using errcode = 'RC003';\n  end if;\n  if v_status", "  if not found then\n    return false;\n  end if;\n  if v_status")],
    "note_null_unchecked": [("  if p_item_id is null then\n    raise exception 'recheck_note_error requires an item id.' using errcode = '22023';\n  end if;\n", "")],
    "note_stamp_in_the_past": [("  set recheck_last_error_at = now()\n", "  set recheck_last_error_at = now() - interval '1 day'\n")],
    "note_every_item": [("  set recheck_last_error_at = now()\n  where a.id = p_item_id;", "  set recheck_last_error_at = now()\n  where a.status = 'open';")],
    "note_security_definer": [("returns boolean\nlanguage plpgsql\nvolatile\nset search_path", "returns boolean\nlanguage plpgsql\nvolatile\nsecurity definer\nset search_path")],
    "note_no_search_path": [("returns boolean\nlanguage plpgsql\nvolatile\nset search_path = pg_catalog, public\n", "returns boolean\nlanguage plpgsql\nvolatile\n")],
    "note_left_public": [("revoke execute on function public.recheck_note_error(uuid) from public, anon, authenticated;\n", "")],
    "note_granted_anon": [("APPEND", "grant execute on function public.recheck_note_error(uuid) to anon;\n")],
    "note_not_granted": [("grant execute on function public.recheck_note_error(uuid) to service_role;\n", "")],
    "error_column_defaults_now": [("  add column if not exists recheck_last_error_at timestamptz null;", "  add column if not exists recheck_last_error_at timestamptz null default now();")],
    "elig_newest_item_first": [("             a.created_at asc, a.id asc\n", "             a.created_at desc, a.id asc\n")],
    "elig_id_desc": [("             a.created_at asc, a.id asc\n", "             a.created_at asc, a.id desc\n")],
    "elig_limit_unchecked": [("  if p_limit is null or p_limit < 1 or p_limit > 40 then", "  if false then")],
    "elig_now_unchecked": [("  if p_now is null then", "  if false then")],
    "elig_blank_project_kept": [("           nullif(th.metadata->>'project', ''),\n", "           th.metadata->>'project',\n")],
    # ----- recheck_plan_scan / recheck_begin_scan -----
    # The plan's own mutation: declared strict, a null embedding must stop begin.
    "begin_strict": [("volatile\ncalled on null input", "volatile\nstrict")],
    "plan_strict": [("stable\ncalled on null input", "stable\nstrict")],
    "begin_regenerates": [("  if v_item.recheck_scan_id is not null then\n    return query select 'existing'::text", "  if false then\n    return query select 'existing'::text")],
    "begin_not_open_unchecked": [("  if v_item.status <> 'open' then\n    return query select 'not_open'::text, v_item.recheck_scan_id,", "  if false then\n    return query select 'not_open'::text, v_item.recheck_scan_id,")],
    "begin_no_lock": [("  perform 1 from public.action_items a where a.id = p_item_id for no key update;", "  perform 1 from public.action_items a where a.id = p_item_id;")],
    "upper_oldest": [("  order by t.created_at desc, t.id desc\n  limit 1;", "  order by t.created_at asc, t.id asc\n  limit 1;")],
    "upper_no_id_tiebreak": [("  order by t.created_at desc, t.id desc\n  limit 1;", "  order by t.created_at desc, t.id asc\n  limit 1;")],
    "upper_not_clamped": [("  if v_upper_at is null or (v_upper_at, v_upper_id) < (v_lower_at, v_lower_id) then", "  if v_upper_at is null then")],
    "frozen_top_3": [("v_upper_at, v_upper_id, 5) m;", "v_upper_at, v_upper_id, 3) m;")],
    "frozen_farthest_first": [("array_agg(m.id order by m.similarity desc, m.created_at, m.id)", "array_agg(m.id order by m.similarity asc, m.created_at, m.id)")],
    # A second scan's frozen set computed from the item's creation, not the cursor.
    "frozen_ignores_cursor": [("  v_lower_at := coalesce(v_item.recheck_cursor_at, v_item.created_at);\n  v_lower_id := coalesce(v_item.recheck_cursor_id, c_max);\n\n  select t.created_at, t.id into v_upper_at",
                               "  v_lower_at := v_item.created_at;\n  v_lower_id := c_max;\n\n  select t.created_at, t.id into v_upper_at")],
    # The persisted proposed flag the dry run resumes from (review finding F2).
    "plan_existing_proposed_lost": [("      v_item.recheck_scan_embedding_ids, v_item.recheck_scan_proposed;\n    return;\n  end if;\n  if v_item.created_at is null then",
                                     "      v_item.recheck_scan_embedding_ids, false;\n    return;\n  end if;\n  if v_item.created_at is null then")],
    "plan_existing_proposed_always": [("      v_item.recheck_scan_embedding_ids, v_item.recheck_scan_proposed;\n    return;\n  end if;\n  if v_item.created_at is null then",
                                       "      v_item.recheck_scan_embedding_ids, true;\n    return;\n  end if;\n  if v_item.created_at is null then")],
    "plan_would_begin_proposed": [("    v_item.recheck_cursor_id, v_upper_at, v_upper_id, v_ids, false;", "    v_item.recheck_cursor_id, v_upper_at, v_upper_id, v_ids, true;")],
    "plan_not_open_proposed_lost": [("      v_item.recheck_scan_embedding_ids, v_item.recheck_scan_proposed;\n    return;\n  end if;\n  if v_item.recheck_scan_id is not null then",
                                     "      v_item.recheck_scan_embedding_ids, false;\n    return;\n  end if;\n  if v_item.recheck_scan_id is not null then")],
    "frozen_always_empty": [("  if p_query_embedding is not null then\n    select coalesce(array_agg", "  if false then\n    select coalesce(array_agg")],
    # ----- recheck_candidates -----
    "cand_no_embedding_ids": [("      t.id = any(coalesce(p_embedding_ids, '{}'::uuid[]))\n      or exists (", "      exists (")],
    "cand_no_project": [("        where (src.project is not null and t.metadata->>'project' = src.project)\n           or (cardinality(src.topics)", "        where (cardinality(src.topics)")],
    "cand_no_topics": [("           or (cardinality(src.topics) > 0 and t.metadata->'topics' ?| src.topics)\n", "")],
    "cand_no_people": [("           or (cardinality(src.people) > 0 and t.metadata->'people' ?| src.people)\n", "")],
    "cand_blank_project_matches": [("    select nullif(th.metadata->>'project', '') as project,", "    select th.metadata->>'project' as project,")],
    "cand_lower_inclusive": [(C_LO, C_LO.replace(" > (", " >= ("))],
    "cand_upper_exclusive": [(C_UP, C_UP.replace(" <= (", " < ("))],
    "cand_no_lower": [(C_LO + "    and (t.created_at, t.id) <= (p_upper_at, p_upper_id)\n", "  where (t.created_at, t.id) <= (p_upper_at, p_upper_id)\n")],
    "cand_no_upper": [(C_UP, "    and (\n")],
    "cand_null_lower_id_min": [(C_LO, C_LO.replace(MAX, ZERO))],
    "cand_newest_first": [(CAND_ORDER, CAND_ORDER.replace("t.created_at, t.id", "t.created_at desc, t.id desc"))],
    "cand_id_desc": [(CAND_ORDER, CAND_ORDER.replace("t.created_at, t.id", "t.created_at, t.id desc"))],
    "cand_limit_ignored": [(CAND_ORDER, "  order by t.created_at, t.id\n  limit 50")],
    # ----- recheck_commit_page -----
    "commit_no_lock": [("  select * into v_item from public.action_items a where a.id = p_item_id for no key update;", "  select * into v_item from public.action_items a where a.id = p_item_id;")],
    "commit_stale_unchecked": [(STALE, "  if false then")],
    "commit_stale_not_null_safe": [(STALE, "  if v_item.recheck_cursor_at <> p_expected_cursor_at\n     or v_item.recheck_cursor_id <> p_expected_cursor_id then")],
    "commit_stale_time_only": [(STALE, "  if v_item.recheck_cursor_at is distinct from p_expected_cursor_at then")],
    "commit_stale_id_only": [(STALE, "  if v_item.recheck_cursor_id is distinct from p_expected_cursor_id then")],
    "commit_unknown_scan_as_final": [("  else\n    raise exception 'unknown_scan: % is neither the active nor the last finalised scan of %',\n      p_scan_id, left(p_item_id::text, 8) using errcode = 'RC002';\n  end if;",
                                      "  else\n    return query select 'already_final'::text, false, null::timestamptz, null::uuid, false, 0, null::timestamptz;\n    return;\n  end if;")],
    "commit_receipt_ignored": [("  elsif v_item.recheck_last_scan_id = p_scan_id then", "  elsif false then")],
    "commit_not_open_unchecked": [("  if v_item.status <> 'open' then\n    return query select 'not_open'::text, true,", "  if false then\n    return query select 'not_open'::text, true,")],
    "commit_args_unchecked": [("  if p_item_id is null or p_scan_id is null or p_final is null then", "  if false then")],
    "commit_nonfinal_needs_no_cursor": [("  elsif not p_final then\n    raise exception 'recheck_commit_page: a page that is not final needs its last (created_at, id).'\n      using errcode = '22023';\n  end if;", "  end if;")],
    "commit_cursor_pair_unchecked": [("  if (p_cursor_at is null) <> (p_cursor_id is null) then", "  if false then")],
    "commit_cursor_may_rewind": [(CURSOR_OK, "    if (p_cursor_at, p_cursor_id) > (v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id) then")],
    "commit_cursor_may_stand_still": [(CURSOR_OK, CURSOR_OK.replace("> (v_lower_at, v_lower_id))", ">= (v_lower_at, v_lower_id))"))],
    "commit_cursor_may_pass_upper": [(CURSOR_OK, "    if not ((p_cursor_at, p_cursor_id) > (v_lower_at, v_lower_id)) then")],
    # The page boundary (review finding F3): the new cursor is a row of the next
    # candidate page, measured from the stored cursor, final or not.
    "commit_page_guard_off": [(PAGE_GUARD, "    if false and not exists (" + PAGE_GUARD[len("    if not exists ("):])],
    "commit_page_guard_nonfinal_only": [(PAGE_GUARD, "    if not p_final and not exists (" + PAGE_GUARD[len("    if not exists ("):])],
    "commit_page_guard_final_only": [(PAGE_GUARD, "    if p_final and not exists (" + PAGE_GUARD[len("    if not exists ("):])],
    "commit_page_guard_only_with_rows": [(PAGE_GUARD, "    if jsonb_array_length(v_rows) > 0 and not exists (" + PAGE_GUARD[len("    if not exists ("):])],
    "commit_page_guard_only_without_rows": [(PAGE_GUARD, "    if jsonb_array_length(v_rows) = 0 and not exists (" + PAGE_GUARD[len("    if not exists ("):])],
    "commit_page_size_11": [("  c_page constant integer := 10;", "  c_page constant integer := 11;")],
    "commit_page_size_50": [("  c_page constant integer := 10;", "  c_page constant integer := 50;")],
    "commit_page_size_9": [("  c_page constant integer := 10;", "  c_page constant integer := 9;")],
    "commit_page_guard_ignores_id": [("      where pg.created_at = p_cursor_at and pg.id = p_cursor_id\n", "      where pg.created_at = p_cursor_at\n")],
    "commit_page_guard_ignores_time": [("      where pg.created_at = p_cursor_at and pg.id = p_cursor_id\n", "      where pg.id = p_cursor_id\n")],
    # The cursor only has to lie within the page's range: it need not be a row.
    "commit_page_guard_within_page_range": [("      where pg.created_at = p_cursor_at and pg.id = p_cursor_id\n", "      where (pg.created_at, pg.id) >= (p_cursor_at, p_cursor_id)\n")],
    # Any candidate at or before the new cursor: a count, not membership.
    "commit_page_guard_any_row_before": [("      where pg.created_at = p_cursor_at and pg.id = p_cursor_id\n", "      where (pg.created_at, pg.id) <= (p_cursor_at, p_cursor_id)\n")],
    # The page measured from the item's creation, not from the stored cursor.
    "commit_page_guard_from_item_start": [(PAGE_GUARD, PAGE_GUARD.replace("v_lower_at, v_lower_id,", "v_item.created_at, c_max,"))],
    "commit_page_guard_ignores_frozen": [("        v_item.recheck_scan_embedding_ids, c_page) pg\n", "        '{}'::uuid[], c_page) pg\n")],
    "commit_rows_array_unchecked": [("  if jsonb_typeof(v_rows) <> 'array' then", "  if false then")],
    "commit_row_object_unchecked": [("    if jsonb_typeof(v_row) <> 'object' then", "    if false then")],
    "commit_outcome_unchecked": [("    if coalesce(v_row->>'outcome', '') not in ('proposed', 'no_evidence') then", "    if false then")],
    "commit_none_found_allowed": [("    if v_row->>'reason' = 'none_found' then", "    if false then")],
    "commit_no_on_conflict": [("    on conflict (item_id, evidence_thought_id)\n      where layer = 'recheck' and evidence_thought_id is not null\n      do nothing\n", "")],
    "commit_proposed_flag_lost": [("  v_proposed := v_item.recheck_scan_proposed or v_proposed_inserted > 0;", "  v_proposed := v_proposed_inserted > 0;")],
    "commit_proposed_flag_any_row": [("  v_proposed := v_item.recheck_scan_proposed or v_proposed_inserted > 0;", "  v_proposed := v_item.recheck_scan_proposed or v_inserted > 0;")],
    "commit_nonfinal_keeps_cursor": [("    set recheck_cursor_at = p_cursor_at,\n        recheck_cursor_id = p_cursor_id,\n        recheck_scan_proposed = v_proposed\n", "    set recheck_scan_proposed = v_proposed\n")],
    "commit_nonfinal_drops_flag": [("        recheck_cursor_id = p_cursor_id,\n        recheck_scan_proposed = v_proposed\n", "        recheck_cursor_id = p_cursor_id\n")],
    "commit_no_premature_check": [("  if exists (\n    select 1 from public.recheck_candidates(p_item_id, v_from_at, v_from_id,", "  if false and exists (\n    select 1 from public.recheck_candidates(p_item_id, v_from_at, v_from_id,")],
    "commit_premature_ignores_cursor": [("  v_from_at := coalesce(p_cursor_at, v_lower_at);\n  v_from_id := coalesce(p_cursor_id, v_lower_id);", "  v_from_at := v_lower_at;\n  v_from_id := v_lower_id;")],
    "commit_premature_ignores_frozen": [("      v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,\n      v_item.recheck_scan_embedding_ids, 1)", "      v_item.recheck_scan_upper_at, v_item.recheck_scan_upper_id,\n      '{}'::uuid[], 1)")],
    "commit_final_cursor_at_page": [("      recheck_cursor_at = a.recheck_scan_upper_at,\n      recheck_cursor_id = a.recheck_scan_upper_id,\n",
                                     "      recheck_cursor_at = coalesce(p_cursor_at, a.recheck_cursor_at),\n      recheck_cursor_id = coalesce(p_cursor_id, a.recheck_cursor_id),\n")],
    "commit_final_no_receipt": [("      recheck_last_scan_id = p_scan_id,\n", "")],
    "commit_final_no_stamp": [("      recheck_scan_embedding_ids = null,\n      last_rechecked_at = v_now\n", "      recheck_scan_embedding_ids = null\n")],
    "commit_none_found_always": [("  if not v_proposed then\n    insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)", "  if true then\n    insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)")],
    "commit_none_found_never": [("  if not v_proposed then\n    insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)", "  if false then\n    insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)")],
    "commit_final_reports_active": [("  return query select 'final'::text, false,", "  return query select 'final'::text, true,")],
    "commit_drops_quote": [("           (e.r->>'evidence_thought_id')::uuid, e.r->>'quote', (e.r->>'score')::numeric", "           (e.r->>'evidence_thought_id')::uuid, null, (e.r->>'score')::numeric")],
    # ----- recheck_pending_proposals -----
    "pending_any_generation": [("    and d.item_generation = a.reopen_generation\n" + PENDING_TAIL, PENDING_TAIL)],
    "pending_any_status": [("    and a.status = 'open'\n    and d.item_generation", "    and d.item_generation")],
    "pending_includes_rejections": [("    and d.outcome = 'proposed'\n    and a.status = 'open'", "    and d.outcome in ('proposed', 'no_evidence')\n    and a.status = 'open'")],
    "pending_includes_kept": [("    and d.outcome = 'proposed'\n    and a.status = 'open'", "    and d.outcome in ('proposed', 'kept')\n    and a.status = 'open'")],
    "pending_total_is_row_number": [("         count(*) over ()\n", "         row_number() over (order by d.created_at, d.id)\n")],
    "pending_limit_ignored": [(PENDING_TAIL, "  order by d.created_at, d.id\n  limit 500")],
    "pending_newest_first": [(PENDING_TAIL, PENDING_TAIL.replace("d.created_at, d.id", "d.created_at desc, d.id desc"))],
    # ----- the small entry points and the receipt table -----
    "names_include_blank": [("  where c.name is not null and c.name <> ''\n", "")],
    "names_unordered": [("jsonb_agg(c.name order by c.name)", "jsonb_agg(c.name order by c.name desc)")],
    "source_embedding_inner_join": [("  left join public.thoughts th on th.id = a.source_thought_id\n  where a.id = p_item_id\n$$;", "  join public.thoughts th on th.id = a.source_thought_id\n  where a.id = p_item_id\n$$;")],
    "record_run_unvalidated": [("  if p_started_at is null or p_summary is null or jsonb_typeof(p_summary) <> 'object' then", "  if false then")],
    "runs_status_unchecked": [("  summary jsonb not null default '{}'::jsonb,\n  constraint action_item_recheck_runs_status check (status in ('ok', 'partial', 'failed'))\n);", "  summary jsonb not null default '{}'::jsonb\n);")],
    "runs_no_rls": [("alter table public.action_item_recheck_runs enable row level security;\n", "")],
    "runs_no_policy": [("create policy \"Service role full access on action_item_recheck_runs\"\n  on public.action_item_recheck_runs for all\n  using (auth.role() = 'service_role'::text);\n", "")],
    # ----- the CHECKs, whole and one arm at a time -----
    "no_check_cursor_pair": [check_block("action_items_recheck_cursor_pair")],
    "no_check_scan_shape": [check_block("action_items_recheck_scan_shape")],
    "check_shape_no_upper_at_arm": [("    (recheck_scan_id is null) = (recheck_scan_upper_at is null)\n    and (recheck_scan_id is null) = (recheck_scan_upper_id is null)", "    (recheck_scan_id is null) = (recheck_scan_upper_id is null)")],
    "check_shape_no_upper_id_arm": [("    and (recheck_scan_id is null) = (recheck_scan_upper_id is null)\n", "")],
    "check_shape_no_embedding_arm": [("    and (recheck_scan_id is null) = (recheck_scan_embedding_ids is null)\n", "")],
    "check_shape_no_proposed_arm": [("    and (recheck_scan_id is not null or recheck_scan_proposed = false)\n", "")],
    # ----- grants and function properties -----
    "grant_commit_anon": [("APPEND", f"grant execute on function public.recheck_commit_page({COMMIT_SIG}) to anon;\n")],
    "grant_begin_authenticated": [("APPEND", "grant execute on function public.recheck_begin_scan(uuid, vector) to authenticated;\n")],
    "candidates_left_public": [("revoke execute on function public.recheck_candidates(uuid, timestamptz, uuid, timestamptz, uuid, uuid[], integer) from public, anon, authenticated;\n", "")],
    "service_role_not_granted": [("grant execute on function public.recheck_eligible_items(timestamptz, integer) to service_role;\n", "")],
    "commit_security_definer": [("language plpgsql\nvolatile\nset search_path = pg_catalog, public\nas $$\n#variable_conflict use_column\ndeclare\n  c_max", "language plpgsql\nvolatile\nsecurity definer\nset search_path = pg_catalog, public\nas $$\n#variable_conflict use_column\ndeclare\n  c_max")],
    "record_run_no_search_path": [("volatile\nset search_path = pg_catalog, public\nas $$\ndeclare\n  v_id uuid;", "volatile\nas $$\ndeclare\n  v_id uuid;")],
}


def is_cold(name):
    """Mutants of 20261119ca: eligibility (replaced there) and what that file adds."""
    return name.startswith(("elig_", "warm_", "note_")) or name == "error_column_defaults_now"


def apply(path_c, path_ca, name):
    if name not in M:
        return 3
    path = path_ca if is_cold(name) else path_c
    s = open(path).read()
    for old, new in M[name]:
        if old == "APPEND":
            s += new
            continue
        if old == "CHECK":
            import re
            pat = re.compile(r"alter table public\.action_items\n  add constraint %s check \(.*?\n  \);\n" % re.escape(new), re.S)
            if len(pat.findall(s)) != 1:
                return 1
            s = pat.sub("", s)
            continue
        if s.count(old) != 1 or old == new:
            return 1
        s = s.replace(old, new)
    open(path, "w").write(s)
    return 0


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--list":
        print(" ".join(M))
        sys.exit(0)
    if len(sys.argv) != 4:
        print(__doc__, file=sys.stderr)
        sys.exit(2)
    sys.exit(apply(sys.argv[1], sys.argv[2], sys.argv[3]))
