import { assertEquals } from "jsr:@std/assert@1.0.19";
import {
  ARCHIVE_PROPOSAL_LIST_CAP,
  archiveJobWarning,
  type ArchiveProposalRow,
  renderArchiveProposals,
} from "./archive-proposals.ts";

const NOW = "2026-11-19T11:00:00.000Z";
const daysAgo = (d: number) => new Date(Date.parse(NOW) - d * 86_400_000).toISOString();
const OK_RUN = { status: "succeeded", start_time: "2026-11-19T05:30:00.000Z", return_message: "1 row" };

function row(id: string, ageDays: number, proposedDaysAgo = 0, description = `item ${id}`): ArchiveProposalRow {
  return { id, description, created_at: daysAgo(ageDays), archive_proposed_at: daysAgo(proposedDaysAgo) };
}

Deno.test("renders the fixed shape, oldest item first, with short ids and item age", () => {
  const out = renderArchiveProposals(
    [
      row("6e76d6c7-3b5b-46cd-a7bb-70a7099faf36", 209, 0, "TODO: flip the\n  leaked password toggle"),
      row("921d1ad1-8114-4d9c-8800-0d8a9ecf2cf3", 212),
    ],
    OK_RUN,
    NOW,
  );
  assertEquals(
    out,
    "## Proposed for archive (reply keep <id> or archive <id>)\n\n" +
      "- 921d1ad1 212 d item 921d1ad1-8114-4d9c-8800-0d8a9ecf2cf3\n" +
      "- 6e76d6c7 209 d TODO: flip the leaked password toggle",
  );
});

Deno.test("counts unreviewed proposals older than 30 days, never acts on them", () => {
  const out = renderArchiveProposals(
    [row("a0000000-0000-4000-8000-000000000000", 100, 31), row("b0000000-0000-4000-8000-000000000000", 90, 30), row("c0000000-0000-4000-8000-000000000000", 80, 29)],
    OK_RUN,
    NOW,
  );
  assertEquals(out.endsWith("_2 unreviewed proposals are older than 30 days._"), true);
  const one = renderArchiveProposals([row("a0000000-0000-4000-8000-000000000000", 100, 45)], OK_RUN, NOW);
  assertEquals(one.endsWith("_1 unreviewed proposal is older than 30 days._"), true);
});

Deno.test("caps the list and says how many are pending", () => {
  const rows = Array.from({ length: ARCHIVE_PROPOSAL_LIST_CAP + 3 }, (_, i) =>
    row(`${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, 200 - i));
  const out = renderArchiveProposals(rows, OK_RUN, NOW);
  assertEquals(out.split("\n").filter((l) => l.startsWith("- ")).length, ARCHIVE_PROPOSAL_LIST_CAP);
  assertEquals(out.includes(`_Showing ${ARCHIVE_PROPOSAL_LIST_CAP} of ${ARCHIVE_PROPOSAL_LIST_CAP + 3} pending proposals, oldest first._`), true);
});

Deno.test("nothing pending and a healthy job: one quiet line naming the run", () => {
  assertEquals(renderArchiveProposals([], OK_RUN, NOW), "Archive proposals: none pending (job ran 2026-11-19 05:30 UTC).");
});

Deno.test("a failed, stale, missing or unreadable job run is printed even with nothing pending", () => {
  assertEquals(
    renderArchiveProposals([], { status: "failed", start_time: "2026-11-19T05:30:00Z", return_message: "ERROR: deadlock detected" }, NOW),
    "Archive proposals: none pending.\n_Archive job: last run 2026-11-19 05:30 UTC failed: ERROR: deadlock detected._",
  );
  assertEquals(
    archiveJobWarning({ status: "succeeded", start_time: "2026-11-17T05:30:00Z" }, Date.parse(NOW)),
    "Archive job: last run 2026-11-17 05:30 UTC, more than 36 hours ago.",
  );
  assertEquals(archiveJobWarning({ status: null, start_time: null }, Date.parse(NOW)), "Archive job has never run.");
  assertEquals(archiveJobWarning(null, Date.parse(NOW)), "Archive job status unavailable: its last run could not be read.");
  assertEquals(archiveJobWarning(OK_RUN, Date.parse(NOW)), null);
});

Deno.test("a failed proposal read says so instead of reading as none pending", () => {
  assertEquals(renderArchiveProposals(null, OK_RUN, NOW), "Archive proposals unavailable: action_items could not be read.");
});

Deno.test("a pending list still carries the job warning", () => {
  const out = renderArchiveProposals([row("a0000000-0000-4000-8000-000000000000", 70)], { status: "failed", start_time: "2026-11-19T05:30:00Z" }, NOW);
  assertEquals(out.endsWith("_Archive job: last run 2026-11-19 05:30 UTC failed._"), true);
});
