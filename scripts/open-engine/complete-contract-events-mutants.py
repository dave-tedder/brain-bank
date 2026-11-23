#!/usr/bin/env python3
"""Planted faults for the complete_contract_events writer (Task 5.4 follow-up,
PR 32 decision 7). The SQL side has its own sweep:
complete-contract-events-sql-test.sh --all-mutations.

    python3 scripts/open-engine/complete-contract-events-mutants.py            # controls, then every planted fault
    python3 scripts/open-engine/complete-contract-events-mutants.py --only M03 # one fault (after the controls)

Each planted fault edits exactly ONE contiguous site in a fresh copy of
supabase/, scripts/ and deno.json (a site that does not occur exactly once is
NEVER-RAN), then runs the checks named for it in that copy:
  unit   deno test of supabase/functions/open-brain-mcp/_complete_contract_events_test.ts;
         completed with failures (the summary line reads FAILED) and the named
         test among them is a catch; a type-check error or no summary line is
         NEVER-RAN.
  probe  scripts/open-engine/complete-contract-events-probe-harness.ts through
         the real open-brain-mcp entrypoint; exit 1 with the named "FAIL Qn"
         line is a catch, exit 2 is NEVER-RAN.
A fault is CAUGHT only when EVERY named check completed and failed for the
named reason. Before any fault runs, the unmutated copy must pass both checks
(else the sweep is NEVER-RAN), and three control cases must read as expected:
a site that does not occur (NEVER-RAN), a fault that breaks the type check
(NEVER-RAN, not a catch), and a probe started on a port nothing listens on
(NEVER-RAN).

Exit 0: controls as expected and every fault caught. 1: a fault survived or
failed a different check. 2: something never ran.
"""
import os
import re
import shutil
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DEADLINE = os.path.join(ROOT, "scripts", "loop-closing", "deadline.py")
INDEX = "supabase/functions/open-brain-mcp/index.ts"
MOD = "supabase/functions/open-brain-mcp/_complete_contract_events.ts"
UNIT = ["deno", "test", "--no-lock", "--allow-read", "--allow-env",
        "supabase/functions/open-brain-mcp/_complete_contract_events_test.ts"]
PROBE = ["deno", "run", "--config", "scripts/loop-closing/closeout-capture-probe.deno.json", "--no-lock",
         "--allow-net", "--allow-env", "--allow-read", "scripts/open-engine/complete-contract-events-probe-harness.ts"]
ANSI = re.compile(r"\x1b\[[0-9;]*m")

REFUSAL_CALL = """      recordCompleteContractEvent(() =>
        refusalEventRow({
          action: contractAction,
          taskId: args.taskId,
          agentCode: args.agentCode,
          slug,
          reasons: verdict.reasons,
          occurredAt: new Date(),
        })
      );
"""
WARNING_CALL = """      recordCompleteContractEvent(() =>
        warningEventRow({
          action: contractAction,
          taskId: args.taskId,
          agentCode: args.agentCode,
          slug,
          code: w.code,
          occurredAt: new Date(),
        })
      );
"""
RECORD_FN = """function recordCompleteContractEvent(build: () => ContractEventRow): void {
  try {
    const write = writeContractEvent(
      (r) => supabase.from(COMPLETE_CONTRACT_EVENTS_TABLE).insert(r),
      build(),
    );
    EdgeRuntime.waitUntil(write);
  } catch (err: unknown) {
    try {
      console.error(
        `[complete-contract] event write not scheduled: ${describeError(err)}`,
      );
    } catch {
      // telemetry about telemetry: nothing more to do, and nothing may escape
    }
  }
}
"""
RECORD_FN_UNGUARDED = """function recordCompleteContractEvent(build: () => ContractEventRow): void {
  const write = writeContractEvent(
    (r) => supabase.from(COMPLETE_CONTRACT_EVENTS_TABLE).insert(r),
    build(),
  );
  EdgeRuntime.waitUntil(write);
}
"""
SCHED_LOG_GUARD = """    try {
      console.error(
        `[complete-contract] event write not scheduled: ${describeError(err)}`,
      );
    } catch {
      // telemetry about telemetry: nothing more to do, and nothing may escape
    }
"""
FULFILLED_GUARD = """        try {
          const error = result ? result.error : null;
          if (error) report(error);
        } catch (err) {
          report(err);
        }
"""
OUTER_CATCH = """  } catch (err) {
    report(err);
    return Promise.resolve();
  }
}
"""
DESCRIBE_CATCH = """  } catch {
    return "(error value could not be formatted)";
  }
"""

def awaited(call, builder):
    body = call.split(builder + "({", 1)[1].rsplit("})", 1)[0]
    return ("      await supabase.from(COMPLETE_CONTRACT_EVENTS_TABLE).insert(" + builder + "({" + body
            + "})).then((r) => {\n        if (r.error) throw new Error(r.error.message);\n      });\n")

# id, name, file, old, new, [(check, expected)]
FAULTS = [
    ("M01", "refusal-site-writer-removed", INDEX, REFUSAL_CALL, "",
     [("probe", r"^FAIL Q1: expected exactly one complete_contract_events write, saw 0"),
      ("unit", "index.ts: each [complete-contract] log line is paired with one event write of its kind")]),
    ("M02", "warning-site-writer-removed", INDEX, WARNING_CALL, "",
     [("probe", r"^FAIL Q5: expected exactly one complete_contract_events write, saw 0"),
      ("unit", "index.ts: each [complete-contract] log line is paired with one event write of its kind")]),
    ("M03", "refused-outcome-swapped", MOD, '    outcome: "refused",\n', '    outcome: "warned",\n',
     [("probe", r"^FAIL Q1: events row outcome=\"warned\", want \"refused\""),
      ("unit", "refusalEventRow: outcome refused, reasons joined exactly as the log line prints them")]),
    ("M04", "warned-outcome-swapped", MOD, '    outcome: "warned",\n', '    outcome: "refused",\n',
     [("probe", r"^FAIL Q5: events row outcome=\"refused\", want \"warned\""),
      ("unit", "warningEventRow: outcome warned, reason is the warning code")]),
    ("M05", "reason-first-only", MOD, '    reason: args.reasons.join(","),\n', '    reason: args.reasons[0] ?? "",\n',
     [("probe", r"^FAIL Q1: events row reason="),
      ("unit", "refusalEventRow: outcome refused, reasons joined exactly as the log line prints them")]),
    ("M06", "insert-error-propagated", MOD, FULFILLED_GUARD,
     "        if (result && result.error) throw new Error(describeError(result.error));\n",
     [("unit", "writeContractEvent: an insert error resolves (never rejects) and is logged once")]),
    ("M07", "rejection-propagated", MOD,
     "      (err) => {\n        report(err);\n      },\n",
     "      (err) => {\n        throw err;\n      },\n",
     [("unit", "writeContractEvent: a rejected insert resolves and is logged once")]),
    ("M08", "sync-throw-propagated", MOD, OUTER_CATCH, "  } finally {\n    // no guard\n  }\n}\n",
     [("unit", "writeContractEvent: an insert that throws synchronously does not throw and is logged once")]),
    ("M09", "refusal-insert-awaited-propagates", INDEX, REFUSAL_CALL, awaited(REFUSAL_CALL, "refusalEventRow"),
     [("probe", r"^FAIL Q8: the refusal answer changed when the events insert failed \(error\)")]),
    ("M10", "warning-insert-awaited-propagates", INDEX, WARNING_CALL, awaited(WARNING_CALL, "warningEventRow"),
     [("probe", r"^FAIL Q8: the warned answer changed when the events insert failed \(error\)")]),
    ("M11", "schedule-error-propagated", INDEX, RECORD_FN, RECORD_FN_UNGUARDED,
     [("probe", r"^FAIL Q10: the refusal answer changed when waitUntil threw")]),
    ("M12", "writer-never-inserts", MOD, "    return Promise.resolve(insert(row)).then(\n",
     "    return Promise.resolve({ error: null } as ContractEventInsertResult).then(\n",
     [("probe", r"^FAIL Q1: expected exactly one complete_contract_events write, saw 0"),
      ("unit", "writeContractEvent: inserts the row once and logs nothing on success")]),
    ("M13", "describe-unguarded", MOD, DESCRIBE_CATCH, "  } finally {\n    // no guard\n  }\n",
     [("unit", "describeError never throws: no primitive conversion, a throwing message getter, ordinary values")]),
    ("M15", "occurred-at-not-the-emission-moment", MOD, "    occurred_at: args.occurredAt.toISOString(),\n  };\n}\n\n// The row for one",
     "    occurred_at: new Date(0).toISOString(),\n  };\n}\n\n// The row for one",
     [("probe", r"^FAIL Q1: occurred_at .* is not inside the call window"),
      ("unit", "refusalEventRow: outcome refused, reasons joined exactly as the log line prints them")]),
    ("M16", "warning-tool-forced", MOD,
     '    tool: contractEventTool(args.action),\n    task_id: textOrNull(args.taskId),\n    agent_code: textOrNull(args.agentCode),\n    outcome: "warned",\n',
     '    tool: "complete_agent_task",\n    task_id: textOrNull(args.taskId),\n    agent_code: textOrNull(args.agentCode),\n    outcome: "warned",\n',
     [("probe", r"^FAIL Q13: events row tool=\"complete_agent_task\", want \"request_agent_review\""),
      ("unit", "warningEventRow: request-review names request_agent_review")]),
    ("M14", "scheduler-log-unguarded", INDEX, SCHED_LOG_GUARD,
     "    console.error(`[complete-contract] event write not scheduled: ${String(err)}`);\n",
     [("probe", r"^FAIL Q11: the answer changed when waitUntil threw an opaque value")]),
]

# Controls: (id, description, file, old, new, check, env)
CONTROLS = [
    ("C1", "a site that does not occur", MOD, "this text is not in the module\n", "", None, None),
    ("C2", "a fault that breaks the type check", MOD, '    outcome: "refused",\n', "    outcome: 42,\n", "unit", None),
    ("C3", "a probe on a port nothing listens on", None, None, None, "probe", {"OBCE_PROBE_INJECT": "bad-port"}),
]


def copy_tree():
    work = tempfile.mkdtemp(prefix="obce-mut.")
    for d in ("supabase", "scripts"):
        shutil.copytree(os.path.join(ROOT, d), os.path.join(work, d),
                        ignore=shutil.ignore_patterns("node_modules", ".git"))
    shutil.copy(os.path.join(ROOT, "deno.json"), os.path.join(work, "deno.json"))
    return work


def plant(work, rel, old, new):
    path = os.path.join(work, rel)
    with open(path) as f:
        s = f.read()
    if s.count(old) != 1:
        return False
    with open(path, "w") as f:
        f.write(s.replace(old, new))
    return True


def run(work, cmd, env_extra=None, secs=300):
    env = dict(os.environ)
    env.pop("OBCE_PROBE_INJECT", None)
    if env_extra:
        env.update(env_extra)
    p = subprocess.run(["python3", DEADLINE, str(secs)] + cmd, cwd=work, env=env,
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return p.returncode, ANSI.sub("", p.stdout)


def unit_verdict(code, out):
    """0 passed, 1 completed with failures (returns failing names), 2 never ran."""
    m = re.search(r"^(ok|FAILED) \| (\d+) passed(?: \(\d+ steps?\))? \| (\d+) failed", out, re.M)
    if not m:
        lines = out.strip().splitlines()
        why = next((l.strip() for l in lines if re.search(r"TS\d{4}|^error:", l.strip())), lines[-1] if lines else "")
        return 2, "no deno test summary line (type check or load failure): " + why[:200], []
    failed = int(m.group(3))
    if m.group(1) == "ok" and failed == 0 and code == 0:
        return 0, f"{m.group(2)} passed", []
    if m.group(1) == "FAILED" and failed > 0 and code != 0:
        sect = out.split(" FAILURES ", 1)[1] if " FAILURES " in out else ""
        names = [l.split(" => ")[0].strip() for l in sect.splitlines() if " => " in l]
        return 1, f"{failed} failed", names
    return 2, f"inconsistent deno result: exit {code}, summary {m.group(0)}", []


def probe_verdict(code, out):
    first = next((l for l in out.splitlines() if l.startswith(("FAIL ", "NEVER-RAN"))), "")
    if code == 0 and "COMPLETE CONTRACT EVENTS PROBE PASSED" in out:
        return 0, "passed", first
    if code == 1 and first.startswith("FAIL "):
        return 1, first, first
    return 2, first or f"exit {code}: {out.strip().splitlines()[-1:] or ['']}", first


def check(work, kind, env_extra=None):
    if kind == "unit":
        code, out = run(work, UNIT, env_extra)
        v, detail, names = unit_verdict(code, out)
        return v, detail, names
    code, out = run(work, PROBE, env_extra)
    v, detail, first = probe_verdict(code, out)
    return v, detail, [first]


def main():
    only = sys.argv[sys.argv.index("--only") + 1] if "--only" in sys.argv else None
    # Unmutated copy first.
    base = copy_tree()
    try:
        for kind in ("unit", "probe"):
            v, detail, _ = check(base, kind)
            if v != 0:
                print(f"NEVER-RAN: the unmutated copy does not pass {kind} ({detail}); no fault can be judged")
                return 2
            print(f"CONTROL baseline {kind}: passed ({detail})")
    finally:
        shutil.rmtree(base, ignore_errors=True)
    bad_controls = 0
    for cid, desc, rel, old, new, kind, env in CONTROLS:
        work = copy_tree()
        try:
            if rel is not None and not plant(work, rel, old, new):
                print(f"AS-EXPECTED {cid} {desc}: NEVER-RAN (the site does not occur exactly once)")
                continue
            v, detail, _ = check(work, kind, env)
            if v == 2:
                print(f"AS-EXPECTED {cid} {desc}: NEVER-RAN ({detail})")
            else:
                bad_controls += 1
                print(f"UNEXPECTED {cid} {desc}: verdict {v} ({detail})")
        finally:
            shutil.rmtree(work, ignore_errors=True)
    if bad_controls:
        print(f"NEVER-RAN: {bad_controls} control case(s) did not read NEVER-RAN; the verdicts cannot be trusted")
        return 2
    caught = survived = wrong = never = 0
    for fid, name, rel, old, new, checks in FAULTS:
        if only and fid != only:
            continue
        work = copy_tree()
        try:
            if not plant(work, rel, old, new):
                never += 1
                print(f"NEVER-RAN {fid} {name}: the site does not occur exactly once")
                continue
            outcome, notes = "CAUGHT", []
            for kind, want in checks:
                v, detail, names = check(work, kind)
                if v == 2:
                    outcome = "NEVER-RAN"; notes.append(f"{kind}: never ran ({detail})"); break
                if v == 0:
                    if outcome == "CAUGHT":
                        outcome = "SURVIVED"
                    notes.append(f"{kind}: passed"); continue
                ok = (want in names) if kind == "unit" else bool(re.search(want, names[0] or ""))
                if not ok:
                    if outcome == "CAUGHT":
                        outcome = "WRONG-CHECK"
                    notes.append(f"{kind}: failed but not as named ({'; '.join(n for n in names if n)[:200]})")
                else:
                    notes.append(f"{kind}: {(names[0] if kind == 'probe' else want)[:160]}")
            print(f"{outcome} {fid} {name}: " + " | ".join(notes))
            if outcome == "CAUGHT":
                caught += 1
            elif outcome == "SURVIVED":
                survived += 1
            elif outcome == "WRONG-CHECK":
                wrong += 1
            else:
                never += 1
        finally:
            shutil.rmtree(work, ignore_errors=True)
    n = caught + survived + wrong + never
    print(f"SWEEP: {n} planted faults, {caught} caught, {survived} survived, {wrong} failed a different check, {never} never ran")
    if never:
        return 2
    if survived or wrong:
        return 1
    print(f"ALL {n} PLANTED FAULTS CAUGHT")
    return 0


if __name__ == "__main__":
    sys.exit(main())
