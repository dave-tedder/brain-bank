// metadata-merge.ts — shallow merge for a jsonb `metadata` column that more than
// one writer shares.
//
// Convention, matching external-crm-sync/_sync.ts (buildClientPatch and
// buildEventPatch both spread `...(existing?.metadata ?? {})` first, then set
// their own keys on top):
//   - incoming top-level keys win, including an explicit null;
//   - keys absent from the incoming payload are left standing;
//   - the merge is one level deep: a nested object is replaced, not merged.
//
// Why this exists: rows in `business_events` on the operator's calendar have two
// writers. The Apps Script calendar sync (integrations/calendar-sync) owns times,
// attendees, calendar and all_day; the CRM push (external-crm-sync) owns
// crm_appointment_id, crm_client_id, source, status, kind and pushed_at. The
// REST `/event` route used to write `metadata: metadata || null` on update, so
// every calendar pass replaced the whole object and stripped the push's keys
// off every row it shared (measured on a live deployment 2026-09-04: rows
// carrying the CRM appointment id fell from 60 to 55, and every stamped row
// inside the sync window was left with exactly six keys). Any writer that
// shares a row with another writer needs this, so nothing here is specific to
// either of them.

export type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as MetadataRecord;
}

/**
 * Merge `incoming` over `existing`, one level deep. Returns a new object;
 * neither input is mutated. Returns null only when neither side is an object,
 * so a row with no metadata and a payload with none stays null rather than
 * becoming `{}`.
 */
export function mergeMetadata(
  existing: unknown,
  incoming: unknown,
): MetadataRecord | null {
  const base = asRecord(existing);
  const patch = asRecord(incoming);
  if (!base && !patch) return null;
  return { ...(base ?? {}), ...(patch ?? {}) };
}
