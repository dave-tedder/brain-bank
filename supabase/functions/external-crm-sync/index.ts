// external-crm-sync — write-only receiver for an external CRM push.
//
// An external CRM (the operator's system of record for contacts and
// appointments) pushes them here one way. Two operations, POST JSON:
//
//   POST /external-crm-sync/upsert_client   keyed on clients.metadata.crm_id
//   POST /external-crm-sync/upsert_event    keyed on business_events.metadata.crm_appointment_id,
//                                          then metadata.gcal_event_id in either form
//
// NO READ OPERATIONS. Nothing here returns a row, a list, or a search; the
// only response bodies are `{status, id}` and error strings. The function's
// own lookups (find by id before deciding insert vs update) are internal and
// never echoed.
//
// Authenticated by EXTERNAL_CRM_PUSH_KEY in the `x-push-key` header, checked in
// `_auth.ts`. MCP_ACCESS_KEY does not unlock this function; the push key does
// not unlock anything else. The decision logic lives in `_sync.ts` and is
// unit-tested there; this file is HTTP plumbing plus the supabase-js store.
//
// Deploy: supabase functions deploy external-crm-sync --no-verify-jwt --project-ref <ref>
// Secret: supabase secrets set --env-file <(...) --project-ref <ref>   (EXTERNAL_CRM_PUSH_KEY)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.47.10";
import { authenticatePushKey } from "./_auth.ts";
import {
  type ClientInsert,
  type ClientPatch,
  type ClientRow,
  type EventInsert,
  type EventPatch,
  type EventRow,
  SYNC,
  type SyncStore,
  UniqueViolation,
  upsertClient,
  upsertEvent,
} from "./_sync.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// `notes` and `preferred_styles` are NOT selected: the push cannot read them,
// so it cannot write them back.
const CLIENT_COLS =
  "id, name, email, phone, instagram, first_contact, last_contact, metadata";
const EVENT_COLS =
  "id, title, event_type, date_start, date_end, location, metadata";

function throwDbError(error: { code?: string; message: string }): never {
  if (error.code === "23505") throw new UniqueViolation(error.message);
  throw new Error(error.message);
}

class SupabaseSyncStore implements SyncStore {
  async findClientByExternalId(externalId: string): Promise<ClientRow | null> {
    const { data, error } = await supabase
      .from("clients")
      .select(CLIENT_COLS)
      .eq(`metadata->>${SYNC.clientIdKey}`, externalId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throwDbError(error);
    return (data?.[0] as ClientRow | undefined) ?? null;
  }

  async findClientById(id: string): Promise<ClientRow | null> {
    const { data, error } = await supabase
      .from("clients")
      .select(CLIENT_COLS)
      .eq("id", id)
      .limit(1);
    if (error) throwDbError(error);
    return (data?.[0] as ClientRow | undefined) ?? null;
  }

  async insertClient(record: ClientInsert): Promise<{ id: string }> {
    const { data, error } = await supabase
      .from("clients")
      .insert(record)
      .select("id")
      .single();
    if (error || !data) throwDbError(error ?? { message: "insert returned no row" });
    return { id: data.id };
  }

  async updateClient(id: string, patch: ClientPatch): Promise<void> {
    const { error } = await supabase.from("clients").update(patch).eq("id", id);
    if (error) throwDbError(error);
  }

  async findEventByAppointmentId(appointmentId: string): Promise<EventRow | null> {
    const { data, error } = await supabase
      .from("business_events")
      .select(EVENT_COLS)
      .eq(`metadata->>${SYNC.appointmentIdKey}`, appointmentId)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throwDbError(error);
    return (data?.[0] as EventRow | undefined) ?? null;
  }

  async findEventByGcalIds(ids: string[]): Promise<EventRow | null> {
    const { data, error } = await supabase
      .from("business_events")
      .select(EVENT_COLS)
      .in(`metadata->>${SYNC.gcalIdKey}`, ids)
      .order("created_at", { ascending: true })
      .limit(1);
    if (error) throwDbError(error);
    return (data?.[0] as EventRow | undefined) ?? null;
  }

  async insertEvent(record: EventInsert): Promise<{ id: string }> {
    const { data, error } = await supabase
      .from("business_events")
      .insert(record)
      .select("id")
      .single();
    if (error || !data) throwDbError(error ?? { message: "insert returned no row" });
    return { id: data.id };
  }

  async updateEvent(id: string, patch: EventPatch): Promise<void> {
    const { error } = await supabase
      .from("business_events")
      .update(patch)
      .eq("id", id);
    if (error) throwDbError(error);
  }
}

const store = new SupabaseSyncStore();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request): Promise<Response> => {
  const path = new URL(req.url).pathname.split("/external-crm-sync").pop() || "/";
  const op = path.replace(/^\/+|\/+$/g, "");

  const auth = authenticatePushKey(req.headers);
  if (!auth.ok) {
    if (auth.reason === "not_configured") {
      return json({ error: "push key not configured" }, 503);
    }
    return json({ error: "Invalid or missing push key" }, 401);
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (op !== "upsert_client" && op !== "upsert_event") {
    return json({ error: "unknown operation" }, 404);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  try {
    const result = op === "upsert_client"
      ? await upsertClient(store, body)
      : await upsertEvent(store, body);
    // Log the op and outcome only. Payloads carry contact details and
    // must never reach the function logs.
    console.log(`external-crm-sync ${op} -> ${result.status}`);
    return json(result.body, result.status);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`external-crm-sync ${op} failed: ${message}`);
    return json({ error: "write failed" }, 500);
  }
});
