#!/bin/bash
# Loop-closing Task 0.2: run the sentinel's four step-3d PostgREST reads locally
# with the sentinel_reader token and print ONLY statuses, Content-Range totals,
# row counts and canary visibility. Credentials come from the mode-600 files
# ~/.config/brain-bank/sentinel-read-jwt and sentinel-apikey (written by
# mint-sentinel-read-jwt.py; the Keychain prompt truncates at 128 chars, so a JWT
# cannot live there) and travel to curl through a mode-600 header file, never
# argv. Nothing secret is printed.
#
#   bash scripts/loop-closing/verify-sentinel-reads.sh REST_BASE [CANARY_TASK_ID]
# REST_BASE is your project's /rest/v1, e.g. https://<your-project-ref>.supabase.co/rest/v1.
# CANARY_TASK_ID (optional) is a card the reads must be able to see.
set -u
REST="${1:?usage: verify-sentinel-reads.sh REST_BASE [CANARY_TASK_ID]}"
CANARY="${2:-}"
STORE="$HOME/.config/brain-bank"
JWT="$(cat "$STORE/sentinel-read-jwt" 2>/dev/null)" || { echo "NO_TOKEN: run mint-sentinel-read-jwt.py first"; exit 2; }
APIKEY="$(cat "$STORE/sentinel-apikey" 2>/dev/null)" || { echo "NO_APIKEY: run mint-sentinel-read-jwt.py first"; exit 2; }
[ -n "$JWT" ] && [ -n "$APIKEY" ] || { echo "EMPTY_CREDENTIAL_FILE: rerun mint-sentinel-read-jwt.py"; exit 2; }

WORK="$(mktemp -d)"; chmod 700 "$WORK"
trap 'rm -rf "$WORK"' EXIT
AUTH="$WORK/auth"; HEADERS="$WORK/headers"
umask 077
printf 'apikey: %s\nAuthorization: Bearer %s\n' "$APIKEY" "$JWT" > "$AUTH"
unset JWT APIKEY

T="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
START14="$(date -u -v-14d +%Y-%m-%dT%H:%M:%SZ)"
DIGEST_START="$(TZ=America/New_York date -v-16d +%Y-%m-%d)"
CARD_FIELDS="id,status,created_at,archived_at"
echo "T=$T START14=$START14 DIGEST_START=$DIGEST_START REST=$REST"

# page RESOURCE QUERY-ARGS...  -> prints status/total/rows per page, writes rows to $WORK/<resource>.json
page() {
  local res="$1"; shift
  local offset=0 total="" pages=0 rows_all=0
  : > "$WORK/$res.ndjson"
  while :; do
    local body="$WORK/$res.$offset.json"
    if ! curl -fsSG -D "$HEADERS" -H @"$AUTH" -H 'Prefer: count=exact' "$REST/$res" "$@" \
         --data-urlencode 'limit=500' --data-urlencode "offset=$offset" -o "$body"; then
      echo "  $res offset=$offset: HTTP FAIL $(grep -i '^HTTP/' "$HEADERS" | tail -1 | tr -d '\r')"; return 1
    fi
    local cr; cr="$(grep -i '^content-range:' "$HEADERS" | tail -1 | tr -d '\r' | awk '{print $2}')"
    local rows; rows="$(python3 -I -c 'import json,sys; d=json.load(open(sys.argv[1])); print(len(d))' "$body")"
    total="${cr##*/}"
    python3 -I -c 'import json,sys; [print(json.dumps(r)) for r in json.load(open(sys.argv[1]))]' "$body" >> "$WORK/$res.ndjson"
    pages=$((pages+1)); rows_all=$((rows_all+rows))
    echo "  $res page offset=$offset content-range=$cr rows=$rows"
    if [ "$total" = "*" ] || [ -z "$total" ]; then echo "  $res: no exact total"; return 1; fi
    if [ "$rows" -eq 0 ] || [ $((offset+rows)) -ge "$total" ]; then break; fi
    offset=$((offset+rows))
  done
  [ "$rows_all" -eq "$total" ] && echo "  $res: TOTAL $total rows across $pages page(s), complete" \
                               || { echo "  $res: GAP rows_all=$rows_all total=$total"; return 1; }
}

echo "[1] digests"
page digests --data-urlencode 'select=digest_date,n:metadata->>open_actions_count' --data-urlencode 'digest_type=eq.daily' \
  --data-urlencode "digest_date=gte.$DIGEST_START" --data-urlencode "created_at=lte.$T" --data-urlencode 'order=digest_date.desc,id.asc'
echo "[2] action_items"
page action_items --data-urlencode 'select=id,created_at,resolved_at,status' \
  --data-urlencode "or=(created_at.gte.$START14,resolved_at.gte.$START14)" --data-urlencode "created_at=lte.$T" --data-urlencode 'order=id.asc'
echo "[3] agent_task_events"
page agent_task_events --data-urlencode 'select=id,task_id,created_at,event_type,status:payload->>status,prior:payload->>from_status' \
  --data-urlencode "created_at=lte.$T" --data-urlencode 'order=created_at.asc,id.asc'
echo "[4] agent_tasks"
page agent_tasks --data-urlencode "select=$CARD_FIELDS" --data-urlencode "created_at=lte.$T" --data-urlencode 'order=id.asc'

echo "[5] visibility"
if [ -n "$CANARY" ]; then
  grep -c "\"$CANARY\"" "$WORK/agent_tasks.ndjson" | sed "s/^/  canary $CANARY rows in agent_tasks page: /"
fi
echo "  newest digest row: $(head -1 "$WORK/digests.ndjson")"
echo "  action_items statuses: $(python3 -I -c 'import json,sys,collections; c=collections.Counter(json.loads(l)["status"] for l in open(sys.argv[1])); print(dict(c))' "$WORK/action_items.ndjson")"
echo "[6] negative: anon key alone must see zero rows"
printf 'apikey: %s\nAuthorization: Bearer %s\n' "$(cat "$STORE/sentinel-apikey")" "$(cat "$STORE/sentinel-apikey")" > "$AUTH"
curl -fsSG -D "$HEADERS" -H @"$AUTH" -H 'Prefer: count=exact' "$REST/agent_tasks" --data-urlencode 'select=id' --data-urlencode 'limit=1' -o "$WORK/anon.json" \
  && echo "  anon content-range=$(grep -i '^content-range:' "$HEADERS" | tail -1 | tr -d '\r' | awk '{print $2}') body=$(head -c 80 "$WORK/anon.json")" \
  || echo "  anon read: HTTP $(grep -i '^HTTP/' "$HEADERS" | tail -1 | tr -d '\r')"
echo "done T=$T"
