// Tests for the OE board-hygiene reconciliation probe runner.
// Run: node --test scripts/open-engine/reconcile-probe.test.mjs
//
// Covers the eligibility gates, the desk-entry timestamp resolution, and the
// fail-closed contract on every probe. The network probes are exercised against
// a local http server rather than the live world, so the suite is offline-safe
// and deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import {
  checkEligibility,
  findDeskEntryTimestamp,
  hasPlanDocSource,
  runProbe,
} from "./reconcile-probe.mjs";

const DESK_EVENT = {
  event_type: "AGENT NEEDS OPERATOR",
  created_at: "2026-07-25T07:47:46.188560+00:00",
  payload: { status: "Needs Operator" },
};

const AUTO_PROMOTE_EVENT = {
  event_type: "AGENT STATUS",
  agent_code: "triage-auto",
  created_at: "2026-07-24T08:41:09.107281+00:00",
  payload: { action: "auto-promoted", status: "Agent Todo" },
};

const VALID_CHECK = {
  probe: "http_contains",
  url: "https://example.com",
  assert: "ok",
};

// ---------------------------------------------------------------------------
// Desk-entry timestamp
// ---------------------------------------------------------------------------

test("findDeskEntryTimestamp picks the most recent desk entry", () => {
  const events = [
    { ...DESK_EVENT, created_at: "2026-07-01T00:00:00.000Z" },
    { event_type: "AGENT CLAIMED", created_at: "2026-07-02T00:00:00.000Z" },
    { ...DESK_EVENT, created_at: "2026-07-20T00:00:00.000Z" },
  ];
  assert.equal(findDeskEntryTimestamp(events), "2026-07-20T00:00:00.000Z");
});

test("findDeskEntryTimestamp also catches a C3 ops-amend desk move", () => {
  // The ops-amend path writes AGENT NEEDS OPERATOR too, but a future desk-mover
  // might not; keying on payload.status keeps both reachable.
  const events = [{
    event_type: "AGENT STATUS",
    created_at: "2026-07-21T00:00:00.000Z",
    payload: { action: "ops-amend", status: "Needs Operator" },
  }];
  assert.equal(findDeskEntryTimestamp(events), "2026-07-21T00:00:00.000Z");
});

// Regression, found live 2026-07-26 while authoring the first real close_check.
// Every admin_amend writes an AGENT STATUS carrying payload.status = the row's
// CURRENT status, so amending a card already on the desk emits
// {from_status: 'Needs Operator', status: 'Needs Operator'}. Counting that as an
// arrival slid a real card's window 16 days forward just by authoring its probe,
// which would make a drop-box card permanently unclosable while looking like an
// ordinary no-match.
test("findDeskEntryTimestamp ignores a no-move ops-amend on a card already on the desk", () => {
  const events = [
    {
      event_type: "AGENT NEEDS OPERATOR",
      created_at: "2026-07-10T21:12:41.523Z",
      payload: { from_status: "Agent Review", status: "Needs Operator" },
    },
    {
      event_type: "AGENT STATUS",
      created_at: "2026-07-26T13:04:42.127Z",
      payload: {
        action: "ops-amend",
        from_status: "Needs Operator",
        status: "Needs Operator",
      },
    },
  ];
  assert.equal(findDeskEntryTimestamp(events), "2026-07-10T21:12:41.523Z");
});

test("findDeskEntryTimestamp still counts a real ops-amend desk MOVE", () => {
  // Same event type, but an actual transition onto the desk. Must count.
  const events = [{
    event_type: "AGENT NEEDS OPERATOR",
    created_at: "2026-07-20T00:00:00.000Z",
    payload: { action: "ops-amend", from_status: "Agent Todo", status: "Needs Operator" },
  }];
  assert.equal(findDeskEntryTimestamp(events), "2026-07-20T00:00:00.000Z");
});

test("findDeskEntryTimestamp counts a desk event with no from_status recorded", () => {
  // Historical events predate the field; unknown provenance must not disqualify.
  const events = [{
    event_type: "AGENT NEEDS OPERATOR",
    created_at: "2026-06-01T00:00:00.000Z",
    payload: { status: "Needs Operator" },
  }];
  assert.equal(findDeskEntryTimestamp(events), "2026-06-01T00:00:00.000Z");
});

test("findDeskEntryTimestamp returns null when the card never reached the desk", () => {
  assert.equal(findDeskEntryTimestamp([]), null);
  assert.equal(
    findDeskEntryTimestamp([{ event_type: "AGENT CLAIMED", created_at: "x" }]),
    null,
  );
});

// ---------------------------------------------------------------------------
// Eligibility gates
// ---------------------------------------------------------------------------

test("gate: a card in any status other than Needs Operator is never probed", () => {
  for (
    const status of [
      "Standing",
      "Agent Todo",
      "Agent Working",
      "Agent Needs Input",
      "Agent Review",
      "Agent Done",
    ]
  ) {
    const skipped = checkEligibility(
      { status, close_check: VALID_CHECK, sources: [] },
      [DESK_EVENT],
    );
    assert.ok(skipped, `${status} must be skipped`);
    assert.match(skipped, /not Needs Operator/);
  }
});

test("gate: a card with no close_check is never probed", () => {
  const skipped = checkEligibility(
    { status: "Needs Operator", close_check: null, sources: [] },
    [DESK_EVENT],
  );
  assert.match(skipped, /no close_check/);
});

test("gate: a plan-doc sourced card is never probed (fork R2 (a))", () => {
  const skipped = checkEligibility({
    status: "Needs Operator",
    close_check: VALID_CHECK,
    sources: ["plan-doc:docs/superpowers/plans/whatever.md"],
  }, [DESK_EVENT]);
  assert.match(skipped, /plan-doc/);
  assert.equal(hasPlanDocSource(["thought:abc"]), false);
});

// An auto-promoted card IS eligible, deliberately, because
// the only way it can carry a close_check at all is that a human authored one
// through admin_amend_agent_task -- triage is blocked at intake, and no executor
// can reach the amend verb. The old gate skipped precisely the cards where a
// human HAD made the call, and cost 6 of 7 live candidates.
test("gate: an auto-promoted card IS eligible when a human authored the check", () => {
  assert.equal(
    checkEligibility(
      { status: "Needs Operator", close_check: VALID_CHECK, sources: [] },
      [AUTO_PROMOTE_EVENT, DESK_EVENT],
    ),
    null,
  );
});

// WHERE THE REAL LOOP GUARD IS TESTED: not here. The protection that survives
// the removal above is assertCloseCheckAuthorAllowed, which refuses a
// close_check on any intake_source='triage-agent' draft. It is TypeScript and
// lives in the Edge Function, so it is covered by the deno suite instead:
//   supabase/functions/open-brain-mcp/_agent_intake_test.ts
//   -> "assertCloseCheckAuthorAllowed: refuses a triage-agent intake carrying a close_check"
//   -> "buildAgentTaskIntakeRecord: ... refuses triage-agent"
// A first draft of this file tried to import that module from node and fell back
// to a no-op when the import failed, which made the test pass unconditionally.
// A test that cannot fail is worse than no test: it advertises coverage it does
// not have. Removed and replaced with this pointer.

test("gate: a fully eligible card passes every gate", () => {
  assert.equal(
    checkEligibility(
      {
        status: "Needs Operator",
        close_check: VALID_CHECK,
        sources: ["thought:abc"],
      },
      [DESK_EVENT],
    ),
    null,
  );
});

// ---------------------------------------------------------------------------
// http_contains, against a local server
// ---------------------------------------------------------------------------

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        await run(`http://127.0.0.1:${port}`);
        resolve();
      } catch (err) {
        reject(err);
      } finally {
        server.close();
      }
    });
  });
}

test("http_contains: known-true fixture matches", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>Glitter Tattoos</title></html>");
  }, async (base) => {
    const result = await runProbe(
      { probe: "http_contains", url: `${base}/x`, assert: "Glitter Tattoos" },
      {},
    );
    assert.equal(result.match, true);
    assert.equal(result.measured_by, "plain-get");
  });
});

test("http_contains: known-false fixture is a no-op", async () => {
  await withServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html><title>Something Else</title></html>");
  }, async (base) => {
    const result = await runProbe(
      { probe: "http_contains", url: `${base}/x`, assert: "Glitter Tattoos" },
      {},
    );
    assert.equal(result.match, false);
    assert.equal(result.error, null);
  });
});

test("http_contains: a moved page (404) is a no-op, never a match", async () => {
  await withServer((_req, res) => {
    res.writeHead(404, { "content-type": "text/html" });
    // The 404 body deliberately CONTAINS the asserted string. A probe that read
    // the body without checking the status would falsely close the card.
    res.end("<html>Glitter Tattoos not found here</html>");
  }, async (base) => {
    const result = await runProbe(
      { probe: "http_contains", url: `${base}/gone`, assert: "Glitter Tattoos" },
      {},
    );
    assert.equal(result.match, false);
    assert.match(result.error, /404/);
  });
});

test("http_contains: a network error is a no-op", async () => {
  // Port 1 on loopback refuses immediately.
  const result = await runProbe(
    { probe: "http_contains", url: "http://127.0.0.1:1/x", assert: "ok" },
    {},
  );
  assert.equal(result.match, false);
  assert.ok(result.error);
});

test("http_contains: the probe identifies itself truthfully, never spoofed", async () => {
  let seenAgent = null;
  await withServer((req, res) => {
    seenAgent = req.headers["user-agent"];
    res.writeHead(200, { "content-type": "text/html" });
    res.end("ok");
  }, async (base) => {
    await runProbe(
      { probe: "http_contains", url: `${base}/x`, assert: "ok" },
      {},
    );
  });
  assert.match(seenAgent, /reconciler/);
  // The point of the test: never a browser disguise. A spoofed UA measures the
  // probe rather than the world, and cannot be audited later.
  assert.doesNotMatch(seenAgent, /Mozilla|Chrome|Safari/);
});

// ---------------------------------------------------------------------------
// wp_post_status
// ---------------------------------------------------------------------------

// The site map is read per call, so these tests configure it directly. An empty
// map is the fail-closed default and is covered by its own test below.
process.env.OE_WP_SITE_BASE_URLS = JSON.stringify({
  "example-wp": "https://example.com",
});

test("wp_post_status: an unconfigured site map is a no-op, not a match", async () => {
  const saved = process.env.OE_WP_SITE_BASE_URLS;
  delete process.env.OE_WP_SITE_BASE_URLS;
  try {
    const result = await runProbe(
      {
        probe: "wp_post_status",
        site: "example-wp",
        post_id: 1,
        assert: "publish",
      },
      { wpCredentials: { "example-wp": "u:p" } },
    );
    assert.equal(result.match, false);
    assert.match(result.error, /unknown site handle/);
  } finally {
    process.env.OE_WP_SITE_BASE_URLS = saved;
  }
});

test("wp_post_status: a missing credential is a no-op, not a match", async () => {
  const result = await runProbe(
    {
      probe: "wp_post_status",
      site: "example-wp",
      post_id: 1,
      assert: "publish",
    },
    { wpCredentials: {} },
  );
  assert.equal(result.match, false);
  assert.match(result.error, /no application password/);
});

test("wp_post_status: an unknown site handle is a no-op", async () => {
  const result = await runProbe(
    { probe: "wp_post_status", site: "nope-wp", post_id: 1, assert: "publish" },
    { wpCredentials: { "nope-wp": "u:p" } },
  );
  assert.equal(result.match, false);
  assert.match(result.error, /unknown site handle/);
});

// ---------------------------------------------------------------------------
// git_path_exists: the install-shape trap, the single highest-value test
// ---------------------------------------------------------------------------

test("git_path_exists: no desk timestamp means the since-clause is unevaluable, so no-op", async () => {
  const result = await runProbe({
    probe: "git_path_exists",
    repo: "example-owner/example-repo",
    path: "operator-dropbox/",
    assert: "new_file_since_card_entered_desk",
  }, { deskEnteredAt: null });
  assert.equal(result.match, false);
  assert.match(result.error, /since-desk clause is unevaluable/);
});

// ---------------------------------------------------------------------------
// The asymmetry rule, asserted structurally
// ---------------------------------------------------------------------------

test("no probe verb outside the allowlist can run", async () => {
  const result = await runProbe({ probe: "shell_exec", cmd: "true" }, {});
  assert.equal(result.match, false);
  assert.match(result.error, /unknown probe verb/);
});

test("every failure path returns match:false, never match:true", async () => {
  // A sweep over the reachable failure shapes. The contract this protects: there
  // is no code path in the runner that turns an error into a close.
  const failures = await Promise.all([
    runProbe({ probe: "http_contains", url: "http://127.0.0.1:1/", assert: "x" }, {}),
    runProbe({ probe: "wp_post_status", site: "example-wp", post_id: 1, assert: "publish" }, { wpCredentials: {} }),
    runProbe({ probe: "wp_post_status", site: "bogus", post_id: 1, assert: "publish" }, {}),
    runProbe({ probe: "git_path_exists", repo: "a/b", path: "p/", assert: "new_file_since_card_entered_desk" }, { deskEnteredAt: null }),
    runProbe({ probe: "nonsense" }, {}),
    runProbe({}, {}),
  ]);
  for (const result of failures) {
    assert.equal(result.match, false);
  }
});
