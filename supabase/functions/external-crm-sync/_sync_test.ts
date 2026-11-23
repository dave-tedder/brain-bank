// Unit tests for the external-crm-sync upsert logic, against an in-memory store
// that enforces the same two partial unique indexes the live database carries.
// Run: deno test --allow-env supabase/functions/external-crm-sync/
//
// Every assertion here was mutation-tested when written (break the thing it
// names, watch it fail, restore); the session log for 2026-09-03 records which
// mutation each one caught.

import { assert, assertEquals, assertFalse } from "jsr:@std/assert@1.0.19";
import {
  buildIntakeMetadata,
  type CapturePipeline,
  captureIntake,
  type ClientInsert,
  type ClientPatch,
  type ClientRow,
  type EventInsert,
  type EventPatch,
  type EventRow,
  gcalIdForms,
  type Metadata,
  SYNC,
  type SyncStore,
  type ThoughtInsert,
  UniqueViolation,
  upsertClient,
  upsertEvent,
} from "./_sync.ts";

// A stored client carries the two columns the push must never touch. They are
// outside `ClientRow` on purpose, so the only way the code under test could
// alter them is through a patch key, which the assertions below look for.
type StoredClient = ClientRow & {
  notes: string | null;
  preferred_styles: string[] | null;
  created_at: string;
};
type StoredEvent = EventRow & { notes: string | null; created_at: string };
type StoredThought = ThoughtInsert & { id: string };

class MemoryStore implements SyncStore {
  clients: StoredClient[] = [];
  events: StoredEvent[] = [];
  thoughts: StoredThought[] = [];
  thoughtInserts = 0;
  clientPatches: Array<{ id: string; patch: ClientPatch }> = [];
  eventPatches: Array<{ id: string; patch: EventPatch }> = [];
  private seq = 0;

  newId(): string {
    this.seq += 1;
    return `00000000-0000-4000-8000-${String(this.seq).padStart(12, "0")}`;
  }

  seedClient(row: Partial<StoredClient> & { name: string }): StoredClient {
    const full: StoredClient = {
      id: row.id ?? this.newId(),
      name: row.name,
      email: row.email ?? null,
      phone: row.phone ?? null,
      instagram: row.instagram ?? null,
      first_contact: row.first_contact ?? null,
      last_contact: row.last_contact ?? null,
      metadata: row.metadata ?? {},
      notes: row.notes ?? null,
      preferred_styles: row.preferred_styles ?? null,
      created_at: row.created_at ?? `2026-01-01T00:00:0${this.seq}Z`,
    };
    this.clients.push(full);
    return full;
  }

  seedEvent(row: Partial<StoredEvent> & { title: string }): StoredEvent {
    const full: StoredEvent = {
      id: row.id ?? this.newId(),
      title: row.title,
      event_type: row.event_type ?? null,
      date_start: row.date_start ?? null,
      date_end: row.date_end ?? null,
      location: row.location ?? null,
      metadata: row.metadata ?? {},
      notes: row.notes ?? null,
      created_at: row.created_at ?? `2026-01-01T00:00:0${this.seq}Z`,
    };
    this.events.push(full);
    return full;
  }

  // The two partial unique indexes from migration 20260903.
  private assertClientUnique(meta: Metadata | null, selfId: string | null) {
    const key = meta?.[SYNC.clientIdKey];
    if (typeof key !== "string" || !key) return;
    const clash = this.clients.find((c) =>
      c.id !== selfId && c.metadata?.[SYNC.clientIdKey] === key
    );
    if (clash) throw new UniqueViolation("idx_clients_crm_id_unique");
  }
  private assertEventUnique(meta: Metadata | null, selfId: string | null) {
    const key = meta?.[SYNC.appointmentIdKey];
    if (typeof key !== "string" || !key) return;
    const clash = this.events.find((e) =>
      e.id !== selfId && e.metadata?.[SYNC.appointmentIdKey] === key
    );
    if (clash) {
      throw new UniqueViolation(
        "idx_business_events_crm_appointment_id_unique",
      );
    }
  }

  findClientByExternalId(externalId: string): Promise<ClientRow | null> {
    const hit = this.clients.find((c) =>
      c.metadata?.[SYNC.clientIdKey] === externalId
    );
    return Promise.resolve(hit ? { ...hit } : null);
  }
  findClientById(id: string): Promise<ClientRow | null> {
    const hit = this.clients.find((c) => c.id === id);
    return Promise.resolve(hit ? { ...hit } : null);
  }
  insertClient(record: ClientInsert): Promise<{ id: string }> {
    this.assertClientUnique(record.metadata, null);
    const row = this.seedClient({ ...record, id: this.newId() });
    return Promise.resolve({ id: row.id });
  }
  updateClient(id: string, patch: ClientPatch): Promise<void> {
    const row = this.clients.find((c) => c.id === id);
    if (!row) throw new Error(`no client ${id}`);
    if (patch.metadata) this.assertClientUnique(patch.metadata, id);
    this.clientPatches.push({ id, patch });
    Object.assign(row, patch);
    return Promise.resolve();
  }
  findEventByAppointmentId(appointmentId: string): Promise<EventRow | null> {
    const hit = this.events.find((e) =>
      e.metadata?.[SYNC.appointmentIdKey] === appointmentId
    );
    return Promise.resolve(hit ? { ...hit } : null);
  }
  findEventByGcalIds(ids: string[]): Promise<EventRow | null> {
    const hit = [...this.events]
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .find((e) => ids.includes(String(e.metadata?.[SYNC.gcalIdKey])));
    return Promise.resolve(hit ? { ...hit } : null);
  }
  insertEvent(record: EventInsert): Promise<{ id: string }> {
    this.assertEventUnique(record.metadata, null);
    const row = this.seedEvent({ ...record, id: this.newId() });
    return Promise.resolve({ id: row.id });
  }
  updateEvent(id: string, patch: EventPatch): Promise<void> {
    const row = this.events.find((e) => e.id === id);
    if (!row) throw new Error(`no event ${id}`);
    if (patch.metadata) this.assertEventUnique(patch.metadata, id);
    this.eventPatches.push({ id, patch });
    Object.assign(row, patch);
    return Promise.resolve();
  }
  findThoughtByIntakeId(intakeId: string): Promise<{ id: string } | null> {
    const hit = this.thoughts.find((t) =>
      t.metadata?.[SYNC.intakeIdKey] === intakeId
    );
    return Promise.resolve(hit ? { id: hit.id } : null);
  }
  // Both live unique indexes on thoughts: idx_thoughts_content_hash and the
  // partial intake-id index from migration 20261010.
  seedThought(record: ThoughtInsert): StoredThought {
    const key = record.metadata?.[SYNC.intakeIdKey];
    if (
      typeof key === "string" &&
      this.thoughts.some((t) => t.metadata?.[SYNC.intakeIdKey] === key)
    ) {
      throw new UniqueViolation("idx_thoughts_crm_intake_id_unique");
    }
    if (this.thoughts.some((t) => t.content_hash === record.content_hash)) {
      throw new UniqueViolation("idx_thoughts_content_hash");
    }
    const row = { ...record, id: this.newId() };
    this.thoughts.push(row);
    return row;
  }
  insertThought(record: ThoughtInsert): Promise<{ id: string }> {
    this.thoughtInserts += 1;
    try {
      return Promise.resolve({ id: this.seedThought(record).id });
    } catch (err) {
      return Promise.reject(err);
    }
  }
}

class FakePipeline implements CapturePipeline {
  analyzeCalls = 0;
  afterInsertCalls: string[] = [];
  failAfterInsert = false;
  hash(text: string): Promise<string> {
    return Promise.resolve(`hash:${text.trim()}`);
  }
  analyze(_content: string) {
    this.analyzeCalls += 1;
    return Promise.resolve({
      embedding: [0.1, 0.2, 0.3],
      metadata: {
        people: ["Jane Doe"],
        action_items: [],
        dates_mentioned: [],
        topics: ["tattoo", "intake"],
        type: "task",
        project: null,
        priority: "normal",
        source: "chatgpt",
      } as Metadata,
    });
  }
  afterInsert(thoughtId: string): Promise<void> {
    this.afterInsertCalls.push(thoughtId);
    if (this.failAfterInsert) return Promise.reject(new Error("boom"));
    return Promise.resolve();
  }
}

const NOW = "2026-09-03T15:00:00.000Z";
const LATER = "2026-09-03T15:05:00.000Z";

const CB_ID = "c1a2b3c4-0000-4000-8000-000000000c01";

function clientPayload(over: Record<string, unknown> = {}) {
  return {
    crm_id: CB_ID,
    name: "Jane Doe",
    email: "jane@example.com",
    phone: "252-555-0100",
    instagram: "@janedoe",
    first_contact: "2026-05-01",
    last_contact: "2026-09-01",
    release_form_signed_on: "2026-05-02",
    ...over,
  };
}

const APPT_ID = "a1a2b3c4-0000-4000-8000-000000000a01";
const GCAL_BARE = "abc123def456ghi789";

function eventPayload(over: Record<string, unknown> = {}) {
  return {
    crm_appointment_id: APPT_ID,
    crm_client_id: CB_ID,
    gcal_event_id: `${GCAL_BARE}@google.com`,
    event_type: "tattoo_session",
    title: "Jane Doe - Session 2",
    date_start: "2026-09-20",
    date_end: "2026-09-20",
    location: "Main Studio",
    attendees: ["jane@example.com"],
    calendar: "you@example.com",
    start_time: "13:00",
    end_time: "17:00",
    status: "scheduled",
    kind: "session",
    ...over,
  };
}

// ---------------------------------------------------------------------------
// upsert_client
// ---------------------------------------------------------------------------

Deno.test("upsert_client: same payload twice yields one row (created, then updated)", async () => {
  const store = new MemoryStore();
  const first = await upsertClient(store, clientPayload(), NOW);
  assertEquals(first.status, 201);
  assertEquals(first.body.status, "created");
  const second = await upsertClient(store, clientPayload(), LATER);
  assertEquals(second.status, 200);
  assertEquals(second.body.status, "updated");
  assertEquals(second.body.id, first.body.id);
  assertEquals(store.clients.length, 1);
  assertEquals(store.clients[0].metadata?.[SYNC.clientSyncedAtKey], LATER);
});

Deno.test("upsert_client: metadata is merged, keeping notion_client_id, intake_status and project", async () => {
  const store = new MemoryStore();
  store.seedClient({
    name: "Jane D",
    metadata: {
      notion_client_id: "abcd1234-aaaa",
      intake_status: "booked",
      project: { title: "Sleeve", status: "Ongoing" },
      source: "notion-sync",
      [SYNC.clientIdKey]: CB_ID,
    },
  });
  const res = await upsertClient(store, clientPayload(), NOW);
  assertEquals(res.body.status, "updated");
  const meta = store.clients[0].metadata!;
  assertEquals(meta.notion_client_id, "abcd1234-aaaa");
  assertEquals(meta.intake_status, "booked");
  assertEquals(meta.project, { title: "Sleeve", status: "Ongoing" });
  assertEquals(meta[SYNC.clientIdKey], CB_ID);
  assertEquals(meta[SYNC.clientSyncedAtKey], NOW);
  assertEquals(meta.source, SYNC.source);
  assertEquals(meta[SYNC.releaseFormKey], "2026-05-02");
});

Deno.test("upsert_client: notes and preferred_styles are never touched", async () => {
  const store = new MemoryStore();
  store.seedClient({
    name: "Jane D",
    notes: "Prefers afternoon sessions.",
    preferred_styles: ["blackwork", "fine line"],
    metadata: { [SYNC.clientIdKey]: CB_ID },
  });
  await upsertClient(store, clientPayload({ name: "Jane Doe" }), NOW);
  assertEquals(store.clients[0].name, "Jane Doe");
  assertEquals(
    store.clients[0].notes,
    "Prefers afternoon sessions.",
  );
  assertEquals(store.clients[0].preferred_styles, [
    "blackwork",
    "fine line",
  ]);
  for (const { patch } of store.clientPatches) {
    assertFalse("notes" in patch, "patch must not carry notes");
    assertFalse(
      "preferred_styles" in patch,
      "patch must not carry preferred_styles",
    );
  }
});

Deno.test("upsert_client: name, email, phone, instagram, last_contact written every time; explicit null clears; absent key leaves alone", async () => {
  const store = new MemoryStore();
  store.seedClient({
    name: "Old Name",
    email: "old@example.com",
    phone: "000",
    instagram: "@old",
    last_contact: "2026-01-01",
    metadata: { [SYNC.clientIdKey]: CB_ID },
  });
  await upsertClient(
    store,
    { crm_id: CB_ID, name: "New Name", email: null, phone: "111" },
    NOW,
  );
  const row = store.clients[0];
  assertEquals(row.name, "New Name");
  assertEquals(row.email, null, "explicit null clears");
  assertEquals(row.phone, "111");
  assertEquals(row.instagram, "@old", "absent key leaves the column alone");
  assertEquals(row.last_contact, "2026-01-01", "absent key leaves the column alone");
  await upsertClient(store, clientPayload({ last_contact: "2026-09-02" }), NOW);
  assertEquals(row.last_contact, "2026-09-02");
  assertEquals(row.instagram, "@janedoe");
});

Deno.test("upsert_client: first_contact is filled only when blank", async () => {
  const store = new MemoryStore();
  store.seedClient({
    name: "Has First",
    first_contact: "2025-01-15T00:00:00Z",
    metadata: { [SYNC.clientIdKey]: CB_ID },
  });
  await upsertClient(store, clientPayload({ first_contact: "2026-05-01" }), NOW);
  assertEquals(store.clients[0].first_contact, "2025-01-15T00:00:00Z");

  const blank = store.seedClient({
    name: "No First",
    metadata: { [SYNC.clientIdKey]: "other-card" },
  });
  await upsertClient(
    store,
    clientPayload({ crm_id: "other-card", first_contact: "2026-05-01" }),
    NOW,
  );
  assertEquals(blank.first_contact, "2026-05-01");

  const created = await upsertClient(
    store,
    { crm_id: "third-card", name: "Fresh" },
    NOW,
  );
  const fresh = store.clients.find((c) => c.id === created.body.id)!;
  assertEquals(fresh.first_contact, NOW, "insert with no first_contact stamps now");
});

Deno.test("upsert_client: brain_bank_id claims that exact row and stamps it", async () => {
  const store = new MemoryStore();
  const target = store.seedClient({
    name: "Jane D",
    metadata: { notion_client_id: "n-1", source: "notion-sync" },
  });
  store.seedClient({ name: "Jane Doe", email: "jane@example.com" }); // a lookalike
  const res = await upsertClient(
    store,
    clientPayload({ brain_bank_id: target.id }),
    NOW,
  );
  assertEquals(res.status, 200);
  assertEquals(res.body, { status: "updated", id: target.id });
  assertEquals(target.metadata?.[SYNC.clientIdKey], CB_ID);
  assertEquals(target.metadata?.notion_client_id, "n-1");
  assertEquals(target.name, "Jane Doe");
  assertEquals(store.clients.length, 2, "no insert on a claim");
  // A later push without brain_bank_id finds the claimed row.
  const again = await upsertClient(store, clientPayload(), LATER);
  assertEquals(again.body, { status: "updated", id: target.id });
  assertEquals(store.clients.length, 2);
});

Deno.test("upsert_client: a second row mapped to a claimed card gets only crm_duplicate_of", async () => {
  const store = new MemoryStore();
  const canonical = store.seedClient({
    name: "Alex R",
    metadata: { notion_client_id: "n-alex", [SYNC.clientIdKey]: CB_ID },
  });
  const dup = store.seedClient({
    name: "Alex Rivera",
    email: "devin@example.com",
    phone: "222",
    notes: "dup row notes",
    metadata: { source: "add_client", intake_status: "lead" },
  });
  const before = JSON.stringify(dup);
  const res = await upsertClient(
    store,
    clientPayload({ brain_bank_id: dup.id, name: "Alex Rivera Pushed" }),
    NOW,
  );
  assertEquals(res.status, 200);
  assertEquals(res.body, {
    status: "duplicate_marked",
    id: dup.id,
    canonical_id: canonical.id,
  });
  assertEquals(dup.metadata?.[SYNC.clientDuplicateOfKey], canonical.id);
  assertEquals(dup.metadata?.source, "add_client", "other metadata untouched");
  assertEquals(dup.metadata?.intake_status, "lead");
  assertEquals(dup.metadata?.[SYNC.clientIdKey], undefined, "no second claim");
  const after = JSON.parse(JSON.stringify(dup));
  delete after.metadata[SYNC.clientDuplicateOfKey];
  assertEquals(JSON.stringify(after), before, "nothing else changed on the duplicate");
  assertEquals(canonical.name, "Alex R", "canonical row not written by a duplicate mark");
  // Idempotent: a second identical push writes nothing.
  const patches = store.clientPatches.length;
  const repeat = await upsertClient(
    store,
    clientPayload({ brain_bank_id: dup.id }),
    LATER,
  );
  assertEquals(repeat.body.status, "duplicate_marked");
  assertEquals(store.clientPatches.length, patches, "no second patch");
});

Deno.test("upsert_client: brain_bank_id that does not exist is 404; a row claimed by another card is 409", async () => {
  const store = new MemoryStore();
  const missing = await upsertClient(
    store,
    clientPayload({ brain_bank_id: "00000000-0000-4000-8000-0000000000ff" }),
    NOW,
  );
  assertEquals(missing.status, 404);
  const taken = store.seedClient({
    name: "Taken",
    metadata: { [SYNC.clientIdKey]: "someone-elses-card" },
  });
  const conflict = await upsertClient(
    store,
    clientPayload({ brain_bank_id: taken.id }),
    NOW,
  );
  assertEquals(conflict.status, 409);
  assertEquals(taken.metadata?.[SYNC.clientIdKey], "someone-elses-card");
  assertEquals(store.clientPatches.length, 0);
});

Deno.test("upsert_client: losing an insert race retries into an update, one row", async () => {
  class RacingStore extends MemoryStore {
    raced = false;
    override insertClient(record: ClientInsert): Promise<{ id: string }> {
      if (!this.raced) {
        this.raced = true;
        // Another push of the same card lands between our lookup and insert.
        this.seedClient({
          name: "Winner",
          metadata: { [SYNC.clientIdKey]: CB_ID },
        });
      }
      return super.insertClient(record);
    }
  }
  const store = new RacingStore();
  const res = await upsertClient(store, clientPayload(), NOW);
  assertEquals(res.body.status, "updated");
  assertEquals(store.clients.length, 1);
  assertEquals(store.clients[0].name, "Jane Doe");
  assert(store.raced);
});

Deno.test("upsert_client: validation rejects a missing name, a missing id and a malformed brain_bank_id", async () => {
  const store = new MemoryStore();
  const noName = await upsertClient(store, { crm_id: CB_ID }, NOW);
  assertEquals(noName.status, 400);
  const noId = await upsertClient(store, { name: "X" }, NOW);
  assertEquals(noId.status, 400);
  const badOb = await upsertClient(
    store,
    clientPayload({ brain_bank_id: "not-a-uuid" }),
    NOW,
  );
  assertEquals(badOb.status, 400);
  const notObject = await upsertClient(store, "nope", NOW);
  assertEquals(notObject.status, 400);
  assertEquals(store.clients.length, 0);
});

// ---------------------------------------------------------------------------
// upsert_event
// ---------------------------------------------------------------------------

Deno.test("upsert_event: same payload twice yields one row (created, then updated)", async () => {
  const store = new MemoryStore();
  const first = await upsertEvent(store, eventPayload(), NOW);
  assertEquals(first.status, 201);
  assertEquals(first.body.status, "created");
  const second = await upsertEvent(store, eventPayload(), LATER);
  assertEquals(second.body, { status: "updated", id: first.body.id });
  assertEquals(store.events.length, 1);
  const row = store.events[0];
  assertEquals(row.event_type, "tattoo_session");
  assertEquals(row.date_start, "2026-09-20");
  assertEquals(row.location, "Main Studio");
  assertEquals(row.metadata?.[SYNC.appointmentIdKey], APPT_ID);
  assertEquals(row.metadata?.[SYNC.eventClientIdKey], CB_ID);
  assertEquals(row.metadata?.[SYNC.gcalIdKey], `${GCAL_BARE}@google.com`);
  assertEquals(row.metadata?.attendees, ["jane@example.com"]);
  assertEquals(row.metadata?.all_day, false);
  assertEquals(row.metadata?.source, SYNC.source);
  assertEquals(row.metadata?.pushed_at, LATER);
  assertEquals(row.metadata?.start_time, "13:00");
});

Deno.test("upsert_event: gcalIdForms canonicalises to @google.com and looks up both forms", () => {
  assertEquals(gcalIdForms("abc"), {
    canonical: "abc@google.com",
    lookup: ["abc@google.com", "abc"],
  });
  assertEquals(gcalIdForms("abc@google.com"), {
    canonical: "abc@google.com",
    lookup: ["abc@google.com", "abc"],
  });
});

Deno.test("upsert_event: an Apps Script row keyed <id>@google.com is adopted by a push with the bare id, and vice versa", async () => {
  const store = new MemoryStore();
  const appsScriptRow = store.seedEvent({
    title: "Jane Doe - Session 2",
    event_type: "tattoo_session",
    date_start: "2026-09-20",
    notes: "calendar description text",
    metadata: {
      [SYNC.gcalIdKey]: `${GCAL_BARE}@google.com`,
      attendees: ["Jane Doe"],
      calendar: "you@example.com",
      start_time: "13:00",
      end_time: "17:00",
      all_day: false,
    },
  });
  const res = await upsertEvent(
    store,
    eventPayload({ gcal_event_id: GCAL_BARE }),
    NOW,
  );
  assertEquals(res.body, { status: "updated", id: appsScriptRow.id });
  assertEquals(store.events.length, 1, "no second row for the same booking");
  assertEquals(appsScriptRow.metadata?.[SYNC.appointmentIdKey], APPT_ID);
  assertEquals(
    appsScriptRow.metadata?.[SYNC.gcalIdKey],
    `${GCAL_BARE}@google.com`,
    "stamped in the @google.com form so the Apps Script keeps finding it",
  );
  assertEquals(appsScriptRow.notes, "calendar description text", "notes column untouched");

  // The reverse: a chat-bot bridge row keyed on the bare id, pushed with @google.com.
  const dashBotRow = store.seedEvent({
    title: "Other booking",
    metadata: { [SYNC.gcalIdKey]: "zzz999", source: "dash-bot" },
  });
  const res2 = await upsertEvent(
    store,
    eventPayload({
      crm_appointment_id: "appt-2",
      gcal_event_id: "zzz999@google.com",
      title: "Other booking",
    }),
    NOW,
  );
  assertEquals(res2.body, { status: "updated", id: dashBotRow.id });
  assertEquals(store.events.length, 2);
  assertEquals(dashBotRow.metadata?.[SYNC.gcalIdKey], "zzz999@google.com");
  assertEquals(dashBotRow.metadata?.source, SYNC.source);
});

Deno.test("upsert_event: metadata is merged on update, never replaced", async () => {
  const store = new MemoryStore();
  const row = store.seedEvent({
    title: "T",
    metadata: {
      [SYNC.appointmentIdKey]: APPT_ID,
      [SYNC.gcalIdKey]: `${GCAL_BARE}@google.com`,
      calendar: "you@example.com",
      custom_flag: "kept",
    },
  });
  // Payload without gcal_event_id or calendar: both must survive.
  const payload = eventPayload();
  delete (payload as Record<string, unknown>).gcal_event_id;
  delete (payload as Record<string, unknown>).calendar;
  await upsertEvent(store, payload, NOW);
  assertEquals(row.metadata?.[SYNC.gcalIdKey], `${GCAL_BARE}@google.com`);
  assertEquals(row.metadata?.calendar, "you@example.com");
  assertEquals(row.metadata?.custom_flag, "kept");
  assertEquals(row.metadata?.[SYNC.appointmentIdKey], APPT_ID);
});

Deno.test("upsert_event: a cancel keeps the row, sets cancelled_session and prefixes the title exactly once", async () => {
  const store = new MemoryStore();
  await upsertEvent(store, eventPayload(), NOW);
  const cancelled = eventPayload({
    event_type: "cancelled_session",
    status: "cancelled",
  });
  await upsertEvent(store, cancelled, LATER);
  assertEquals(
    store.events[0].title,
    "CANCELLED - Jane Doe - Session 2",
    "an unprefixed cancel title gets the prefix",
  );
  await upsertEvent(
    store,
    eventPayload({
      event_type: "cancelled_session",
      status: "cancelled",
      title: "CANCELLED - Jane Doe - Session 2",
    }),
    LATER,
  );
  assertEquals(store.events.length, 1, "cancel never deletes");
  const row = store.events[0];
  assertEquals(row.event_type, "cancelled_session");
  assertEquals(row.title, "CANCELLED - Jane Doe - Session 2");
  assertEquals(row.metadata?.status, "cancelled");
});

Deno.test("upsert_event: a move records rescheduled_from; a non-move keeps it; the CRM's value wins", async () => {
  const store = new MemoryStore();
  await upsertEvent(store, eventPayload(), NOW);
  const row = store.events[0];
  assertEquals(row.metadata?.rescheduled_from, undefined);
  await upsertEvent(
    store,
    eventPayload({ date_start: "2026-09-27", date_end: "2026-09-27" }),
    LATER,
  );
  assertEquals(row.date_start, "2026-09-27");
  assertEquals(row.metadata?.rescheduled_from, "2026-09-20");
  // Same date again: the recorded move survives the merge.
  await upsertEvent(
    store,
    eventPayload({ date_start: "2026-09-27", date_end: "2026-09-27" }),
    LATER,
  );
  assertEquals(row.metadata?.rescheduled_from, "2026-09-20");
  // The CRM states the previous date itself.
  await upsertEvent(
    store,
    eventPayload({
      date_start: "2026-10-04",
      date_end: "2026-10-04",
      rescheduled_from: "2026-09-01",
    }),
    LATER,
  );
  assertEquals(row.metadata?.rescheduled_from, "2026-09-01");
});

Deno.test("upsert_event: losing an insert race retries into an update, one row", async () => {
  class RacingStore extends MemoryStore {
    raced = false;
    override insertEvent(record: EventInsert): Promise<{ id: string }> {
      if (!this.raced) {
        this.raced = true;
        this.seedEvent({
          title: "Winner",
          metadata: { [SYNC.appointmentIdKey]: APPT_ID },
        });
      }
      return super.insertEvent(record);
    }
  }
  const store = new RacingStore();
  const res = await upsertEvent(store, eventPayload(), NOW);
  assertEquals(res.body.status, "updated");
  assertEquals(store.events.length, 1);
  assertEquals(store.events[0].title, "Jane Doe - Session 2");
  assert(store.raced);
});

Deno.test("upsert_event: validation rejects a bad event_type, a bad date and a missing appointment id", async () => {
  const store = new MemoryStore();
  const badType = await upsertEvent(store, eventPayload({ event_type: "general" }), NOW);
  assertEquals(badType.status, 400);
  const badDate = await upsertEvent(store, eventPayload({ date_start: "09/20/2026" }), NOW);
  assertEquals(badDate.status, 400);
  const noAppt = await upsertEvent(
    store,
    eventPayload({ crm_appointment_id: "" }),
    NOW,
  );
  assertEquals(noAppt.status, 400);
  const badAttendees = await upsertEvent(store, eventPayload({ attendees: "x" }), NOW);
  assertEquals(badAttendees.status, 400);
  assertEquals(store.events.length, 0);
  // date_end defaults to date_start.
  const ok = await upsertEvent(store, eventPayload({ date_end: undefined }), NOW);
  assertEquals(ok.status, 201);
  assertEquals(store.events[0].date_end, "2026-09-20");
});

// ---------------------------------------------------------------------------
// capture_intake
// ---------------------------------------------------------------------------

const INTAKE_ID = "1a2b3c4d-0000-4000-8000-0000000000aa";
const INTAKE_CONTENT = [
  "[Intake] New tattoo request from Jane Doe (asked for Alex)",
  "Idea: Koi swimming up the forearm, black and grey",
  "Placement: Left forearm. Size: Half sleeve",
  "Venue: Main Studio. From: example.com",
  "Submitted Oct 10, 2:14 PM. In the CRM under Intake.",
].join("\n");

function intakePayload(over: Record<string, unknown> = {}) {
  return {
    crm_intake_id: INTAKE_ID,
    content: INTAKE_CONTENT,
    submitted_at: "2026-10-10T18:14:00.000Z",
    site: "example.com",
    venue: "Main Studio",
    audience: "artist",
    tags: ["intake", "external-crm"],
    ...over,
  };
}

Deno.test("capture_intake: same intake twice is created then duplicate, same id, one thought, one pipeline run", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  const first = await captureIntake(store, pipe, intakePayload());
  assertEquals(first.status, 200);
  assertEquals(first.body.status, "created");
  const second = await captureIntake(store, pipe, intakePayload());
  assertEquals(second.status, 200);
  assertEquals(second.body.status, "duplicate");
  assertEquals(second.body.id, first.body.id);
  assertEquals(store.thoughts.length, 1);
  // Find-first: the retry must not spend an embedding/LLM call or attempt an insert.
  assertEquals(pipe.analyzeCalls, 1);
  assertEquals(store.thoughtInserts, 1);
  assertEquals(pipe.afterInsertCalls, [first.body.id]);
});

Deno.test("capture_intake: an edited body under the same intake id is still a duplicate", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  const first = await captureIntake(store, pipe, intakePayload());
  const edited = await captureIntake(
    store,
    pipe,
    intakePayload({ content: INTAKE_CONTENT + " (edited)" }),
  );
  assertEquals(edited.body.status, "duplicate");
  assertEquals(edited.body.id, first.body.id);
  assertEquals(store.thoughts.length, 1);
});

Deno.test("capture_intake: losing an insert race answers duplicate with the winner's id", async () => {
  class RacingStore extends MemoryStore {
    raced = false;
    winnerId = "";
    override insertThought(record: ThoughtInsert): Promise<{ id: string }> {
      if (!this.raced) {
        this.raced = true;
        // A concurrent push of the same intake lands between lookup and insert.
        this.winnerId = this.seedThought({
          ...record,
          content_hash: "winner-hash",
        }).id;
      }
      return super.insertThought(record);
    }
  }
  const store = new RacingStore();
  const pipe = new FakePipeline();
  const res = await captureIntake(store, pipe, intakePayload());
  assert(store.raced);
  assertEquals(res.status, 200);
  assertEquals(res.body.status, "duplicate");
  assertEquals(res.body.id, store.winnerId);
  assertEquals(store.thoughts.length, 1);
  assertEquals(pipe.afterInsertCalls.length, 0);
  // The re-find answers the race directly; no second write is attempted.
  assertEquals(store.thoughtInserts, 1);
});

Deno.test("capture_intake: a content-hash collision followed by a same-id race still answers duplicate", async () => {
  class CollideThenRaceStore extends MemoryStore {
    calls = 0;
    winnerId = "";
    override insertThought(record: ThoughtInsert): Promise<{ id: string }> {
      this.calls += 1;
      if (this.calls === 2) {
        // Between the salted retry's decision and its insert, a concurrent
        // push of the same intake id wins.
        this.winnerId = this.seedThought({
          ...record,
          content_hash: "winner-hash",
        }).id;
      }
      return super.insertThought(record);
    }
  }
  const store = new CollideThenRaceStore();
  // An unrelated earlier capture already holds byte-identical text.
  store.seedThought({
    content: INTAKE_CONTENT,
    embedding: [],
    content_hash: `hash:${INTAKE_CONTENT}`,
    metadata: { source: "chatgpt" },
  });
  const res = await captureIntake(store, new FakePipeline(), intakePayload());
  assertEquals(res.status, 200);
  assertEquals(res.body.status, "duplicate");
  assertEquals(res.body.id, store.winnerId);
  assertEquals(store.calls, 2);
  assertEquals(store.thoughts.length, 2); // the unrelated capture + the winner
});

Deno.test("capture_intake: two separate intakes with identical text both land (content_hash does not reject)", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  const a = await captureIntake(store, pipe, intakePayload());
  const b = await captureIntake(
    store,
    pipe,
    intakePayload({ crm_intake_id: "1a2b3c4d-0000-4000-8000-0000000000bb" }),
  );
  assertEquals(a.body.status, "created");
  assertEquals(b.body.status, "created");
  assert(a.body.id !== b.body.id);
  assertEquals(store.thoughts.length, 2);
  assert(store.thoughts[0].content_hash !== store.thoughts[1].content_hash);
  // The first keeps the plain content hash, exactly as any other capture would.
  assertEquals(store.thoughts[0].content_hash, `hash:${INTAKE_CONTENT}`);
});

Deno.test("capture_intake: metadata is the pipeline's plus source, intake fields and merged tags; no contact fields", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  await captureIntake(
    store,
    pipe,
    intakePayload({ email: "jane@example.com", phone: "252-555-0100", instagram: "@jane" }),
  );
  const t = store.thoughts[0];
  assertEquals(t.content, INTAKE_CONTENT);
  assertEquals(t.embedding, [0.1, 0.2, 0.3]);
  assertEquals(t.metadata.source, "external-crm");
  assertEquals(t.metadata[SYNC.intakeIdKey], INTAKE_ID);
  assertEquals(t.metadata.submitted_at, "2026-10-10T18:14:00.000Z");
  assertEquals(t.metadata.site, "example.com");
  assertEquals(t.metadata.venue, "Main Studio");
  assertEquals(t.metadata.audience, "artist");
  assertEquals(t.metadata.topics, ["tattoo", "intake", "external-crm"]);
  assertEquals(t.metadata.people, ["Jane Doe"]);
  assertEquals(t.metadata.type, "task");
  for (const k of ["email", "phone", "instagram"]) {
    assertFalse(k in t.metadata, `metadata must not carry ${k}`);
  }
});

Deno.test("capture_intake: shop-queue audience and null site/venue are stored as given", () => {
  const md = buildIntakeMetadata(
    { topics: ["tattoo"], source: "x" },
    {
      crm_intake_id: INTAKE_ID,
      content: "c",
      submitted_at: "2026-10-10T18:14:00Z",
      site: null,
      venue: null,
      audience: "shop_queue",
      tags: ["Intake", "tattoo"],
    },
  );
  assertEquals(md.audience, "shop_queue");
  assertEquals(md.site, null);
  assertEquals(md.venue, null);
  assertEquals(md.source, "external-crm");
  assertEquals(md.topics, ["tattoo", "intake"]);
});

Deno.test("capture_intake: a failing post-insert step still answers created", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  pipe.failAfterInsert = true;
  const res = await captureIntake(store, pipe, intakePayload());
  assertEquals(res.body.status, "created");
  assertEquals(store.thoughts.length, 1);
});

Deno.test("capture_intake: a pipeline failure propagates (500, the CRM retries) and writes nothing", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  pipe.analyze = () => Promise.reject(new Error("embedding call failed"));
  let threw = false;
  try {
    await captureIntake(store, pipe, intakePayload());
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(store.thoughts.length, 0);
});

Deno.test("capture_intake: validation 400s only bodies that can never succeed", async () => {
  const store = new MemoryStore();
  const pipe = new FakePipeline();
  const cases: Array<[string, unknown]> = [
    ["missing id", intakePayload({ crm_intake_id: undefined })],
    ["non-uuid id", intakePayload({ crm_intake_id: "abc" })],
    ["missing content", intakePayload({ content: "" })],
    ["content wrong type", intakePayload({ content: 42 })],
    ["missing submitted_at", intakePayload({ submitted_at: undefined })],
    ["bad submitted_at", intakePayload({ submitted_at: "not a date" })],
    ["bad audience", intakePayload({ audience: "everyone" })],
    ["tags not array", intakePayload({ tags: "intake" })],
    ["array body", []],
  ];
  for (const [label, body] of cases) {
    const res = await captureIntake(store, pipe, body);
    assertEquals(res.status, 400, label);
    assert(Array.isArray(res.body.error), label);
  }
  assertEquals(store.thoughts.length, 0);
  assertEquals(pipe.analyzeCalls, 0);
  const ok = await captureIntake(
    store,
    pipe,
    intakePayload({ site: null, venue: null, audience: null, tags: undefined }),
  );
  assertEquals(ok.body.status, "created");
});
