#!/bin/bash
# Loop-closing Task 5.3, correction 1: run client-identity-witness.ts against
# one tree's code and migrations on a throwaway LOCAL cluster.
#
#   bash scripts/loop-closing/client-identity-witness-run.sh <tree>
#
# <tree> is a checkout of the repository (the reviewed head or the corrected
# head). The witness and its psql adapter are copied from THIS checkout into
# <tree>/scripts/loop-closing/, so both heads run the same scenarios through
# their own code. Prints the witness's W<n> lines. Exit 0
# when WITNESS COMPLETE, 2 otherwise (NEVER-RAN). The caller holds the shared
# database lock (scripts/loop-closing/db-lock.py run ... -- bash <this> <tree>).
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
TREE="$(cd "${1:?tree}" && pwd)"
# Always this checkout's witness and adapter, so both heads run the same
# scenarios (copied over the target's own copies; the target is disposable).
for f in client-identity-witness.ts client-identity-psql-db.ts; do
  [ "$HERE/$f" -ef "$TREE/scripts/loop-closing/$f" ] || cp -f "$HERE/$f" "$TREE/scripts/loop-closing/$f"
done
PORT=$((56100 + RANDOM % 800))
WORK="$(mktemp -d /tmp/obrp.XXXXXX)"
trap 'pg_ctl -D "$WORK/pg" stop -m fast -t 10 >/dev/null 2>&1; rm -rf "$WORK"' EXIT
initdb -D "$WORK/pg" -A trust -U postgres --locale=en_US.UTF-8 >/dev/null 2>&1 || { echo "NEVER-RAN: initdb"; exit 2; }
pg_ctl -D "$WORK/pg" -o "-p $PORT -c listen_addresses=127.0.0.1 -k $WORK" -l "$WORK/pg.log" start -w >/dev/null || { echo "NEVER-RAN: start"; exit 2; }
P=(psql -X -h 127.0.0.1 -p "$PORT" -U postgres -v ON_ERROR_STOP=1 -q)
"${P[@]}" -d postgres -c "create role service_role nologin bypassrls; create role anon nologin; create role authenticated nologin;" >/dev/null || { echo "NEVER-RAN: roles"; exit 2; }
"${P[@]}" -d postgres -c "create database obwitness" >/dev/null || { echo "NEVER-RAN: database"; exit 2; }
# The stub schema is client-identity-sql-test.sh's, read from THIS checkout.
python3 - "$HERE/client-identity-sql-test.sh" > "$WORK/stub.sql" <<'PYEOF' || { echo "NEVER-RAN: stub"; exit 2; }
import sys
s = open(sys.argv[1]).read()
a = s.index("<<'SQL' >/dev/null || never \"stub schema failed in $d\"\n")
a = s.index("\n", a) + 1
b = s.index("\nSQL\n", a)
print(s[a:b])
PYEOF
"${P[@]}" -d obwitness -f "$WORK/stub.sql" >/dev/null || { echo "NEVER-RAN: stub schema"; exit 2; }
for m in 0016_mcp_tool_invocations 20261105_auto_resolve_decisions 20261106_action_items_close_reason 20261109a_action_items_archive_proposals 20261109b_review_proposal_rpc 20261120c_dedup_semantic_reads 20261121b_action_items_client_id; do
  PGOPTIONS="-c client_min_messages=warning" "${P[@]}" -d obwitness -f "$TREE/supabase/migrations/$m.sql" >/dev/null 2>"$WORK/m.err" || { echo "NEVER-RAN: migration $m: $(head -2 "$WORK/m.err")"; exit 2; }
done
echo "tree: $TREE ($(git -C "$TREE" rev-parse --short HEAD 2>/dev/null))"
cd "$TREE" || exit 2
out=$(OBRP_PG_PORT="$PORT" OBRP_PG_DB=obwitness deno run --no-lock --allow-env --allow-read --allow-run=psql scripts/loop-closing/client-identity-witness.ts 2>&1)
printf '%s\n' "$out" | grep -E '^(W[0-9]|NOTE|NEVER-RAN|WITNESS)'
printf '%s\n' "$out" | grep -qx "WITNESS COMPLETE" && exit 0
exit 2
