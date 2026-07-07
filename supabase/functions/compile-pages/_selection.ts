// --- Per-run page selection (fairness lane) ---
//
// The scheduled compile queue is oldest-`last_compiled`-first and capped at
// `batch` pages per run (throughput is really bounded by the 150s Edge wall, so
// batch ~10 is the practical ceiling). High-volume topic pages (busy tags with
// deep backlogs) never fully drain in one capped run, so their watermark stays
// in the past and they permanently occupy the front of the oldest-first queue —
// starving client and curated-project pages that sit just behind them. Fix
// (Session 281): split the per-run budget into two lanes so topic backlog can't
// monopolize the batch.
//
//   - high-value lane: client + curated-project pages (the named entity pages
//     the wiki exists to keep fresh)
//   - backlog lane: everything else (topic pages)
//
// The high-value lane is guaranteed up to `reserve` slots; the rest go to the
// backlog lane. Unused slots in either lane spill to the other so the batch is
// always filled when candidates exist. Both lanes stay oldest-first (the
// caller passes candidates already sorted oldest-`last_compiled`-first, and the
// filters below preserve that order).

export function isHighValuePage(page: { page_type: string }): boolean {
  // Project pages in compiled_pages are curated rows joined to the projects
  // table (Phase 15.3); they are entity pages, not mechanical topic feeds.
  return page.page_type === "client" || page.page_type === "project";
}

export function selectPagesToCompile<T extends { page_type: string }>(
  candidates: T[],
  batch: number,
  reserve: number,
): T[] {
  const cap = Math.max(0, batch);
  if (cap === 0) return [];
  const reserved = Math.min(Math.max(0, reserve), cap);

  const highValue = candidates.filter(isHighValuePage);
  const backlog = candidates.filter((p) => !isHighValuePage(p));

  const picks: T[] = [];
  // 1. Reserved high-value slots (oldest-first).
  picks.push(...highValue.slice(0, reserved));
  // 2. Fill the rest of the batch from the backlog lane (oldest-first). If the
  //    high-value lane was short, this naturally takes more backlog pages.
  picks.push(...backlog.slice(0, cap - picks.length));
  // 3. Backlog short? Spill remaining slots back to extra high-value pages.
  if (picks.length < cap) {
    picks.push(...highValue.slice(reserved, reserved + (cap - picks.length)));
  }
  return picks;
}
