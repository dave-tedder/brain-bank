// _rest_event.ts — the pure part of the REST `/event` route's update path.
//
// `handleRestEvent` in index.ts finds the existing business_events row by
// metadata.gcal_event_id and applies the patch built here. Kept out of index.ts
// so the exact object sent to `.update()` is unit-testable: the merge of
// `metadata` is the part that matters (see ../_shared/metadata-merge.ts for why),
// and the scalar columns keep the route's long-standing semantics, where an
// omitted field is written as null because the calendar sync always sends the
// full set.

import { mergeMetadata, type MetadataRecord } from "../_shared/metadata-merge.ts";

export interface RestEventBody {
  title: string;
  event_type?: unknown;
  date_start?: unknown;
  date_end?: unknown;
  location?: unknown;
  notes?: unknown;
  metadata?: unknown;
}

export interface RestEventUpdate {
  title: string;
  /** Absent (not null) when another writer owns the row's event_type. */
  event_type?: unknown;
  date_start: unknown;
  date_end: unknown;
  location: unknown;
  notes: unknown;
  metadata: MetadataRecord | null;
}

function sourceOf(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }
  const source = (metadata as MetadataRecord).source;
  return typeof source === "string" ? source : null;
}

/**
 * A writer that stamps `metadata.source` on a row owns that row's `event_type`:
 * the CRM push writes tattoo_session / consultation / cancelled_session from the
 * appointment's own kind and status, and the Dash-Bot bridge stamps
 * `dash-bot-create` / `dash-bot-reschedule`. The Apps Script calendar sync sends
 * no `source` and guesses `event_type` from the calendar title, so on a row
 * some other writer has claimed it must not overwrite the field (measured
 * 2026-09-04: four real tattoo appointments typed `general` after one pass).
 * Same source, or no source on the row, and the payload's event_type is written
 * as before.
 */
export function eventTypeOwnedByAnotherWriter(
  existingMetadata: unknown,
  incomingMetadata: unknown,
): boolean {
  const owner = sourceOf(existingMetadata);
  // An empty string is nobody's claim, hence the falsy check rather than null.
  if (!owner) return false;
  return sourceOf(incomingMetadata) !== owner;
}

/**
 * Build the `.update()` patch for an existing row. `existingMetadata` is the
 * row's current jsonb; the payload's top-level metadata keys win and every key
 * it does not mention is left standing. `event_type` is omitted from the patch
 * (left as it is on the row) when another writer owns it, see above.
 */
export function buildRestEventUpdate(
  body: RestEventBody,
  existingMetadata: unknown,
): RestEventUpdate {
  const patch: RestEventUpdate = {
    title: body.title,
    date_start: body.date_start || null,
    date_end: body.date_end || null,
    location: body.location || null,
    notes: body.notes || null,
    metadata: mergeMetadata(existingMetadata, body.metadata),
  };
  if (!eventTypeOwnedByAnotherWriter(existingMetadata, body.metadata)) {
    patch.event_type = body.event_type || null;
  }
  return patch;
}
