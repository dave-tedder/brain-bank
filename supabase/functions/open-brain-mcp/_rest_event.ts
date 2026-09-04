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
  event_type: unknown;
  date_start: unknown;
  date_end: unknown;
  location: unknown;
  notes: unknown;
  metadata: MetadataRecord | null;
}

/**
 * Build the `.update()` patch for an existing row. `existingMetadata` is the
 * row's current jsonb; the payload's top-level metadata keys win and every key
 * it does not mention is left standing.
 */
export function buildRestEventUpdate(
  body: RestEventBody,
  existingMetadata: unknown,
): RestEventUpdate {
  return {
    title: body.title,
    event_type: body.event_type || null,
    date_start: body.date_start || null,
    date_end: body.date_end || null,
    location: body.location || null,
    notes: body.notes || null,
    metadata: mergeMetadata(existingMetadata, body.metadata),
  };
}
