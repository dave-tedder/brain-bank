import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  formatReconcilerReport,
  formatSentinelReport,
} from "./sentinel-report.ts";

const NOW = "2026-07-11T10:05:00.000Z"; // 6:05 AM ET (EDT)

Deno.test("fresh same-ET-day PASS verdict passes through verbatim", () => {
  const out = formatSentinelReport(
    {
      last_heartbeat: "2026-07-11T09:02:00.000Z", // 5:02 AM ET today
      last_queue_result:
        "OE-SENTINEL PASS 2026-07-11: spine fresh; local 4/4 fresh; board clean",
    },
    NOW,
  );
  assertEquals(
    out,
    "*Ops sentinel:* OE-SENTINEL PASS 2026-07-11: spine fresh; local 4/4 fresh; board clean",
  );
});

Deno.test("stale heartbeat (yesterday ET) reports the sentinel itself as missed", () => {
  const out = formatSentinelReport(
    {
      last_heartbeat: "2026-07-10T09:01:00.000Z",
      last_queue_result: "OE-SENTINEL PASS 2026-07-10: spine fresh",
    },
    NOW,
  );
  assertEquals(
    out,
    "*Ops sentinel MISSED:* no run recorded today (last: 2026-07-10). The scheduled sentinel did not fire.",
  );
});

Deno.test("missing row reports never-ran", () => {
  assertEquals(
    formatSentinelReport(null, NOW),
    "*Ops sentinel:* no run recorded yet.",
  );
});

Deno.test("fresh heartbeat but non-sentinel queue_result flags shape drift", () => {
  const out = formatSentinelReport(
    { last_heartbeat: "2026-07-11T09:02:00.000Z", last_queue_result: "ok" },
    NOW,
  );
  assertEquals(
    out,
    "*Ops sentinel:* ran today but left no OE-SENTINEL verdict line (got: \"ok\").",
  );
});

Deno.test("reconciler: no ledger row prints NO LINE, not a warning", () => {
  // The lesson this encodes: a check that has never once passed is a bug in the
  // check. Before the lane is installed there is nothing to report, and a daily
  // "no run recorded yet" would train the reader to skip the line, which is how
  // a real miss later goes unnoticed. This is the path a fork that never
  // installs the reconciler takes every single morning.
  assertEquals(formatReconcilerReport(null, NOW), null);
  assertEquals(
    formatReconcilerReport({
      last_heartbeat: null,
      last_queue_result: null,
    }, NOW),
    null,
  );
});

Deno.test("reconciler: fresh verdict renders without the machine prefix", () => {
  assertEquals(
    formatReconcilerReport({
      last_heartbeat: "2026-07-11T09:17:00.000Z", // 5:17 AM ET today
      last_queue_result:
        "OE-RECONCILE 2 closed (711039ee, d3a23233); 3 probed no match; 18 skipped; 0 errors",
    }, NOW),
    "*Reconciled:* 2 closed (711039ee, d3a23233); 3 probed no match; 18 skipped; 0 errors",
  );
});

Deno.test("reconciler: once installed, a missed run IS reported", () => {
  // The absence only becomes information after the row exists.
  assertEquals(
    formatReconcilerReport({
      last_heartbeat: "2026-07-10T09:17:00.000Z",
      last_queue_result: "OE-RECONCILE 0 closed",
    }, NOW),
    "*Reconciled MISSED:* no run recorded today (last: 2026-07-10). The scheduled reconciler did not fire.",
  );
});

Deno.test("reconciler: ran today but left no verdict line is called out", () => {
  assertEquals(
    formatReconcilerReport({
      last_heartbeat: "2026-07-11T09:17:00.000Z",
      last_queue_result: "ok",
    }, NOW),
    '*Reconciled:* ran today but left no OE-RECONCILE verdict line (got: "ok").',
  );
});
