// Loop-closing Task 5.2: the digest's "possible duplicates" section.
// Run: deno test --allow-read supabase/functions/brain-digest/dedup-proposals.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  DEDUP_PROPOSAL_LIST_CAP,
  DEDUP_SECTION_HEADER,
  type DedupProposalRow,
  renderDedupProposals,
} from "./dedup-proposals.ts";
import { parseReviewCommand } from "../_shared/proposal-review.ts";
// Runtime-bound claim for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";

const BASE_MS = Date.parse("2026-11-20T04:00:00.000Z");

function row(n: number, over: Partial<DedupProposalRow> = {}): DedupProposalRow {
  const h = String(n).padStart(4, "0");
  return {
    decision_id: `d${h}000-0000-4000-8000-000000000000`,
    item_id: `a${h}000-0000-4000-8000-000000000000`,
    description: `send Riley the reminder email ${n}`,
    survivor_id: `5${h}000-0000-4000-8000-000000000000`,
    survivor_description: `send Sam the reminder email ${n}`,
    survivor_status: "open",
    score: 0.833,
    proposed_at: new Date(BASE_MS + n * 60_000).toISOString(),
    ...over,
  };
}

Deno.test("dedup section: header, one line per item with both ids, both descriptions and the constraint wording", () => {
  assertEquals(DEDUP_SECTION_HEADER, "## Possible duplicates (reply done <id> to archive the newer copy, or keep <id> if they are distinct)");
  claim(
    "dedup-digest-lines",
    renderDedupProposals([
      row(1, { description: "send Riley the final appointment reminder email", survivor_description: "send Sam the final appointment reminder email" }),
      row(2, { description: "deploy the CRM appointment reminder email to demo", survivor_description: "deploy the CRM appointment reminder email to live" }),
    ]),
    `${DEDUP_SECTION_HEADER}\n\n` +
      `- a0001000 "send Riley the final appointment reminder email" possible duplicate of 50001000 "send Sam the final appointment reminder email" (constraints agree)\n` +
      `- a0002000 "deploy the CRM appointment reminder email to demo" possible duplicate of 50002000 "deploy the CRM appointment reminder email to live" (constraints differ: live vs demo)`,
    "the plan's two wordings",
  );
});

Deno.test("dedup section: the printed id is the newer item, which the exact Slack forms done <id> and keep <id> accept", () => {
  const out = renderDedupProposals([row(7)]);
  const id = out.split("\n")[2].slice(2, 10);
  assertEquals(id, "a0007000");
  assertEquals(parseReviewCommand(`done ${id}`), { verb: "done", itemRef: "a0007000", decisionRef: null });
  assertEquals(parseReviewCommand(`keep ${id}`), { verb: "keep", itemRef: "a0007000", decisionRef: null });
});

Deno.test("dedup section: a survivor that is no longer open says so", () => {
  const line = renderDedupProposals([row(1, { survivor_status: "archived" })]).split("\n")[2];
  assert(line.endsWith("(constraints agree, survivor archived)"), line);
  const gone = renderDedupProposals([row(2, { survivor_status: null, survivor_description: null })]).split("\n")[2];
  assert(gone.includes('possible duplicate of 50002000 ""'), gone);
});

Deno.test("dedup section: nothing pending omits the section; a failed read says so", () => {
  assertEquals(renderDedupProposals([]), "");
  assertEquals(renderDedupProposals(null), "Duplicate checks unavailable: the pending dedup proposals could not be read.");
});

Deno.test("dedup section: oldest first then item id, one line per item, capped with a count line", () => {
  const same = "2026-11-20T05:00:00.000Z";
  const a = row(1, { proposed_at: same, item_id: "b9000000-0000-4000-8000-000000000000" });
  const b = row(2, { proposed_at: same, item_id: "b1000000-0000-4000-8000-000000000000" });
  const c = row(3, { proposed_at: "2026-11-20T04:30:00.000Z" });
  const dup = row(4, { proposed_at: "2026-11-20T06:00:00.000Z", item_id: c.item_id });
  const ids = renderDedupProposals([a, dup, b, c]).split("\n").slice(2).map((l) => l.slice(2, 10));
  assertEquals(ids, ["a0003000", "b1000000", "b9000000"]);
  const rows = Array.from({ length: DEDUP_PROPOSAL_LIST_CAP + 2 }, (_, i) => row(i + 1, { pending_total: 30 }));
  const lines = renderDedupProposals(rows).split("\n");
  assertEquals(lines.length, 2 + DEDUP_PROPOSAL_LIST_CAP + 1);
  assertEquals(lines[lines.length - 1], `_Showing ${DEDUP_PROPOSAL_LIST_CAP} of 30 pending duplicate checks, oldest first._`);
});

Deno.test("dedup section: the digest reads dedup_pending_proposals and joins the section after the fragment section", () => {
  // brain-digest/index.ts builds its client and starts Deno.serve at import, so
  // the wiring is checked in its source.
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertEquals(src.split(`supabase.rpc("dedup_pending_proposals", { p_limit: 200 })`).length - 1, 1);
  assertEquals(src.split("return renderDedupProposals(rows);").length - 1, 1);
  assertEquals(src.split("const dedupSection = await loadDedupProposals();").length - 1, 1);
  claim(
    "dedup-digest-section-joined",
    src.includes("[synthesized, checklist, deskLine, archiveSection, recheckSection, fragmentSection, dedupSection, calendarSection].filter(Boolean)"),
    true,
    "the section is joined into the digest body",
  );
});
