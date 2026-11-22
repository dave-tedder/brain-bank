#!/usr/bin/env python3
"""Run one command under a hard deadline, in its own process group.

    python3 scripts/loop-closing/deadline.py <seconds> <command> [args...]

Exit status is the command's own, or 124 when the deadline expired. On expiry
the whole process group gets SIGTERM, then SIGKILL five seconds later, so a
runner's EXIT trap can stop its own throwaway cluster before the hard kill.
124 always means the command did NOT finish: a caller must classify it as
NEVER-RAN, never as a pass or a caught mutation.

When OBRP_STATE_FILE is set, the runner writes its throwaway cluster directory
there; after a deadline this wrapper stops that cluster with pg_ctl and removes
the directory, in case the runner's own trap never got to run.
"""
import os
import shutil
import signal
import subprocess
import sys


def reap_cluster(state_file):
    if not state_file or not os.path.exists(state_file):
        return
    try:
        work = open(state_file).read().strip()
    except OSError:
        return
    if not work or not work.startswith("/tmp/obrp."):
        return
    pgdata = os.path.join(work, "pg")
    if os.path.exists(os.path.join(pgdata, "postmaster.pid")):
        subprocess.run(["pg_ctl", "-D", pgdata, "stop", "-m", "immediate"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=30)
    shutil.rmtree(work, ignore_errors=True)


def main():
    if len(sys.argv) < 3:
        print("usage: deadline.py <seconds> <command> [args...]", file=sys.stderr)
        return 2
    seconds = float(sys.argv[1])
    cmd = sys.argv[2:]
    p = subprocess.Popen(cmd, start_new_session=True)

    # When THIS wrapper is terminated (an outer deadline killing our group), pass it
    # on to the child's own group, so nothing is orphaned, and report NEVER-RAN.
    def forward(signum, _frame):
        try:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(timeout=5)
        except (ProcessLookupError, subprocess.TimeoutExpired):
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        reap_cluster(os.environ.get("OBRP_STATE_FILE"))
        print(f"NEVER-RAN: interrupted by signal {signum}: {' '.join(cmd)[:160]}", flush=True)
        sys.exit(124)

    signal.signal(signal.SIGTERM, forward)
    signal.signal(signal.SIGINT, forward)
    signal.signal(signal.SIGHUP, forward)
    try:
        return p.wait(timeout=seconds)
    except subprocess.TimeoutExpired:
        try:
            os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            p.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            p.wait()
        reap_cluster(os.environ.get("OBRP_STATE_FILE"))
        print(f"NEVER-RAN: deadline of {seconds:g}s exceeded: {' '.join(cmd)[:160]}", flush=True)
        return 124


if __name__ == "__main__":
    sys.exit(main())
