// supabase/functions/_shared/quote-coverage.ts
//
// LAYER 3 of checkAutoResolve: does the LLM's past-tense `reason` quote
// substantively address the candidate action item?
//
// Loop-closing Task 1.3 (synthesis B1) replaced Jaccard-over-the-union with
// SUBJECT COVERAGE. Jaccard punished exactly the precise quotes the LAYER 2
// prompt demands: a long quote full of commit hashes and Railway ids inflated
// the union and drove the score below 0.25, so on 2026-11-02 six of eight
// Layer 3 drops were real completions the model had found (audit
// docs/audits/2026-11-03-loop-closing-synthesis.md section 2.1). Coverage
// asks the other question: what share of the DESCRIPTION's content tokens
// appear in the quote? The quote's length no longer matters.
//
// Single source for both capture files (like still-owed-veto.ts); `stem`
// moved here from open-brain-mcp/index.ts and ingest-thought/index.ts, which
// also pass it to stillOwedAdjacencyVeto. No mirror burden for the helper
// itself; only the LAYER 3 call block inside each checkAutoResolve is mirrored.

// Minimal stemmer. Collapses common English verb/noun alternation so
// "rotation"/"rotate"/"rotating"/"rotated" all converge on "rotat".
// Deliberately not a full Porter stemmer. Rules applied in order, chaining
// allowed. Known surprises (documented, not bugs): `notion` -> `not`;
// `-ment` is not covered (`deployment` stays whole while `deployed` -> `deploy`);
// `fixes` -> `fixe` (diverges from `fix`/`fixing`/`fixed`).
export function stem(token: string): string {
  let t = token;
  if (t.length >= 4 && t.endsWith("s")) t = t.slice(0, -1);
  if (t.length >= 5 && t.endsWith("ing")) t = t.slice(0, -3);
  if (t.length >= 4 && t.endsWith("ed")) t = t.slice(0, -2);
  if (t.length >= 5 && t.endsWith("tion")) t = t.slice(0, -4) + "t";
  if (t.length >= 5 && t.endsWith("e")) t = t.slice(0, -1);
  return t;
}

// Generic verbs and function words that say nothing about WHAT the item is.
// Matched on raw lowercase words BEFORE stemming, and applied to the
// description only. Many entries are shorter than the 3-character token
// floor and are listed for completeness of the plan's interface. If your
// action items routinely name you as the actor ("Alex runs the deploy"), add
// your own first name here, lowercase, the way "operator" is.
export const SUBJECT_COVERAGE_STOPLIST: ReadonlySet<string> = new Set([
  "need", "needs", "should", "must", "todo", "operator", "run", "runs", "do",
  "does", "make", "update", "fix", "check", "deploy", "apply", "add", "then",
  "the", "and", "for", "with", "that", "this", "from", "into", "to", "it",
  "its", "his", "her", "him", "on", "in", "of", "by", "a", "an", "at", "be",
  "is", "are", "was", "were", "has", "have", "had", "so",
]);

// Measured on the eight full logged pairs of 2026-11-02: at 0.4 the metric
// recovers 4 of 6 real completions and still blocks both lexical false
// positives and the FluentSMTP case (plan Task 1.3 table). A false positive
// found by the monthly hand read reverts this to 0.5 and reopens the task.
export const SUBJECT_COVERAGE_THRESHOLD = 0.4;

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

/** Share of the description's distinct content tokens (stoplist dropped on
 * raw words, then stemmed) that appear among the quote's stemmed tokens. A
 * description with fewer than 2 content tokens after the stoplist uses all
 * its tokens. 0 when either side has no tokens. */
export function subjectCoverage(quote: string, description: string): number {
  const quoteStems = new Set(words(quote).map(stem));
  const rawDesc = words(description);
  let content = rawDesc.filter((w) => !SUBJECT_COVERAGE_STOPLIST.has(w));
  if (content.length < 2) content = rawDesc;
  const descStems = new Set(content.map(stem));
  if (quoteStems.size === 0 || descStems.size === 0) return 0;
  let covered = 0;
  for (const t of descStems) if (quoteStems.has(t)) covered++;
  return covered / descStems.size;
}
