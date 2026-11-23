#!/bin/bash
# Self-test for the shared local-database lock (db-lock.py + db-lock.sh).
#
#   bash scripts/loop-closing/db-lock-selftest.sh                # exit 0 all passed, 1 a check failed
#   bash scripts/loop-closing/db-lock-selftest.sh --all-mutations  # every planted fault must be caught
#
# Runs against a private lock file in a temporary directory, never the real
# /tmp/ob-db.flock, so it is safe beside a live harness run. Each check is a
# way the old mkdir lock was stranded or misbehaved; after each one the lock
# must be FREE again within a few seconds with nothing removed by hand.
export LC_ALL=C
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export OB_DB_LOCK_HELPER="${OB_DB_LOCK_HELPER:-$HERE/db-lock.py}"
LIB="$HERE/db-lock.sh"

if [ "${1:-}" = --all-mutations ]; then
  T="$(mktemp -d /tmp/ob-db-lock-mut.XXXXXX)"; trap 'rm -rf "$T"' EXIT
  caught=0; survived=0; n=0
  # name | python one-liner that edits the copy | the check that must catch it
  while IFS='|' read -r name edit want; do
    [ -z "$name" ] && continue; n=$((n + 1))
    cp "$HERE/db-lock.py" "$T/$name.py"
    if ! python3 - "$T/$name.py" "$edit" <<'PY'
import sys
p, edit = sys.argv[1], sys.argv[2]
a, b = (x.replace("\\n", "\n") for x in edit.split(" => "))
s = open(p).read()
if s.count(a) != 1: sys.exit(1)
open(p, "w").write(s.replace(a, b))
PY
    then echo "NEVER-RAN $name: the planted fault did not apply"; exit 2; fi
    out=$(OB_DB_LOCK_HELPER="$T/$name.py" bash "$0" 2>&1); code=$?
    first=$(printf '%s\n' "$out" | grep -m1 '^FAIL ')
    if [ "$code" = 1 ] && printf '%s\n' "$first" | grep -q "^FAIL $want"; then caught=$((caught + 1)); echo "CAUGHT   $name: $first"
    else survived=$((survived + 1)); echo "SURVIVED $name (exit $code; first FAIL: ${first:-none})"; fi
  done <<'M'
no_parent_watch|    while os.getppid() == parent:\n        time.sleep(0.2) =>     while True:\n        time.sleep(0.2)|L03
holder_dies_on_int|for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):\n        signal.signal(s, signal.SIG_IGN)\n    write_owner => write_owner|L05a
no_exclusion|if try_lock(fd):\n            return fd => if True:\n            return fd|L01
verify_trusts_claim|        if try_lock(fd):  # free: nobody holds it, so the claim is false\n            return False =>         pass|L08
verify_ignores_note|    return f" holder-pid {pid} " in f" {owner_note()} " =>     return True|L08
keeps_fds|    os.closerange(3 => #    os.closerange(3|L10
keeps_stderr|    for target in (0, 1, 2): =>     for target in (0, 1):|L10
run_releases_early|    rc = child.wait() =>     os._exit(0)|L09
M
  echo "SWEEP: $n planted faults, $caught caught, $survived survived"
  [ "$survived" = 0 ] && { echo "ALL $n PLANTED FAULTS CAUGHT"; exit 0; }
  exit 1
fi

# The mutation table writes "\n" for newlines; nothing else in this script reads it.
W="$(mktemp -d /tmp/ob-db-lock-test.XXXXXX)"
# A private lock file, and a short wait so a planted fault that never lets go
# fails a check in seconds instead of sitting out the 150-minute default.
export OB_DB_LOCK_FILE="$W/test.flock" OB_DB_LOCK_REPORT_SEC=1 OB_DB_LOCK_WAIT_MIN=0.1
unset OB_DB_LOCK_HELD OB_DB_LOCK_HOLDER
PIDS=()
cleanup() { local p; for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill -KILL -- "-$p" "$p" 2>/dev/null; done; rm -rf "$W"; }
trap cleanup EXIT
FAILS=0; PASSES=0
ok() { if [ "$2" = 1 ]; then PASSES=$((PASSES + 1)); echo "PASS $1"; else FAILS=$((FAILS + 1)); echo "FAIL $1: $3"; fi; }

state() { python3 - "$OB_DB_LOCK_FILE" <<'PY'
import fcntl, os, sys
try:
    fd = os.open(sys.argv[1], os.O_RDWR | os.O_CREAT)
except OSError:
    print("error"); sys.exit()
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); print("free")
except OSError:
    print("held")
PY
}
# wait_state <free|held> <seconds>: 1 when the lock reached that state in time
wait_state() { local i=0 lim=$(( $2 * 10 )); while [ "$i" -lt "$lim" ]; do [ "$(state)" = "$1" ] && { echo 1; return; }; sleep 0.1; i=$((i + 1)); done; echo 0; }

# A holder script: acquire, mark, then sit in a cleanup-style trap set.
cat > "$W/holder.sh" <<EOF
. "$LIB"
trap 'sleep 1; exit 2' TERM
trap 'sleep 1; exit 2' INT
trap 'sleep 1; exit 2' HUP
ob_db_lock_acquire "\${1:-selftest}" || { echo "NEVER-RAN: \$OB_DB_LOCK_ERROR"; exit 2; }
echo held > "$W/marker.\${1:-selftest}"
[ "\${2:-}" = release ] && { ob_db_lock_release; echo released > "$W/marker.\${1:-selftest}"; sleep 30; exit 0; }
[ "\${2:-}" = nested ] && { bash "$W/nested.sh" > "$W/nested.out" 2>&1; echo "nested exit \$?" >> "$W/nested.out"; }
sleep 30 & wait \$!
EOF
cat > "$W/nested.sh" <<EOF
. "$LIB"
ob_db_lock_acquire nested-child || { echo "NEVER-RAN: \$OB_DB_LOCK_ERROR"; exit 2; }
echo "child holds via parent: mine=\$OB_DB_LOCK_MINE"
ob_db_lock_release
EOF
# Its own process group (so a group signal reaches only it), with INT, QUIT, TERM
# and HUP back at their defaults: bash starts every `&` job with INT ignored, and
# a script cannot trap a signal that was ignored when it started.
start_holder() { rm -f "$W/marker.$1"; python3 -c 'import os,signal,sys
for s in (signal.SIGINT, signal.SIGQUIT, signal.SIGTERM, signal.SIGHUP): signal.signal(s, signal.SIG_DFL)
os.setsid(); os.execvp("bash", ["bash"] + sys.argv[1:])' "$W/holder.sh" "$@" > "$W/holder-$1.out" 2>&1 & HP=$!; disown "$HP"; PIDS+=("$HP"); local i=0; while [ ! -f "$W/marker.$1" ] && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done; }

[ "$(state)" = free ] || { echo "NEVER-RAN: the private lock is not free at start"; exit 2; }

# L01 a held lock excludes a second taker, and the waiter reports who holds it
start_holder a
ok "L01a holder took the lock" "$( [ -f "$W/marker.a" ] && [ "$(state)" = held ] && echo 1 || echo 0)" "marker $( [ -f "$W/marker.a" ] && echo present || echo missing), state $(state)"
out=$(OB_DB_LOCK_WAIT_MIN=0.05 bash -c ". '$LIB'; ob_db_lock_acquire second || { echo \"refused: \$OB_DB_LOCK_ERROR\"; exit 2; }; echo TOOK; exit 0" 2>&1); code=$?
ok "L01b a second taker is refused while it is held (exit 2, no TOOK)" "$( [ "$code" = 2 ] && ! printf '%s' "$out" | grep -q TOOK && echo 1 || echo 0)" "exit $code: $(printf '%s' "$out" | tail -1)"
ok "L01c the refusal names the holder and says nothing was removed" "$(printf '%s' "$out" | grep -q 'held by another run for .*(a script-pid [0-9]* holder-pid [0-9]* since .*nothing removed' && echo 1 || echo 0)" "$(printf '%s' "$out" | tail -1)"
ok "L01d the waiter printed a waiting line" "$(printf '%s' "$out" | grep -q '^waiting for .*minute 0' && echo 1 || echo 0)" "$(printf '%s' "$out" | head -2 | tr '\n' ' ')"

# L03 SIGKILL of the holding script frees the lock within 2 s (the mkdir lock stayed)
kill -KILL "$HP" 2>/dev/null
ok "L03 SIGKILL of the holding script frees the lock" "$(wait_state free 2)" "state $(state) 2 s after SIGKILL"
kill -KILL -- "-$HP" 2>/dev/null

# L02 an explicit release frees it at once while the script lives on
start_holder b release
i=0; while [ "$(cat "$W/marker.b" 2>/dev/null)" != released ] && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
ok "L02 ob_db_lock_release frees the lock while the script still runs" "$( [ "$(cat "$W/marker.b" 2>/dev/null)" = released ] && [ "$(state)" = free ] && echo 1 || echo 0)" "marker $(cat "$W/marker.b" 2>/dev/null), state $(state)"
kill -KILL -- "-$HP" 2>/dev/null

# L04 a process-group SIGINT: still held while the script's cleanup runs, free after
start_holder c
kill -INT -- "-$HP" 2>/dev/null
sleep 0.4
ok "L04a still held during the script's 1 s INT cleanup" "$( [ "$(state)" = held ] && echo 1 || echo 0)" "state $(state) 0.4 s into cleanup"
ok "L04b free after the script exits from INT" "$(wait_state free 4)" "state $(state)"

# L05 TERM then HUP during cleanup (round-14 finding 2): free after exit
start_holder d
kill -TERM -- "-$HP" 2>/dev/null; sleep 0.3; kill -HUP -- "-$HP" 2>/dev/null
sleep 0.2
ok "L05a still held through the script's TERM and HUP cleanup (deadline.py sends TERM to the group)" "$( [ "$(state)" = held ] && echo 1 || echo 0)" "state $(state) 0.5 s after TERM"
ok "L05b TERM then HUP to the group: free after exit" "$(wait_state free 4)" "state $(state)"

# L06 a group SIGKILL of everything (deadline.py's last resort): free
start_holder e
kill -KILL -- "-$HP" 2>/dev/null
ok "L06 group SIGKILL: free" "$(wait_state free 2)" "state $(state)"

# L07 nested: a child harness under a holder uses the parent's hold, no wait, no release
start_holder f nested
i=0; while ! grep -q 'nested exit' "$W/nested.out" 2>/dev/null && [ "$i" -lt 50 ]; do sleep 0.1; i=$((i + 1)); done
ok "L07a the nested child ran under the parent's hold" "$(grep -q 'child holds via parent: mine=0' "$W/nested.out" 2>/dev/null && grep -q 'nested exit 0' "$W/nested.out" && echo 1 || echo 0)" "$(tr '\n' ' ' < "$W/nested.out" 2>/dev/null)"
ok "L07b the child's release left the parent's hold in place" "$( [ "$(state)" = held ] && echo 1 || echo 0)" "state $(state)"

# L08 a false OB_DB_LOCK_HELD claim (live pid, wrong holder) is not trusted
out=$(OB_DB_LOCK_HELD=1 OB_DB_LOCK_HOLDER=$$ OB_DB_LOCK_WAIT_MIN=0.03 bash -c ". '$LIB'; ob_db_lock_acquire liar || { echo refused; exit 2; }; echo TOOK" 2>&1); code=$?
ok "L08 a false held claim is not trusted while another run holds it" "$( [ "$code" = 2 ] && echo 1 || echo 0)" "exit $code: $(printf '%s' "$out" | tail -1)"
kill -KILL -- "-$HP" 2>/dev/null
wait_state free 2 >/dev/null
# A stale owner note naming a live pid, with the lock free: the claim must not
# be trusted, so the run takes the lock for real (mine=1).
echo "stale script-pid 1 holder-pid $$ since then" > "$OB_DB_LOCK_FILE.owner"
out=$(OB_DB_LOCK_HELD=1 OB_DB_LOCK_HOLDER=$$ bash -c ". '$LIB'; ob_db_lock_acquire claim; echo \"rc \$? mine \$OB_DB_LOCK_MINE\"; ob_db_lock_release" 2>&1)
ok "L08b with the lock free, a claim matching a stale note takes the lock for real" "$(printf '%s' "$out" | grep -q 'rc 0 mine 1' && echo 1 || echo 0)" "$out"

# L09 run mode: exit status passes through, held during, free after; a signal death is 128+n
python3 "$OB_DB_LOCK_HELPER" run --label run-test -- bash -c 'exit 7'; code=$?
ok "L09a run passes the command's exit status through" "$( [ "$code" = 7 ] && echo 1 || echo 0)" "exit $code"
s=$(python3 "$OB_DB_LOCK_HELPER" run --label run-test -- python3 - "$OB_DB_LOCK_FILE" <<'PY'
import fcntl, os, sys
fd = os.open(sys.argv[1], os.O_RDWR)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB); print("free")
except OSError:
    print("held")
PY
)
ok "L09b the lock is held while the wrapped command runs" "$( [ "$s" = held ] && echo 1 || echo 0)" "the command saw $s"
python3 "$OB_DB_LOCK_HELPER" run --label run-test -- bash -c 'kill -TERM $$'; code=$?
ok "L09c a command ended by TERM reports 143" "$( [ "$code" = 143 ] && echo 1 || echo 0)" "exit $code"
ok "L09d free after the wrapped commands" "$( [ "$(state)" = free ] && echo 1 || echo 0)" "state $(state)"

# L10 the holder keeps none of the script's pipes open. The script holds the lock,
# closes its own stdout, stderr and an extra copy of the pipe on fd 7, then keeps
# working for 4 s. $( ) must return when the SCRIPT lets go of the pipe, not when
# the script and its holder are finally gone. (Measured as end-of-file on the
# pipe; bash's own $( ) also waits for the child to exit, so it cannot tell.)
cat > "$W/pipe.sh" <<EOF
. "$LIB"
exec 7>&1
ob_db_lock_acquire pipe || exit 2
echo inside
exec 1>&- 2>&- 7>&-
sleep 4
EOF
res=$(python3 - "$W/pipe.sh" <<'PY'
import subprocess, sys, time
t0 = time.monotonic()
p = subprocess.Popen(["bash", sys.argv[1]], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
out = p.stdout.read().decode().strip()
eof = time.monotonic() - t0
print(f"{eof:.2f} {out}")
PY
)
ok "L10a the pipe reaches end-of-file while the script still holds the lock" "$(python3 -c "import sys; e, *o = sys.argv[1].split(' ', 1); print(1 if float(e) < 2 and o == ['inside'] else 0)" "$res")" "end-of-file after ${res%% *} s, output [${res#* }]"
ok "L10b the lock is still held by the working script" "$( [ "$(state)" = held ] && echo 1 || echo 0)" "state $(state)"
ok "L10c free once the script is done" "$(wait_state free 6)" "state $(state)"

# L11 run mode: a background process the command leaves behind does not inherit the lock
python3 "$OB_DB_LOCK_HELPER" run --label orphan -- bash -c "sleep 5 >/dev/null 2>&1 & echo \$! > '$W/orphan.pid'"
ok "L11 a leftover background process does not keep the lock" "$(wait_state free 2)" "state $(state) with orphan $(cat "$W/orphan.pid" 2>/dev/null) alive"
kill -KILL "$(cat "$W/orphan.pid" 2>/dev/null)" 2>/dev/null

echo "DB LOCK SELFTEST: $PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ] && { echo "DB LOCK SELFTEST PASSED"; exit 0; }
exit 1
