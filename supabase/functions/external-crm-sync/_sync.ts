// external-crm-sync: pure upsert logic, no I/O.
//
// An external CRM (the operator's system of record for contacts and
// appointments, living in its own database) pushes them here one way.
// This module decides what to write; `index.ts` owns HTTP, auth and the
// supabase-js store. Every decision here is unit-tested against an in-memory
// store in `_sync_test.ts`, which is why nothing in this file touches Deno,
// fetch or supabase-js.
//
// Idempotency and race safety, stated once:
//   - Clients are keyed on `clients.metadata->>'crm_id'`, events on
//     `business_events.metadata->>'crm_appointment_id'`. Both keys carry
//     a PARTIAL UNIQUE INDEX (migration 20260903_external_crm_sync_unique_keys),
//     so the database, not this code, is the arbiter of "one row per id".
//   - supabase-js has no transaction, so an advisory lock cannot span the
//     lookup and the write from an Edge Function. The chosen serialisation is
//     therefore insert-then-select with ONE retry: when a write loses a race
//     the unique index raises 23505, the store surfaces it as
//     `UniqueViolation`, and the operation re-runs its lookup, which now finds
//     the winner's row and updates it instead. Two pushes of one appointment
//     cannot race into two rows.
//   - Metadata is always MERGED (existing ⊕ patch), never replaced. The
//     existing REST `/event` route replaces metadata wholesale; this module
//     deliberately does not, because the Apps Script calendar sync and this
//     push share event rows.
//   - Intakes (`capture_intake`) are keyed on
//     `thoughts.metadata->>'crm_intake_id'`, which carries its own
//     partial unique index (migration 20261010_external_crm_intake_unique_key).
//     An intake is never updated: a second push of the same id answers
//     `duplicate` with the existing thought's id and writes nothing.

import { normalizeTopic } from "../_shared/metadata-validation.ts";

export const SYNC = {
  /** metadata.source stamped on every row this function writes */
  source: "external-crm",
  /** clients.metadata key holding the CRM's client id (unique, indexed) */
  clientIdKey: "crm_id",
  clientSyncedAtKey: "crm_synced_at",
  /** set on a second Brain Bank row that maps to an already-claimed CRM card */
  clientDuplicateOfKey: "crm_duplicate_of",
  releaseFormKey: "release_form_signed_on",
  /** business_events.metadata key holding the CRM's appointment id (unique) */
  appointmentIdKey: "crm_appointment_id",
  eventClientIdKey: "crm_client_id",
  gcalIdKey: "gcal_event_id",
  gcalSuffix: "@google.com",
  cancelledPrefix: "CANCELLED - ",
  /** thoughts.metadata key holding the CRM's intake id (unique, indexed) */
  intakeIdKey: "crm_intake_id",
} as const;

export const INTAKE_AUDIENCES = ["artist", "shop_queue"] as const;
export type IntakeAudience = typeof INTAKE_AUDIENCES[number];

export const EVENT_TYPES = [
  "tattoo_session",
  "consultation",
  "cancelled_session",
] as const;
export type EventType = typeof EVENT_TYPES[number];

export type Metadata = Record<string, unknown>;

/** The client columns this function may read. `notes` and `preferred_styles`
 * are deliberately absent from the type: they belong to Brain Bank's agents
 * and the push can neither see nor write them. */
export interface ClientRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  instagram: string | null;
  first_contact: string | null;
  last_contact: string | null;
  metadata: Metadata | null;
}

export interface ClientPatch {
  name?: string;
  email?: string | null;
  phone?: string | null;
  instagram?: string | null;
  first_contact?: string;
  last_contact?: string | null;
  metadata?: Metadata;
}

export interface ClientInsert extends ClientPatch {
  name: string;
  metadata: Metadata;
}

export interface EventRow {
  id: string;
  title: string;
  event_type: string | null;
  date_start: string | null;
  date_end: string | null;
  location: string | null;
  metadata: Metadata | null;
}

export interface EventPatch {
  title?: string;
  event_type?: EventType;
  date_start?: string;
  date_end?: string;
  location?: string | null;
  metadata?: Metadata;
}

export interface EventInsert extends EventPatch {
  title: string;
  event_type: EventType;
  date_start: string;
  date_end: string;
  metadata: Metadata;
}

/** Raised by a store when the database rejects a write on one of the two
 * partial unique indexes (Postgres SQLSTATE 23505). */
export class UniqueViolation extends Error {
  readonly code = "23505";
  constructor(message = "unique violation") {
    super(message);
    this.name = "UniqueViolation";
  }
}

export interface SyncStore {
  findClientByExternalId(externalId: string): Promise<ClientRow | null>;
  findClientById(id: string): Promise<ClientRow | null>;
  insertClient(record: ClientInsert): Promise<{ id: string }>;
  updateClient(id: string, patch: ClientPatch): Promise<void>;
  findEventByAppointmentId(appointmentId: string): Promise<EventRow | null>;
  findEventByGcalIds(ids: string[]): Promise<EventRow | null>;
  insertEvent(record: EventInsert): Promise<{ id: string }>;
  updateEvent(id: string, patch: EventPatch): Promise<void>;
  findThoughtByIntakeId(intakeId: string): Promise<{ id: string } | null>;
  insertThought(record: ThoughtInsert): Promise<{ id: string }>;
}

export interface ThoughtInsert {
  content: string;
  embedding: number[];
  content_hash: string;
  metadata: Metadata;
}

/** The capture pipeline `capture_intake` reuses (embedding, metadata
 * extraction, coercion, project routing, action-item storage). Injected so
 * the decision logic here stays pure; `index.ts` wires the real one from
 * `_shared/capture-pipeline.ts` and `_shared/metadata-validation.ts`. */
export interface CapturePipeline {
  /** SHA-256 of the trimmed text, the same function every capture path uses. */
  hash(text: string): Promise<string>;
  /** Embedding plus coerced, project-routed metadata for `content`. */
  analyze(content: string): Promise<{ embedding: number[]; metadata: Metadata }>;
  /** Post-insert work (action-item storage). A throw here is logged by the
   * caller and never turns a stored thought into a failed capture. */
  afterInsert(thoughtId: string, content: string, metadata: Metadata): Promise<void>;
}

export interface SyncResult {
  status: number;
  body: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

type Body = Record<string, unknown>;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ID = 128;
const MAX_TEXT = 2000;

/** Reads an optional string field. Returns `undefined` when the key is absent,
 * `null` when explicitly null, the trimmed string otherwise. Pushes to
 * `errors` on any other type. */
function optString(
  body: Body,
  key: string,
  errors: string[],
  max = MAX_TEXT,
): string | null | undefined {
  if (!(key in body)) return undefined;
  const v = body[key];
  if (v === undefined) return undefined; // JSON never carries undefined; treat as absent
  if (v === null) return null;
  if (typeof v !== "string") {
    errors.push(`${key} must be a string or null`);
    return undefined;
  }
  const t = v.trim();
  if (t.length > max) errors.push(`${key} exceeds ${max} characters`);
  return t;
}

function reqString(
  body: Body,
  key: string,
  errors: string[],
  max = MAX_TEXT,
): string {
  const v = optString(body, key, errors, max);
  if (v === undefined || v === null || v === "") {
    errors.push(`${key} is required`);
    return "";
  }
  return v;
}

function optTimestamp(
  body: Body,
  key: string,
  errors: string[],
): string | null | undefined {
  const v = optString(body, key, errors, 64);
  if (v === undefined || v === null) return v;
  if (v === "" || Number.isNaN(Date.parse(v))) {
    errors.push(`${key} must be a date or ISO timestamp`);
    return undefined;
  }
  return v;
}

function optDate(
  body: Body,
  key: string,
  errors: string[],
): string | null | undefined {
  const v = optString(body, key, errors, 10);
  if (v === undefined || v === null) return v;
  if (!DATE_RE.test(v) || Number.isNaN(Date.parse(v))) {
    errors.push(`${key} must be YYYY-MM-DD`);
    return undefined;
  }
  return v;
}

export interface ClientPayload {
  crm_id: string;
  brain_bank_id?: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  instagram?: string | null;
  first_contact?: string | null;
  last_contact?: string | null;
  release_form_signed_on?: string | null;
}

export function parseClientPayload(
  input: unknown,
): { ok: true; payload: ClientPayload } | { ok: false; errors: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Body;
  const errors: string[] = [];
  const crm_id = reqString(body, "crm_id", errors, MAX_ID);
  const name = reqString(body, "name", errors, 500);
  const brain_bank_id = optString(body, "brain_bank_id", errors, 64);
  if (brain_bank_id !== undefined && brain_bank_id !== null) {
    if (!UUID_RE.test(brain_bank_id)) errors.push("brain_bank_id must be a uuid");
  }
  const payload: ClientPayload = { crm_id, name };
  if (brain_bank_id) payload.brain_bank_id = brain_bank_id;
  const email = optString(body, "email", errors, 320);
  if (email !== undefined) payload.email = email || null;
  const phone = optString(body, "phone", errors, 64);
  if (phone !== undefined) payload.phone = phone || null;
  const instagram = optString(body, "instagram", errors, 128);
  if (instagram !== undefined) payload.instagram = instagram || null;
  const first_contact = optTimestamp(body, "first_contact", errors);
  if (first_contact !== undefined) payload.first_contact = first_contact;
  const last_contact = optTimestamp(body, "last_contact", errors);
  if (last_contact !== undefined) payload.last_contact = last_contact;
  const release = optTimestamp(body, "release_form_signed_on", errors);
  if (release !== undefined) payload.release_form_signed_on = release;
  if (errors.length) return { ok: false, errors };
  return { ok: true, payload };
}

export interface EventPayload {
  crm_appointment_id: string;
  crm_client_id?: string | null;
  gcal_event_id?: string | null;
  event_type: EventType;
  title: string;
  date_start: string;
  date_end: string;
  location?: string | null;
  attendees?: string[];
  calendar?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  status?: string | null;
  kind?: string | null;
  rescheduled_from?: string | null;
  pushed_at?: string;
}

export function parseEventPayload(
  input: unknown,
): { ok: true; payload: EventPayload } | { ok: false; errors: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Body;
  const errors: string[] = [];
  const crm_appointment_id = reqString(
    body,
    "crm_appointment_id",
    errors,
    MAX_ID,
  );
  const title = reqString(body, "title", errors, 500);
  const rawType = reqString(body, "event_type", errors, 64);
  if (rawType && !(EVENT_TYPES as readonly string[]).includes(rawType)) {
    errors.push(`event_type must be one of ${EVENT_TYPES.join(", ")}`);
  }
  const date_start = optDate(body, "date_start", errors);
  if (!date_start) errors.push("date_start is required");
  const date_end = optDate(body, "date_end", errors);
  const payload: EventPayload = {
    crm_appointment_id,
    title,
    event_type: rawType as EventType,
    date_start: date_start || "",
    date_end: date_end || date_start || "",
  };
  const cbClient = optString(body, "crm_client_id", errors, MAX_ID);
  if (cbClient !== undefined) payload.crm_client_id = cbClient || null;
  const gcal = optString(body, "gcal_event_id", errors, 256);
  if (gcal !== undefined) payload.gcal_event_id = gcal || null;
  const location = optString(body, "location", errors, 500);
  if (location !== undefined) payload.location = location || null;
  if ("attendees" in body) {
    const a = body.attendees;
    if (
      !Array.isArray(a) || a.some((x) => typeof x !== "string" || x.length > 320)
    ) {
      errors.push("attendees must be an array of strings");
    } else {
      payload.attendees = a.map((x) => (x as string).trim()).filter(Boolean);
    }
  }
  for (
    const key of [
      "calendar",
      "start_time",
      "end_time",
      "status",
      "kind",
    ] as const
  ) {
    const v = optString(body, key, errors, 128);
    if (v !== undefined) payload[key] = v || null;
  }
  const rescheduled_from = optDate(body, "rescheduled_from", errors);
  if (rescheduled_from !== undefined) payload.rescheduled_from = rescheduled_from;
  const pushed_at = optTimestamp(body, "pushed_at", errors);
  if (pushed_at) payload.pushed_at = pushed_at;
  if (errors.length) return { ok: false, errors };
  return { ok: true, payload };
}

export interface IntakePayload {
  crm_intake_id: string;
  content: string;
  submitted_at: string;
  site: string | null;
  venue: string | null;
  audience: IntakeAudience | null;
  tags: string[];
}

/** Content arrives already formatted and scrubbed by the CRM (typically
 * well under 2,000 chars). The cap is generous on purpose: a 400 parks the row for good. */
const MAX_INTAKE_CONTENT = 8000;

/** Only the contract's fields are read; any other key in the body is ignored
 * and never stored, so a contact field added upstream cannot land here. */
export function parseIntakePayload(
  input: unknown,
): { ok: true; payload: IntakePayload } | { ok: false; errors: string[] } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["body must be a JSON object"] };
  }
  const body = input as Body;
  const errors: string[] = [];
  const crm_intake_id = reqString(
    body,
    "crm_intake_id",
    errors,
    MAX_ID,
  );
  if (crm_intake_id && !UUID_RE.test(crm_intake_id)) {
    errors.push("crm_intake_id must be a uuid");
  }
  const content = reqString(body, "content", errors, MAX_INTAKE_CONTENT);
  const submitted_at = optTimestamp(body, "submitted_at", errors);
  if (!submitted_at) errors.push("submitted_at is required");
  const site = optString(body, "site", errors, 256);
  const venue = optString(body, "venue", errors, 256);
  const rawAudience = optString(body, "audience", errors, 64);
  if (
    rawAudience &&
    !(INTAKE_AUDIENCES as readonly string[]).includes(rawAudience)
  ) {
    errors.push(`audience must be one of ${INTAKE_AUDIENCES.join(", ")}`);
  }
  let tags: string[] = [];
  if (body.tags !== undefined && body.tags !== null) {
    const t = body.tags;
    if (
      !Array.isArray(t) || t.some((x) => typeof x !== "string" || x.length > 64)
    ) {
      errors.push("tags must be an array of strings");
    } else {
      tags = t as string[];
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    payload: {
      crm_intake_id: crm_intake_id.toLowerCase(),
      content,
      submitted_at: submitted_at as string,
      site: site || null,
      venue: venue || null,
      audience: (rawAudience || null) as IntakeAudience | null,
      tags,
    },
  };
}

// ---------------------------------------------------------------------------
// Client upsert
// ---------------------------------------------------------------------------

/** Field policy for a pushed client. `name`, `email`, `phone`, `instagram`
 * and `last_contact` are the CRM's and are written whenever the payload
 * carries the key (an explicit null clears; an absent key leaves the column
 * alone). `first_contact` is filled only when the row has none. `notes` and
 * `preferred_styles` are not representable in `ClientPatch` at all. */
export function buildClientPatch(
  existing: ClientRow | null,
  p: ClientPayload,
  now: string,
): ClientPatch {
  const patch: ClientPatch = { name: p.name };
  if (p.email !== undefined) patch.email = p.email;
  if (p.phone !== undefined) patch.phone = p.phone;
  if (p.instagram !== undefined) patch.instagram = p.instagram;
  if (p.last_contact !== undefined) patch.last_contact = p.last_contact;
  if (!existing?.first_contact) {
    if (p.first_contact) patch.first_contact = p.first_contact;
    else if (!existing) patch.first_contact = now;
  }
  const metadata: Metadata = {
    ...(existing?.metadata ?? {}),
    [SYNC.clientIdKey]: p.crm_id,
    [SYNC.clientSyncedAtKey]: now,
    source: SYNC.source,
  };
  if (p.release_form_signed_on !== undefined) {
    metadata[SYNC.releaseFormKey] = p.release_form_signed_on;
  }
  patch.metadata = metadata;
  return patch;
}

async function withUniqueRetry<T>(
  attempt: () => Promise<T>,
): Promise<T> {
  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof UniqueViolation)) throw err;
    // Lost a race on one of the partial unique indexes: the lookup now finds
    // the winner's row, so the second pass updates instead of inserting.
    return await attempt();
  }
}

export async function upsertClient(
  store: SyncStore,
  input: unknown,
  now: string = new Date().toISOString(),
): Promise<SyncResult> {
  const parsed = parseClientPayload(input);
  if (!parsed.ok) return { status: 400, body: { error: parsed.errors } };
  const p = parsed.payload;

  return await withUniqueRetry(async (): Promise<SyncResult> => {
    if (p.brain_bank_id) {
      // First-run match: the CRM names the exact Brain Bank row it matched.
      const row = await store.findClientById(p.brain_bank_id);
      if (!row) {
        return { status: 404, body: { error: "brain_bank_id not found" } };
      }
      const claimedBy = row.metadata?.[SYNC.clientIdKey];
      if (
        typeof claimedBy === "string" && claimedBy && claimedBy !== p.crm_id
      ) {
        return {
          status: 409,
          body: {
            error: "row already claimed by another crm_id",
            id: row.id,
          },
        };
      }
      const canonical = await store.findClientByExternalId(p.crm_id);
      if (canonical && canonical.id !== row.id) {
        // A second Brain Bank row mapped to an already-claimed card: mark it
        // and change nothing else on it.
        const already = row.metadata?.[SYNC.clientDuplicateOfKey];
        if (already !== canonical.id) {
          await store.updateClient(row.id, {
            metadata: {
              ...(row.metadata ?? {}),
              [SYNC.clientDuplicateOfKey]: canonical.id,
            },
          });
        }
        return {
          status: 200,
          body: {
            status: "duplicate_marked",
            id: row.id,
            canonical_id: canonical.id,
          },
        };
      }
      await store.updateClient(row.id, buildClientPatch(row, p, now));
      return { status: 200, body: { status: "updated", id: row.id } };
    }

    const existing = await store.findClientByExternalId(p.crm_id);
    if (existing) {
      await store.updateClient(existing.id, buildClientPatch(existing, p, now));
      return { status: 200, body: { status: "updated", id: existing.id } };
    }
    const patch = buildClientPatch(null, p, now);
    const inserted = await store.insertClient({
      ...patch,
      name: p.name,
      metadata: patch.metadata as Metadata,
    });
    return { status: 201, body: { status: "created", id: inserted.id } };
  });
}

// ---------------------------------------------------------------------------
// Event upsert
// ---------------------------------------------------------------------------

/** The Apps Script calendar sync stores Google event ids as `<id>@google.com`
 * (what `CalendarEvent.getId()` returns); other bridges may store the bare
 * `<id>`. Both forms must find the same row, and the row is stamped with the
 * canonical `@google.com` form so the Apps Script keeps finding it too. */
export function gcalIdForms(id: string): { canonical: string; lookup: string[] } {
  const bare = id.endsWith(SYNC.gcalSuffix)
    ? id.slice(0, -SYNC.gcalSuffix.length)
    : id;
  const canonical = bare + SYNC.gcalSuffix;
  return { canonical, lookup: [canonical, bare] };
}

export function buildEventPatch(
  existing: EventRow | null,
  p: EventPayload,
  now: string,
): EventPatch {
  const title = p.event_type === "cancelled_session" &&
      !p.title.startsWith(SYNC.cancelledPrefix)
    ? SYNC.cancelledPrefix + p.title
    : p.title;
  const patch: EventPatch = {
    title,
    event_type: p.event_type,
    date_start: p.date_start,
    date_end: p.date_end,
  };
  if (p.location !== undefined) patch.location = p.location;

  const metadata: Metadata = {
    ...(existing?.metadata ?? {}),
    [SYNC.appointmentIdKey]: p.crm_appointment_id,
    all_day: false,
    source: SYNC.source,
    pushed_at: p.pushed_at ?? now,
  };
  if (p.gcal_event_id) {
    metadata[SYNC.gcalIdKey] = gcalIdForms(p.gcal_event_id).canonical;
  }
  if (p.crm_client_id !== undefined) {
    metadata[SYNC.eventClientIdKey] = p.crm_client_id;
  }
  if (p.attendees !== undefined) metadata.attendees = p.attendees;
  for (
    const key of ["calendar", "start_time", "end_time", "status", "kind"] as const
  ) {
    if (p[key] !== undefined) metadata[key] = p[key];
  }
  if (p.rescheduled_from !== undefined) {
    metadata.rescheduled_from = p.rescheduled_from;
  } else if (
    existing?.date_start && existing.date_start !== p.date_start
  ) {
    // A move: the function is the only side that reliably knows the previous
    // date, so it records it unless the CRM said otherwise.
    metadata.rescheduled_from = existing.date_start;
  }
  patch.metadata = metadata;
  return patch;
}

export async function upsertEvent(
  store: SyncStore,
  input: unknown,
  now: string = new Date().toISOString(),
): Promise<SyncResult> {
  const parsed = parseEventPayload(input);
  if (!parsed.ok) return { status: 400, body: { error: parsed.errors } };
  const p = parsed.payload;

  return await withUniqueRetry(async (): Promise<SyncResult> => {
    let existing = await store.findEventByAppointmentId(
      p.crm_appointment_id,
    );
    if (!existing && p.gcal_event_id) {
      existing = await store.findEventByGcalIds(
        gcalIdForms(p.gcal_event_id).lookup,
      );
    }
    if (existing) {
      await store.updateEvent(existing.id, buildEventPatch(existing, p, now));
      return { status: 200, body: { status: "updated", id: existing.id } };
    }
    const patch = buildEventPatch(null, p, now);
    const inserted = await store.insertEvent({
      ...patch,
      title: patch.title as string,
      event_type: p.event_type,
      date_start: p.date_start,
      date_end: p.date_end,
      metadata: patch.metadata as Metadata,
    });
    return { status: 201, body: { status: "created", id: inserted.id } };
  });
}

// ---------------------------------------------------------------------------
// Intake capture
// ---------------------------------------------------------------------------

/** Final thought metadata: the pipeline's coerced metadata, the explicit tags
 * merged into topics the way REST /capture merges them (normalised, order
 * kept, deduped), then the intake fields. `source` is always `external-crm`,
 * overriding anything the pipeline produced. */
export function buildIntakeMetadata(
  analyzed: Metadata,
  p: IntakePayload,
): Metadata {
  const coercedTopics = Array.isArray(analyzed.topics)
    ? (analyzed.topics as unknown[]).filter((t): t is string =>
      typeof t === "string"
    )
    : [];
  const explicitTags = p.tags.map((t) => normalizeTopic(t)).filter(Boolean);
  return {
    ...analyzed,
    topics: Array.from(new Set([...coercedTopics, ...explicitTags])),
    source: SYNC.source,
    [SYNC.intakeIdKey]: p.crm_intake_id,
    submitted_at: p.submitted_at,
    site: p.site,
    venue: p.venue,
    audience: p.audience,
  };
}

/** One thought per CRM intake id.
 *
 * Find first, so a retry answers `duplicate` before spending an embedding or
 * an LLM call. On a miss, build through the shared capture pipeline and
 * insert. A UniqueViolation on insert has two possible causes, told apart by
 * re-finding on the intake id:
 *   - the intake index: a concurrent push of the same id won. Answer
 *     `duplicate` with the winner's id.
 *   - `idx_thoughts_content_hash` (thoughts.content_hash is UNIQUE): a
 *     DIFFERENT capture already holds byte-identical text, e.g. two genuinely
 *     separate requests submitted in the same minute with the same idea. The
 *     content hash must not be what rejects an intake, so insert once more
 *     with the hash salted by the intake id.
 * Anything else, or a second violation that the re-find cannot explain,
 * propagates as a 500 and the CRM retries.
 *
 * Auto-resolve is deliberately NOT run for intakes (see
 * docs/architecture/rest-api.md): a new request is not evidence that any
 * action item was completed. */
export async function captureIntake(
  store: SyncStore,
  pipeline: CapturePipeline,
  input: unknown,
): Promise<SyncResult> {
  const parsed = parseIntakePayload(input);
  if (!parsed.ok) return { status: 400, body: { error: parsed.errors } };
  const p = parsed.payload;

  const existing = await store.findThoughtByIntakeId(p.crm_intake_id);
  if (existing) {
    return { status: 200, body: { status: "duplicate", id: existing.id } };
  }

  const analyzed = await pipeline.analyze(p.content);
  const metadata = buildIntakeMetadata(analyzed.metadata, p);
  const record: ThoughtInsert = {
    content: p.content,
    embedding: analyzed.embedding,
    content_hash: await pipeline.hash(p.content),
    metadata,
  };

  let inserted: { id: string } | null = null;
  try {
    inserted = await store.insertThought(record);
  } catch (err) {
    if (!(err instanceof UniqueViolation)) throw err;
    const winner = await store.findThoughtByIntakeId(p.crm_intake_id);
    if (winner) {
      return { status: 200, body: { status: "duplicate", id: winner.id } };
    }
    try {
      inserted = await store.insertThought({
        ...record,
        content_hash: await pipeline.hash(
          `${p.content}\n[${SYNC.intakeIdKey}:${p.crm_intake_id}]`,
        ),
      });
    } catch (err2) {
      if (!(err2 instanceof UniqueViolation)) throw err2;
      const late = await store.findThoughtByIntakeId(p.crm_intake_id);
      if (!late) throw err2;
      return { status: 200, body: { status: "duplicate", id: late.id } };
    }
  }

  try {
    await pipeline.afterInsert(inserted.id, p.content, metadata);
  } catch (err) {
    // The thought is stored; a failed post-insert step must not make Client
    // Bank retry into a duplicate. Log the step only, never the content.
    console.error(
      `external-crm-sync capture_intake afterInsert failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return { status: 200, body: { status: "created", id: inserted.id } };
}
