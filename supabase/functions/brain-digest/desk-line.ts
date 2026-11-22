// Loop-closing Task 2.3 (D5, D6): one deterministic line about the board desk
// in every daily and weekly digest, rendered from exact agent_tasks rows, so a
// desk that never moves is visible as a number rather than invisible as a
// habit. Pure: no clock, no I/O; the caller passes the rows and the moment.
//
// Shape (fixed, tests pin it):
//   Board desk: Needs Operator 7 (oldest 116 d), Review held 7 (oldest 56 d),
//   Needs Input 4, 1 hold past its not-before date (f78f1aec).
//
// "oldest" is card age from created_at, the one deterministic figure a single
// agent_tasks read gives. The sentinel measures the current continuous stay
// from the event trail; the two agree for a card that entered its lane when it
// was created and differ for one that bounced, which is why the sentinel line
// is still the graded figure and this line is the daily reminder.

export interface DeskRow {
  id: string;
  status: string;
  created_at: string;
  archived_at?: string | null;
  not_before?: string | null;
  title?: string | null;
  desired_outcome?: string | null;
}

export const DESK_STATUSES = [
  "Needs Operator",
  "Agent Review",
  "Agent Needs Input",
] as const;

// Same marker the sentinel prompt uses (integrations/open-engine-sentinel/
// routine-prompt.txt, step 3): "perpetual" together with "canary" or
// "tripwire", in the title or desired_outcome, case-insensitive. No ids are
// hardcoded, so a fork with its own canaries gets the same behaviour.
export function isPerpetualCanary(row: DeskRow): boolean {
  const text = `${row.title ?? ""}\n${row.desired_outcome ?? ""}`.toLowerCase();
  return text.includes("perpetual") &&
    (text.includes("canary") || text.includes("tripwire"));
}

function wholeDays(fromIso: string, nowMs: number): number {
  const from = Date.parse(fromIso);
  if (Number.isNaN(from)) return 0;
  return Math.max(0, Math.floor((nowMs - from) / 86_400_000));
}

// Called only on Agent Needs Input rows (the lane filter below is the one
// status check, so a mutation there has nothing to hide behind).
function isExpiredHold(row: DeskRow, nowMs: number): boolean {
  if (!row.not_before) return false;
  const at = Date.parse(row.not_before);
  if (Number.isNaN(at)) return false;
  return at < nowMs;
}

function laneClause(label: string, rows: DeskRow[], nowMs: number): string {
  if (rows.length === 0) return `${label} 0`;
  const oldest = Math.max(...rows.map((r) => wholeDays(r.created_at, nowMs)));
  return `${label} ${rows.length} (oldest ${oldest} d)`;
}

export function renderDeskLine(rows: DeskRow[], nowIso: string): string {
  const nowMs = Date.parse(nowIso);
  // Archived and canary rows drop here; each lane then selects its own status,
  // which is what excludes a released (Agent Todo) or terminal (Agent Done)
  // card that still carries a stale date.
  const live = rows.filter((r) => !r.archived_at && !isPerpetualCanary(r));
  const desk = live.filter((r) => r.status === "Needs Operator");
  const review = live.filter((r) => r.status === "Agent Review");
  const held = live.filter((r) => r.status === "Agent Needs Input");
  const expired = held
    .filter((r) => isExpiredHold(r, nowMs))
    .map((r) => r.id.slice(0, 8))
    .sort();

  const expiredClause = expired.length === 0
    ? "no holds past their not-before date"
    : expired.length === 1
    ? `1 hold past its not-before date (${expired[0]})`
    : `${expired.length} holds past their not-before date (${expired.join(", ")})`;

  return `Board desk: ${laneClause("Needs Operator", desk, nowMs)}, ${
    laneClause("Review held", review, nowMs)
  }, Needs Input ${held.length}, ${expiredClause}.`;
}
