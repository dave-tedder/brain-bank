// Appointment extraction guard.
//
// Past/undated appointment reminders extracted from chatgpt and brain-channel
// person_note/task captures tend to become open action items ("Prepare for
// appointment with Jordan Lee", "Schedule Appointment - Alex Smith"). These
// duplicate the operator's real booking system and rot into stale backlog
// rows. Rule: appointment-shaped items are review-only — not stored — UNLESS
// the source carries explicit still-owed language or a future-date signal.
//
// Deterministic and conservative by design: an ambiguous date (month-day
// with no year) counts as a future signal, so the guard only drops items
// that are provably unanchored (no date, or a year-bearing date in the past)
// AND carry no still-owed phrasing in the item or its source content.
// Single source in _shared/ — imported by both capture files, no byte-mirror
// burden (same pattern as still-owed-veto.ts).

import { STILL_OWED_MARKERS } from "./still-owed-veto.ts";

// Extend with business-specific session vocabulary if your booking language
// differs (e.g. "grooming session", "studio session").
const APPOINTMENT_SHAPE_RE =
  /\b(?:appointment|appt|consult(?:ation)?|touch[- ]?up)\b/i;

// Explicit still-owed phrasing. Complements STILL_OWED_MARKERS (single words)
// with the multi-word commitment phrases common in person notes.
const STILL_OWED_PHRASE_RE =
  /\b(?:need(?:s)? to|should|must|still|don'?t forget|do not forget|not yet|overdue|to-?do)\b/i;

const RELATIVE_FUTURE_RE =
  /\b(?:tomorrow|tonight|upcoming|next\s+(?:week|month|year|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?))\b/i;

const MONTH_NAMES =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const MONTH_INDEX: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// ISO yyyy-mm-dd
const ISO_DATE_RE = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g;
// US m/d/yyyy or m/d/yy
const SLASH_DATE_RE = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/g;
// "May 30", "May 30th", "May 30, 2026" — day required; bare month names are
// not a date anchor ("in March or April" anchors nothing).
const MONTH_DAY_RE = new RegExp(
  `\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`,
  "gi",
);

function startOfDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

// True when the text carries any date signal that is future or ambiguous
// (ambiguous = no year, resolvable to a future occurrence). Year-bearing
// dates strictly before `now`'s date are past and do NOT count.
export function hasFutureDateSignal(text: string, now: Date): boolean {
  if (RELATIVE_FUTURE_RE.test(text)) return true;
  const today = startOfDay(now);

  for (const m of text.matchAll(ISO_DATE_RE)) {
    const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    if (t >= today) return true;
  }
  for (const m of text.matchAll(SLASH_DATE_RE)) {
    const yearRaw = Number(m[3]);
    const year = yearRaw < 100 ? 2000 + yearRaw : yearRaw;
    const t = Date.UTC(year, Number(m[1]) - 1, Number(m[2]));
    if (t >= today) return true;
  }
  for (const m of text.matchAll(MONTH_DAY_RE)) {
    const month = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
    const day = Number(m[2]);
    if (m[3]) {
      const t = Date.UTC(Number(m[3]), month, day);
      if (t >= today) return true;
    } else {
      // No year → ambiguous → treat as the next occurrence, i.e. future.
      return true;
    }
  }
  return false;
}

const STILL_OWED_WORD_RES = STILL_OWED_MARKERS.map(
  (w) => new RegExp(`\\b${w}\\b`, "i"),
);

function hasStillOwedLanguage(text: string): boolean {
  return STILL_OWED_PHRASE_RE.test(text) ||
    STILL_OWED_WORD_RES.some((re) => re.test(text));
}

// True → the extracted item is an unanchored appointment reminder and must
// NOT be stored as an open action item. `content` is the full source capture;
// keep-signals are honored from either the item or its source ("unless the
// SOURCE contains a future date or explicit still-owed language").
export function isUnanchoredAppointmentItem(
  itemText: string,
  content: string,
  now: Date,
): boolean {
  if (!APPOINTMENT_SHAPE_RE.test(itemText)) return false;
  if (hasStillOwedLanguage(itemText) || hasStillOwedLanguage(content)) {
    return false;
  }
  if (hasFutureDateSignal(itemText, now) || hasFutureDateSignal(content, now)) {
    return false;
  }
  return true;
}
