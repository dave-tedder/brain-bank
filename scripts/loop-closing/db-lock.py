#!/usr/bin/env python3
"""The shared local-database lock for every harness that starts a throwaway
PostgreSQL cluster. The operating system releases it when its holder dies, so
no interrupted run can leave it behind.

It replaces the old `mkdir /tmp/ob-db.lock` scheme. That lock was a directory a
run had to remove on its way out, and every way a run could die before the
`rmdir` (SIGKILL, a process-group SIGINT that killed `rmdir` itself, a second
signal during EXIT cleanup) stranded it; later runs then waited 150 minutes and
exited NEVER-RAN. This lock is an flock(2) on /tmp/ob-db.flock, held by a
process whose lifetime is tied to the run. A dead holder holds nothing, so
there is nothing to clean up and nothing ever to remove by hand.

Three modes:

  db-lock.py run --label NAME [--wait-min N] -- <command> [args...]
      Take the lock, run the command, release when it exits. Exit status is the
      command's own (128+N when a signal ended it), or 2 with a NEVER-RAN line
      when the lock could not be had. Use this for ad-hoc callers (an evidence
      runner, a reviewer's shell). The lock file is opened close-on-exec, so a
      cluster or watchdog the command leaves running never inherits it.

  db-lock.py hold --label NAME [--wait-min N]
      For scripts/loop-closing/db-lock.sh only. Waits for the lock, then prints
      one line on stdout (ACQUIRED, TIMEOUT or ERROR) and keeps the lock until
      it is killed (db-lock.sh releases with SIGKILL, which cannot be ignored or
      lost) or until its parent, the bash script that started it, is gone,
      checked every 0.2 s. INT, TERM and HUP are ignored once it holds the lock,
      so a signal to the whole group lets the script run its cleanup first.

      Known gap, by design: if the HOLDER alone is SIGKILLed while its script
      lives on, the lock is free while the script still works. Nothing does
      that except db-lock.sh's own release.

  db-lock.py verify --holder-pid PID
      Exit 0 only when the lock is held right now, PID is alive, and the owner
      note names PID as the holder. Lets a nested run trust OB_DB_LOCK_HELD=1
      without taking the lock again (which would wait on its own parent).

While waiting, a line goes to stderr every report interval (default 60 s):
"waiting for /tmp/ob-db.flock (held by <owner note>), minute N". The owner
note (/tmp/ob-db.flock.owner) is information only: it is never read to decide
whether the lock is free, and it is never removed.

Environment: OB_DB_LOCK_FILE (default /tmp/ob-db.flock), OB_DB_LOCK_WAIT_MIN
(default 150, fractions allowed), OB_DB_LOCK_REPORT_SEC (default 60).
"""
import argparse
import datetime
import errno
import fcntl
import os
import signal
import subprocess
import sys
import time

LOCK_FILE = os.environ.get("OB_DB_LOCK_FILE", "/tmp/ob-db.flock")
OWNER_FILE = LOCK_FILE + ".owner"


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def owner_note():
    try:
        with open(OWNER_FILE) as f:
            return f.read().strip() or "no owner note"
    except OSError:
        return "no owner note"


def write_owner(label, script_pid, holder_pid):
    try:
        with open(OWNER_FILE, "w") as f:
            f.write(f"{label} script-pid {script_pid} holder-pid {holder_pid} since {now()}\n")
    except OSError:
        pass  # information only


def try_lock(fd):
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return True
    except OSError as e:
        if e.errno in (errno.EWOULDBLOCK, errno.EAGAIN):
            return False
        raise


def acquire(wait_min, report_sec, gone=None):
    """Return (fd, waited_seconds), or (None, waited_seconds) on timeout or when
    gone() says the caller has died while waiting."""
    fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CREAT | os.O_CLOEXEC, 0o666)
    start = time.monotonic()
    next_report = report_sec
    minute = 0
    while True:
        if try_lock(fd):
            return fd, time.monotonic() - start
        waited = time.monotonic() - start
        if waited >= wait_min * 60:
            os.close(fd)
            return None, waited
        if gone is not None and gone():
            os.close(fd)
            return None, waited
        if waited >= next_report:
            print(f"waiting for {LOCK_FILE} (held by {owner_note()}), minute {minute}", file=sys.stderr, flush=True)
            minute += 1
            next_report += report_sec
        time.sleep(min(1.0, max(0.05, wait_min * 60 - waited)))


def timeout_line(waited):
    return (f"NEVER-RAN: {LOCK_FILE} held by another run for {waited / 60:.1f} minute(s) "
            f"({owner_note()}); nothing removed, the lock frees itself when its holder exits")


def cmd_run(a):
    if not a.command:
        print("NEVER-RAN: db-lock.py run needs a command after --", flush=True)
        return 2
    if os.environ.get("OB_DB_LOCK_HELD") == "1" and verify(os.environ.get("OB_DB_LOCK_HOLDER", "")):
        # An enclosing run already holds it for this process tree.
        os.execvp(a.command[0], a.command)
    fd, waited = acquire(a.wait_min, a.report_sec)
    if fd is None:
        print(timeout_line(waited), flush=True)
        return 2
    me = os.getpid()
    write_owner(a.label, me, me)
    env = dict(os.environ, OB_DB_LOCK_HELD="1", OB_DB_LOCK_HOLDER=str(me))
    try:
        child = subprocess.Popen(a.command, env=env)
    except OSError as e:
        print(f"NEVER-RAN: could not start {a.command[0]}: {e}", flush=True)
        return 2
    # Hold until the child is done, whatever signal the group gets.
    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, signal.SIG_IGN)
    rc = child.wait()
    return 128 - rc if rc < 0 else rc


def cmd_hold(a):
    # Inherited descriptors (a caller's pipe, a psql connection FIFO) must not be
    # kept open by a process that outlives the work by up to 0.2 s, or a reader
    # waiting for EOF on them would wait on the lock instead.
    os.closerange(3, os.sysconf("SC_OPEN_MAX") if os.sysconf("SC_OPEN_MAX") > 0 else 1024)
    parent = os.getppid()
    gone = lambda: os.getppid() != parent
    try:
        fd, waited = acquire(a.wait_min, a.report_sec, gone)
    except OSError as e:
        print(f"ERROR could not open or lock {LOCK_FILE}: {e}", flush=True)
        return 2
    if fd is None:
        if not gone():
            print(f"TIMEOUT {timeout_line(waited)}", flush=True)
        return 3
    for s in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(s, signal.SIG_IGN)
    write_owner(a.label, parent, os.getpid())
    print(f"ACQUIRED after {waited:.0f}s", flush=True)
    # Nothing more is written anywhere: let go of the reader's pipe and the
    # caller's stderr, so neither is held open by the lock.
    devnull = os.open(os.devnull, os.O_RDWR)
    for target in (0, 1, 2):
        os.dup2(devnull, target)
    os.close(devnull)
    while os.getppid() == parent:
        time.sleep(0.2)
    return 0  # exit closes fd: the lock is free


def verify(pid_text):
    try:
        pid = int(pid_text)
        os.kill(pid, 0)
    except (ValueError, OSError):
        return False
    try:
        fd = os.open(LOCK_FILE, os.O_RDWR | os.O_CLOEXEC)
    except OSError:
        return False
    try:
        if try_lock(fd):  # free: nobody holds it, so the claim is false
            return False
    finally:
        os.close(fd)
    return f" holder-pid {pid} " in f" {owner_note()} "


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="mode", required=True)
    wait_default = float(os.environ.get("OB_DB_LOCK_WAIT_MIN", "150"))
    report_default = float(os.environ.get("OB_DB_LOCK_REPORT_SEC", "60"))
    for name in ("run", "hold"):
        s = sub.add_parser(name)
        s.add_argument("--label", required=True)
        s.add_argument("--wait-min", type=float, default=wait_default)
        s.add_argument("--report-sec", type=float, default=report_default)
        if name == "run":
            s.add_argument("command", nargs=argparse.REMAINDER)
    v = sub.add_parser("verify")
    v.add_argument("--holder-pid", required=True)
    a = p.parse_args()
    if a.mode == "run":
        if a.command and a.command[0] == "--":
            a.command = a.command[1:]
        return cmd_run(a)
    if a.mode == "hold":
        return cmd_hold(a)
    return 0 if verify(a.holder_pid) else 1


if __name__ == "__main__":
    sys.exit(main())
