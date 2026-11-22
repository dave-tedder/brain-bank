#!/bin/bash
# PR 23 review F1/F2 negative controls on the TypeScript side: each mutant is
# applied to a THROWAWAY COPY of the tree (never this checkout), then judged by
#   (a) the helper unit tests, supabase/functions/_shared/proposal-review.test.ts, and
#   (b) the full runner, review-proposal-sql-test.sh, whose integration step drives
#       the mutated helper / MCP entrypoint / Slack entrypoint against the real RPCs.
#
#   bash scripts/loop-closing/review-proposal-ts-mutants.sh            # every mutant
#   bash scripts/loop-closing/review-proposal-ts-mutants.sh <name>...  # some
#
# A mutant is CAUGHT only when a judge RAN TO COMPLETION and failed an assertion
# (deno test reports failed tests; the runner exits 1 with a FAIL/ERROR line). A
# judge that timed out, could not load, or never reached its checks is NEVER-RAN.
# Exit 0 only when every mutant was CAUGHT; 1 if any survived; 2 if any never ran.
export LC_ALL=C
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEADLINE="$ROOT/scripts/loop-closing/deadline.py"
ALL="helper_blank_ref_as_absent helper_actor_forced_operator helper_decision_ref_dropped mcp_decision_ref_not_forwarded mcp_schema_min1 ingest_decision_ref_dropped"
HELPER=supabase/functions/_shared/proposal-review.ts
MCP=supabase/functions/open-brain-mcp/index.ts
INGEST=supabase/functions/ingest-thought/index.ts

apply() { # tree, file, old, new
  python3 - "$1/$2" "$3" "$4" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, 'w').write(s.replace(a, b))
PY
}

mutate() { # tree, name
  case "$2" in
    # The pre-amendment helper: a blank decision ref read as absent.
    helper_blank_ref_as_absent) apply "$1" "$HELPER" '  const decisionSupplied = args.decisionRef !== undefined && args.decisionRef !== null;
  const decisionRef = decisionSupplied ? String(args.decisionRef).trim().toLowerCase() : null;' '  const decisionRef = args.decisionRef == null || args.decisionRef.trim() === "" ? null : args.decisionRef.trim().toLowerCase();
  const decisionSupplied = decisionRef !== null;';;
    # Codex's fresh mutant: the supplied actor replaced by operator.
    helper_actor_forced_operator) apply "$1" "$HELPER" '    p_actor: args.actor,' '    p_actor: "operator",';;
    helper_decision_ref_dropped) apply "$1" "$HELPER" '    p_decision_ref: decisionRef,' '    p_decision_ref: null,';;
    mcp_decision_ref_not_forwarded) apply "$1" "$MCP" '        decisionRef: decision_ref ?? null,' '        decisionRef: null,';;
    # The pre-amendment MCP schema: "" rejected by zod before the callback.
    mcp_schema_min1) apply "$1" "$MCP" '      decision_ref: z.string().max(64).optional().describe(' '      decision_ref: z.string().min(1).max(64).optional().describe(';;
    ingest_decision_ref_dropped) apply "$1" "$INGEST" '    decisionRef: command.decisionRef,' '    decisionRef: null,';;
    *) return 2;;
  esac
}

caught=0; survived=0; never=0
for m in ${*:-$ALL}; do
  T="$(mktemp -d /tmp/obrp-ts.XXXXXX)"
  mkdir -p "$T/supabase" "$T/scripts"
  cp -R "$ROOT/supabase/functions" "$ROOT/supabase/migrations" "$T/supabase/"
  cp -R "$ROOT/scripts/loop-closing" "$T/scripts/"
  cp "$ROOT/deno.json" "$T/"
  if ! mutate "$T" "$m"; then
    echo "NEVER-RAN $m: the mutant did not apply to exactly one site"; never=$((never + 1)); rm -rf "$T"; continue
  fi
  uout=$(python3 "$DEADLINE" 180 deno test --allow-read --allow-env --allow-net "$T/supabase/functions/_shared/proposal-review.test.ts" 2>&1); ucode=$?
  rout=$(python3 "$DEADLINE" 400 bash "$T/scripts/loop-closing/review-proposal-sql-test.sh" 2>&1); rcode=$?
  rm -rf "$T"
  uline=$(printf '%s\n' "$uout" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^FAILED|\| [1-9][0-9]* failed' | head -1)
  rline=$(printf '%s\n' "$rout" | grep -E '^(FAIL|ERROR)' | head -1 | cut -c1-150)
  verdict=""
  if [ "$ucode" = 1 ] && [ -n "$uline" ]; then verdict="unit: $(printf '%s\n' "$uout" | sed 's/\x1b\[[0-9;]*m//g' | grep -E '=> |FAILED' | head -1 | cut -c1-110)"; fi
  if [ "$rcode" = 1 ] && [ -n "$rline" ]; then verdict="${verdict:+$verdict; }runner: $rline"; fi
  if [ -n "$verdict" ]; then
    echo "CAUGHT    $m: $verdict"; caught=$((caught + 1))
  elif [ "$ucode" = 0 ] && [ "$rcode" = 0 ]; then
    echo "SURVIVED  $m"; survived=$((survived + 1))
  else
    echo "NEVER-RAN $m: unit exit $ucode, runner exit $rcode ($(printf '%s\n' "$rout" | tail -1 | cut -c1-120))"; never=$((never + 1))
  fi
done
echo "TS MUTANTS: $caught caught, $survived survived, $never never ran"
[ "$never" -gt 0 ] && exit 2
[ "$survived" -gt 0 ] && exit 1
echo "ALL TS MUTANTS CAUGHT"
exit 0
