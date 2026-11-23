#!/bin/bash
# Loop-closing Task 6.1, Codex review 1 P2 (2026-11-20): regression for the
# candidate_axis_attribution query in scripts/loop-closing/metrics.sql. Runs the
# query text, extracted from metrics.sql by its anchor comment (never by line
# number), on a throwaway LOCAL PostgreSQL cluster (never production).
# Needs initdb/pg_ctl/psql (Homebrew postgresql@16 here).
#
#   bash scripts/loop-closing/candidate-axis-sql-test.sh                    # expect: CANDIDATE AXIS SQL TEST PASSED, exit 0
#   bash scripts/loop-closing/candidate-axis-sql-test.sh --mutate drop_l35  # expect: FAIL on l35 (L3.5 left out of the shown set)
#   bash scripts/loop-closing/candidate-axis-sql-test.sh --mutate add_l15   # expect: FAIL on l15 (L1.5 counted as shown to LAYER 2)
#   METRICS_SQL=/path/to/older/metrics.sql bash scripts/loop-closing/candidate-axis-sql-test.sh   # run another revision's text
#
# The finding: both capture files write a separate `L3.5 / vetoed / still_owed`
# row when a candidate LAYER 2 claimed passes LAYER 3 and is then vetoed, and
# write no L3 or resolved row for it. A shown set built from L2/L3/resolved alone
# drops such a candidate, including its operator-only and wrong-person counts.
#
# One fixture, three cases. A capture names the operator and Client A; its one
# candidate is an open item whose source thought names the operator and Client B,
# with no project and no topics on either side, so the candidate reaches LAYER 2
# only through the operator's name and names a different person (operator-only,
# wrong-person exposure). Each case writes exactly one decision row for that pair:
#   l35  L3.5 / vetoed / still_owed       expect 1 capture, 1 candidate, 1 operator-only, 0 without, 1 wrong-person
#   l3   L3 / dropped / coverage (control) expect the same row (the layer the committed query already counted)
#   l15  L1.5 / dropped / restatement      expect no row (L1.5 removes candidates BEFORE LAYER 2)
# The l3 control proves the fixture and the query can produce the expected row
# at all, so a zero on l35 is the layer list, not a broken fixture.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
METRICS_SQL="${METRICS_SQL:-$ROOT/scripts/loop-closing/metrics.sql}"
MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
PORT="${CANDIDATE_AXIS_PORT:-54362}"
WORK="$(mktemp -d /tmp/obcax.XXXXXX)"
trap 'pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1; rm -rf "$WORK"' EXIT

sed -n '/^-- candidate_axis_attribution/,/;$/p' "$METRICS_SQL" > "$WORK/metric.sql"
grep -q "^from routes group by 1 order by 1;$" "$WORK/metric.sql" || { echo "candidate_axis_attribution not extracted from $METRICS_SQL"; exit 2; }
case "$MUTATE" in
  "") ;;
  drop_l35)
    sed -i '' "s/'L2','L3','L3.5','resolved'/'L2','L3','resolved'/" "$WORK/metric.sql"
    grep -q "'L2','L3','resolved'" "$WORK/metric.sql" || { echo "mutant did not change the layer list"; exit 2; }
    echo "MUTATION drop_l35 applied: L3.5 removed from the shown set";;
  add_l15)
    sed -i '' "s/'L2','L3','L3.5','resolved'/'L1.5','L2','L3','L3.5','resolved'/" "$WORK/metric.sql"
    grep -q "'L1.5','L2'" "$WORK/metric.sql" || { echo "mutant did not change the layer list"; exit 2; }
    echo "MUTATION add_l15 applied: L1.5 added to the shown set";;
  *) echo "unknown mutation: $MUTATE"; exit 2;;
esac

initdb -D "$WORK/pg" -A trust -U postgres >"$WORK/initdb.log" 2>&1 || { echo "initdb failed"; cat "$WORK/initdb.log"; exit 2; }
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || { echo "pg start failed"; cat "$WORK/pg.log"; exit 2; }
PSQL=(psql -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q -X)

"${PSQL[@]}" -d postgres <<'SQL' >/dev/null || { echo "fixture setup failed"; exit 2; }
create table public.thoughts (id uuid primary key, metadata jsonb);
create table public.action_items (id uuid primary key, description text, source_thought_id uuid, status text, created_at timestamptz);
create table public.auto_resolve_decisions (thought_id uuid, item_id uuid, layer text, outcome text, reason text, created_at timestamptz);
insert into public.thoughts values
  ('00000000-0000-0000-0000-0000000000c1', '{"project": null, "topics": [], "people": ["Alex", "Client A"]}'),
  ('00000000-0000-0000-0000-0000000000b1', '{"project": null, "topics": [], "people": ["Alex", "Client B"]}');
insert into public.action_items values
  ('00000000-0000-0000-0000-0000000000a1', 'fixture candidate', '00000000-0000-0000-0000-0000000000b1', 'open', '2026-11-17 12:00:00+00');
SQL
FAIL=0
run_case() { # name layer outcome reason expected
  "${PSQL[@]}" -d postgres -c "truncate public.auto_resolve_decisions; insert into public.auto_resolve_decisions values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '$2', '$3', '$4', '2026-11-18 12:00:00+00')" >/dev/null || { echo "case $1: decision insert failed"; exit 2; }
  local got
  got=$("${PSQL[@]}" -d postgres -At -F' ' -f "$WORK/metric.sql" 2>&1) || { echo "case $1: metric query failed: $got"; exit 2; }
  [ -n "$got" ] || got="(no rows)"
  if [ "$got" = "$5" ]; then echo "PASS $1 ($2): $got"
  else echo "FAIL $1 ($2): expected [$5] got [$got]"; FAIL=1; fi
}
echo "metric text: $METRICS_SQL ($(grep -c '' "$WORK/metric.sql") lines, layer list: $(grep -o "d.layer in ([^)]*)" "$WORK/metric.sql"))"
EXPECT_ROW="2026-11-16 1 1 1 0 1"
run_case l35 L3.5 vetoed still_owed "$EXPECT_ROW"
run_case l3  L3   dropped coverage_below_threshold "$EXPECT_ROW"
run_case l15 L1.5 dropped restatement "(no rows)"
if [ "$FAIL" = 0 ]; then echo "CANDIDATE AXIS SQL TEST PASSED"; exit 0; fi
echo "CANDIDATE AXIS SQL TEST FAILED"
exit 1
