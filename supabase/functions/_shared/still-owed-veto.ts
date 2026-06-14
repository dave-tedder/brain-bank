// LAYER 3.5 still-owed adjacency veto. Runs after quote-overlap and before
// resolving an action item. The caller injects the mirrored LAYER 3 stemmer.

export const STILL_OWED_WINDOW = 6;

export const STILL_OWED_MARKERS: readonly string[] = [
  "queued",
  "remaining",
  "outstanding",
  "pending",
  "deferred",
  "todo",
  "unblocked",
  "prepped",
];

const SUBJECT_STOPLIST: readonly string[] = [
  "todo",
  "task",
  "item",
  "the",
  "for",
  "and",
  "with",
  "next",
  "this",
  "that",
];

export type VetoResult = {
  vetoed: boolean;
  marker?: string;
  subject?: string;
  distance?: number;
};

function rawTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

export function stillOwedAdjacencyVeto(
  note: string,
  description: string,
  stem: (token: string) => string,
): VetoResult {
  const markerStems = new Map<string, string>();
  for (const marker of STILL_OWED_MARKERS) {
    markerStems.set(stem(marker), marker);
  }

  const stopStems = new Set(SUBJECT_STOPLIST.map(stem));
  const subjectStems = new Set(
    rawTokens(description)
      .filter((token) => token.length >= 3)
      .map(stem)
      .filter((token) => !stopStems.has(token)),
  );
  if (subjectStems.size === 0) return { vetoed: false };

  const noteStems = rawTokens(note).map(stem);
  for (let markerIndex = 0; markerIndex < noteStems.length; markerIndex++) {
    const marker = markerStems.get(noteStems[markerIndex]);
    if (!marker) continue;

    const low = Math.max(0, markerIndex - STILL_OWED_WINDOW);
    const high = Math.min(noteStems.length - 1, markerIndex + STILL_OWED_WINDOW);
    for (let subjectIndex = low; subjectIndex <= high; subjectIndex++) {
      if (subjectStems.has(noteStems[subjectIndex])) {
        return {
          vetoed: true,
          marker,
          subject: noteStems[subjectIndex],
          distance: Math.abs(markerIndex - subjectIndex),
        };
      }
    }
  }

  return { vetoed: false };
}
