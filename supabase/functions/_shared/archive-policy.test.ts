import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  archiveAction,
  archiveDueAt,
  archiveDueRows,
  type ArchivePolicyContext,
  type ArchivePolicyItem,
  deadlineFrom,
  isClientShaped,
  realDateUtc,
  sourceIsWorkReport,
} from "./archive-policy.ts";

const NOW = new Date("2026-11-19T05:30:00Z");
const daysAgo = (d: number, from = NOW) => new Date(from.getTime() - d * 86_400_000).toISOString();

// Fixture clients: Jordan matches two names by find_client's partial match.
const CLIENTS = ["Jordan Lee", "Avery Jordans", "Paul Reyes", "Chris Vale", "Chris Marsh", "Mira"];

function item(over: Partial<ArchivePolicyItem> = {}): ArchivePolicyItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    description: "update the shop hours page",
    status: "open",
    created_at: daysAgo(10),
    reopened_at: null,
    archive_proposed_at: null,
    archive_review_outcome: null,
    archive_reviewed_at: null,
    ...over,
  };
}
function ctx(over: Partial<ArchivePolicyContext> = {}): ArchivePolicyContext {
  return { sourceIsWorkReport: false, fragmentFlagged: false, linkedToOpenCard: false, clientNames: CLIENTS, ...over };
}
const isDue = (i: ArchivePolicyItem, c: ArchivePolicyContext, now = NOW) => {
  const d = archiveDueAt(i, c, now);
  return d !== null && d.dueAt.getTime() <= now.getTime();
};

// --- Plan Step 1 ---

Deno.test("a 31-day work-report item is due (age_work_report)", () => {
  const d = archiveDueAt(item({ created_at: daysAgo(31) }), ctx({ sourceIsWorkReport: true }), NOW);
  assertEquals(d?.reason, "age_work_report");
  assert(d!.dueAt.getTime() <= NOW.getTime());
});

Deno.test("a 31-day standard item is not due", () => {
  assertEquals(isDue(item({ created_at: daysAgo(31) }), ctx()), false);
});

Deno.test("standard: 59 days is not due, 61 is (age_standard)", () => {
  assertEquals(isDue(item({ created_at: daysAgo(59) }), ctx()), false);
  const d = archiveDueAt(item({ created_at: daysAgo(61) }), ctx(), NOW);
  assertEquals(d?.reason, "age_standard");
  assert(isDue(item({ created_at: daysAgo(61) }), ctx()));
});

Deno.test("the 30 and 60 day boundaries are inclusive to the millisecond", () => {
  assert(isDue(item({ created_at: daysAgo(60) }), ctx()));
  const justUnder = new Date(NOW.getTime() - 60 * 86_400_000 + 1).toISOString();
  assertEquals(isDue(item({ created_at: justUnder }), ctx()), false);
  assert(isDue(item({ created_at: daysAgo(30) }), ctx({ fragmentFlagged: true })));
});

Deno.test("a deadline is due at the date plus 14: by 2027-03-01 is due 2027-03-15", () => {
  const d = archiveDueAt(
    item({ description: "flip the Riverside venue in April 2027 by 2027-03-01", created_at: daysAgo(79) }),
    ctx(),
    NOW,
  );
  assertEquals(d?.reason, "deadline_passed");
  assertEquals(d?.dueAt.toISOString(), "2027-03-15T00:00:00.000Z");
  // 79 days old but the deadline rule replaces the age rule.
  assertEquals(d!.dueAt.getTime() > NOW.getTime(), true);
});

Deno.test("a bare reference date follows the standard rule", () => {
  const desc = "compare Fluent Forms entries per page for the 60 days before and after, from 2026-12-22";
  assertEquals(deadlineFrom(desc), null);
  assertEquals(archiveDueAt(item({ description: desc, created_at: daysAgo(26) }), ctx(), NOW)?.reason, "age_standard");
  assert(isDue(item({ description: desc, created_at: daysAgo(61) }), ctx()));
});

Deno.test("the canary returns null", () => {
  const desc = "Perpetual auto-resolve canary (do NOT resolve): re-verify the guards";
  assertEquals(archiveDueAt(item({ description: desc, created_at: daysAgo(400) }), ctx(), NOW), null);
  assertEquals(archiveDueAt(item({ description: "perpetual tripwire row", created_at: daysAgo(400) }), ctx(), NOW), null);
});

Deno.test("a client-shaped description returns null (full name)", () => {
  const desc = "TODO: create a design for the backyard garden for Paul Reyes's pergola";
  assertEquals(archiveDueAt(item({ description: desc, created_at: daysAgo(400) }), ctx(), NOW), null);
});

Deno.test("nudge Jordan returns null: a first name find_client matches twice", () => {
  assertEquals(archiveDueAt(item({ description: "nudge Jordan if nothing arrives", created_at: daysAgo(121) }), ctx(), NOW), null);
});

// --- Exemptions ---

Deno.test("deferred, resolved and archived items are exempt", () => {
  for (const status of ["deferred", "resolved", "archived"]) {
    assertEquals(archiveDueAt(item({ status, created_at: daysAgo(400) }), ctx(), NOW), null);
  }
});

Deno.test("an item linked to an open card is exempt", () => {
  assertEquals(archiveDueAt(item({ created_at: daysAgo(400) }), ctx({ linkedToOpenCard: true }), NOW), null);
});

Deno.test("reopened 10 days ago: exempt; 91 days ago and still due: proposed", () => {
  assertEquals(archiveDueAt(item({ created_at: daysAgo(200), reopened_at: daysAgo(10) }), ctx(), NOW), null);
  assert(isDue(item({ created_at: daysAgo(200), reopened_at: daysAgo(91) }), ctx()));
  // Exactly 90 days is no longer "within the last 90 days".
  assert(isDue(item({ created_at: daysAgo(200), reopened_at: daysAgo(90) }), ctx()));
});

Deno.test("client shape: one-word client names and single-match first names do not exempt", () => {
  assertEquals(isClientShaped("ask Mira about the swatch sheet", CLIENTS), false); // one-word client name, one match
  assertEquals(isClientShaped("send Paul the invoice", CLIENTS), false); // Paul matches one client
  assertEquals(isClientShaped("send paul reyes the invoice", CLIENTS), true); // full name, any case
  assertEquals(isClientShaped("Chris Fenwick's departure export", CLIENTS), true); // Chris matches two
  assertEquals(isClientShaped("chris asked about it", CLIENTS), false); // not capitalised
  assertEquals(isClientShaped("Jo asked", ["Jo Ann", "Jo Bee"]), false); // under three letters
  assertEquals(isClientShaped("paulreyes tag", CLIENTS), false); // not whole tokens
});

// --- Deadline parsing ---

Deno.test("deadline keywords within three tokens, latest date wins, invalid dates ignored", () => {
  assertEquals(deadlineFrom("run the export before 2026-11-01"), Date.UTC(2026, 10, 1));
  assertEquals(deadlineFrom("Switch the post-visit after 2026-11-17, keeping the rule."), Date.UTC(2026, 10, 17));
  assertEquals(deadlineFrom("due on Friday 2026-12-04"), Date.UTC(2026, 11, 4)); // keyword is the 3rd token back
  assertEquals(deadlineFrom("due on a Friday 2026-12-04"), null); // 4th token back
  assertEquals(deadlineFrom("by 2026-12-01 or until (2027-01-05)."), Date.UTC(2027, 0, 5));
  assertEquals(deadlineFrom("by 2026-02-30"), null);
  assertEquals(deadlineFrom("By: 2026-12-01"), Date.UTC(2026, 11, 1));
  assertEquals(deadlineFrom("by 12026-12-01"), null);
  assertEquals(deadlineFrom("bypass 2026-12-01"), null);
  assertEquals(deadlineFrom("before and after, from 2026-12-22"), null); // clause break
  assertEquals(deadlineFrom("due. Then 2026-12-22"), null); // keyword ends its sentence
  assertEquals(deadlineFrom("before the end 2026-12-22"), Date.UTC(2026, 11, 22));
  assertEquals(realDateUtc(99, 1, 1), null);
});

// --- Review state ---

Deno.test("archiveAction: propose, pending, kept recently, repropose after 90 days", () => {
  assertEquals(archiveAction(item(), NOW), "propose");
  assertEquals(archiveAction(item({ archive_proposed_at: daysAgo(3) }), NOW), "pending");
  assertEquals(
    archiveAction(item({ archive_proposed_at: daysAgo(40), archive_review_outcome: "kept", archive_reviewed_at: daysAgo(30) }), NOW),
    "kept_recently",
  );
  assertEquals(
    archiveAction(item({ archive_proposed_at: daysAgo(100), archive_review_outcome: "kept", archive_reviewed_at: daysAgo(91) }), NOW),
    "repropose",
  );
});

Deno.test("archiveDueRows keeps only due rows and sorts by id", () => {
  const rows = archiveDueRows(
    [
      item({ id: "b0000000-0000-4000-8000-000000000000", created_at: daysAgo(61) }),
      item({ id: "a0000000-0000-4000-8000-000000000000", created_at: daysAgo(90) }),
      item({ id: "c0000000-0000-4000-8000-000000000000", created_at: daysAgo(5) }),
    ],
    () => ctx(),
    NOW,
  );
  assertEquals(rows.map((r) => r.item_id), ["a0000000-0000-4000-8000-000000000000", "b0000000-0000-4000-8000-000000000000"]);
  assertEquals(rows.every((r) => r.action === "propose" && r.reason === "age_standard"), true);
});

Deno.test("sourceIsWorkReport uses Task 1.2's classifier and refuses a missing source", () => {
  assertEquals(sourceIsWorkReport(null, null), false);
  assert(sourceIsWorkReport("Brain Bank Session 412 (2026-11-01): built the gate, commit abc1234", "2026-11-01T20:00:00Z"));
  assertEquals(sourceIsWorkReport("buy more black ink", "2026-11-01T20:00:00Z"), false);
});

// The reference's Unicode semantics, pinned because the SQL mirror reproduces
// them explicitly (Codex re-review of PR 24, 2026-11-18). These describe the
// existing TypeScript; they are not a policy change.
const cp = (n: number) => String.fromCodePoint(n);
const JS_WS = [
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004,
  0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff,
];

Deno.test("reference: exactly 25 code points are whitespace to the deadline split", () => {
  const found: number[] = [];
  for (let c = 0; c <= 0x10ffff; c++) {
    if (c >= 0xd800 && c <= 0xdfff) continue;
    if (deadlineFrom(`reply by${cp(c)}2026-12-30`) === Date.UTC(2026, 11, 30)) found.push(c);
  }
  assertEquals(found, JS_WS);
});

Deno.test("reference: U+FEFF separates tokens and the commit shape; U+0085/U+180E/U+200B do not", () => {
  const bom = cp(0xfeff);
  assertEquals(deadlineFrom(`by x${bom}y z 2026-12-30`), null);
  assertEquals(deadlineFrom(`by x${bom}y 2026-12-30`), Date.UTC(2026, 11, 30));
  assertEquals(sourceIsWorkReport(`commit${bom}abcdef1 handoff`, "2026-11-02T20:00:00Z"), true);
  for (const c of [0x85, 0x180e, 0x200b]) {
    assertEquals(deadlineFrom(`reply by${cp(c)}2026-12-30`), null);
    assertEquals(sourceIsWorkReport(`commit${cp(c)}abcdef1 handoff`, "2026-11-02T20:00:00Z"), false);
  }
});

Deno.test("reference: the dated-header gap is 24 UTF-16 code units", () => {
  const e = cp(0x1f600);
  const wr = (gap: string) => sourceIsWorkReport(`session 1 ${gap} 2026-11-01`, "2026-11-02T20:00:00Z");
  assertEquals(wr(e.repeat(11)), true); // 1 + 22 + 1 = 24 units
  assertEquals(wr(e.repeat(12)), false); // 26 units, 14 characters
  assertEquals(wr("a".repeat(20) + e), true); // 24 units
  assertEquals(wr("a".repeat(21) + e), false); // 25 units, 24 characters
  assertEquals(wr("é".repeat(22)), true);
  assertEquals(wr("é".repeat(23)), false);
});

Deno.test("reference: client names lowercase U+0130 to i + U+0307 and U+212A to k", () => {
  const clients = ["İpek Kaya", "Ipek Demir", `${cp(0x212a)}ira Lee`, "Jordan Lee", "Avery Jordans"];
  const dot = cp(0x307);
  assertEquals(isClientShaped(`notify i${dot}pek kaya`, clients), true);
  assertEquals(isClientShaped("notify İpek Kaya", clients), true);
  assertEquals(isClientShaped("notify ipek kaya", clients), false);
  assertEquals(isClientShaped("notify pek kaya", clients), false);
  assertEquals(isClientShaped("ask kira lee", clients), true);
  assertEquals(isClientShaped("ask ira lee", clients), false);
  assertEquals(isClientShaped("ask Ipek about the swatch", clients), false); // one partial match
  assertEquals(isClientShaped("nudge Jordan again", clients), true);
  assertEquals(deadlineFrom("UNTİL 2026-12-30"), Date.UTC(2026, 11, 30));
  assertEquals(deadlineFrom(`due${cp(0x212a)} 2026-12-30`), null);
  // The canary check lowercases the same way: "trİpwire" is not "tripwire".
  const due = archiveDueAt(item({ description: "perpetual trİpwire", created_at: daysAgo(70) }), ctx(), NOW);
  assertEquals(due?.reason, "age_standard");
});
