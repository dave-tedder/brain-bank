#!/bin/bash
# Loop-closing Task 1.4: run the auto_resolve_decisions SQL contract test on a
# throwaway LOCAL PostgreSQL cluster (never production). Needs initdb/pg_ctl/psql
# (Homebrew postgresql@16 here) and deno.
#
#   bash scripts/loop-closing/decisions-sql-test.sh            # expect: DECISIONS SQL TEST PASSED, exit 0
#   bash scripts/loop-closing/decisions-sql-test.sh --mutate legal       # expect: FAIL (a legal triple removed)
#   bash scripts/loop-closing/decisions-sql-test.sh --mutate review_seq  # expect: FAIL (the review_seq CHECK dropped)
#   bash scripts/loop-closing/decisions-sql-test.sh --mutate payload     # expect: FAIL (one id requirement removed)
#
# The cluster lives in a mktemp dir and is destroyed on exit. The migration is
# applied to a stub schema holding only what it references (thoughts,
# action_items, business_events by id; auth.role(); the three Supabase roles).
# macOS: the postmaster refuses to start without a valid locale ("postmaster became
# multithreaded during startup"); initdb/pg_ctl inherit this.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
MIGRATION="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
PORT=54329
WORK="$(mktemp -d /tmp/obdec.XXXXXX)"
trap 'pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1; rm -rf "$WORK"' EXIT

initdb -D "$WORK/pg" -A trust -U postgres >"$WORK/initdb.log" 2>&1 || { echo "initdb failed"; cat "$WORK/initdb.log"; exit 2; }
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || { echo "pg start failed"; cat "$WORK/pg.log"; exit 2; }
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)

"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null
"${PSQL[@]}" -d obtest <<'SQL' >/dev/null
create role service_role nologin; create role anon nologin; create role authenticated nologin;
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
create table public.thoughts (id uuid primary key);
create table public.action_items (id uuid primary key, description text not null, status text not null default 'open');
create table public.business_events (id uuid primary key);
SQL
"${PSQL[@]}" -d obtest -f "$MIGRATION" >/dev/null || { echo "migration failed to apply"; exit 2; }

case "$MUTATE" in
  "") ;;
  legal)
    # Remove one legal triple from the combination function: gate/dropped/work_report.
    grep -v "('gate', 'dropped', 'work_report')" "$MIGRATION" \
      | sed -n '/create or replace function public.auto_resolve_decision_legal/,/^\$\$;/p' > "$WORK/mutant.sql"
    grep -q "'work_report'" "$WORK/mutant.sql" && { echo "mutant did not remove the triple"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION legal applied: gate/dropped/work_report removed from auto_resolve_decision_legal";;
  review_seq)
    "${PSQL[@]}" -d obtest -c "alter table public.auto_resolve_decisions drop constraint auto_resolve_decision_review_seq" >/dev/null
    echo "MUTATION review_seq applied: CHECK dropped";;
  payload)
    # Remove the related_item_id requirement from the payload function (the
    # mapping row stays, so positives still land; the exact_batch negative
    # without a survivor must now land, which fails the test).
    sed -n '/create or replace function public.auto_resolve_decision_payload_ok/,/^\$\$;/p' "$MIGRATION" \
      | sed 's/and (p_related_item_id is not null) = m.related_item_id/and true/' > "$WORK/mutant.sql"
    grep -q "p_related_item_id is not null" "$WORK/mutant.sql" && { echo "mutant did not remove the requirement"; exit 2; }
    "${PSQL[@]}" -d obtest -f "$WORK/mutant.sql" >/dev/null || { echo "mutant failed to apply"; exit 2; }
    echo "MUTATION payload applied: related_item_id requirement removed from auto_resolve_decision_payload_ok";;
  *) echo "unknown mutation: $MUTATE"; exit 2;;
esac

deno run --allow-read "$ROOT/scripts/loop-closing/decisions-sql-test.ts" > "$WORK/test.sql" || { echo "test generation failed"; exit 2; }
if "${PSQL[@]}" -d obtest -f "$WORK/test.sql" 2>&1 | grep -E "NOTICE|PASSED|ERROR" | sed 's/^psql:.*ERROR/ERROR/'; then
  if grep -q "DECISIONS SQL TEST PASSED" <("${PSQL[@]}" -d obtest -f "$WORK/test.sql" 2>&1); then exit 0; fi
fi
echo "DECISIONS SQL TEST FAILED"
exit 1
