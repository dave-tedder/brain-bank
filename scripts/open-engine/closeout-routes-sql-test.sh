#!/bin/bash
# Loop-closing Task 5.4: prove supabase/migrations/20261120b_closeout_routes.sql
# on a throwaway LOCAL PostgreSQL cluster (never production), and bridge the
# real publisher (publish-route-snapshot.mjs) and the real complete-time
# evaluator (open-brain-mcp/_complete_contract.ts) through it.
#
#   bash scripts/open-engine/closeout-routes-sql-test.sh                  # exit 0 passed
#   bash scripts/open-engine/closeout-routes-sql-test.sh --mutate <name>  # exit 1 expected
#   bash scripts/open-engine/closeout-routes-sql-test.sh --all-mutations  # all must be CAUGHT
#   bash scripts/open-engine/closeout-routes-sql-test.sh --verdict-selftest  # no database
#   bash scripts/open-engine/closeout-routes-sql-test.sh --inject-selftest   # negative controls
#   bash scripts/open-engine/closeout-routes-sql-test.sh --inject-selftest-controls  # controls OF the self-test
#
# --inject-selftest runs every injection in inject_table (29) in its own run. An
# injection counts only when ALL hold: the run printed exactly one
# "OBRT_INJECT_REACHED <name>" line, printed only by the injected code as it
# executes (a NOTICE raised by the planted SQL, for cancel_in_attempt from
# INSIDE the SQL that pg_temp.attempt_as executes; a psql \echo just before the
# planted statement; for a launch injection, a psql -c '\echo' run by the very
# psql process whose launch was changed; or, for a shell-side injection, the
# shell once a query has confirmed the injected state); the exit is the one the
# table names; the first FAIL/NEVER-RAN line matches the table's diagnostic,
# which for most entries carries a token only the injected statement can
# produce; and, where the table names one, the error was raised at the
# required site: the run prints the SQL contract's first error CONTEXT as one
# "OBRT_ERROR_CONTEXT" line ("(none)" for a top-level statement) and it must
# match (Codex re-review 1 of PR 32, P2-2).
# No marker (an unknown name, a failed setup, an unrelated early exit, a site
# never reached) or a deadline is INCOMPLETE, exit 2; a reached injection with
# the wrong exit, diagnostic or site is FAILED, exit 1; only all-good is
# PASSED, exit 0.
# OBRT_INJECT_TABLE replaces the table (the self-test controls use it), and
# OBRT_SELFTEST_STOP_BEFORE_BRIDGE=1 makes a run stop NEVER-RAN after the SQL
# contract, before any bridge injection site; both exist only for those controls.
# The selftest_cancel_* injections exist only for those controls too; like every
# injection, a run with one set never completes, so it can never be a PASS.
#
# Three outcomes, never two, with the TF001 mechanism and verdict functions of
# scripts/loop-closing/action-item-review-sql-test.sh (sqlstate_kind,
# contract_verdict, classify and its 62 canned cases, copied with this
# contract's PASSED line; 121 more cover publish_verdict, b3_verdict and the
# identity line, 183 in all):
#   0  passed: every check ran to completion and held.
#   1  FAILED: a check RAN TO COMPLETION and its assertion did not hold. Only this
#      is a caught mutation. Every exit 1 prints a line starting "FAIL ".
#   2  NEVER-RAN: the cluster, the migration or a mutant did not apply; a helper
#      query did not execute; a statement was interrupted; the SQL contract
#      stopped on an error that is not one of its own assertions; a step stopped
#      before its last check. Nothing was judged, so nothing was caught.
#
# The bridge's publish step (B1) has its own classifier, publish_verdict, with
# the same three outcomes. psql's exit 3 there is NOT a failure by itself. Which
# statement raised is established two independent ways, and both must agree:
#   shape     the harness wrote publish.sql itself, so before judging it checks
#             the file ends with exactly the identity line, the role switch and
#             the publish call, one statement per line, each once; anything
#             else is NEVER-RAN.
#   identity  psql runs with -e (ECHO=queries): it prints every statement it
#             sends, just before sending it, and its error lines are written
#             after stdout is flushed, so the statement that raised is the one
#             psql printed on the line right above the ERROR line, and its
#             reported file line must be that statement's line. A statement
#             that printed a result did not raise, so a later error is never
#             its refusal (Codex re-review 1 of PR 32, P2-1).
# Only these are a judged B1 failure (exit 1):
#   42501 raised by the SET ROLE statement with "permission denied to set role"
#         (authenticator may not switch to the publisher);
#   42501 raised by the publish_closeout_routes call, sent right after a
#         successful role switch (the publisher may not execute it, reach its
#         schema, or was denied inside);
#   22023 raised there by the RPC's own validation (its CONTEXT names
#         publish_closeout_routes(jsonb) at RAISE): it refused the publisher's
#         own dry-run payload;
#   exit 0 where the publish call printed exactly one result and it is not 2.
# An interruption (INTERRUPTION_PREFIXES), any other SQLSTATE, a judged code
# raised by any other statement, an unreadable SQLSTATE, a statement psql did
# not report sending, or any other psql exit is NEVER-RAN (exit 2).
# Every judged B1 or B3 outcome (exit 0 or 1) also needs the server's own
# account of who sent the judged statements (ident_gap). The generated file's
# statement just above them is the identity line, ID_TXT: it selects a token
# fresh for each run, the login of this backend (pg_stat_activity.usename),
# session_user and current_user. The verdict requires, in the file, nothing but
# injection markers ("\echo OBRT_INJECT_REACHED <name>" alone on its line)
# above the identity line, the identity line once, and the judged statement on
# the next line; in psql's output, the identity line's echo once, its one
# result on the next line equal to ID_WANT (token|authenticator|authenticator|
# authenticator), the judged statement's echo on the line after that, and
# nothing but whole-line markers above. Missing, duplicated, misplaced or wrong
# identity is NEVER-RAN. Why nothing can come between the identity line and
# the judged statements: they are adjacent lines of the one file psql reads in
# order on its current connection; the file grammar admits no meta-command
# there (only exact markers stand above, only the fixed lines below); a -c
# given on the psql command line runs wholly before the file or wholly after
# it, never inside it. So a launch that connects as someone else (-U, a
# connection string, PGOPTIONS, a pre-file -c reconnect or SET SESSION
# AUTHORIZATION) is seen by the identity line itself (Codex re-review 3 of PR
# 32), as is a prelude in the file (re-review 2), which the file layer also
# names.
# B3 (no role switch) has b3_verdict: when the identity line establishes the
# authenticator login with nothing but markers above it, the publish call is
# the next statement, and it did not raise, B3 FAILS (the protection is broken)
# whatever happens after it; otherwise the file must be the generated
# shape and B3 passes only on 42501 "permission denied for function
# publish_closeout_routes" raised by that call; anything else is NEVER-RAN.
#
# What it proves, in order:
#   1. The migration applies on a stub that carries Supabase's default privileges
#      (every new public table and function granted to anon, authenticated and
#      service_role), so its revokes are exercised, not assumed.
#   2. The single-connection contract (closeout-routes-sql-test.sql, T01 to T12):
#      shape, RLS, every grant, the role's attributes, the publish path, server
#      stamping and refresh, direct access refused for every role, every
#      malformed payload refused with 22023 and no write, atomicity, the CHECK.
#   3. The bridge: the publisher's own --dry-run payload from a fixture registry
#      (paths under a directory with spaces) is published by a real login as
#      authenticator through SET ROLE (the PostgREST path); the table then holds
#      exactly those booleans and no path; authenticator without the role switch
#      is refused, each judged only under a server-reported authenticator
#      login; and the rows read back as service_role drive the real
#      evaluateCompletion to accept a clean receipt on a complete route and refuse
#      it on a route published with a false capability.
# --all-mutations runs each mutant under its own deadline (OBRT_MUTANT_DEADLINE,
# default 240 s) via scripts/loop-closing/deadline.py and classifies with the same
# rules as the reference harness. Run it alone; it starts one cluster at a time.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
HERE="$ROOT/scripts/open-engine"
DEADLINE_PY="$ROOT/scripts/loop-closing/deadline.py"
M_ROUTES="$ROOT/supabase/migrations/20261120b_closeout_routes.sql"
TEST_SQL="$HERE/closeout-routes-sql-test.sql"
PUBLISHER="$HERE/publish-route-snapshot.mjs"
CONTRACT_TS="$ROOT/supabase/functions/open-brain-mcp/_complete_contract.ts"

MUTATIONS="rls_off anon_keeps_default authenticated_keeps_default service_role_writes service_role_no_select publisher_table_grant rpc_public_execute rpc_anon_execute rpc_service_execute rpc_invoker search_path_unpinned extra_key_allowed slug_unchecked bool_unchecked duplicate_unchecked array_unchecked empty_allowed size_unbounded no_refresh_on_update do_nothing_on_conflict role_can_login role_bypassrls no_authenticator_grant slug_check_dropped"
MUTANT_DEADLINE="${OBRT_MUTANT_DEADLINE:-240}"

# SQLSTATE prefixes that mean the statement was interrupted or the server could
# not do the work: nothing was judged. 08 connection, 53 insufficient resources,
# 54 program limit, 57 operator intervention (57014 is statement_timeout and
# cancel), 58 system error, XX internal error, 55P03 lock_timeout. The SQL
# contract and the integration bridge are handed this same list.
INTERRUPTION_PREFIXES="08 53 54 57 58 XX 55P03"
# The SQL contract's assertion failures: pg_temp.ok raises this, nothing else does.
ASSERT_STATE=TF001

# sqlstate_kind <state>: assertion | interruption | behavioral | unparseable.
sqlstate_kind() {
  local p
  case "$1" in
    [0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z][0-9A-Z]) ;;
    *) echo unparseable; return;;
  esac
  [ "$1" = "$ASSERT_STATE" ] && { echo assertion; return; }
  for p in $INTERRUPTION_PREFIXES; do
    case "$1" in "$p"*) echo interruption; return;; esac
  done
  echo behavioral
}

# contract_verdict <psql exit> <output file>: judge one run of the SQL contract
# (psql -f, ON_ERROR_STOP, VERBOSITY=verbose, so every error line carries its
# SQLSTATE). Sets VERDICT; returns 0 passed, 1 a completed assertion failed,
# 2 NEVER-RAN. psql's exit 3 says only that a statement raised.
contract_verdict() {
  local code="$1" file="$2" first state msg
  first=$(grep -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$file")
  case "$code" in
    0)
      if [ -n "$first" ]; then VERDICT="psql exited 0 but its output carries an error"; return 2; fi
      if grep -Eq '^psql:.*:[0-9]+: NOTICE:  00000: CLOSEOUT ROUTES SQL TEST PASSED$' "$file"; then VERDICT="passed"; return 0; fi
      VERDICT="the SQL contract exited 0 without its PASSED line"; return 2;;
    3)
      state=$(printf '%s\n' "$first" | sed -nE 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): .*$/\1/p')
      msg=$(printf '%s\n' "$first" | sed -E 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}: )?//' | cut -c1-240)
      case "$(sqlstate_kind "$state")" in
        assertion)
          case "$msg" in
            "FAIL "*) VERDICT="$msg"; return 1;;
          esac
          VERDICT="SQLSTATE $ASSERT_STATE without a FAIL message, so no named check failed: $msg"; return 2;;
        interruption) VERDICT="the SQL contract was interrupted (SQLSTATE $state: $msg); the statement did not complete, so no check was judged"; return 2;;
        behavioral) VERDICT="the SQL contract stopped on an SQL error that is not one of its assertions (SQLSTATE $state: $msg); no check judged it, so it is not a failure and not a catch"; return 2;;
        *) VERDICT="the SQL contract stopped (psql exit 3) on an error with no readable SQLSTATE: $(printf '%s' "${first:-$(tail -1 "$file")}" | cut -c1-200)"; return 2;;
      esac;;
    *) VERDICT="the SQL contract did not complete (psql exit $code): $(tail -1 "$file" | cut -c1-160)"; return 2;;
  esac
}

# psql_first_error <output file>: sets E_LINE, E_STATE, E_MSG from the first
# "psql:<file>:<line>: ERROR:  <SQLSTATE>: <message>" line (VERBOSITY=verbose);
# E_FOUND is 1 when there is an ERROR line at all.
psql_first_error() {
  local first
  first=$(grep -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$1")
  E_FOUND=0; [ -n "$first" ] && E_FOUND=1
  E_LINE=$(printf '%s\n' "$first" | sed -nE 's/^psql:.*:([0-9]+): ERROR:  .*$/\1/p')
  E_STATE=$(printf '%s\n' "$first" | sed -nE 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): .*$/\1/p')
  E_MSG=$(printf '%s\n' "$first" | sed -E 's/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}: )?//' | cut -c1-240)
}

# The two statements the bridge judges, exactly as the harness writes them.
# The generators below spell them out separately on purpose, so a change to a
# generator is caught here rather than copied into the check.
ROLE_TXT="set role closeout_route_publisher;"
PUB_TXT="select public.publish_closeout_routes(:'routes'::jsonb);"
# pub_echo <routes json>: the exact line psql -e prints when it sends PUB_TXT
# (psql quotes the :'routes' value as a literal, doubling single quotes).
pub_echo() { printf "select public.publish_closeout_routes('%s'::jsonb);" "${1//\'/\'\'}"; }
# The identity line: the statement the generated file runs right before the
# judged statement(s), on the same connection. Its one result row is the
# server's account of who sends them: a token fresh for each run (so no other
# line can pass for the result), the backend's login (pg_stat_activity.usename
# keeps the role that logged in, whatever SET SESSION AUTHORIZATION does),
# session_user and current_user (SQL keywords, not functions a search_path
# could shadow). ID_WANT is what psql -At prints for a real authenticator login.
id_txt() { printf "select 'OBRT_IDENTITY %s', (select usename from pg_stat_activity where pid = pg_backend_pid()), session_user, current_user;" "$1"; }
id_want() { printf 'OBRT_IDENTITY %s|authenticator|authenticator|authenticator' "$1"; }
ID_TOKEN=$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')
[ -n "$ID_TOKEN" ] || ID_TOKEN="r$RANDOM$$"
ID_TXT=$(id_txt "$ID_TOKEN")
ID_WANT=$(id_want "$ID_TOKEN")

# sql_tail_shape <sql> <line>...: 0 when the file's last lines are exactly the
# given lines, in order, and each of them occurs exactly once in the file.
sql_tail_shape() {
  local f="$1" n i want; shift
  n=$(wc -l < "$f" | tr -d ' '); i=$((n - $# + 1))
  [ "$i" -ge 1 ] || return 1
  for want in "$@"; do
    [ "$(sed -n "${i}p" "$f")" = "$want" ] || return 1
    [ "$(grep -c -x -F -- "$want" "$f")" = 1 ] || return 1
    i=$((i + 1))
  done
  return 0
}
# echo_line <psql output> <text>: the number of the one output line equal to
# the text; 0 if none; "many" if more than one.
echo_line() {
  local c; c=$(grep -c -x -F -- "$2" "$1")
  case "$c" in 0) echo 0;; 1) grep -n -x -F -m1 -- "$2" "$1" | cut -d: -f1;; *) echo many;; esac
}
# first_error_line <psql output>: the number of the first ERROR line, or empty.
first_error_line() { grep -n -m1 -E '^psql:.*:[0-9]+: ERROR:  ' "$1" | cut -d: -f1; }
# error_block <psql output> <error line>: the lines psql printed with that error
# (DETAIL, HINT, CONTEXT, LOCATION), up to its LOCATION line.
error_block() { awk -v s="$2" 'NR > s { if ($0 ~ /^psql:/) exit; print; if ($0 ~ /^LOCATION:  /) exit }' "$1"; }
# sent_before <psql output> <error line>: what psql printed on the line right
# above the error, i.e. the statement it sent that raised (cut for messages).
sent_before() { [ "$2" -gt 1 ] && sed -n "$(($2 - 1))p" "$1" | cut -c1-160; }
# ident_gap <sql> <psql output> <judged echo line> <judged statement text>:
# nothing when the identity line establishes that a real authenticator login
# sent the judged statement; otherwise says what is missing or wrong. The
# judged statement is the role switch for B1 and the publish call for B3.
ident_gap() {
  local sql="$1" out="$2" s="$3" next="$4" l k c res f
  f=$(basename "$sql")
  # File: only markers above the identity line, the identity line once, and
  # the judged statement on the line right after it.
  l=$(awk -v id="$ID_TXT" '$0 == id { exit } !/^\\echo OBRT_INJECT_REACHED [a-z0-9_]+$/ { printf "%s%s", (n++ ? " / " : ""), ($0 == "" ? "(an empty line)" : $0) }' "$sql")
  [ -n "$l" ] && { printf '%s has `%s` above the identity line' "$f" "$(printf '%s' "$l" | cut -c1-200)"; return; }
  c=$(grep -c -x -F -- "$ID_TXT" "$sql")
  [ "$c" = 1 ] || { printf '%s holds the identity line %s time(s), not once' "$f" "$c"; return; }
  k=$(grep -n -x -F -m1 -- "$ID_TXT" "$sql" | cut -d: -f1)
  case "$(sed -n "$((k + 1))p" "$sql")" in
    "$next"*) ;;
    *) printf '%s does not hold the judged statement on the line right after the identity line' "$f"; return;;
  esac
  # Output: the identity echo once, two lines above the judged echo; exactly
  # one identity result, on the line between them, and the expected one; only
  # whole-line markers above the identity echo.
  c=$(grep -c -x -F -- "$ID_TXT" "$out")
  [ "$c" = 1 ] || { printf 'psql reported sending the identity line %s time(s), not once' "$c"; return; }
  { [ "$s" -ge 3 ] 2>/dev/null && [ "$(sed -n "$((s - 2))p" "$out")" = "$ID_TXT" ]; } \
    || { printf 'psql did not report the identity line and its result right above the judged statement'; return; }
  c=$(grep -c '^OBRT_IDENTITY ' "$out")
  [ "$c" = 1 ] || { printf 'psql printed %s identity results, not one' "$c"; return; }
  res=$(sed -n "$((s - 1))p" "$out")
  [ "$res" = "$ID_WANT" ] || { printf 'the identity line reported `%s` (token|login|session_user|current_user), not the authenticator login `%s`' "$(printf '%s' "$res" | cut -c1-160)" "$ID_WANT"; return; }
  l=$(awk -v s="$((s - 2))" 'NR >= s { exit } !/^OBRT_INJECT_REACHED [a-z0-9_]+$/ { printf "%s%s", (n++ ? " / " : ""), ($0 == "" ? "(an empty line)" : $0) }' "$out")
  [ -n "$l" ] && printf 'psql printed `%s` above the identity line' "$(printf '%s' "$l" | cut -c1-200)"
}

# publish_verdict <psql exit> <output file> <publish.sql> <pub echo>: judge the
# bridge's B1 step (authenticator -> SET ROLE closeout_route_publisher ->
# publish), run with psql -e. Sets VERDICT; returns 0 published and told 2,
# 1 a judged B1 failure (see the header for the exact list), 2 NEVER-RAN.
publish_verdict() {
  local code="$1" file="$2" sql="$3" pecho="$4" n r p e stmt where res nres why
  if ! sql_tail_shape "$sql" "$ID_TXT" "$ROLE_TXT" "$PUB_TXT"; then
    VERDICT="B1 publish.sql is not the shape the harness generates (it must end with the identity line, the role switch and then the publish call, one statement per line, each once), so no statement in it can be judged"; return 2
  fi
  n=$(wc -l < "$sql" | tr -d ' ')
  r=$(echo_line "$file" "$ROLE_TXT"); p=$(echo_line "$file" "$pecho")
  if [ "$r" = many ] || [ "$p" = many ]; then VERDICT="B1 psql reported sending the role switch or the publish call more than once"; return 2; fi
  e=$(first_error_line "$file")
  psql_first_error "$file"
  case "$code" in
    0)
      [ -z "$e" ] || { VERDICT="B1 psql exited 0 but its output carries an error"; return 2; }
      if [ "$r" = 0 ] || [ "$p" != $((r + 1)) ]; then VERDICT="B1 psql did not report sending the role switch and then the publish call, so no result can be attributed to the call"; return 2; fi
      why=$(ident_gap "$sql" "$file" "$r" "$ROLE_TXT")
      [ -z "$why" ] || { VERDICT="B1 $why, so the session that sent the switch and the call is not established as the authenticator login; nothing was judged"; return 2; }
      nres=$(( $(wc -l < "$file" | tr -d ' ') - p ))
      [ "$nres" = 1 ] || { VERDICT="B1 the publish call printed $nres result lines, not one, so its result cannot be read"; return 2; }
      res=$(sed -n "$((p + 1))p" "$file")
      [ "$res" = "2" ] && { VERDICT="published, told 2"; return 0; }
      VERDICT="B1 authenticator -> closeout_route_publisher published, but was told '$(printf '%s' "$res" | cut -c1-160)', not 2"; return 1;;
    3)
      [ -n "$e" ] || { VERDICT="B1 psql exited 3 with no ERROR line: $(tail -1 "$file" | cut -c1-200)"; return 2; }
      stmt=other
      if [ "$r" != 0 ] && [ "$e" = $((r + 1)) ] && [ "$E_LINE" = $((n - 1)) ]; then stmt=role
      elif [ "$r" != 0 ] && [ "$p" = $((r + 1)) ] && [ "$e" = $((p + 1)) ] && [ "$E_LINE" = "$n" ]; then stmt=publish
      fi
      case "$stmt" in
        role) where="the SET ROLE";;
        publish) where="the publish call";;
        *) where="\`$(sent_before "$file" "$e")\`"
           [ "$where" = '``' ] && where="a statement psql did not report"
           [ "$p" != 0 ] && [ "$p" -lt "$e" ] && where="$where, after the publish call had returned";;
      esac
      if [ "$stmt" != other ]; then
        why=$(ident_gap "$sql" "$file" "$r" "$ROLE_TXT")
        [ -z "$why" ] || { VERDICT="B1 $why, so the session in which $where raised (SQLSTATE ${E_STATE:-none}) is not established as the authenticator login; nothing was judged"; return 2; }
      fi
      case "$(sqlstate_kind "$E_STATE")" in
        interruption) VERDICT="B1 the publish step was interrupted at $where (SQLSTATE $E_STATE: $E_MSG); the statement did not complete, so nothing was judged"; return 2;;
        behavioral)
          if [ "$stmt" = role ] && [ "$E_STATE" = 42501 ]; then
            case "$E_MSG" in "permission denied to set role "*)
              VERDICT="B1 a real authenticator login was refused the role switch to closeout_route_publisher (SQLSTATE 42501: $E_MSG)"; return 1;;
            esac
          fi
          if [ "$stmt" = publish ] && [ "$E_STATE" = 42501 ]; then
            VERDICT="B1 authenticator, switched to closeout_route_publisher, was refused the publish call (SQLSTATE 42501: $E_MSG)"; return 1
          fi
          if [ "$stmt" = publish ] && [ "$E_STATE" = 22023 ] \
             && error_block "$file" "$e" | grep -Eq '^CONTEXT:  PL/pgSQL function (public\.)?publish_closeout_routes\(jsonb\) line [0-9]+ at RAISE$'; then
            VERDICT="B1 publish_closeout_routes refused the publisher's own dry-run payload (SQLSTATE 22023: $E_MSG)"; return 1
          fi
          VERDICT="B1 the publish step stopped on an SQL error that is not a judged denial (SQLSTATE $E_STATE from $where: $E_MSG); no check judged it, so it is not a failure and not a catch"; return 2;;
        *) VERDICT="B1 the publish step stopped (psql exit 3) on an error with no readable or expected SQLSTATE (${E_STATE:-none} from $where): $(printf '%s' "$E_MSG" | cut -c1-200)"; return 2;;
      esac;;
    *) VERDICT="B1 the authenticator publish did not run (psql exit $code): $(tail -1 "$file" | cut -c1-200)"; return 2;;
  esac
}

# b3_verdict <psql exit> <output file> <publish-norole.sql> <pub echo>: judge B3,
# authenticator calling the RPC with NO role switch, run with psql -e. Sets
# VERDICT; returns 0 refused as required, 1 it published (B3 FAILS), 2 NEVER-RAN.
b3_verdict() {
  local code="$1" file="$2" sql="$3" pecho="$4" n p e nxt where why
  p=$(echo_line "$file" "$pecho")
  [ "$p" = many ] && { VERDICT="B3 psql reported sending the publish call more than once"; return 2; }
  why=""; [ "$p" != 0 ] && why=$(ident_gap "$sql" "$file" "$p" "$PUB_TXT")
  # Published: the identity line, the session's first statement (nothing but
  # injection markers above it in the output AND in the file, so nothing, not
  # even a statement hidden by toggling ECHO, could have switched the role),
  # reported the authenticator login, the call was the very next statement,
  # and it did not raise. A later error does not undo that.
  if [ "$p" != 0 ] && [ -z "$why" ]; then
    nxt=$(sed -n "$((p + 1))p" "$file")
    if { [ -z "$nxt" ] && [ "$(wc -l < "$file" | tr -d ' ')" = "$p" ] && [ "$code" = 0 ]; } \
       || { [ "$(wc -l < "$file" | tr -d ' ')" -gt "$p" ] && case "$nxt" in psql:*) false;; *) true;; esac; }; then
      VERDICT="B3 authenticator without SET ROLE could publish: the call, sent right after the identity line reported the authenticator login, returned '$(printf '%s' "$nxt" | cut -c1-80)'"; return 1
    fi
  fi
  if ! sql_tail_shape "$sql" "$ID_TXT" "$PUB_TXT"; then
    VERDICT="B3 publish-norole.sql is not the shape the harness generates (it must end with the identity line and then the publish call alone on its line, each once), so no statement in it can be judged"; return 2
  fi
  [ -n "$why" ] && { VERDICT="B3 $why, so the publish call is not established as sent by the authenticator login without a role switch; nothing was judged"; return 2; }
  n=$(wc -l < "$sql" | tr -d ' ')
  e=$(first_error_line "$file")
  psql_first_error "$file"
  case "$code" in
    3)
      [ -n "$e" ] || { VERDICT="B3 psql exited 3 with no ERROR line"; return 2; }
      if [ "$p" != 0 ] && [ "$e" = $((p + 1)) ] && [ "$E_LINE" = "$n" ] \
         && [ "$E_STATE" = 42501 ] && [ "$E_MSG" = "permission denied for function publish_closeout_routes" ]; then
        VERDICT="refused (SQLSTATE 42501: $E_MSG)"; return 0
      fi
      where="\`$(sent_before "$file" "$e")\`"; [ "$where" = '``' ] && where="a statement psql did not report"
      [ "$p" != 0 ] && [ "$e" = $((p + 1)) ] && where="the publish call"
      VERDICT="B3 authenticator without the role switch stopped on something other than the permission error of its publish call (SQLSTATE ${E_STATE:-none} from $where): $(printf '%s' "$E_MSG" | cut -c1-200)"; return 2;;
    0) VERDICT="B3 psql exited 0 but did not report the publish call right after the identity line, so its result cannot be attributed"; return 2;;
    *) VERDICT="B3 the authenticator no-role call did not run (psql exit $code): $(tail -1 "$file" | cut -c1-200)"; return 2;;
  esac
}

# classify <mutation> <exit code> <output>: prints one line; returns 0 CAUGHT,
# 1 SURVIVED, 2 NEVER-RAN. An exit 1 is a catch only when the run printed a
# completed "FAIL " line and nothing in it says the run was cut short: no
# NEVER-RAN line, and no SQL error line other than a contract assertion.
classify() {
  local m="$1" code="$2" out="$3" line bad
  case "$code" in
    1)
      bad=$(printf '%s\n' "$out" | grep -m1 '^NEVER-RAN')
      if [ -n "$bad" ]; then echo "NEVER-RAN $m: exit 1, but the run says it did not complete: $(printf '%s' "$bad" | cut -c1-160)"; return 2; fi
      bad=$(printf '%s\n' "$out" | grep -E '^ERROR' | grep -m1 -v "^ERROR $ASSERT_STATE: FAIL ")
      if [ -n "$bad" ]; then echo "NEVER-RAN $m: exit 1, but the output carries an SQL error that is not a completed assertion: $(printf '%s' "$bad" | cut -c1-160)"; return 2; fi
      line=$(printf '%s\n' "$out" | grep -m1 '^FAIL ' | cut -c1-240)
      if [ -n "$line" ]; then echo "CAUGHT    $m: $line"; return 0; fi
      echo "NEVER-RAN $m: exit 1 with no completed FAIL line: $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
    0) echo "SURVIVED  $m"; return 1;;
    124) echo "NEVER-RAN $m: deadline of ${MUTANT_DEADLINE}s exceeded, the run did not complete"; return 2;;
    *) echo "NEVER-RAN $m (exit $code): $(printf '%s\n' "$out" | tail -1 | cut -c1-140)"; return 2;;
  esac
}

# Canned transcripts with the verdict each must get; no database. Run by
# --verdict-selftest and, silently, before any run trusts a verdict. Fields:
# want | contract or classify | exit code | output (\n separates lines).
verdict_selftest() {
  local d n=0 bad=0 got want kind code body P="psql:/x/t.sql:9:" U
  d=$(mktemp -d /tmp/obrt-verdict.XXXXXX)
  # Every generated-shape canned file carries the identity line ID_TXT right
  # above its judged statement, as the harness writes it.
  # publish: line 1 an injection marker (the only prelude a judged verdict
  # allows), line 2 the identity line, line 3 the switch, line 4 the call; a
  # statement planted above the identity line appears in a body as its echo.
  # publishC / publishA: Codex re-review 2's preludes, a \connect to postgres,
  # and that plus SET SESSION AUTHORIZATION anon; publishX: a \connect chained
  # after a marker's \echo on the same line (psql runs both); publishE: an
  # empty line, which is not a marker either.
  # publishS: Codex re-review 1's same-line shape (a second statement after the
  # call on its line). b3 / b3S: the no-role file, generated / same-line;
  # b3P: a prelude that hides a role switch from psql's echo.
  # publishN / b3N: the shapes before the identity line existed (no identity
  # line); publishM: a marker between the identity line and the switch; b3G:
  # a role switch hidden from psql's echo BETWEEN the identity line and the call.
  # In a body, @R is the line psql -e prints for the switch, @U the line it
  # prints for the call with routes [{"slug":"x"}], @Sn a psql error prefix at
  # line n, @I the identity line's echo, @J its expected result (the
  # authenticator login), @K the result's token field alone (for wrong results).
  printf '%s\n' '\echo OBRT_INJECT_REACHED planted' "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publish.sql"
  printf '%s\n' '\connect obtest postgres' "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publishC.sql"
  printf '%s\n' '\connect obtest postgres' "set session authorization anon;" "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publishA.sql"
  printf '%s\n' '\echo OBRT_INJECT_REACHED x \connect obtest postgres' "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publishX.sql"
  printf '%s\n' '' "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publishE.sql"
  printf '%s\n' "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb); select pg_read_file('/reviewer-forbidden');" > "$d/publishS.sql"
  printf '%s\n' '\echo OBRT_INJECT_REACHED planted' "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publishN.sql"
  printf '%s\n' "$ID_TXT" '\echo OBRT_INJECT_REACHED x' "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/publishM.sql"
  printf '%s\n' "$ID_TXT" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/b3.sql"
  printf '%s\n' "$ID_TXT" "select public.publish_closeout_routes(:'routes'::jsonb); select pg_read_file('/reviewer-forbidden');" > "$d/b3S.sql"
  printf '%s\n' '\set ECHO none' "set role closeout_route_publisher;" '\set ECHO queries' "$ID_TXT" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/b3P.sql"
  printf '%s\n' "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/b3N.sql"
  printf '%s\n' "$ID_TXT" '\set ECHO none' "set role closeout_route_publisher;" '\set ECHO queries' "select public.publish_closeout_routes(:'routes'::jsonb);" > "$d/b3G.sql"
  U=$(pub_echo '[{"slug":"x"}]')
  while IFS='|' read -r want kind code body; do
    [ -z "$want" ] && continue
    n=$((n + 1))
    body=$(printf '%s' "$body" | sed "s#@P#$P#g; s#@S\([0-9]\)#psql:/x/publish.sql:\1:#g; s#@R#$ROLE_TXT#g; s#@U#$U#g; s#@I#$ID_TXT#g; s#@J#$ID_WANT#g; s#@K#OBRT_IDENTITY $ID_TOKEN#g")
    printf '%b\n' "$body" > "$d/out"
    VERDICT=""
    case "$kind" in
      contract) contract_verdict "$code" "$d/out"; got=$?;;
      publish|publishS|publishC|publishA|publishX|publishE|publishN|publishM) publish_verdict "$code" "$d/out" "$d/$kind.sql" "$U"; got=$?;;
      b3|b3S|b3P|b3N|b3G) b3_verdict "$code" "$d/out" "$d/$kind.sql" "$U"; got=$?;;
      idtxt) VERDICT=$(id_txt "$code"); [ "$VERDICT" = "$body" ]; got=$?;;
      idwant) VERDICT=$(id_want "$code"); [ "$VERDICT" = "$body" ]; got=$?;;
      classify) VERDICT=$(classify m "$code" "$(cat "$d/out")"); got=$?;;
      kind) VERDICT=$(sqlstate_kind "$code"); [ "$VERDICT" = "$body" ]; got=$?;;
    esac
    if [ "$got" != "$want" ]; then
      bad=$((bad + 1)); echo "FAIL verdict case $n ($kind, exit $code): got $got, expected $want: $VERDICT"
    fi
  done <<'CASES'
0|contract|0|@P NOTICE:  00000: PASS T01 x\nLOCATION:  exec_stmt_raise, pl_exec.c:3911\n@P NOTICE:  00000: CLOSEOUT ROUTES SQL TEST PASSED\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|contract|0|@P NOTICE:  00000: PASS T01 x
2|contract|0|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T02 y: z\n@P NOTICE:  00000: CLOSEOUT ROUTES SQL TEST PASSED
1|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  TF001: FAIL T08 a keep on a deferred item is refused: recorded|kept c1080001\nCONTEXT:  PL/pgSQL function pg_temp_3.ok(text,boolean,text) line 4 at RAISE
2|contract|3|@P ERROR:  57014: canceling statement due to statement timeout\nLOCATION:  ProcessInterrupts, postgres.c:3382
2|contract|3|@P NOTICE:  00000: PASS T01 x\n@P ERROR:  57014: canceling statement due to user request
2|contract|3|@P ERROR:  57P01: terminating connection due to administrator command
2|contract|3|@P ERROR:  08006: connection failure
2|contract|3|@P ERROR:  53200: out of memory
2|contract|3|@P ERROR:  53100: could not extend file: No space left on device
2|contract|3|@P ERROR:  54001: stack depth limit exceeded
2|contract|3|@P ERROR:  58030: could not read block 0
2|contract|3|@P ERROR:  XX000: unexpected internal state
2|contract|3|@P ERROR:  55P03: canceling statement due to lock timeout
2|contract|3|@P ERROR:  23503: insert or update on table "action_items" violates foreign key constraint "action_items_triage_replacement_id_fkey"
2|contract|3|@P ERROR:  22012: division by zero
2|contract|3|@P ERROR:  P0001: FAIL T02 looks like a check but is not the contract's SQLSTATE
2|contract|3|@P ERROR:  TF001: T02 the contract's SQLSTATE without the FAIL marker
2|contract|3|@P ERROR:  canceling statement due to statement timeout
2|contract|3|@P ERROR:  FAIL T02 a FAIL message with no SQLSTATE at all
2|contract|3|@P NOTICE:  00000: PASS T01 x
2|contract|3|
2|contract|2|psql: error: connection to server at "127.0.0.1", port 1 failed
2|contract|1|psql: fatal
2|contract|124|@P ERROR:  TF001: FAIL T02 y: z
0|classify|1|migration applied over 3 existing rows\nPASS T01 x\nERROR TF001: FAIL T08 a keep on a deferred item is refused: recorded\nFAIL CLOSEOUT ROUTES SQL TEST: FAIL T08 a keep on a deferred item is refused: recorded
0|classify|1|PASS C1 x\nFAIL C2: the review behind the archive was not refused (recorded|kept c0910001)
0|classify|1|PASS I helper list\nFAIL integration: MCP review: a keep is recorded
2|classify|1|ERROR 57014: canceling statement due to statement timeout\nFAIL CLOSEOUT ROUTES SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR: canceling statement due to statement timeout\nFAIL CLOSEOUT ROUTES SQL TEST: canceling statement due to statement timeout
2|classify|1|ERROR 23503: insert or update on table "action_items" violates foreign key constraint\nFAIL CLOSEOUT ROUTES SQL TEST: insert or update on table
2|classify|1|ERROR TF001: not a fail message\nFAIL CLOSEOUT ROUTES SQL TEST: x
2|classify|1|ERROR: FAIL T38 the old display shape, with no SQLSTATE
2|classify|1|FAIL C1: the first review did not record\nNEVER-RAN: a helper query did not execute
2|classify|1|NEVER-RAN: the script stopped before its last check
2|classify|1|something died
2|classify|1|
2|classify|1|PASS T01 x\n  FAIL indented is not a verdict line
1|classify|0|CLOSEOUT ROUTES TEST COMPLETE (mutation x)
2|classify|124|FAIL C2: printed before the deadline killed the run
2|classify|2|NEVER-RAN: initdb failed
2|classify|3|FAIL x
2|classify|137|FAIL x
0|kind|TF001|assertion
0|kind|57014|interruption
0|kind|57P01|interruption
0|kind|08006|interruption
0|kind|53200|interruption
0|kind|54001|interruption
0|kind|58030|interruption
0|kind|XX000|interruption
0|kind|55P03|interruption
0|kind|55000|behavioral
0|kind|23503|behavioral
0|kind|23514|behavioral
0|kind|22023|behavioral
0|kind|40P01|behavioral
0|kind|P0001|behavioral
0|kind||unparseable
0|kind|5701|unparseable
0|kind|57014x|unparseable
0|kind|tf001|unparseable
0|publish|0|@I\n@J\n@R\n@U\n2
1|publish|0|@I\n@J\n@R\n@U\n5
1|publish|0|@I\n@J\n@R\n@U\n
2|publish|0|
2|publish|0|@I\n@J\n@R\n@U\n2\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
1|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes\nLOCATION:  aclcheck_error, aclchk.c:2814
1|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for schema public
1|publish|3|@I\n@J\n@R\n@S3 ERROR:  42501: permission denied to set role "closeout_route_publisher"
1|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  22023: each route must carry exactly slug, has_workspace, has_tracker, has_session_log, has_capture_tag (got x)\nCONTEXT:  PL/pgSQL function publish_closeout_routes(jsonb) line 27 at RAISE\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  22023: each route must carry exactly slug (no CONTEXT, so not the RPC's validation)\nLOCATION:  exec_stmt_raise, pl_exec.c:3911
2|publish|3|select reviewer_no_such_function();\n@S1 ERROR:  42883: function reviewer_no_such_function() does not exist\nLINE 1: select reviewer_no_such_function();
2|publish|3|select 'reviewer-not-an-integer'::integer;\n@S1 ERROR:  22P02: invalid input syntax for type integer: "reviewer-not-an-integer"
2|publish|3|select pg_sleep(0.05);\n@S1 ERROR:  57014: canceling statement due to statement timeout
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  57014: canceling statement due to statement timeout
2|publish|3|@I\n@J\n@R\n@S3 ERROR:  57P01: terminating connection due to administrator command
2|publish|3|select 'planted';\n@S1 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publish|3|select 'planted';\n@S1 ERROR:  42501: permission denied for function pg_read_file
2|publish|3|@I\n@J\n@R\n@S3 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|@I\n@J\n@R\n@S3 ERROR:  22023: each route must carry exactly slug
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  23505: duplicate key value violates unique constraint "closeout_routes_pkey"
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  TF001: FAIL B1 not this harness's assertion
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  permission denied for function publish_closeout_routes
2|publish|3|@I\n@J\n@R\n@U\npsql:/x/publish.sql: ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|
2|publish|2|psql: error: connection to server at "127.0.0.1", port 1 failed
2|publish|1|psql: fatal
2|publish|3|@I\n@J\n@R\n@U\n2\nselect pg_read_file('/reviewer-forbidden');\n@S4 ERROR:  42501: permission denied for function pg_read_file
2|publish|3|@I\n@J\n@R\n@U\n2\nselect pg_read_file('/reviewer-forbidden');\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|@I\n@J\n@R\n@U\n2\nselect pg_read_file('/reviewer-forbidden');\n@S4 ERROR:  22023: each route must carry exactly slug\nCONTEXT:  PL/pgSQL function publish_closeout_routes(jsonb) line 27 at RAISE
2|publish|3|@I\n@J\n@R\nselect pg_read_file('/reviewer-forbidden');\n@S4 ERROR:  42501: permission denied for function pg_read_file
2|publish|3|@I\n@J\n@R\n@U\n@S1 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|@I\n@J\n@R\n@U\n2\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|@I\n@J\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|@I\n@J\n@R\n@U\n@S4 NOTICE:  00000: a notice between the call and the error\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|0|@I\n@J\n@R\n@U\n2\n2
2|publish|0|@I\n@J\n@U\n2
2|publishS|3|@I\n@J\n@R\n@U\n2\nselect pg_read_file('/reviewer-forbidden');\n@S3 ERROR:  42501: permission denied for function pg_read_file
2|publishS|0|@I\n@J\n@R\n@U\n2
2|publishS|3|@I\n@J\n@R\n@U\n@S3 ERROR:  42501: permission denied for function publish_closeout_routes
0|b3|3|@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes\nLOCATION:  aclcheck_error, aclchk.c:2814
0|b3|3|OBRT_INJECT_REACHED x\n@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
1|b3|0|@I\n@J\n@U\n2
1|b3|0|OBRT_INJECT_REACHED x\n@I\n@J\n@U\n2
1|b3|0|@I\n@J\n@U
1|b3|3|@I\n@J\n@U\n2\nselect pg_read_file('/reviewer-forbidden');\n@S2 ERROR:  42501: permission denied for function pg_read_file
1|b3|3|@I\n@J\n@U\n2\n@S2 ERROR:  57014: canceling statement due to statement timeout
2|b3|3|@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for function pg_read_file
2|b3|3|@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for schema public
2|b3|3|select reviewer_no_such_function();\n@S2 ERROR:  42883: function reviewer_no_such_function() does not exist
2|b3|3|select pg_read_file('/reviewer-forbidden');\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|3|@I\n@J\n@U\n@S2 ERROR:  57014: canceling statement due to statement timeout
2|b3|3|@I\n@J\n@U\n@S3 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|3|@I\n@J\n@U\n@S2 NOTICE:  00000: a notice between the call and the error\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|0|set role closeout_route_publisher;\n@I\n@J\n@U\n2
2|b3|0|
2|b3|2|psql: error: connection to server at "127.0.0.1", port 1 failed
1|b3S|3|@I\n@J\n@U\n2\nselect pg_read_file('/reviewer-forbidden');\n@S2 ERROR:  42501: permission denied for function pg_read_file
2|b3S|3|@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3P|0|@I\n@J\n@U\n2
2|b3P|3|@I\n@J\n@U\n@S5 ERROR:  42501: permission denied for function publish_closeout_routes
2|publishC|0|@I\n@J\n@R\n@U\n2
2|publishC|0|@I\n@J\n@R\n@U\n5
2|publishC|3|@I\n@J\n@R\n@S3 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publishC|3|@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publishC|3|@I\n@J\n@R\n@U\n@S4 ERROR:  22023: each route must carry exactly slug\nCONTEXT:  PL/pgSQL function publish_closeout_routes(jsonb) line 27 at RAISE
2|publishA|3|set session authorization anon;\n@I\n@J\n@R\n@S4 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publishA|0|set session authorization anon;\n@I\n@J\n@R\n@U\n2
2|publishX|0|OBRT_INJECT_REACHED x\n@I\n@J\n@R\n@U\n2
2|publishX|3|OBRT_INJECT_REACHED x\n@I\n@J\n@R\n@S3 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publish|0|set session authorization anon;\n@I\n@J\n@R\n@U\n2
2|publish|3|set session authorization anon;\n@I\n@J\n@R\n@S3 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publish|3|select 1;\n1\n@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
0|publish|0|OBRT_INJECT_REACHED planted\n@I\n@J\n@R\n@U\n2
1|publish|3|OBRT_INJECT_REACHED planted\n@I\n@J\n@R\n@S3 ERROR:  42501: permission denied to set role "closeout_route_publisher"
1|publish|3|OBRT_INJECT_REACHED planted\n@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for schema public
1|publish|0|OBRT_INJECT_REACHED planted\n@I\n@J\n@R\n@U\n5
2|publishE|0|@I\n@J\n@R\n@U\n2
2|b3|0|OBRT_INJECT_REACHED x y\n@I\n@J\n@U\n2
2|b3|0|OBRT_INJECT_REACHED X\n@I\n@J\n@U\n2
2|b3|0|OBRT_INJECT_REACHED \n@I\n@J\n@U\n2
2|publish|0|@I\n@K|postgres|postgres|postgres\n@R\n@U\n2
2|publish|0|@I\n@K|postgres|authenticator|authenticator\n@R\n@U\n2
2|publish|0|@I\n@K|authenticator|anon|authenticator\n@R\n@U\n2
2|publish|0|@I\n@K|authenticator|authenticator|anon\n@R\n@U\n2
2|publish|0|@I\nOBRT_IDENTITY 0|authenticator|authenticator|authenticator\n@R\n@U\n2
2|publish|0|@I\n@J|x\n@R\n@U\n2
2|publish|0|@I\n@R\n@U\n2
2|publish|0|@J\n@R\n@U\n2
2|publish|0|@I\n@J\n@I\n@J\n@R\n@U\n2
2|publish|0|@J\n@I\n@J\n@R\n@U\n2
2|publish|0|@I\n@J\nOBRT_INJECT_REACHED planted\n@R\n@U\n2
2|publish|0|@I\n@K|postgres|postgres|postgres\n@R\n@U\n5
2|publish|3|@I\n@K|postgres|postgres|postgres\n@R\n@S3 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publish|3|@I\n@K|authenticator|authenticator|anon\n@R\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|3|@I\n@K|postgres|postgres|postgres\n@R\n@U\n@S4 ERROR:  22023: each route must carry exactly slug\nCONTEXT:  PL/pgSQL function publish_closeout_routes(jsonb) line 27 at RAISE
2|publish|3|@I\n@J\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for schema public
0|publish|0|@I\n@J\n@R\n@U\n2
1|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for function publish_closeout_routes
2|publishN|0|OBRT_INJECT_REACHED planted\n@R\n@U\n2
2|publishN|3|OBRT_INJECT_REACHED planted\n@R\n@S2 ERROR:  42501: permission denied to set role "closeout_route_publisher"
2|publishM|0|@I\n@J\nOBRT_INJECT_REACHED x\n@R\n@U\n2
2|b3|0|@I\n@K|postgres|postgres|postgres\n@U\n2
2|b3|0|@I\n@K|postgres|authenticator|authenticator\n@U\n2
2|b3|3|@I\n@K|authenticator|authenticator|anon\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|3|@I\n@K|postgres|postgres|postgres\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|0|@I\n@U\n2
2|b3|0|@J\n@U\n2
2|b3|3|@I\n@J\n@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|3|@J\n@I\n@J\n@U\n@S2 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3|0|@I\nOBRT_IDENTITY 0|authenticator|authenticator|authenticator\n@U\n2
2|b3N|0|@U\n2
2|b3N|3|@U\n@S1 ERROR:  42501: permission denied for function publish_closeout_routes
2|b3G|0|@I\n@J\n@U\n2
2|b3G|3|@I\n@J\n@U\n@S5 ERROR:  42501: permission denied for function publish_closeout_routes
2|publish|0|@I\nOBRT_INJECT_REACHED planted\n@J\n@R\n@U\n2
2|b3|0|@I\n@J\n@U\n2\n@K|postgres|postgres|postgres
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for schema public\n@K|postgres|postgres|postgres
2|b3|0|@I\n@J\n@U\n2\n@I
2|publish|3|@I\n@J\n@R\n@U\n@S4 ERROR:  42501: permission denied for schema public\n@I
0|idtxt|tok|select 'OBRT_IDENTITY tok', (select usename from pg_stat_activity where pid = pg_backend_pid()), session_user, current_user;
0|idwant|tok|OBRT_IDENTITY tok|authenticator|authenticator|authenticator
CASES
  rm -rf "$d"
  [ "$n" = 183 ] || { echo "VERDICT SELFTEST FAILED: ran $n cases, expected 183 (a case was lost)"; return 1; }
  if [ "$bad" -gt 0 ]; then echo "VERDICT SELFTEST FAILED ($bad of $n)"; return 1; fi
  echo "VERDICT SELFTEST PASSED ($n cases)"; return 0
}

if [ "${1:-}" = "--verdict-selftest" ]; then
  verdict_selftest; exit $?
fi
# No verdict below is trusted unless the classifiers pass their own cases.
vst=$(verdict_selftest) || { echo "NEVER-RAN: the verdict classifiers failed their own self-test, so no verdict can be trusted: $(printf '%s\n' "$vst" | grep -m1 '^FAIL')"; exit 2; }

if [ "${1:-}" = "--verdict-selftest" ]; then
  verdict_selftest; exit $?
fi
# No verdict below is trusted unless the classifiers pass their own cases.
vst=$(verdict_selftest) || { echo "NEVER-RAN: the verdict classifiers failed their own self-test, so no verdict can be trusted: $(printf '%s\n' "$vst" | grep -m1 '^FAIL')"; exit 2; }

if [ "${1:-}" = "--all-mutations" ]; then
  caught=0; survived=0; never=0; n=0
  shm_before=$(ipcs -m 2>/dev/null | grep -c '^m')
  for m in ${OBRT_MUTATIONS:-$MUTATIONS}; do
    n=$((n + 1))
    state="$(mktemp /tmp/obrt-state.XXXXXX)"
    out=$(OBRP_STATE_FILE="$state" python3 "$DEADLINE_PY" "$MUTANT_DEADLINE" bash "$0" --mutate "$m" 2>&1); code=$?
    rm -f "$state"
    classify "$m" "$code" "$out"
    case $? in 0) caught=$((caught + 1));; 1) survived=$((survived + 1));; *) never=$((never + 1));; esac
  done
  shm_after=$(ipcs -m 2>/dev/null | grep -c '^m')
  [ "$shm_after" -gt "$shm_before" ] && echo "WARNING: SysV shared memory segments grew from $shm_before to $shm_after during the sweep"
  echo "SWEEP: $n mutations, $caught caught, $survived survived, $never never ran"
  if [ "$never" -gt 0 ]; then echo "SWEEP INCOMPLETE: $never mutant(s) never ran; they are not catches"; exit 2; fi
  if [ "$survived" -gt 0 ]; then exit 1; fi
  echo "ALL $n MUTATIONS CAUGHT"
  exit 0
fi

# Negative controls for the verdicts themselves. Fields: name | exit | ERE the
# first FAIL/NEVER-RAN line must match | where the error must have been raised:
# "-" not checked (the diagnostic itself carries the injection's own token, or
# the bridge judge names the statement), "none" a top-level statement (the
# run's OBRT_ERROR_CONTEXT line is "(none)"), otherwise an ERE that line must
# match, e.g. the PL/pgSQL frames of the helper the error passed through.
inject_table() {
  cat <<'T'
sql_timeout|2|^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\)|none
cancel_in_attempt|2|^NEVER-RAN: the SQL contract was interrupted \(SQLSTATE 57014: canceling statement due to statement timeout\)|^OBRT_ERROR_CONTEXT SQL statement "SELECT pg_sleep\(p_secs\)" \| PL/pgSQL function pg_temp(_[0-9]+)?\.obrt_reach_then_sleep\(text,double precision\) line [0-9]+ at PERFORM \| SQL statement "select pg_temp\.obrt_reach_then_sleep\('cancel_in_attempt', 2\)" \| PL/pgSQL function pg_temp(_[0-9]+)?\.attempt_as\(text,text\) line [0-9]+ at EXECUTE \| SQL statement "select \*[ ]+from pg_temp\.attempt_as\(p_role, p_sql\)" \| PL/pgSQL function pg_temp(_[0-9]+)?\.raises\(text,text,text,text,text\) line [0-9]+ at SQL statement$
raw_error|2|^NEVER-RAN: the SQL contract stopped on an SQL error that is not one of its assertions \(SQLSTATE 22P02: invalid input syntax for type integer: "obrt_raw_error"|none
assert_fail|1|^FAIL CLOSEOUT ROUTES SQL TEST: FAIL INJECTED a completed check that does not hold: one is not two$|^OBRT_ERROR_CONTEXT PL/pgSQL function pg_temp(_[0-9]+)?\.ok\(text,boolean,text\) line [0-9]+ at RAISE$
helper_stray|2|^NEVER-RAN: every check held, but a helper query did not execute during the run \(psql exit 1: ERROR:  22P02: invalid input syntax for type integer: "obrt_helper_stray"|-
bridge_publisher_broken|2|^NEVER-RAN: the publisher's dry run did not complete \(exit 1\): Error: Cannot find module '.*/obrt-bridge-publisher-broken\.mjs'|-
bridge_missing_function|2|^NEVER-RAN: B1 the publish step stopped on an SQL error that is not a judged denial \(SQLSTATE 42883 from `select reviewer_no_such_function\(\);`: function reviewer_no_such_function\(\) does not exist\)|-
bridge_invalid_cast|2|^NEVER-RAN: B1 the publish step stopped on an SQL error that is not a judged denial \(SQLSTATE 22P02 from `select 'reviewer-not-an-integer'::integer;`: invalid input syntax for type integer: "reviewer-not-an-integer"\)|-
bridge_cancel|2|^NEVER-RAN: B1 the publish step was interrupted at `select pg_sleep\(0\.05\) as obrt_bridge_cancel;` \(SQLSTATE 57014: canceling statement due to statement timeout\)|-
bridge_revoke_execute|1|^FAIL B1 authenticator, switched to closeout_route_publisher, was refused the publish call \(SQLSTATE 42501: permission denied for function publish_closeout_routes\)$|-
bridge_revoke_membership|1|^FAIL B1 a real authenticator login was refused the role switch to closeout_route_publisher \(SQLSTATE 42501: permission denied to set role "closeout_route_publisher"\)$|-
b3_planted_error|2|^NEVER-RAN: B3 authenticator without the role switch stopped on something other than the permission error of its publish call \(SQLSTATE 42883 from `select reviewer_no_such_function\(\);`\): function reviewer_no_such_function\(\) does not exist$|-
bridge_payload_extra_key|1|^FAIL B1 publish_closeout_routes refused the publisher's own dry-run payload \(SQLSTATE 22023: each route must carry exactly slug, has_workspace, has_tracker, has_session_log, has_capture_tag \(got \{extra,|-
bridge_revoke_schema_usage|1|^FAIL B1 authenticator, switched to closeout_route_publisher, was refused the publish call \(SQLSTATE 42501: permission denied for schema public\)$|-
bridge_same_line_denial|2|^NEVER-RAN: B1 publish\.sql is not the shape the harness generates|-
b3_same_line_success|1|^FAIL B3 authenticator without SET ROLE could publish: the call, sent right after the identity line reported the authenticator login, returned '2'$|-
b3_same_line_refused|2|^NEVER-RAN: B3 publish-norole\.sql is not the shape the harness generates|-
bridge_prelude_reconnect_admin|2|^NEVER-RAN: B1 publish\.sql has `\\connect obtest postgres` above the identity line, so the session that sent the switch and the call is not established|-
bridge_prelude_session_anon|2|^NEVER-RAN: B1 publish\.sql has `\\connect obtest postgres / set session authorization anon;` above the identity line, so the session in which the SET ROLE raised \(SQLSTATE 42501\) is not established|-
bridge_prelude_reconnect_anon|2|^NEVER-RAN: B1 psql exited 3 with no ERROR line: psql:.*/publish\.sql:[0-9]+: error: \\connect: connection to server at .* failed: FATAL:  role "anon" is not permitted to log in$|-
bridge_prelude_chained_reconnect|2|^NEVER-RAN: B1 publish\.sql has `\\echo OBRT_INJECT_REACHED bridge_prelude_chained_reconnect \\connect obtest postgres` above the identity line|-
launch_b1_login_postgres|2|^NEVER-RAN: B1 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.postgres.postgres` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b1_conninfo_postgres|2|^NEVER-RAN: B1 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.postgres.postgres` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b1_prefile_reconnect|2|^NEVER-RAN: B1 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.postgres.postgres` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b3_login_postgres|2|^NEVER-RAN: B3 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.postgres.postgres` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b3_conninfo_postgres|2|^NEVER-RAN: B3 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.postgres.postgres` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b3_prefile_reconnect|2|^NEVER-RAN: B3 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.postgres.postgres` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b1_prefile_session_auth|2|^NEVER-RAN: B1 the identity line reported `OBRT_IDENTITY [0-9a-z]+.postgres.authenticator.authenticator` \(token.login.session_user.current_user\), not the authenticator login|-
launch_b1_pgoptions_role|2|^NEVER-RAN: B1 the identity line reported `OBRT_IDENTITY [0-9a-z]+.authenticator.authenticator.anon` \(token.login.session_user.current_user\), not the authenticator login|-
T
}
if [ "${1:-}" = "--inject-selftest" ]; then
  bad=0; inc=0; n=0
  # Set but empty is an empty table (INCOMPLETE), never a silent fall back to the default.
  table="${OBRT_INJECT_TABLE-$(inject_table)}"
  while IFS='|' read -r inj want re where; do
    [ -z "$inj" ] && continue
    n=$((n + 1))
    if [ -z "$where" ]; then inc=$((inc + 1)); echo "INJECT INCOMPLETE $inj: the table entry names no error site (use - to skip that check)"; continue; fi
    state="$(mktemp /tmp/obrt-state.XXXXXX)"
    out=$(OBRT_INJECT="$inj" OBRP_STATE_FILE="$state" python3 "$DEADLINE_PY" "$MUTANT_DEADLINE" bash "$0" </dev/null 2>&1); code=$?
    rm -f "$state"
    decisive=$(printf '%s\n' "$out" | grep -m1 -E '^(FAIL|NEVER-RAN)' | cut -c1-300)
    reached=$(printf '%s\n' "$out" | grep -cx "OBRT_INJECT_REACHED $inj")
    other=$(printf '%s\n' "$out" | grep '^OBRT_INJECT_REACHED ' | grep -m1 -vx "OBRT_INJECT_REACHED $inj")
    ctxs=$(printf '%s\n' "$out" | grep -c '^OBRT_ERROR_CONTEXT ')
    ctx=$(printf '%s\n' "$out" | grep -m1 '^OBRT_ERROR_CONTEXT ')
    site_ok=1
    case "$where" in
      -) ;;
      none) [ "$ctxs" = 1 ] && [ "$ctx" = "OBRT_ERROR_CONTEXT (none)" ] || site_ok=0;;
      *) [ "$ctxs" = 1 ] && printf '%s\n' "$ctx" | grep -Eq -- "$where" || site_ok=0;;
    esac
    if [ "$code" = 124 ]; then
      inc=$((inc + 1)); echo "INJECT INCOMPLETE $inj: the run hit its ${MUTANT_DEADLINE}s deadline"
    elif [ "$reached" != 1 ] || [ -n "$other" ]; then
      inc=$((inc + 1)); echo "INJECT INCOMPLETE $inj: the injection did not reach its site (OBRT_INJECT_REACHED $inj seen $reached time(s)${other:+, and $other}); exit $code: ${decisive:-$(printf '%s\n' "$out" | tail -1 | cut -c1-160)}"
    elif [ "$code" != "$want" ]; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site, but exit $code, expected $want: ${decisive:-$(printf '%s\n' "$out" | tail -1 | cut -c1-160)}"
    elif ! printf '%s\n' "$decisive" | grep -Eq -- "$re"; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site and exit $code, but not its diagnostic: ${decisive:-none} (expected /$re/)"
    elif [ "$site_ok" != 1 ]; then
      bad=$((bad + 1)); echo "INJECT BAD  $inj: reached its site, exit $code and its diagnostic, but the error was not raised where it must be: $(printf '%s' "${ctx:-no OBRT_ERROR_CONTEXT line}" | cut -c1-400) ($ctxs line(s); expected $where)"
    else
      echo "INJECT ok   $inj: reached, exit $code, $decisive${ctx:+; $(printf '%s' "$ctx" | cut -c1-600)}"
    fi
  done <<< "$table"
  if [ "$bad" -gt 0 ]; then echo "INJECT SELFTEST FAILED ($bad of $n wrong, $inc incomplete)"; exit 1; fi
  if [ "$n" = 0 ]; then echo "INJECT SELFTEST INCOMPLETE (the table held no injections, so nothing was controlled)"; exit 2; fi
  if [ "$inc" -gt 0 ]; then echo "INJECT SELFTEST INCOMPLETE ($inc of $n did not reach their site or finish; they are not controls)"; exit 2; fi
  if [ -z "${OBRT_INJECT_TABLE+set}" ] && [ "$n" != 29 ]; then echo "INJECT SELFTEST INCOMPLETE (ran $n injections, expected 29: an entry was lost)"; exit 2; fi
  echo "INJECT SELFTEST PASSED ($n of $n)"; exit 0
fi

# Controls OF the self-test: each runs --inject-selftest on a one-entry table and
# must end with the named exit and summary line. A, B and C are the shapes the
# exit-only self-test accepted (Codex review 1 of PR 32, P2-2); D is the positive
# control that proves B and C fail for the reason they name. E, F and G are the
# shapes Codex re-review 1 showed passing as cancel_in_attempt (P2-2): the
# helper call replaced by a bare sleep, the same with the reach marker kept at
# top level, and a timeout inserted before the unchanged helper call; each is
# run under cancel_in_attempt's own diagnostic and site. H is the positive
# control that proves E, F and G fail for the reason they name; I proves the
# "none" (top-level) site check can fail: the real in-helper cancel under it.
if [ "${1:-}" = "--inject-selftest-controls" ]; then
  bad=0; n=0
  real_cancel=$(inject_table | grep '^bridge_cancel|')
  real_attempt=$(inject_table | grep '^cancel_in_attempt|')
  attempt_checks=${real_attempt#cancel_in_attempt|}
  ctl() { # label, want exit, required ERE, env assignments...
    local label="$1" want="$2" need="$3" out code; shift 3
    n=$((n + 1))
    out=$(env "$@" bash "$0" --inject-selftest </dev/null 2>&1); code=$?
    if [ "$code" = "$want" ] && printf '%s\n' "$out" | grep -Eq -- "$need"; then
      echo "CONTROL ok   $label: exit $code; $(printf '%s\n' "$out" | grep -E '^INJECT (ok|BAD|INCOMPLETE)' | head -1 | cut -c1-260)"
    else
      bad=$((bad + 1)); echo "CONTROL BAD  $label: exit $code, expected $want and /$need/: $(printf '%s\n' "$out" | tail -2 | tr '\n' ' ' | cut -c1-300)"
    fi
  }
  ctl "A unknown injection name" 2 '^INJECT INCOMPLETE no_such_injection: the injection did not reach its site' \
    OBRT_INJECT_TABLE='no_such_injection|2|^NEVER-RAN|-'
  ctl "B injection site never reached (run stops before the bridge)" 2 '^INJECT INCOMPLETE bridge_cancel: the injection did not reach its site' \
    OBRT_INJECT_TABLE='bridge_cancel|2|^NEVER-RAN|-' OBRT_SELFTEST_STOP_BEFORE_BRIDGE=1
  ctl "C reached with the right exit but the wrong diagnostic" 1 '^INJECT BAD  bridge_cancel: reached its site and exit 2, but not its diagnostic' \
    OBRT_INJECT_TABLE='bridge_cancel|2|^NEVER-RAN: a diagnostic this run never prints$|-'
  ctl "D the real bridge_cancel entry alone" 0 '^INJECT SELFTEST PASSED \(1 of 1\)$' \
    OBRT_INJECT_TABLE="$real_cancel"
  ctl "E cancel_in_attempt's helper call replaced by a bare sleep" 2 '^INJECT INCOMPLETE selftest_cancel_bare_sleep: the injection did not reach its site' \
    OBRT_INJECT_TABLE="selftest_cancel_bare_sleep|$attempt_checks"
  ctl "F the bare sleep with the reach marker kept at top level" 1 '^INJECT BAD  selftest_cancel_forged_marker: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be: OBRT_ERROR_CONTEXT \(none\)' \
    OBRT_INJECT_TABLE="selftest_cancel_forged_marker|$attempt_checks"
  ctl "G a timeout inserted before the unchanged helper call" 2 '^INJECT INCOMPLETE selftest_cancel_timeout_before_helper: the injection did not reach its site' \
    OBRT_INJECT_TABLE="selftest_cancel_timeout_before_helper|$attempt_checks"
  ctl "H the real cancel_in_attempt entry alone" 0 '^INJECT SELFTEST PASSED \(1 of 1\)$' \
    OBRT_INJECT_TABLE="$real_attempt"
  ctl "I an error raised inside the helper is not a top-level one" 1 '^INJECT BAD  cancel_in_attempt: reached its site, exit 2 and its diagnostic, but the error was not raised where it must be' \
    OBRT_INJECT_TABLE="cancel_in_attempt|$(printf '%s\n' "$real_attempt" | cut -d'|' -f2,3)|none"
  [ "$bad" -eq 0 ] && { echo "INJECT SELFTEST CONTROLS PASSED ($n of $n)"; exit 0; }
  echo "INJECT SELFTEST CONTROLS FAILED ($bad of $n)"; exit 1
fi

MUTATE="${2:-}"; [ "${1:-}" = "--mutate" ] || MUTATE=""
INJECT="${OBRT_INJECT:-}"
PORT=$((56000 + RANDOM % 900))
# The /tmp/obrp. prefix is the one deadline.py's reaper recognises.
WORK="$(mktemp -d /tmp/obrp.routes.XXXXXX)"
[ -n "${OBRP_STATE_FILE:-}" ] && printf '%s\n' "$WORK" > "$OBRP_STATE_FILE"
COMPLETED=0
never() { echo "NEVER-RAN: $*"; exit 2; }
fail() {
  if [ -s "$WORK/qfail" ]; then never "a helper query did not execute while checking: $* ($(head -1 "$WORK/qfail" | cut -c1-200))"; fi
  echo "FAIL $*"; exit 1
}
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

if ! initdb -D "$WORK/pg" -A trust -U postgres --locale=en_US.UTF-8 >"$WORK/initdb.log" 2>&1; then
  if grep -q shmget "$WORK/initdb.log"; then
    never "initdb failed at shmget: SysV shared memory is exhausted or denied (check 'ipcs -m' for orphaned segments from killed clusters, kern.sysv.shmmni)"
  fi
  never "initdb failed: $(tail -1 "$WORK/initdb.log")"
fi
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || never "pg start failed: $(tail -1 "$WORK/pg.log")"
PSQL=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q)
"${PSQL[@]}" -d postgres -c "create database obtest" >/dev/null || never "create database failed"

# Supabase's roles and default privileges: every table and function postgres
# creates in public is granted to anon, authenticated and service_role unless a
# migration revokes it. authenticator is the login PostgREST uses.
"${PSQL[@]}" -d obtest <<'SQL' >/dev/null || never "stub schema failed"
create role service_role nologin bypassrls;
create role anon nologin;
create role authenticated nologin;
create role authenticator login noinherit;
grant anon, authenticated, service_role to authenticator;
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
SQL

q() {
  local out code
  out=$("${PSQL[@]}" -d obtest -At -c "$1" 2>&1); code=$?
  if [ "$code" -ne 0 ]; then echo "psql exit $code: $(printf '%s' "$out" | head -1)" >> "$WORK/qfail"; fi
  printf '%s\n' "$out"
}

[ "$(q "select count(*) from pg_roles where rolname = 'closeout_route_publisher'")" = "0" ] || never "the publisher role exists before the migration"

SRC="$WORK/routes.sql"; cp "$M_ROUTES" "$SRC"
mutate_file() { # file, old, new: literal replace, exactly one occurrence
  python3 - "$1" "$2" "$3" <<'PY' || never "mutant did not change exactly one site: $(printf '%s' "$2" | head -1)"
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}
mr() { mutate_file "$SRC" "$1" "$2"; }
case "$MUTATE" in
  "") ;;
  rls_off) mr "alter table public.closeout_routes enable row level security;" "";;
  anon_keeps_default) mr "revoke all on table public.closeout_routes from public, anon, authenticated, service_role;" "revoke all on table public.closeout_routes from public, authenticated, service_role;";;
  authenticated_keeps_default) mr "revoke all on table public.closeout_routes from public, anon, authenticated, service_role;" "revoke all on table public.closeout_routes from public, anon, service_role;";;
  service_role_writes) mr "revoke all on table public.closeout_routes from public, anon, authenticated, service_role;" "revoke all on table public.closeout_routes from public, anon, authenticated;";;
  service_role_no_select) mr "grant select on table public.closeout_routes to service_role;" "";;
  publisher_table_grant) echo "grant select, insert, update on public.closeout_routes to closeout_route_publisher;" >> "$SRC";;
  rpc_public_execute) mr "revoke execute on function public.publish_closeout_routes(jsonb) from public, anon, authenticated, service_role;" "revoke execute on function public.publish_closeout_routes(jsonb) from anon, authenticated, service_role;";;
  rpc_anon_execute) mr "revoke execute on function public.publish_closeout_routes(jsonb) from public, anon, authenticated, service_role;" "revoke execute on function public.publish_closeout_routes(jsonb) from public, authenticated, service_role;";;
  rpc_service_execute) mr "revoke execute on function public.publish_closeout_routes(jsonb) from public, anon, authenticated, service_role;" "revoke execute on function public.publish_closeout_routes(jsonb) from public, anon, authenticated;";;
  rpc_invoker) mr "security definer
set search_path" "security invoker
set search_path";;
  search_path_unpinned) mr "set search_path = pg_catalog, public
as \$\$" "as \$\$";;
  extra_key_allowed) mr "    if v_keys is distinct from array['has_capture_tag', 'has_session_log', 'has_tracker', 'has_workspace', 'slug'] then" "    if not (v_keys @> array['has_capture_tag', 'has_session_log', 'has_tracker', 'has_workspace', 'slug']) then";;
  slug_unchecked) mr "    if jsonb_typeof(v_el -> 'slug') <> 'string'
       or (v_el ->> 'slug') !~ '^[a-z0-9][a-z0-9_-]{0,63}\$' then" "    if jsonb_typeof(v_el -> 'slug') <> 'string' then";;
  bool_unchecked) mr "    if jsonb_typeof(v_el -> 'has_workspace') <> 'boolean'" "    if false and jsonb_typeof(v_el -> 'has_workspace') <> 'boolean'";;
  duplicate_unchecked) mr "    if (v_el ->> 'slug') = any (v_slugs) then" "    if false then";;
  array_unchecked) mr "  if p_routes is null or jsonb_typeof(p_routes) <> 'array' then" "  if p_routes is null then";;
  empty_allowed) mr "  if jsonb_array_length(p_routes) < 1 or jsonb_array_length(p_routes) > 200 then" "  if jsonb_array_length(p_routes) > 200 then";;
  size_unbounded) mr "  if jsonb_array_length(p_routes) < 1 or jsonb_array_length(p_routes) > 200 then" "  if jsonb_array_length(p_routes) < 1 then";;
  no_refresh_on_update) mr "        has_capture_tag = excluded.has_capture_tag,
        published_at = excluded.published_at;" "        has_capture_tag = excluded.has_capture_tag;";;
  do_nothing_on_conflict) mr "  on conflict (slug) do update
    set has_workspace = excluded.has_workspace,
        has_tracker = excluded.has_tracker,
        has_session_log = excluded.has_session_log,
        has_capture_tag = excluded.has_capture_tag,
        published_at = excluded.published_at;" "  on conflict (slug) do nothing;";;
  role_can_login) mr "create role closeout_route_publisher nologin noinherit nobypassrls;" "create role closeout_route_publisher login noinherit nobypassrls;";;
  role_bypassrls) mr "create role closeout_route_publisher nologin noinherit nobypassrls;" "create role closeout_route_publisher nologin noinherit bypassrls;";;
  no_authenticator_grant) mr "grant closeout_route_publisher to authenticator;" "";;
  slug_check_dropped) mr "  published_at timestamptz not null default now(),
  -- Route-key shape only: lower-case letters, digits, '-' and '_', no '/', no
  -- spaces, at most 64 characters. A path cannot fit in this column.
  constraint closeout_routes_slug_shape check (slug ~ '^[a-z0-9][a-z0-9_-]{0,63}\$')" "  published_at timestamptz not null default now()";;
  *) never "unknown mutation: $MUTATE";;
esac

if ! PGOPTIONS="-c client_min_messages=warning" "${PSQL[@]}" -d obtest -f "$SRC" >"$WORK/mig.out" 2>&1; then
  never "migration failed to apply: $(sed 's/^psql:.*ERROR/ERROR/' "$WORK/mig.out" | head -3)"
fi
echo "migration applied on a stub with Supabase's default privileges"

CONTRACT="$TEST_SQL"
inject_sql() { # anchor, inserted text: into a copy of the contract, exactly one site
  CONTRACT="$WORK/contract.sql"; cp "$TEST_SQL" "$CONTRACT"
  mutate_file "$CONTRACT" "$1" "$1$2"
}
TOP_ANCHOR="set client_min_messages = notice;
"
POINT_ANCHOR="-- OBRT_INJECT_POINT (the runner's negative controls insert one statement here)
"
# The reach marker for an injection planted in SQL: a NOTICE the planted code
# raises as it executes, printed by the runner like every contract NOTICE.
reached_sql() { printf '%s' "do \$\$ begin raise notice 'OBRT_INJECT_REACHED $INJECT'; end \$\$;"; }
reached() { echo "OBRT_INJECT_REACHED $INJECT"; }
# reached_if <query> <want>: print the marker only when the injected state is
# in effect (the query, run after the injection, answers <want>), so the marker
# is evidence of the injection, not of the shell line that planted it.
reached_if() {
  local got; got=$(q "$1")
  [ "$got" = "$2" ] || never "injection $INJECT did not take effect ($1 answered '$(printf '%s' "$got" | head -1 | cut -c1-80)', not '$2')"
  reached
}
# For cancel_in_attempt the marker is raised INSIDE the helper: it is the first
# thing the SQL handed to pg_temp.attempt_as does when attempt_as EXECUTEs it,
# and the same function then sleeps into the timeout. A timeout anywhere else
# never prints it (Codex re-review 1 of PR 32, P2-2).
reach_then_sleep_sql() {
  printf '%s' "create function pg_temp.obrt_reach_then_sleep(p_name text, p_secs float8) returns text
language plpgsql as \$\$ begin raise notice 'OBRT_INJECT_REACHED %', p_name; perform pg_sleep(p_secs); return 'slept'; end \$\$;"
}
CANCEL_IN_ATTEMPT_CALL="select pg_temp.raises('INJECTED a statement cancelled inside attempt', null, 'select pg_temp.obrt_reach_then_sleep(''$INJECT'', 2)', '22023', 'x');"
case "$INJECT" in
  "") ;;
  sql_timeout) inject_sql "$TOP_ANCHOR" "$(reached_sql)
set statement_timeout=10;
select pg_sleep(0.2);
";;
  cancel_in_attempt) inject_sql "$POINT_ANCHOR" "$(reach_then_sleep_sql)
set statement_timeout = 50;
$CANCEL_IN_ATTEMPT_CALL
";;
  # Controls of the self-test (--inject-selftest-controls), never in the table:
  # the two shapes Codex re-review 1 showed passing as cancel_in_attempt.
  selftest_cancel_bare_sleep) inject_sql "$POINT_ANCHOR" "set statement_timeout = 50;
select pg_sleep(2);
";;
  selftest_cancel_forged_marker) inject_sql "$POINT_ANCHOR" "$(reached_sql)
set statement_timeout = 50;
select pg_sleep(2);
";;
  selftest_cancel_timeout_before_helper) inject_sql "$POINT_ANCHOR" "$(reach_then_sleep_sql)
set statement_timeout = 50; select pg_sleep(2);
$CANCEL_IN_ATTEMPT_CALL
";;
  raw_error) inject_sql "$POINT_ANCHOR" "$(reached_sql)
select 'obrt_raw_error'::integer;
";;
  assert_fail) inject_sql "$POINT_ANCHOR" "$(reached_sql)
select pg_temp.ok('INJECTED a completed check that does not hold', 1 = 2, 'one is not two');
";;
  helper_stray|bridge_publisher_broken|bridge_missing_function|bridge_invalid_cast|bridge_cancel|bridge_revoke_execute|bridge_revoke_schema_usage|bridge_revoke_membership|bridge_payload_extra_key|bridge_same_line_denial|b3_planted_error|b3_same_line_success|b3_same_line_refused|bridge_prelude_reconnect_admin|bridge_prelude_session_anon|bridge_prelude_reconnect_anon|bridge_prelude_chained_reconnect) ;; # planted further down
  launch_b1_login_postgres|launch_b1_conninfo_postgres|launch_b1_prefile_reconnect|launch_b3_login_postgres|launch_b3_conninfo_postgres|launch_b3_prefile_reconnect|launch_b1_prefile_session_auth|launch_b1_pgoptions_role) ;; # planted at the bridge's psql launches
  *) never "unknown injection: $INJECT";;
esac

# 2. The single-connection contract.
"${PSQL[@]}" -d obtest -v interruption_prefixes="$INTERRUPTION_PREFIXES" -f "$CONTRACT" >"$WORK/contract.out" 2>&1; code=$?
grep -E '^psql:.*:[0-9]+: (NOTICE|ERROR):  ' "$WORK/contract.out" \
  | sed -E 's/^psql:.*:[0-9]+: NOTICE:  00000: //; s/^psql:.*:[0-9]+: ERROR:  ([0-9A-Z]{5}): /ERROR \1: /; s/^psql:.*:[0-9]+: ERROR:  /ERROR (no SQLSTATE): /'
# The first error's CONTEXT, joined on one line ("(none)" for a top-level
# statement): the inject self-test checks WHERE an injected error was raised.
ce=$(first_error_line "$WORK/contract.out")
if [ -n "$ce" ]; then
  ctx=$(error_block "$WORK/contract.out" "$ce" | awk '/^LOCATION:  /{exit} /^CONTEXT:  /{c=1; sub(/^CONTEXT:  /, "")} c' | awk 'NR > 1 { printf " | " } { printf "%s", $0 }')
  echo "OBRT_ERROR_CONTEXT ${ctx:-(none)}"
fi
contract_verdict "$code" "$WORK/contract.out"
case $? in
  0) ;;
  1) echo "FAIL CLOSEOUT ROUTES SQL TEST: $VERDICT"; exit 1;;
  *) never "$VERDICT";;
esac

[ "${OBRT_SELFTEST_STOP_BEFORE_BRIDGE:-}" = 1 ] && never "OBRT_SELFTEST_STOP_BEFORE_BRIDGE: stopped after the SQL contract, before the bridge (a control of the inject self-test)"

# 3. The bridge. Fresh table state for it.
[ "$INJECT" = "helper_stray" ] && { reached; q "select 'obrt_helper_stray'::integer" >/dev/null; }
q "truncate public.closeout_routes" >/dev/null
FIX="$WORK/fixture registry"; WS="$FIX/Mobile Documents/Project One"
mkdir -p "$WS" || never "could not create the fixture registry directory"
: > "$WS/PROJECT-TRACKER.md"; : > "$WS/SESSION-LOG.md"
cat > "$FIX/registry.json" <<JSON
{
  "bridge-ok": {"workspace_path": "$WS", "tracker_path": "$WS/PROJECT-TRACKER.md", "session_log_path": "$WS/SESSION-LOG.md", "capture_tag": "bridge_ok"},
  "bridge-no-tracker": {"workspace_path": "$WS", "tracker_path": "$WS/MISSING.md", "session_log_path": "$WS/SESSION-LOG.md", "capture_tag": "bridge_no_tracker"}
}
JSON
PUB="$PUBLISHER"; [ "$INJECT" = "bridge_publisher_broken" ] && { reached; PUB="$WORK/obrt-bridge-publisher-broken.mjs"; }
DRY=$(node "$PUB" --dry-run --registry "$FIX/registry.json" 2>&1); dcode=$?
[ "$dcode" = 0 ] || never "the publisher's dry run did not complete (exit $dcode): $(printf '%s\n' "$DRY" | grep -m1 '^[A-Za-z]*Error' || printf '%s' "$DRY" | tail -1 | cut -c1-200)"
ROUTES=$(printf '%s' "$DRY" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);if(j.status!=="DRY_RUN")process.exit(3);process.stdout.write(JSON.stringify(j.routes))})') \
  || never "the publisher's dry-run output was not a DRY_RUN JSON object: $(printf '%s' "$DRY" | cut -c1-200)"
case "$ROUTES" in *"$WORK"*|*/*) fail "the publisher's payload carries a path: $ROUTES";; esac
# Negative controls for publish_verdict: three planted SQL errors before the
# role switch (Codex review 1 of PR 32) must be NEVER-RAN; four real denials
# of the publish path must be a judged FAIL B1; a second statement on the
# publish line (Codex re-review 1) must be NEVER-RAN, never a FAIL; a prelude
# that changes the session (Codex re-review 2) must be NEVER-RAN, never judged.
# Every prelude is planted above the identity line, where a setup line would go;
# the identity line, the switch and the call stay the file's last three lines.
case "$INJECT" in
  bridge_revoke_execute) q "revoke execute on function public.publish_closeout_routes(jsonb) from closeout_route_publisher" >/dev/null
    reached_if "select has_function_privilege('closeout_route_publisher', 'public.publish_closeout_routes(jsonb)', 'execute')" f;;
  bridge_revoke_schema_usage) q "revoke usage on schema public from public, closeout_route_publisher" >/dev/null
    reached_if "select has_schema_privilege('closeout_route_publisher', 'public', 'usage')" f;;
  bridge_revoke_membership) q "revoke closeout_route_publisher from authenticator" >/dev/null
    reached_if "select pg_has_role('authenticator', 'closeout_route_publisher', 'member')" f;;
  bridge_payload_extra_key) ROUTES=$(printf '%s' "$ROUTES" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);j[0].extra=true;process.stdout.write(JSON.stringify(j))})') || never "injection $INJECT did not apply"; reached;;
esac
printf '%s\n' "$ID_TXT" "set role closeout_route_publisher;" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$WORK/publish.sql"
case "$INJECT" in
  bridge_missing_function) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
select reviewer_no_such_function();
$ID_TXT";;
  bridge_invalid_cast) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
select 'reviewer-not-an-integer'::integer;
$ID_TXT";;
  bridge_cancel) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
set statement_timeout=1; select pg_sleep(0.05) as obrt_bridge_cancel;
$ID_TXT";;
  bridge_same_line_denial) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
$ID_TXT"
    mutate_file "$WORK/publish.sql" "select public.publish_closeout_routes(:'routes'::jsonb);" "select public.publish_closeout_routes(:'routes'::jsonb); select pg_read_file('/obrt-bridge-same-line-denial');";;
  # Codex re-review 2's preludes that replace the session before the switch,
  # the NOLOGIN reconnect it kept as a control, and a \connect chained after
  # the marker's \echo on one line: each must be NEVER-RAN, never judged.
  bridge_prelude_reconnect_admin) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
\\connect obtest postgres
$ID_TXT";;
  bridge_prelude_session_anon) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
\\connect obtest postgres
set session authorization anon;
$ID_TXT";;
  bridge_prelude_reconnect_anon) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
\\connect obtest anon
$ID_TXT";;
  bridge_prelude_chained_reconnect) mutate_file "$WORK/publish.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT \\connect obtest postgres
$ID_TXT";;
esac
# The judge names the statement that raised by the line psql -e printed for
# it, so it needs the exact text psql sends for the call.
case "$ROUTES" in *\\*) never "the publisher's payload carries a backslash, which psql would send as an E'' literal that pub_echo does not model: $(printf '%s' "$ROUTES" | cut -c1-200)";; esac
PUB_ECHO=$(pub_echo "$ROUTES")
# launch_planted <b1|b3> <sql> <out>: the launch-fault controls of the identity
# line (Codex re-review 3 of PR 32). When $INJECT names a launch fault for this
# site it runs THAT launch instead of the harness's own psql line below, with
# one change of who connects and the generated file unchanged, sets LCODE and
# returns 0; otherwise it runs nothing and returns 1. The planted launch first
# runs -c '\echo OBRT_INJECT_REACHED <name>', so the marker comes from that
# very psql process; a pre-file -c runs before the file, so it cannot come
# between the identity line and the judged statements.
launch_planted() {
  local site="$1" user=authenticator db=obtest pre=() env=()
  case "$INJECT" in "launch_${site}_"*) ;; *) return 1;; esac
  case "$INJECT" in
    *_login_postgres) user=postgres;;
    *_conninfo_postgres) db="host=127.0.0.1 port=$PORT dbname=obtest user=postgres";;
    *_prefile_reconnect) pre=(-c '\c -reuse-previous=on "dbname=obtest user=postgres"');;
    *_prefile_session_auth) user=postgres; pre=(-c "set session authorization authenticator");;
    *_pgoptions_role) env=(PGOPTIONS="-c role=anon");;
    *) never "unknown launch injection: $INJECT";;
  esac
  env ${env[@]+"${env[@]}"} psql -X -h 127.0.0.1 -p "$PORT" -U "$user" -d "$db" -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -At -e -v routes="$ROUTES" \
    -c "\\echo OBRT_INJECT_REACHED $INJECT" ${pre[@]+"${pre[@]}"} -f "$2" >"$3" 2>&1; LCODE=$?
  return 0
}
# The harness's own launch lines stay exactly as before, so a one-line edit of
# either reaches the same text; the identity line, not this line, establishes
# who ran the judged statements.
if launch_planted b1 "$WORK/publish.sql" "$WORK/publish.out"; then pcode=$LCODE; else
psql -X -h 127.0.0.1 -p "$PORT" -U authenticator -d obtest -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -At -e -v routes="$ROUTES" -f "$WORK/publish.sql" >"$WORK/publish.out" 2>&1; pcode=$?
fi
grep '^OBRT_INJECT_REACHED ' "$WORK/publish.out"
publish_verdict "$pcode" "$WORK/publish.out" "$WORK/publish.sql" "$PUB_ECHO"
case $? in
  0) ;;
  1) fail "$VERDICT";;
  *) never "$VERDICT";;
esac
echo "PASS B1 a real authenticator login published the publisher's own dry-run payload through SET ROLE (told 2)"
ROWS=$(q "select string_agg(slug || ':' || has_workspace || ',' || has_tracker || ',' || has_session_log || ',' || has_capture_tag, ' ' order by slug) from public.closeout_routes")
[ "$ROWS" = "bridge-no-tracker:true,false,true,true bridge-ok:true,true,true,true" ] || fail "B2 the table does not hold exactly the published booleans: $ROWS"
ALL=$(q "select string_agg(to_jsonb(r)::text, ' ') from public.closeout_routes r")
case "$ALL" in *"$WORK"*|*"Mobile Documents"*|*"/"*) fail "B2 a path reached the table: $ALL";; esac
echo "PASS B2 the table holds exactly the published booleans and no path"
printf '%s\n' "$ID_TXT" "select public.publish_closeout_routes(:'routes'::jsonb);" > "$WORK/publish-norole.sql"
[ "$INJECT" = b3_planted_error ] && mutate_file "$WORK/publish-norole.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
select reviewer_no_such_function();
$ID_TXT"
case "$INJECT" in
  b3_same_line_success) q "grant execute on function public.publish_closeout_routes(jsonb) to authenticator" >/dev/null
    reached_if "select has_function_privilege('authenticator', 'public.publish_closeout_routes(jsonb)', 'execute')" t
    mutate_file "$WORK/publish-norole.sql" "select public.publish_closeout_routes(:'routes'::jsonb);" "select public.publish_closeout_routes(:'routes'::jsonb); select pg_read_file('/obrt-b3-same-line-success');";;
  b3_same_line_refused) mutate_file "$WORK/publish-norole.sql" "$ID_TXT" "\\echo OBRT_INJECT_REACHED $INJECT
$ID_TXT"
    mutate_file "$WORK/publish-norole.sql" "select public.publish_closeout_routes(:'routes'::jsonb);" "select public.publish_closeout_routes(:'routes'::jsonb); select pg_read_file('/obrt-b3-same-line-refused');";;
esac
if launch_planted b3 "$WORK/publish-norole.sql" "$WORK/norole.out"; then ncode=$LCODE; else
psql -X -h 127.0.0.1 -p "$PORT" -U authenticator -d obtest -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -q -At -e -v routes="$ROUTES" -f "$WORK/publish-norole.sql" >"$WORK/norole.out" 2>&1; ncode=$?
fi
grep '^OBRT_INJECT_REACHED ' "$WORK/norole.out"
b3_verdict "$ncode" "$WORK/norole.out" "$WORK/publish-norole.sql" "$PUB_ECHO"
case $? in
  0) ;;
  1) fail "$VERDICT";;
  *) never "$VERDICT";;
esac
echo "PASS B3 authenticator without the role switch is refused (42501)"
# Read back as the Edge Function's role, in the Edge Function's column list.
COLS=$(sed -nE '/^export const ROUTE_SNAPSHOT_COLUMNS =$/{n;s/^ *"([^"]+)";$/\1/p;}' "$CONTRACT_TS")
[ -n "$COLS" ] || never "could not read ROUTE_SNAPSHOT_COLUMNS from $CONTRACT_TS"
SNAP=$(q "set role service_role; select coalesce(jsonb_agg(to_jsonb(r) order by r.slug), '[]'::jsonb)::text from (select $COLS from public.closeout_routes) r")
case "$SNAP" in "["*) ;; *) never "the service_role read did not return JSON: $(printf '%s' "$SNAP" | cut -c1-200)";; esac
BRIDGE_TS="$WORK/bridge.ts"
cat > "$BRIDGE_TS" <<TS
import { evaluateCompletion } from "$CONTRACT_TS";
const rows = JSON.parse(Deno.args[0]) as Array<Record<string, unknown>>;
const receipt = ["Work summary: x", "Verification: x", "Touched files or records: none", "Limitations: x", "Tracker draft: x", "Session-log draft: x", "Brain Bank capture draft: x", "Follow-up recommendation: none"].join("\n");
const out: Record<string, unknown> = {};
for (const row of rows) {
  const v = evaluateCompletion({ receipt, task: { project_slug: String(row.slug), desired_outcome: "A fix", title: "t" }, route: { row: row as never }, now: new Date() });
  out[String(row.slug)] = v.ok ? ["ok", v.warnings.length] : ["refused", v.reasons.join("+")];
}
console.log(JSON.stringify(out));
TS
VERD=$(deno run --no-lock --allow-read "$BRIDGE_TS" "$SNAP" 2>&1); vcode=$?
[ "$vcode" = 0 ] || never "the evaluateCompletion bridge did not run (exit $vcode): $(printf '%s' "$VERD" | tail -1 | cut -c1-200)"
[ "$VERD" = '{"bridge-no-tracker":["refused","UNRESOLVED_TRACKER_PATH"],"bridge-ok":["ok",0]}' ] || fail "B4 evaluateCompletion on the rows read back as service_role: $VERD"
echo "PASS B4 rows read back as service_role drive evaluateCompletion: bridge-ok accepted with no warning, bridge-no-tracker refused UNRESOLVED_TRACKER_PATH"

[ -s "$WORK/qfail" ] && never "every check held, but a helper query did not execute during the run ($(head -1 "$WORK/qfail" | cut -c1-200))"
[ -n "$INJECT" ] && never "the injection $INJECT did not stop the run, so it did not fire"
COMPLETED=1
echo "CLOSEOUT ROUTES TEST COMPLETE${MUTATE:+ (mutation $MUTATE)}"
