#!/usr/bin/env python3
"""Loop-closing Task 5.3: the contract-side control cases of
client-identity-sql-test.sh --inject-selftest.

    python3 scripts/loop-closing/client-identity-controls.py <name> <contract> <copy> <anchor>

Writes a copy of the SQL contract with one control case planted. Each plant
raises "OBCI_INJECT_REACHED <name>" from inside the planted code, so the
self-test can tell the plant ran. Every site must match exactly once, or the
script exits 1 (the runner then reports NEVER-RAN). contract_truncated needs
no plant here beyond dropping the completion line (the runner prints its
marker).
"""
import sys


def reached(name: str) -> str:
    return f"do $obci$ begin raise notice 'OBCI_INJECT_REACHED {name}'; end $obci$;\n"


def main() -> int:
    name, src, dst, anchor = sys.argv[1:5]
    s = open(src).read()

    def before_anchor(text: str) -> bool:
        nonlocal s
        if s.count(anchor) != 1:
            return False
        s = s.replace(anchor, text + anchor)
        return True

    def swap(old: str, new: str) -> bool:
        nonlocal s
        if s.count(old) != 1:
            return False
        s = s.replace(old, new)
        return True

    ok = True
    if name == "contract_undefined_table":
        ok = before_anchor(reached(name) + "select * from public.obci_missing_table;\n")
    elif name == "contract_timeout":
        ok = before_anchor(reached(name) + "set statement_timeout = 50;\nselect pg_sleep(2);\n")
    elif name == "contract_planted_fail":
        ok = before_anchor(reached(name) + "select pg_temp.ck('P01', false, 'obci planted completed failure');\n")
    elif name == "contract_spaces_path_fail":
        ok = before_anchor(reached(name) + "select pg_temp.ck('M01', false, 'obci planted completed failure in a checkout path with spaces');\n")
    elif name == "contract_unknown_check_id":
        ok = before_anchor(reached(name) + "select pg_temp.ck('INJ', false, 'obci a check id the runner does not expect');\n")
    elif name == "contract_nested_diagnostic":
        ok = before_anchor(reached(name) +
                           "do $obci$ begin raise exception 'obci nested ERROR:  OBC01: FAIL M01: not the outer diagnostic' using errcode = '22023'; end $obci$;\n")
    elif name == "contract_m03_other_error":
        ok = swap("    insert into public.action_items (description, status, client_id)\n    values ('orphan', 'open', '00000000-0000-4000-8000-0000000000ff');",
                  "    raise notice 'OBCI_INJECT_REACHED contract_m03_other_error';\n    insert into public.obci_m03_missing (description) values ('orphan');")
    elif name == "contract_checks_skipped":
        ok = swap("  if p_ok is distinct from true then", "  return;\n  if p_ok is distinct from true then") and \
            swap("\\set ON_ERROR_STOP 1\n", "\\set ON_ERROR_STOP 1\n" + reached(name))
    elif name == "contract_truncated":
        ok = swap("select 'CONTRACT COMPLETE';\n", "")
    else:
        print(f"unknown control case {name}", file=sys.stderr)
        return 1
    if not ok:
        print(f"control case {name}: a site did not match exactly once", file=sys.stderr)
        return 1
    open(dst, "w").write(s)
    return 0


if __name__ == "__main__":
    sys.exit(main())
