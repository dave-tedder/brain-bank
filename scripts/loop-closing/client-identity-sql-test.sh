#!/bin/bash
# Loop-closing Task 5.3: prove 20261121b_action_items_client_id.sql and the
# REAL client-identity and booking-match code on a throwaway LOCAL PostgreSQL
# cluster (never production).
#
#   bash scripts/loop-closing/client-identity-sql-test.sh                   # exit 0 passed
#   bash scripts/loop-closing/client-identity-sql-test.sh --mutate <name>   # exit 1 expected
#   bash scripts/loop-closing/client-identity-sql-test.sh --all-mutations   # every one must be CAUGHT
#   bash scripts/loop-closing/client-identity-sql-test.sh --inject-selftest # control cases
#   bash scripts/loop-closing/client-identity-sql-test.sh --list-mutations
#
# Three outcomes, for every run:
#   0  passed: the migration applied; MIG held; the SQL contract printed
#      CONTRACT COMPLETE and EXACTLY the check ids in EXPECTED_CONTRACT, each
#      once, each PASS; the bridge printed EXACTLY the ids in EXPECTED_BRIDGE
#      and CLIENT IDENTITY INTEGRATION PASSED.
#   1  a COMPLETED assertion failed: MIG's own comparison; the contract's
#      first error is the OUTER diagnostic "ERROR:  OBC01: FAIL <id>: ..." with
#      <id> one of EXPECTED_CONTRACT (raised only by pg_temp.ck); or the
#      bridge exited 1 with "FAIL integration: ...".
#   2  NEVER-RAN: anything else (setup, a prior migration, the migration under
#      test, any other SQLSTATE, a nested diagnostic that is not the outer one,
#      an interruption, a missing, extra or repeated check id, no CONTRACT
#      COMPLETE, a bridge that could not run or hit an SQL error).
#
# --all-mutations first runs the unmutated harness, which must pass (else the
# sweep is NEVER-RAN). Then each planted fault goes into a copy of the
# migration (never the file). CAUGHT needs exit 1 AND the first FAIL line to be
# the check named for that fault in MUTATION_CHECK; exit 0 is SURVIVED;
# anything else, including an exit 1 without that FAIL line, is NEVER-RAN.
#
# --inject-selftest runs each control case in inject_table in its own run. A
# control counts only when ALL hold: the run printed exactly one
# "OBCI_INJECT_REACHED <name>" line (from inside the planted code), its exit is
# the one the table names, and its first FAIL/NEVER-RAN line matches the
# table's pattern.
#
# Database lock: the caller (the evidence runner) takes /tmp/ob-db.lock; this
# script never touches it. The /tmp/obrp. prefix is the one deadline.py's
# reaper recognises.
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
M_MCP_LOG="$ROOT/supabase/migrations/0016_mcp_tool_invocations.sql"
M_DECISIONS="$ROOT/supabase/migrations/20261105_auto_resolve_decisions.sql"
M_CLOSE="$ROOT/supabase/migrations/20261106_action_items_close_reason.sql"
M_ARCHIVE="$ROOT/supabase/migrations/20261109a_action_items_archive_proposals.sql"
M_REVIEW="$ROOT/supabase/migrations/20261109b_review_proposal_rpc.sql"
M_DEDUP="$ROOT/supabase/migrations/20261120c_dedup_semantic_reads.sql"
M_UNDER_TEST="$ROOT/supabase/migrations/20261121b_action_items_client_id.sql"
TEST_SQL="$HERE/client-identity-sql-test.sql"
BRIDGE="$HERE/client-identity-integration.ts"
INJECT_ANCHOR="-- P01: the pending read lists the four supported proposals, oldest first,"

EXPECTED_CONTRACT="M01 M02 M03 M04 M05 B01 B02 T01 G01 S01 K01 D01a D01c D01b Y01a Y01b Y02 Y02b Y03 Y03b Y04a Y04b Y04c P01 Y05a Y05b Y06 Y07a Y07b Y08a Y08b Y09 Y10a Y10b G02 G03 G04 H01 G05 H02a H02b Y11a Y11b Y11c Y11d Y11e P02a P02b P02c P03 P04a R01a R01b R01c R02 R02b P05"
EXPECTED_BRIDGE="I1 I2 I3 I4 I5 I6 I7 I8"
NEW_FUNCTIONS="booking_event_snapshot booking_gcal_key booking_same booking_match_read calendar_pending_proposals calendar_proposal_supported calendar_support_guard calendar_support_holds client_roster sync_booking_proposals"

# The planted faults, each with the ONE check that must report it.
MUTATION_CHECK="mig_no_fk:M02 mig_cascade:M02 mig_no_action:M02 mig_not_null:M01 mig_default:M01 mig_no_index:M05 mig_index_all_rows:M05
support_no_cascade:T01 support_no_rls:T01 support_anon_select:G01 record_decisions_revoked:MIG
snapshot_no_status:K01 gcal_no_suffix_strip:K01 gcal_no_trim:K01 same_booking_by_date_only:K01 same_booking_ignores_key_mismatch:K01
supported_no_client_check:Y08a supported_no_snapshot_check:Y05a sync_no_withdraw:Y06 sync_no_same_booking_skip:Y03 sync_skip_ignores_support:Y09
guard_dropped:S01 guard_on_kept:R02 guard_update_only:S01 guard_reads_stored_row:G04 sync_no_stale_check:Y10a
holds_ignores_pair:H01 holds_ignores_text:H02a sync_no_read_order:Y11b sync_read_at_optional:Y11d roster_no_cap:B01 match_read_items_any_status:B02 match_read_no_client_key:B02 match_read_no_cap:B02
pend_no_generation:P02a pend_any_outcome:R02b pend_includes_deferred:P04a pend_unsupported_listed:Y05a pend_order_desc:P01
pend_limit_unclamped:P03 pend_limit_default:P03 pend_cap_lowered:P05 pend_cap_raised:P05 pend_total_row_number:P01
grant_anon:G01 grant_authenticated:G01 security_definer:S01 volatile_read:S01 no_search_path:S01 sync_table_no_rls:T01"
MUTATIONS="$(printf '%s\n' $MUTATION_CHECK | cut -d: -f1 | tr '\n' ' ')"

MODE="run"; MUTATE=""
case "${1:-}" in
  "") ;;
  --mutate) MUTATE="${2:-}"; [ -n "$MUTATE" ] || { echo "NEVER-RAN: --mutate needs a name"; exit 2; };;
  --all-mutations) MODE="all";;
  --inject-selftest) MODE="inject";;
  --list-mutations) echo $MUTATIONS; exit 0;;
  *) echo "NEVER-RAN: unknown argument $1"; exit 2;;
esac
INJECT="${OBCI_INJECT:-}"

# --- sweep mode --------------------------------------------------------------
if [ "$MODE" = "all" ]; then
  # OBCI_SWEEP_CHILD_FAIL=1 (a control case): every child "fails" with exit 1
  # and no diagnostic, as a setup error before initdb would.
  childfail="${OBCI_SWEEP_CHILD_FAIL:-}"
  [ "$childfail" = 1 ] && echo "OBCI_INJECT_REACHED sweep_child_setup_error"
  if [ "$childfail" != 1 ]; then
    ctl=$(bash "$0" 2>&1); ccode=$?
    if [ "$ccode" != 0 ]; then
      echo "NEVER-RAN: the unmutated control did not pass (exit $ccode): $(printf '%s\n' "$ctl" | grep -m1 -E '^(FAIL|NEVER-RAN)' | cut -c1-200)"
      exit 2
    fi
    echo "CONTROL   unmutated harness passed"
  fi
  caught=0; survived=0; never=0
  for pair in $MUTATION_CHECK; do
    m="${pair%%:*}"; want="${pair##*:}"
    if [ "$childfail" = 1 ]; then out="setup error before initdb"; code=1
    else out=$(bash "$0" --mutate "$m" 2>&1); code=$?; fi
    first=$(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)' || true)
    if [ "$code" = 1 ] && printf '%s\n' "$first" | grep -qE "^FAIL ${want}( |:)"; then
      caught=$((caught+1)); echo "CAUGHT    $m  ${first:0:160}"
    elif [ "$code" = 0 ]; then
      survived=$((survived+1)); echo "SURVIVED  $m"
    else
      never=$((never+1)); echo "NEVER-RAN $m  (exit $code; want FAIL $want) ${first:0:160}"
    fi
  done
  total=$((caught+survived+never))
  echo "MUTATIONS: $caught of $total caught, $survived survived, $never never ran"
  [ "$survived" -eq 0 ] && [ "$never" -eq 0 ] && exit 0
  [ "$never" -gt 0 ] && exit 2
  exit 1
fi

inject_table() {
  # name|expected exit|first FAIL/NEVER-RAN line pattern (extended regex)
  cat <<'T'
contract_undefined_table|2|^NEVER-RAN: the SQL contract stopped on SQLSTATE 42P01: relation "public.obci_missing_table" does not exist
contract_timeout|2|^NEVER-RAN: the SQL contract stopped on SQLSTATE 57014: canceling statement due to statement timeout
contract_truncated|2|^NEVER-RAN: the SQL contract ended without CONTRACT COMPLETE
contract_planted_fail|1|^FAIL P01: obci planted completed failure
contract_unknown_check_id|2|^NEVER-RAN: the SQL contract failed check INJ, which is not one of the expected checks
contract_nested_diagnostic|2|^NEVER-RAN: the SQL contract stopped on SQLSTATE 22023: obci nested ERROR:  OBC01: FAIL M01
contract_m03_other_error|2|^NEVER-RAN: the SQL contract stopped on SQLSTATE 42P01: relation "public.obci_m03_missing" does not exist
contract_spaces_path_fail|1|^FAIL M01: obci planted completed failure in a checkout path with spaces
contract_checks_skipped|2|^NEVER-RAN: the SQL contract printed 0 of the 57 expected checks
prior_review_missing|2|^NEVER-RAN: the SQL contract stopped on SQLSTATE 42883: function public.review_proposal
bridge_no_port|2|^NEVER-RAN: OBRP_PG_PORT is not set
bridge_bad_column|2|^NEVER-RAN: an SQL error no check expects, at a read-back \(SQLSTATE 42703: column "obci_injected_missing_column" does not exist
bridge_planted_fail|1|^FAIL integration: obci planted assertion
bridge_skip_check|2|^NEVER-RAN: the bridge printed checks I1 I2 I4 I5 I6 I7 I8, not I1 I2 I3 I4 I5 I6 I7 I8
sweep_child_setup_error|2|^NEVER-RAN all_mutations: exit 2, 0 caught, [0-9]+ never ran
T
}

if [ "$MODE" = "inject" ]; then
  ok=0; bad=0
  while IFS='|' read -r name want pattern; do
    [ -n "$name" ] || continue
    if [ "$name" = "contract_spaces_path_fail" ]; then
      # The harness copied into a checkout path with spaces, run there.
      sp="$(mktemp -d /tmp/obrp.XXXXXX)"
      mkdir -p "$sp/check out with spaces/repo/supabase" "$sp/check out with spaces/repo/scripts"
      cp -R "$ROOT/supabase/migrations" "$sp/check out with spaces/repo/supabase/" && cp -R "$HERE" "$sp/check out with spaces/repo/scripts/"
      out=$(OBCI_INJECT="$name" bash "$sp/check out with spaces/repo/scripts/loop-closing/client-identity-sql-test.sh" 2>&1); code=$?
      rm -rf "$sp"
    elif [ "$name" = "sweep_child_setup_error" ]; then
      sout=$(OBCI_SWEEP_CHILD_FAIL=1 bash "$0" --all-mutations 2>&1); code=$?
      out="$(printf '%s\n' "$sout" | grep '^OBCI_INJECT_REACHED')
NEVER-RAN all_mutations: exit $code, $(printf '%s\n' "$sout" | grep -c '^CAUGHT') caught, $(printf '%s\n' "$sout" | grep -c '^NEVER-RAN ') never ran"
    else
      out=$(OBCI_INJECT="$name" bash "$0" 2>&1); code=$?
    fi
    reached=$(printf '%s\n' "$out" | grep -cE '^OBCI_INJECT_REACHED ' || true)
    reached_name=$(printf '%s\n' "$out" | grep -oE 'OBCI_INJECT_REACHED [a-z0-9_]+' | sort -u | tr '\n' ' ')
    first=$(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)' || true)
    why=""
    [ "$reached" = 1 ] || why="reached-marker lines: $reached ($reached_name)"
    [ -z "$why" ] && [ "$reached_name" != "OBCI_INJECT_REACHED $name " ] && why="marker names $reached_name"
    [ -z "$why" ] && [ "$code" != "$want" ] && why="exit $code, want $want"
    [ -z "$why" ] && ! printf '%s\n' "$first" | grep -qE "$pattern" && why="first line: ${first:0:200}"
    if [ -z "$why" ]; then ok=$((ok+1)); echo "INJECT OK   $name  exit $code  ${first:0:140}"
    else bad=$((bad+1)); echo "INJECT BAD  $name  $why"; fi
  done < <(inject_table)
  echo "INJECT SELFTEST: $ok of $((ok+bad)) gave their expected exit and diagnostic"
  [ "$bad" -eq 0 ] && exit 0
  exit 2
fi

# --- one run -----------------------------------------------------------------
PORT=$((55000 + RANDOM % 900))
WORK="$(mktemp -d /tmp/obrp.XXXXXX)"
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
cleanup() {
  local rc=$?
  pg_ctl -D "$WORK/pg" stop -m fast -t 10 >/dev/null 2>&1 || pg_ctl -D "$WORK/pg" stop -m immediate >/dev/null 2>&1
  rm -rf "$WORK"
  if [ "$COMPLETED" != 1 ] && [ "$rc" = 0 ]; then
    echo "NEVER-RAN: the script stopped before its last check"
    rc=2
  fi
  exit "$rc"
}
trap cleanup EXIT
trap 'echo "NEVER-RAN: interrupted by a signal"; exit 2' TERM INT HUP

if [ -n "$INJECT" ] && ! inject_table | cut -d'|' -f1 | grep -qx "$INJECT"; then never "unknown injection $INJECT"; fi

if ! initdb -D "$WORK/pg" -A trust -U postgres --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log"; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check 'ipcs -m')"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log")"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)
"${PSQL[@]}" -d postgres -c "create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;" >/dev/null || never "roles failed"

# The migration under test, mutated or not, in a copy. The planted faults
# are literal replacements in scripts/loop-closing/client-identity-faults.py.
SRC="$WORK/migration.sql"; cp "$M_UNDER_TEST" "$SRC"
if [ -n "$MUTATE" ]; then
  python3 "$HERE/client-identity-faults.py" "$MUTATE" "$SRC" || never "planted fault $MUTATE could not be applied (unknown, or a site that does not match exactly once)"
fi

# The stub schema and the prior migrations, into one database.
setup_db() { # dbname
  local d="$1"
  "${PSQL[@]}" -d postgres -c "create database $d" >/dev/null || never "create database $d failed"
  "${PSQL[@]}" -d "$d" <<'SQL' >/dev/null || never "stub schema failed in $d"
create schema auth;
create function auth.role() returns text language sql stable as $$ select 'service_role'::text $$;
grant usage on schema auth to service_role, anon, authenticated;
create table public.thoughts (id uuid primary key, metadata jsonb);
create table public.clients (
  id uuid primary key default gen_random_uuid(), name text not null,
  metadata jsonb not null default '{}'::jsonb, last_contact timestamptz
);
create table public.business_events (
  id uuid primary key default gen_random_uuid(), title text not null, event_type text,
  date_start date, date_end date, location text, notes text, metadata jsonb,
  created_at timestamptz default now(), updated_at timestamptz default now()
);
create table public.agent_task_ledger (agent_code text primary key);
create table public.action_items (
  id uuid primary key default gen_random_uuid(),
  source_thought_id uuid references public.thoughts(id) on delete set null,
  description text not null,
  status text not null default 'open' check (status in ('open','resolved','archived','deferred')),
  resolved_by_thought_id uuid references public.thoughts(id) on delete set null,
  created_at timestamptz default now(),
  resolved_at timestamptz,
  resolution_note text,
  deferred_at timestamptz,
  defer_reason text
);
create table public.agent_tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null default 't',
  status text not null,
  completed_at timestamptz, claimed_at timestamptz, claimed_by text, claim_expires_at timestamptz,
  blocked_reason text, review_reason text, operator_action text, operator_target text,
  linked_action_item_id uuid references public.action_items(id),
  parent_task_id uuid, archived_at timestamptz, updated_at timestamptz not null default now()
);
create table public.agent_task_events (
  id uuid primary key default gen_random_uuid(), task_id uuid not null, event_type text not null,
  agent_code text, payload jsonb not null default '{}'::jsonb, created_at timestamptz not null default now()
);
grant select, insert, update, delete on all tables in schema public to service_role;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
SQL
  for f in "$M_MCP_LOG" "$M_DECISIONS" "$M_CLOSE" "$M_ARCHIVE" "$M_REVIEW" "$M_DEDUP"; do
    if [ "$INJECT" = "prior_review_missing" ] && [ "$f" = "$M_REVIEW" ] && [ "$d" = "obtest" ]; then
      echo "OBCI_INJECT_REACHED prior_review_missing"
      continue
    fi
    PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$d" -f "$f" >"$WORK/prior.out" 2>&1 \
      || never "prior migration failed in $d: $(basename "$f"): $(head -3 "$WORK/prior.out")"
  done
}
setup_db obtest
setup_db obbridge

# Every public function's body AND its grants, before and after: the
# migration may add exactly NEW_FUNCTIONS and change nothing else.
FN_SQL="select coalesce(string_agg(p.proname || ':' || md5(p.prosrc || coalesce(p.proacl::text, '')), ',' order by p.proname, md5(p.prosrc || coalesce(p.proacl::text, ''))), '') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'"
fn_before=$("${PSQL[@]}" -d obtest -At -c "$FN_SQL") || never "could not read the public functions before the migration"
case "$fn_before" in *record_decisions:*) ;; *) never "record_decisions is missing before the migration";; esac
for f in $NEW_FUNCTIONS; do
  case ",$fn_before" in *",$f:"*) never "$f exists before its migration";; esac
done

for d in obtest obbridge; do
  if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d "$d" -f "$SRC" >"$WORK/mig.out" 2>&1; then
    never "the migration failed to apply in $d: $(sed 's/^psql:[^E]*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
  fi
done
echo "migration applied"

fn_after=$("${PSQL[@]}" -d obtest -At -c "$FN_SQL") || never "could not read the public functions after the migration"
printf '^%s:\n' $NEW_FUNCTIONS > "$WORK/new.pat"
stripped=$(printf '%s\n' "$fn_after" | tr ',' '\n' | grep -v -f "$WORK/new.pat" | paste -sd, -)
added=$(printf '%s\n' "$fn_after" | tr ',' '\n' | grep -c -f "$WORK/new.pat")
nnew=$(printf '%s\n' $NEW_FUNCTIONS | wc -l | tr -d ' ')
if [ "$stripped" != "$fn_before" ] || [ "$added" != "$nnew" ]; then
  echo "FAIL MIG: the migration changed the body or grants of an existing function, or did not add exactly the $nnew new ones ($added added)"; exit 1
fi
echo "PASS MIG the migration adds exactly the $added new functions and changes no body or grant of the other $(printf '%s\n' "$fn_before" | tr ',' '\n' | wc -l | tr -d ' ')"

# --- the SQL contract --------------------------------------------------------
# The contract always runs from one fixed file under $WORK, so psql's own
# diagnostic prefix is known exactly whatever the checkout path (Codex
# re-review 1, finding 5: a checkout path with spaces).
CONTRACT="$WORK/contract.sql"
cp "$TEST_SQL" "$CONTRACT" || never "could not copy the contract"
if [ -n "$INJECT" ]; then
  case "$INJECT" in contract_*) python3 "$HERE/client-identity-controls.py" "$INJECT" "$TEST_SQL" "$CONTRACT" "$INJECT_ANCHOR" \
    || never "control case $INJECT could not be planted";; esac
  [ "$INJECT" = contract_truncated ] && echo "OBCI_INJECT_REACHED contract_truncated"
fi

"${PSQL[@]}" -At -d obtest -f "$CONTRACT" >"$WORK/contract.out" 2>&1; pcode=$?
grep -E 'NOTICE:  00000: (PASS |OBCI_INJECT_REACHED )' "$WORK/contract.out" | sed -E 's/^.*NOTICE:  00000: //'
# The OUTER diagnostic only: psql's own "psql:<file>:<line>: ERROR:  <SQLSTATE>: "
# line, matched from its start, never a diagnostic quoted inside a message.
prefix="psql:$CONTRACT:"
err=""
while IFS= read -r line; do
  case "$line" in
    "$prefix"*)
      rest="${line#"$prefix"}"
      if [[ "$rest" =~ ^[0-9]+:\ ERROR:\ \ [0-9A-Z]{5}:\  ]]; then err="$rest"; break; fi;;
  esac
done < "$WORK/contract.out"
if [ -z "$err" ] && grep -q 'ERROR:' "$WORK/contract.out"; then
  never "the SQL contract printed an error psql did not report as its own: $(grep -m1 'ERROR:' "$WORK/contract.out" | cut -c1-200)"
fi
if [ -n "$err" ]; then
  body="${err#*: ERROR:  }"
  state="${body%%: *}"
  msg="${body#*: }"
  if [ "$state" = "OBC01" ]; then
    id=$(printf '%s' "$msg" | sed -nE 's/^FAIL ([A-Za-z0-9]+): .*/\1/p')
    if [ -n "$id" ] && printf '%s\n' $EXPECTED_CONTRACT | grep -qx "$id"; then echo "$msg"; exit 1; fi
    never "the SQL contract failed check ${id:-<none>}, which is not one of the expected checks: ${msg:0:160}"
  fi
  never "the SQL contract stopped on SQLSTATE $state: ${msg:0:200}"
fi
[ "$pcode" = 0 ] || never "the SQL contract did not complete (psql exit $pcode): $(tail -1 "$WORK/contract.out" | cut -c1-160)"
grep -qx 'CONTRACT COMPLETE' "$WORK/contract.out" || never "the SQL contract ended without CONTRACT COMPLETE"
seen=$(grep -oE 'NOTICE:  00000: PASS [A-Za-z0-9]+ ' "$WORK/contract.out" | awk '{print $4}')
nseen=$(printf '%s\n' $seen | grep -c . || true)
nwant=$(printf '%s\n' $EXPECTED_CONTRACT | wc -l | tr -d ' ')
if [ "$(printf '%s\n' $seen | sort | tr '\n' ' ')" != "$(printf '%s\n' $EXPECTED_CONTRACT | sort | tr '\n' ' ')" ]; then
  never "the SQL contract printed $nseen of the $nwant expected checks (got: $(printf '%s ' $seen | cut -c1-200))"
fi
echo "CLIENT IDENTITY SQL CONTRACT PASSED ($nseen checks)"

# --- the integration bridge --------------------------------------------------
BENV=(OBRP_PG_PORT="$PORT" OBRP_PG_DB=obbridge)
case "$INJECT" in
  bridge_no_port) echo "OBCI_INJECT_REACHED bridge_no_port"; BENV=(OBRP_PG_DB=obbridge);;
  bridge_bad_column|bridge_planted_fail|bridge_skip_check) BENV+=(OBCI_BRIDGE_INJECT="$INJECT");;
esac
bout=$(env -u OBRP_PG_PORT "${BENV[@]}" deno run --no-lock --allow-env --allow-read --allow-run=psql "$BRIDGE" 2>&1); bcode=$?
printf '%s\n' "$bout"
case "$bcode" in
  0) printf '%s\n' "$bout" | grep -qx "CLIENT IDENTITY INTEGRATION PASSED" || never "the bridge exited 0 without its PASSED line"
     bseen=$(printf '%s\n' "$bout" | sed -nE 's/^PASS (I[0-9]+) .*/\1/p' | tr '\n' ' ' | sed 's/ $//')
     [ "$bseen" = "$EXPECTED_BRIDGE" ] || never "the bridge printed checks $bseen, not $EXPECTED_BRIDGE";;
  1) printf '%s\n' "$bout" | grep -q '^FAIL integration: ' || never "the bridge exited 1 without a FAIL line"; exit 1;;
  *) printf '%s\n' "$bout" | grep -q '^NEVER-RAN' || echo "NEVER-RAN: the bridge exited $bcode"; exit 2;;
esac

COMPLETED=1
echo "CLIENT IDENTITY TEST COMPLETE"
exit 0
