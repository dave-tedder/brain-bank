#!/usr/bin/env bash
# Phase 2 closeout step: pull cloud-written deliverables from the Supabase
# Storage bucket down into deliverables/ on disk (decision D4: git stays the
# single durable store; the bucket is the cloud on-ramp only).
#
# INERT until the open-brain-mcp deploy ships list_deliverables /
# get_deliverable: before that the tools/call returns an unknown-tool error and
# this script reports {"synced":0,"reason":"VERBS_NOT_DEPLOYED"} and exits 0.
#
# Flat invocation for the closeout lane (closeout-run.sh credential precedent):
#   bash scripts/open-engine/deliverables-bucket-sync.sh
# Then the lane runs:  bash scripts/open-engine/deliverables-push.sh --sweep
#
# Never prints key material. Downloads only paths that validate against the
# same slug/filename shape the server enforces; never overwrites a local file
# (local disk + git history win; the bucket object is the copy).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${DELIVERABLES_REPO_ROOT:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
CLAUDE_CONFIG="$HOME/.claude.json"
MCP_SERVER_NAME="brain-bank"

if [ -z "${BB_MCP_URL:-}" ] || [ -z "${BB_MCP_KEY:-}" ]; then
  if [ ! -f "$CLAUDE_CONFIG" ]; then
    echo '{"synced":0,"reason":"NO_CREDS"}'
    exit 1
  fi
  BB_MCP_URL="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["url"])
except Exception:
    pass' "$CLAUDE_CONFIG" "$MCP_SERVER_NAME")"
  BB_MCP_KEY="$(python3 -c 'import json,sys
try:
    print(json.load(open(sys.argv[1]))["mcpServers"][sys.argv[2]]["headers"]["x-brain-key"])
except Exception:
    pass' "$CLAUDE_CONFIG" "$MCP_SERVER_NAME")"
  export BB_MCP_URL BB_MCP_KEY
fi
if [ -z "${BB_MCP_URL:-}" ] || [ -z "${BB_MCP_KEY:-}" ]; then
  echo '{"synced":0,"reason":"NO_CREDS"}'
  exit 1
fi

# All JSON-RPC handling in one python3 process: list bucket objects, download
# each one missing locally, write under deliverables/. Path shape re-validated
# client-side before any write (defense in depth vs a compromised server).
python3 - "$ROOT" <<'PYEOF'
import json, os, re, sys, urllib.request

root = sys.argv[1]
url = os.environ["BB_MCP_URL"]
key = os.environ["BB_MCP_KEY"]
PATH_RE = re.compile(r"^[a-z0-9][a-z0-9-]*/[A-Za-z0-9][A-Za-z0-9._-]*\.(md|html|txt|json|csv)$")

def rpc(tool, args):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                       "params": {"name": tool, "arguments": args}}).encode()
    req = urllib.request.Request(url, data=body, headers={
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "x-brain-key": key})
    with urllib.request.urlopen(req, timeout=60) as resp:
        raw = resp.read().decode()
    # Streamable-HTTP responses may arrive as SSE; take the last data: line.
    if raw.lstrip().startswith("event:") or "\ndata:" in raw or raw.startswith("data:"):
        lines = [l[5:].strip() for l in raw.splitlines() if l.startswith("data:")]
        raw = lines[-1] if lines else raw
    msg = json.loads(raw)
    if "error" in msg:
        raise RuntimeError(msg["error"].get("message", "rpc error"))
    result = msg["result"]
    if result.get("isError"):
        raise RuntimeError(result["content"][0]["text"][:200])
    return json.loads(result["content"][0]["text"])

try:
    listing = rpc("list_deliverables", {})
except Exception as e:
    reason = "VERBS_NOT_DEPLOYED" if "not found" in str(e).lower() or "unknown" in str(e).lower() else "LIST_FAILED"
    print(json.dumps({"synced": 0, "reason": reason, "detail": str(e)[:160]}))
    sys.exit(0)

synced, skipped, files = 0, 0, []
for entry in listing.get("objects", []):
    path = entry.get("path", "")
    if not PATH_RE.match(path):
        skipped += 1
        continue
    local = os.path.join(root, "deliverables", path)
    if os.path.exists(local):
        continue  # local disk + git history win; never overwrite
    try:
        got = rpc("get_deliverable", {"path": path})
        content = got["content"]
    except Exception:
        skipped += 1
        continue
    os.makedirs(os.path.dirname(local), exist_ok=True)
    try:
        with open(local, "x", encoding="utf-8") as f:  # O_EXCL: never clobber a racing writer
            f.write(content)
    except FileExistsError:
        continue
    synced += 1
    files.append(path)

print(json.dumps({"synced": synced, "skipped": skipped, "files": files}))
PYEOF
