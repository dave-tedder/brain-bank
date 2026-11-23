# Sourced, not run. The shared local-database lock for bash harnesses; see
# db-lock.py beside this file for why it replaced the mkdir lock.
#
#   . "$ROOT/scripts/loop-closing/db-lock.sh"
#   ob_db_lock_acquire <label> || never "$OB_DB_LOCK_ERROR"   # 0 held, 2 not
#   ...                                                         # cluster work
#   ob_db_lock_release                                          # optional
#
# The lock is held by a small db-lock.py process started by this script; it
# lets go when ob_db_lock_release kills it, or by itself within 0.2 s of this
# script's death, however the script dies. So release is a courtesy, never a
# duty: a run killed at any instant leaves nothing behind.
#
# Nested runs: acquire exports OB_DB_LOCK_HELD=1 and OB_DB_LOCK_HOLDER=<pid>.
# A child harness that sees them and can verify them (the lock is held and the
# owner note names that live holder) uses the parent's hold instead of waiting
# on it; it never releases what it did not take.
#
# Never use a bare `wait` (no pid) in a script that holds this lock: the holder
# is a background child that runs until release.

# OB_DB_LOCK_HELPER may point at another copy of db-lock.py (the self-test's
# planted faults use it); normally it is the copy beside this file.
OB_DB_LOCK_HELPER="${OB_DB_LOCK_HELPER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/db-lock.py}"
OB_DB_LOCK_MINE=0
OB_DB_LOCK_PID=""
OB_DB_LOCK_ERROR=""

ob_db_lock_acquire() {
  local label="${1:?ob_db_lock_acquire needs a label}" d line=""
  if [ "${OB_DB_LOCK_HELD:-0}" = 1 ] && python3 "$OB_DB_LOCK_HELPER" verify --holder-pid "${OB_DB_LOCK_HOLDER:-}" 2>/dev/null; then
    return 0
  fi
  unset OB_DB_LOCK_HELD OB_DB_LOCK_HOLDER
  d="$(mktemp -d /tmp/ob-db-lock.XXXXXX)" || { OB_DB_LOCK_ERROR="could not create a temporary directory for the lock handshake"; return 2; }
  if ! mkfifo "$d/answer"; then
    rm -rf "$d"; OB_DB_LOCK_ERROR="could not create the lock handshake pipe"; return 2
  fi
  python3 "$OB_DB_LOCK_HELPER" hold --label "$label" >| "$d/answer" &
  OB_DB_LOCK_PID=$!
  read -r line < "$d/answer"
  rm -rf "$d"
  case "$line" in
    ACQUIRED*)
      OB_DB_LOCK_MINE=1
      OB_DB_LOCK_HELD=1; OB_DB_LOCK_HOLDER="$OB_DB_LOCK_PID"
      export OB_DB_LOCK_HELD OB_DB_LOCK_HOLDER
      return 0;;
    TIMEOUT\ *) OB_DB_LOCK_ERROR="${line#TIMEOUT NEVER-RAN: }";;
    ERROR\ *) OB_DB_LOCK_ERROR="${line#ERROR }";;
    *) OB_DB_LOCK_ERROR="the lock helper exited without an answer (${line:-no output})";;
  esac
  wait "$OB_DB_LOCK_PID" 2>/dev/null
  OB_DB_LOCK_PID=""
  return 2
}

ob_db_lock_release() {
  [ "$OB_DB_LOCK_MINE" = 1 ] || return 0
  OB_DB_LOCK_MINE=0
  # SIGKILL: the kernel closes the holder's descriptor, which is the release.
  # Nothing can catch or delay it, so this never waits on a stuck helper.
  kill -KILL "$OB_DB_LOCK_PID" 2>/dev/null
  wait "$OB_DB_LOCK_PID" 2>/dev/null
  OB_DB_LOCK_PID=""
  unset OB_DB_LOCK_HELD OB_DB_LOCK_HOLDER
  return 0
}
