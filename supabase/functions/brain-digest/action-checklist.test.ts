import {
  assert,
  assertEquals,
} from "jsr:@std/assert@1.0.19";
import { renderOpenActionChecklist } from "./action-checklist.ts";

Deno.test("renderOpenActionChecklist: renders exact row descriptions and ids", () => {
  const md = renderOpenActionChecklist([
    {
      id: "action-1",
      description: "Confirm Jane Doe appointment time",
      created_at: "2026-06-18T12:00:00Z",
    },
    {
      id: "action-2",
      description: "Send Sam Smith the bookkeeping export",
      created_at: "2026-06-18T12:01:00Z",
    },
  ]);

  assertEquals(
    md,
    [
      "## Open Action Items",
      "",
      "- [ ] Confirm Jane Doe appointment time (action-1)",
      "- [ ] Send Sam Smith the bookkeeping export (action-2)",
    ].join("\n"),
  );
});

Deno.test("renderOpenActionChecklist: adds cap wording when more rows are open", () => {
  const md = renderOpenActionChecklist(
    [
      {
        id: "action-1",
        description: "Confirm Jane Doe appointment time",
        created_at: "2026-06-18T12:00:00Z",
      },
    ],
    3,
  );

  assert(md.includes("Showing 1 of 3 open action items"));
  assert(md.includes("2 more remain open"));
});

Deno.test("renderOpenActionChecklist: cannot invent event context without a row", () => {
  const md = renderOpenActionChecklist([
    {
      id: "action-1",
      description: "Send Sam Smith the bookkeeping export",
      created_at: "2026-06-18T12:01:00Z",
    },
  ]);

  assertEquals(md.includes("July 5"), false);
  assertEquals(md.includes("launch"), false);
});

Deno.test("renderOpenActionChecklist: no rows renders no checklist", () => {
  assertEquals(renderOpenActionChecklist([], 0), "");
});

// ---------------------------------------------------------------------------
// Loop-closing Task 3.3: triage tags and the 25 + 15 slot split.
// Fixtures are sized PAST every bound they test (more than 15 reserved
// candidates, more than 40 rows), so a cap that did nothing would show.
// ---------------------------------------------------------------------------

import {
  buildOpenActionChecklist,
  CHECKLIST_CAP,
  type DigestActionRow,
  isReservedItem,
  RESERVED_SLOTS,
  selectChecklistRows,
  triageTag,
} from "./action-checklist.ts";

const CLIENTS = ["Jordan Lee", "Avery Jordans", "Paul Reyes", "Mira"];
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const day = (n: number) => new Date(T0 + n * DAY).toISOString();
const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function row(n: number, over: Partial<DigestActionRow> = {}): DigestActionRow {
  return { id: uid(n), description: `plain item ${n}`, created_at: day(n), ...over };
}
function proposal(n: number, reviewedDay: number, over: Partial<DigestActionRow> = {}): DigestActionRow {
  return row(n, {
    last_reviewed_at: day(reviewedDay),
    review_outcome: "proposal",
    triage_disposition: "stale",
    triage_evidence: "no activity since spring",
    ...over,
  });
}
function kept(n: number, reviewedDay: number): DigestActionRow {
  return row(n, { last_reviewed_at: day(reviewedDay), review_outcome: "keep" });
}

Deno.test("triageTag: duplicate names the full replacement id", () => {
  assertEquals(
    triageTag(proposal(1, 300, { triage_disposition: "duplicate", triage_replacement_id: uid(77) })),
    `triage: duplicate of ${uid(77)}`,
  );
});

Deno.test("triageTag: done names its evidence pointer", () => {
  assertEquals(
    triageTag(proposal(1, 300, { triage_disposition: "done", triage_evidence: "thought:1a2b3c4d shipped in S440" })),
    "triage: done per thought:1a2b3c4d shipped in S440",
  );
});

Deno.test("triageTag: stale, vague and paused carry their evidence in brackets", () => {
  for (const d of ["stale", "vague", "paused"]) {
    assertEquals(
      triageTag(proposal(1, 300, { triage_disposition: d, triage_evidence: "why" })),
      `triage: ${d} (why)`,
    );
  }
});

Deno.test("triageTag: a keep, an unreviewed row and a proposal with no disposition carry no tag", () => {
  assertEquals(triageTag(kept(1, 300)), "");
  assertEquals(triageTag(row(1)), "");
  assertEquals(triageTag(row(1, { review_outcome: "proposal", triage_disposition: null })), "");
  // The disposition alone is not a proposal: the outcome decides.
  assertEquals(triageTag(row(1, { review_outcome: "keep", triage_disposition: "stale", triage_evidence: "x" })), "");
});

Deno.test("triageTag: evidence is one line and capped at 80 characters", () => {
  const tag = triageTag(proposal(1, 300, { triage_evidence: `first\nsecond   third ${"x".repeat(200)}` }));
  assertEquals(tag.includes("\n"), false);
  assert(tag.startsWith("triage: stale (first second third x"));
  assertEquals(tag.length, "triage: stale ()".length + 80);
  assert(tag.endsWith("…)"));
});

Deno.test("triageTag: a duplicate whose replacement row is gone says so instead of printing null", () => {
  assertEquals(
    triageTag(proposal(1, 300, { triage_disposition: "duplicate", triage_replacement_id: null })),
    "triage: duplicate (the other item no longer exists)",
  );
});

Deno.test("renderOpenActionChecklist: the tag follows the id, and an untagged line is unchanged", () => {
  const md = renderOpenActionChecklist([
    proposal(1, 300, { description: "Research VA rules", triage_disposition: "duplicate", triage_replacement_id: uid(9) }),
    row(2, { description: "Send the estimate" }),
  ]);
  assertEquals(
    md,
    [
      "## Open Action Items",
      "",
      `- [ ] Research VA rules (${uid(1)}) [triage: duplicate of ${uid(9)}]`,
      `- [ ] Send the estimate (${uid(2)})`,
    ].join("\n"),
  );
});

Deno.test("isReservedItem: a deadline or a client; not a bare reference date, not one shared-with-nobody first name", () => {
  assert(isReservedItem(row(1, { description: "flip the venue listing by 2027-03-01" }), CLIENTS));
  assert(isReservedItem(row(1, { description: "send Paul Reyes the stencil" }), CLIENTS));
  assert(isReservedItem(row(1, { description: "nudge Jordan if nothing arrives" }), CLIENTS));
  assertEquals(isReservedItem(row(1, { description: "compare form entries from 2026-12-22" }), CLIENTS), false);
  assertEquals(isReservedItem(row(1, { description: "ask Paul about the booth" }), CLIENTS), false);
  assertEquals(isReservedItem(row(1, { description: "send Paul Reyes the stencil" }), []), false);
});

Deno.test("selectChecklistRows: 15 reserved slots, oldest first, and the 16th dated item is not reserved", () => {
  // 20 dated items created on days 100..119 (given newest first, to prove the
  // sort), plus 60 plain items older than all of them.
  const dated = Array.from({ length: 20 }, (_, i) => row(119 - i, { description: `pay the deposit by 2027-01-${String(10 + i)}` }));
  const plain = Array.from({ length: 60 }, (_, i) => row(i + 1));
  const { reserved, general } = selectChecklistRows([...dated, ...plain], CLIENTS);
  assertEquals(reserved.length, RESERVED_SLOTS);
  assertEquals(reserved.map((r) => r.id), Array.from({ length: 15 }, (_, i) => uid(100 + i)));
  assertEquals(general.length, CHECKLIST_CAP - RESERVED_SLOTS);
  // The general 25 are the oldest plain items; the five dated items past the
  // reserve are newer than those and do not get in.
  assertEquals(general.map((r) => r.id), Array.from({ length: 25 }, (_, i) => uid(i + 1)));
});

Deno.test("selectChecklistRows: proposals cannot crowd out dated or client-shaped items", () => {
  // 60 pending proposals, all older than the 5 newest items, which are dated or
  // client-shaped. Without the reserve the 40 slots would be 40 proposals.
  const proposals = Array.from({ length: 60 }, (_, i) => proposal(i + 1, 300 + i));
  const protectedRows = [
    row(201, { description: "send Paul Reyes the stencil" }),
    row(202, { description: "renew the permit before 2027-02-01" }),
    row(203, { description: "nudge Jordan if nothing arrives" }),
    row(204, { description: "file the form by 2027-04-15" }),
    row(205, { description: "email Avery Jordans the aftercare sheet" }),
  ];
  const { reserved, general } = selectChecklistRows([...proposals, ...protectedRows], CLIENTS);
  assertEquals(reserved.map((r) => r.id), [201, 202, 203, 204, 205].map(uid));
  assertEquals(general.length, 35);
  assert(general.every((r) => r.review_outcome === "proposal"));
});

Deno.test("selectChecklistRows: general order is oldest unreviewed first by coalesce(last_reviewed_at, created_at); a proposal gets no priority", () => {
  const rows = [
    kept(1, 320), // old item, reviewed most recently of all: last
    row(2), // never reviewed, created day 2: first
    kept(3, 250), // reviewed day 250
    proposal(4, 310), // a proposal sorts by its review time, after the day-305 one
    proposal(5, 305),
    row(6), // never reviewed, created day 6
  ];
  const { reserved, general } = selectChecklistRows(rows, CLIENTS);
  assertEquals(reserved, []);
  assertEquals(general.map((r) => r.id), [2, 6, 3, 5, 4, 1].map(uid));
});

Deno.test("selectChecklistRows: pending proposals cannot crowd never-reviewed items out of the general slots", () => {
  // The PR 25 review's fixture: 40 pending proposals, each reviewed recently
  // (days 500..539), and 30 never-reviewed items created on days 100..129.
  // Nothing is dated or client-shaped, so all 40 slots are general. Proposals
  // first would fill them with the 40 proposals and show none of the 30.
  const proposals = Array.from({ length: 40 }, (_, i) => proposal(i + 1, 500 + i));
  const never = Array.from({ length: 30 }, (_, i) => row(100 + i));
  const { reserved, general } = selectChecklistRows([...proposals, ...never], CLIENTS);
  assertEquals(reserved, []);
  assertEquals(general.length, CHECKLIST_CAP);
  // All 30 never-reviewed items, oldest first, then the 10 proposals reviewed longest ago.
  assertEquals(general.slice(0, 30).map((r) => r.id), Array.from({ length: 30 }, (_, i) => uid(100 + i)));
  assertEquals(general.slice(30).map((r) => r.id), Array.from({ length: 10 }, (_, i) => uid(i + 1)));
  // The proposals that are shown keep their tags.
  const md = renderOpenActionChecklist([...reserved, ...general], 70);
  assertEquals(md.split("\n").filter((l) => l.includes("[triage: stale (no activity since spring)]")).length, 10);
});

Deno.test("selectChecklistRows: with 15 reserved, proposals still do not take the 25 general slots from older unreviewed items", () => {
  const dated = Array.from({ length: 15 }, (_, i) => row(700 + i, { description: `pay the deposit by 2027-01-${String(10 + i)}` }));
  const proposals = Array.from({ length: 25 }, (_, i) => proposal(i + 1, 500 + i));
  const never = Array.from({ length: 25 }, (_, i) => row(100 + i));
  const { reserved, general } = selectChecklistRows([...proposals, ...never, ...dated], CLIENTS);
  assertEquals(reserved.length, RESERVED_SLOTS);
  assertEquals(general.map((r) => r.id), Array.from({ length: 25 }, (_, i) => uid(100 + i)));
});

Deno.test("selectChecklistRows: equal times fall back to id, whatever the input order", () => {
  const a = row(7, { id: uid(1), created_at: day(7) });
  const b = row(7, { id: uid(2), created_at: day(7) });
  assertEquals(selectChecklistRows([b, a], CLIENTS).general.map((r) => r.id), [uid(1), uid(2)]);
  const da = row(7, { id: uid(3), description: "pay by 2027-01-01", created_at: day(7) });
  const db = row(7, { id: uid(4), description: "pay by 2027-01-02", created_at: day(7) });
  assertEquals(selectChecklistRows([db, da], CLIENTS).reserved.map((r) => r.id), [uid(3), uid(4)]);
});

Deno.test("selectChecklistRows: an unclaimed reserved slot goes to the general list, and the cap holds", () => {
  const dated = [row(500, { description: "pay by 2027-01-01" }), row(501, { description: "pay by 2027-01-02" })];
  const plain = Array.from({ length: 60 }, (_, i) => row(i + 1));
  const { reserved, general } = selectChecklistRows([...plain, ...dated], CLIENTS);
  assertEquals(reserved.length, 2);
  assertEquals(general.length, 38);
  assertEquals(reserved.length + general.length, CHECKLIST_CAP);
  // No row twice.
  assertEquals(new Set([...reserved, ...general].map((r) => r.id)).size, CHECKLIST_CAP);
});

Deno.test("selectChecklistRows: a dated item past the reserve competes in the general list and is never listed twice", () => {
  // 16 dated items, the 16th the OLDEST unreviewed row overall once the first
  // 15 are reserved, so it must lead the general list.
  const dated = Array.from({ length: 16 }, (_, i) => row(i + 1, { description: `pay by 2027-01-${String(10 + i)}` }));
  const plain = Array.from({ length: 30 }, (_, i) => row(100 + i));
  const { reserved, general } = selectChecklistRows([...plain, ...dated], CLIENTS);
  assertEquals(reserved.map((r) => r.id), Array.from({ length: 15 }, (_, i) => uid(i + 1)));
  assertEquals(general[0].id, uid(16));
  assertEquals(new Set([...reserved, ...general].map((r) => r.id)).size, reserved.length + general.length);
});

Deno.test("selectChecklistRows: a dated item with a pending proposal is reserved and keeps its tag", () => {
  const r = proposal(1, 300, { description: "renew the permit before 2027-02-01" });
  const { reserved, general } = selectChecklistRows([r, row(2)], CLIENTS);
  assertEquals(reserved.map((x) => x.id), [uid(1)]);
  assertEquals(general.map((x) => x.id), [uid(2)]);
  assert(renderOpenActionChecklist([...reserved, ...general]).includes("[triage: stale (no activity since spring)]"));
});

Deno.test("buildOpenActionChecklist: reserved rows lead, the total is the exact count, tags render", () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, i) => row(i + 1)),
    row(900, { description: "send Paul Reyes the stencil" }),
    // Reviewed before any other row's clock (day 0.5), so it leads the general list.
    proposal(0, 0.5, { triage_disposition: "done", triage_evidence: "commit:abc1234" }),
  ];
  const md = buildOpenActionChecklist({ rows, total: 52, clientNames: CLIENTS, legacyRows: null });
  const lines = md.split("\n");
  assertEquals(lines[0], "## Open Action Items");
  assertEquals(lines[2], `- [ ] send Paul Reyes the stencil (${uid(900)})`);
  assertEquals(lines[3], `- [ ] plain item 0 (${uid(0)}) [triage: done per commit:abc1234]`);
  assertEquals(lines[4], `- [ ] plain item 1 (${uid(1)})`);
  assertEquals(lines.filter((l) => l.startsWith("- [ ] ")).length, 40);
  assertEquals(lines[lines.length - 1], "_Showing 40 of 52 open action items. 12 more remain open._");
});

Deno.test("buildOpenActionChecklist: a failed review-column read falls back to the legacy rows and says so", () => {
  const md = buildOpenActionChecklist({
    rows: null,
    total: 3,
    clientNames: null,
    legacyRows: [row(2), row(1)],
  });
  const lines = md.split("\n");
  assertEquals(lines[2], `- [ ] plain item 2 (${uid(2)})`); // the legacy order is kept
  assertEquals(lines[3], `- [ ] plain item 1 (${uid(1)})`);
  assert(md.includes("Showing 2 of 3 open action items"));
  assert(md.includes("Triage tags unavailable: the review columns could not be read."));
});

Deno.test("buildOpenActionChecklist: both reads failed is an unavailable line, never an empty section", () => {
  assertEquals(
    buildOpenActionChecklist({ rows: null, total: null, clientNames: null, legacyRows: null }),
    "Open action items unavailable: action_items could not be read.",
  );
});

Deno.test("buildOpenActionChecklist: failed client names are said, and dated items are still reserved", () => {
  const rows = [
    ...Array.from({ length: 45 }, (_, i) => proposal(i + 1, 300 + i)),
    row(800, { description: "renew the permit before 2027-02-01" }),
    row(801, { description: "send Paul Reyes the stencil" }),
  ];
  const md = buildOpenActionChecklist({ rows, total: 47, clientNames: null, legacyRows: null });
  assert(md.includes(`(${uid(800)})`));
  assertEquals(md.includes(`(${uid(801)})`), false); // no client list, so not reserved
  assert(md.includes("_Client names unavailable: reserved slots hold dated items only._"));
  // With the names, the client item is reserved and the note is gone.
  const withNames = buildOpenActionChecklist({ rows, total: 47, clientNames: CLIENTS, legacyRows: null });
  assert(withNames.includes(`(${uid(801)})`));
  assertEquals(withNames.includes("Client names"), false);
});

Deno.test("buildOpenActionChecklist: a partly read client list and a capped row read are each said", () => {
  const rows = Array.from({ length: 45 }, (_, i) => row(i + 1));
  const md = buildOpenActionChecklist({
    rows,
    total: 60,
    clientNames: CLIENTS,
    clientNamesPartial: true,
    legacyRows: null,
  });
  assert(md.includes("_Showing 40 of 60 open action items. 20 more remain open._"));
  assert(md.includes("_Chosen from the oldest 45 open items; 15 newer ones were not considered._"));
  assert(md.includes("_Client names only partly read: some client-shaped items may be missing from the reserved slots._"));
  const whole = buildOpenActionChecklist({ rows, total: 45, clientNames: CLIENTS, legacyRows: null });
  assertEquals(whole.includes("Chosen from"), false);
  assertEquals(whole.includes("partly read"), false);
});

Deno.test("buildOpenActionChecklist: no open items renders nothing", () => {
  assertEquals(buildOpenActionChecklist({ rows: [], total: 0, clientNames: CLIENTS, legacyRows: null }), "");
});
