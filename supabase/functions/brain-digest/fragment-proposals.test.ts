// Loop-closing Task 5.1: the digest's "check wording" section.
// Run: deno test --allow-read supabase/functions/brain-digest/fragment-proposals.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  FRAGMENT_PROPOSAL_LIST_CAP,
  FRAGMENT_SECTION_HEADER,
  type FragmentProposalRow,
  renderFragmentProposals,
} from "./fragment-proposals.ts";
import { parseReviewCommand } from "../_shared/proposal-review.ts";
// Runtime-bound claim for the TS mutant sweep (Codex re-review 2, N1).
import { claim } from "../../../scripts/loop-closing/claim.ts";

const BASE_MS = Date.parse("2026-11-20T04:00:00.000Z");

function row(n: number, over: Partial<FragmentProposalRow> = {}): FragmentProposalRow {
  const h = String(n).padStart(4, "0");
  return {
    decision_id: `d${h}000-0000-4000-8000-000000000000`,
    item_id: `a${h}000-0000-4000-8000-000000000000`,
    description: `send her item ${n}`,
    proposed_at: new Date(BASE_MS + n * 60_000).toISOString(),
    ...over,
  };
}

Deno.test("fragment section: the plan's header, one line per item with its 8-hex item id and description", () => {
  assertEquals(FRAGMENT_SECTION_HEADER, "## Check wording (reply keep <id> or archive <id>)");
  assertEquals(
    renderFragmentProposals([row(1), row(2)]),
    `${FRAGMENT_SECTION_HEADER}\n\n- a0001000 send her item 1\n- a0002000 send her item 2`,
  );
});

Deno.test("fragment section: the printed id is what the exact Slack forms keep <id> and archive <id> accept, as the item ref", () => {
  const out = renderFragmentProposals([row(7)]);
  const id = out.split("\n")[2].slice(2, 10);
  assertEquals(parseReviewCommand(`keep ${id}`), { verb: "keep", itemRef: "a0007000", decisionRef: null });
  assertEquals(parseReviewCommand(`archive ${id}`), { verb: "archive", itemRef: "a0007000", decisionRef: null });
});

Deno.test("fragment section: nothing pending omits the section; a failed read says so", () => {
  assertEquals(renderFragmentProposals([]), "");
  const failed = renderFragmentProposals(null);
  assertEquals(failed, "Wording checks unavailable: the pending fragment suspects could not be read.");
});

Deno.test("fragment section: oldest first then item id, whatever order the rows arrive in, one line per item", () => {
  const same = "2026-11-20T05:00:00.000Z";
  const a = row(1, { proposed_at: same, item_id: "b9000000-0000-4000-8000-000000000000" });
  const b = row(2, { proposed_at: same, item_id: "b1000000-0000-4000-8000-000000000000" });
  const c = row(3, { proposed_at: "2026-11-20T04:30:00.000Z" });
  const dup = row(4, { proposed_at: "2026-11-20T06:00:00.000Z", item_id: c.item_id, description: "duplicate" });
  const lines = renderFragmentProposals([a, dup, b, c]).split("\n").slice(2);
  assertEquals(lines, ["- a0003000 send her item 3", "- b1000000 send her item 2", "- b9000000 send her item 1"]);
});

Deno.test("fragment section: capped at the list cap with a count line, the RPC's total winning", () => {
  const rows = Array.from({ length: FRAGMENT_PROPOSAL_LIST_CAP + 3 }, (_, i) => row(i + 1, { pending_total: 40 }));
  const lines = renderFragmentProposals(rows).split("\n");
  assertEquals(lines.length, 2 + FRAGMENT_PROPOSAL_LIST_CAP + 1);
  assertEquals(lines[lines.length - 1], `_Showing ${FRAGMENT_PROPOSAL_LIST_CAP} of 40 pending wording checks, oldest first._`);
  const short = renderFragmentProposals([row(1, { pending_total: 1 })]);
  assert(!short.includes("_Showing"), short);
});

Deno.test("fragment section: a long or multi-line description is flattened and cut", () => {
  const out = renderFragmentProposals([row(1, { description: `send her\n\nthe ${"x".repeat(200)}` })]);
  const line = out.split("\n")[2];
  assert(line.startsWith("- a0001000 send her the xxx"), line);
  assertEquals(line.length, "- a0001000 ".length + 90);
  assert(line.endsWith("…"), line);
});

Deno.test("fragment section: the digest reads fragment_pending_proposals and joins the section after the recheck section", () => {
  // brain-digest/index.ts builds its client and starts Deno.serve at import, so
  // the wiring is checked in its source.
  const src = Deno.readTextFileSync(new URL("./index.ts", import.meta.url));
  assertEquals(src.split(`supabase.rpc("fragment_pending_proposals", { p_limit: 200 })`).length - 1, 1);
  assertEquals(src.split("return renderFragmentProposals(rows);").length - 1, 1);
  assertEquals(src.split("const fragmentSection = await loadFragmentProposals();").length - 1, 1);
  claim(
    "digest-section-joined",
    src.includes("[synthesized, checklist, deskLine, archiveSection, recheckSection, fragmentSection, dedupSection, calendarSection].filter(Boolean)"),
    true,
    "the section is joined into the digest body",
  );
});
