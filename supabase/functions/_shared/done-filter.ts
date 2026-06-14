// Phase 15.4 / audit C5: keyword pre-filter + cap for `done:` Slack command.
// Before this helper, handleDoneCommand sent every open action item (~1000+
// rows post-audit) to the LLM in a single prompt. At that scale, the model
// degrades and over-matches. This helper keeps the candidate set bounded:
// 1. Tokenize the done text (lowercase, alphanumeric split, drop stopwords / len<3).
// 2. If tokens present, filter open items to those sharing at least one token.
// 3. If overlap set is empty (or done text yields no usable tokens), fall back
//    to the first `cap` items so the user still gets a best-effort match.
// 4. Always respect `cap` (default 200).

const STOPWORDS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "have", "has", "had",
  "was", "were", "are", "will", "would", "could", "should", "been", "being",
  "its", "his", "her", "their", "them", "they", "our", "out", "about", "into",
  "some", "any", "all", "can", "may", "more", "just", "also", "than", "then",
  "one", "two", "only", "very", "most", "much", "few", "now", "here", "there",
  "when", "where", "what", "which", "who", "how", "why", "still",
  // 'done' itself is noise in a done: command
  "done", "did", "does",
]);

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 3 && !STOPWORDS.has(t)) tokens.add(t);
  }
  return tokens;
}

export interface OpenItem {
  id: string;
  description: string;
}

export function filterCandidatesForDone<T extends OpenItem>(
  doneText: string,
  openItems: T[],
  cap = 200,
): T[] {
  const doneTokens = tokenize(doneText);
  if (doneTokens.size === 0) return openItems.slice(0, cap);

  const overlap = openItems.filter((item) => {
    const itemTokens = tokenize(item.description);
    for (const t of doneTokens) {
      if (itemTokens.has(t)) return true;
    }
    return false;
  });

  if (overlap.length === 0) return openItems.slice(0, cap);
  return overlap.slice(0, cap);
}

export const _internals = { tokenize, STOPWORDS };
