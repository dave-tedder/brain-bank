import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { formatSentinelReport } from "./sentinel-report.ts";

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
