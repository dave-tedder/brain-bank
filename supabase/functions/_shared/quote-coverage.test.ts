// Loop-closing Task 1.3: the LAYER 3 subject-coverage metric, tested ALONE on
// the full logged quote/description pairs from 2026-11-02 (quotes exactly as
// the LAYER 3 drop log recorded them, 200-character truncation included;
// descriptions from action_items). Item ids in comments. The whole-pipeline
// replay (model plus every gate) is separate: scripts/auto-resolve-ab-test.
// Run: deno test supabase/functions/_shared/quote-coverage.test.ts
import { assert, assertEquals } from "jsr:@std/assert@1.0.19";
import {
  stem,
  SUBJECT_COVERAGE_THRESHOLD,
  subjectCoverage,
} from "./quote-coverage.ts";

const T = SUBJECT_COVERAGE_THRESHOLD;

Deno.test("threshold is 0.4 (plan Task 1.3; a hand-read false positive reverts it to 0.5)", () => {
  assertEquals(T, 0.4);
});

// --- Real completions the old Jaccard guard dropped; recovered at 0.4 -------

Deno.test("94cb0549 migration 063: recovered", () => {
  const c = subjectCoverage(
    "migration 063 applied live on project dilycpfwozgnuffpxkqw via psql",
    "Awaiting the operator to apply migration 063",
  );
  assert(c >= T, `coverage ${c}`); // measured 0.67
});

Deno.test("7beea1fc deploy app and demo: recovered", () => {
  const c = subjectCoverage(
    "The operator deployed d024025 (npm audit patch bumps) to live (Railway d9564881 SUCCESS, health 200) and demo (cfd804bd SUCCESS, health 200)",
    "deploy the app and the demo",
  );
  assert(c >= T, `coverage ${c}`); // measured 0.50
});

Deno.test("11d377ba paste in WordPress (cancelled): recovered", () => {
  const c = subjectCoverage(
    "No WordPress edit needed per the deliverable; nothing to install.",
    "The operator needs to paste it in WordPress",
  );
  assert(c >= T, `coverage ${c}`); // measured 0.50
});

Deno.test("57607c5a Riley crew card (both logged quotes): recovered", () => {
  const desc =
    "update the homepage crew card for Riley Lerue to reflect the correct work style";
  const c1 = subjectCoverage(
    `"Riley's homepage crew card now reads 'American Traditional · Japanese · Lettering'... Verified live on example.com homepage 09:56 ET"`,
    desc,
  );
  const c2 = subjectCoverage(
    `"Riley's homepage crew card style line changed to 'American Traditional · Japanese · Lettering' in page 1783 post_content ... verified logged out"`,
    desc,
  );
  assert(c1 >= T, `coverage ${c1}`); // measured 0.44
  assert(c2 >= T, `coverage ${c2}`);
});

// --- Known misses, recorded as such (NOT desired behaviour): left to the ---
// --- Task 4.1 re-check, which sees the whole thought -----------------------

Deno.test("9979f986 Casey post-visit (arguable, scheduled not done): below threshold, known miss", () => {
  const c = subjectCoverage(
    "Casey Morgan's post-visit pass built in phaseAM-casey-post... scheduled as task casey-morgan-post-visit for 2026-11-18 09:00 ET",
    "Switch Casey's post-visit after 2026-11-17, keeping the current-guest-first rule.",
  );
  assert(c < T, `coverage ${c}`); // measured 0.36
});

Deno.test("3ce0bf94 delete TEST submission (quote is ids, not words): below threshold, known miss", () => {
  const c = subjectCoverage(
    `"the CRM intake 13204d35 (intakes 628 -> 627), and Sheet row 36 in 'Intake Requests', each deleted by exact id behind a name guard"`,
    "Delete the TEST submission by Claude for the operator.",
  );
  assert(c < T, `coverage ${c}`); // measured 0.25
});

Deno.test("2a9beb6f both deploys (description padded with commands): below threshold, known miss", () => {
  const c = subjectCoverage(
    `"The operator deployed 7f87a7e to live (Railway 06d22750 SUCCESS, booted 23:00 UTC) and to the demo (e6e92f4b SUCCESS"`,
    "The operator runs both deploys (npm run deploy, then bash scripts/deploy.sh external-crm-demo) so the check starts recording on Today.",
  );
  assert(c < T, `coverage ${c}`); // measured 0.18
});

// --- Correct blocks that must stay blocked ---------------------------------

Deno.test("75b237d6 FluentSMTP downgrade (different work): stays blocked", () => {
  const c = subjectCoverage(
    `"All four WordPress sites send via FluentSMTP App Passwords; three rotated into wp-config.php constants...old App Passwords revoked by the operator" — Gmail credential hardening DONE, replacing the ful`,
    "walk the operator through downgrading FluentSMTP from a full-mailbox Gmail grant to send-only and re-authorizing it",
  );
  assert(c < T, `coverage ${c}`);
});

Deno.test("umbrella FP (Session 55/56): a subtask quote does not cover the umbrella item", () => {
  const c = subjectCoverage(
    "Notion token rotation COMPLETE",
    "rotate 4 live secrets before any code copies into brain-bank",
  );
  assert(c < T, `coverage ${c}`); // measured 0.11
});

// --- Codex review of PR 16 (2026-11-05): a one-conjunct completion ----------
//
// KNOWN PASS, not desired. "deploy the app and the demo" has two content
// tokens after the stoplist (app, demo); a quote that deployed only the demo
// covers one of two = 0.5, above 0.4. The old Jaccard guard scored this pair
// 0.18 and blocked it. The recovered real completion 7beea1fc above has the
// same lexical shape (its quote says "to live ... and demo", and "live" is not
// "app"), so no token rule separates the two; LAYER 2 is the judge of whether
// every conjunct was done, and the Task 4.1 whole-thought re-check is the
// planned backstop. Note the plan's revert lever (0.4 to 0.5) does not block
// a two-token description either, since 1 of 2 equals 0.5. The operator decided
// 2026-11-05: keep 0.4; the re-check is the backstop, not a token rule.
Deno.test("Codex pair: a demo-only deploy quote covers half of 'deploy the app and the demo' (known pass)", () => {
  const c = subjectCoverage(
    "Deployed the demo to Railway, deployment cfd804bd succeeded and health returned 200; verified login, intake upload, gallery rendering, export download, mobile navigation.",
    "deploy the app and the demo",
  );
  assertEquals(c, 0.5);
  assert(c >= T);
});

Deno.test("generic-verb FP: a shared verb covers nothing once the stoplist drops it", () => {
  const c = subjectCoverage(
    "deployed the dashboard fix",
    "deploy the app and the demo",
  );
  assertEquals(c, 0); // measured 0.00
});

// --- Metric mechanics --------------------------------------------------------

Deno.test("stoplist applies to the description's raw words, before stemming", () => {
  // "needs" is on the stoplist raw; stemmed it would be "need", also listed,
  // but a word the stoplist only matches post-stem must NOT be dropped: "runs"
  // is listed raw, "running" is not, so "running" survives as content.
  assertEquals(subjectCoverage("running the export", "running the export"), 1);
  assertEquals(subjectCoverage("x y z", "needs the export"), 0);
});

Deno.test("a description with fewer than 2 content tokens uses all its tokens", () => {
  // "The operator runs both deploys": after the stoplist only "both"/"deploys" would
  // remain (2), so the rule does not fire. "check the export": after the
  // stoplist only "export" (1) remains, so all three raw tokens count.
  assertEquals(subjectCoverage("exported it", "check the export"), 1 / 3);
});

Deno.test("empty sides score 0", () => {
  assertEquals(subjectCoverage("", "deploy the app"), 0);
  assertEquals(subjectCoverage("deployed the app", ""), 0);
});

Deno.test("stem: the documented families and surprises are unchanged", () => {
  assertEquals(stem("rotation"), "rotat");
  assertEquals(stem("rotated"), "rotat");
  assertEquals(stem("rotating"), "rotat");
  assertEquals(stem("rotate"), "rotat");
  assertEquals(stem("notion"), "not");
  assertEquals(stem("deployment"), "deployment");
  assertEquals(stem("fixes"), "fixe");
  assertEquals(stem("fixed"), "fix");
});
