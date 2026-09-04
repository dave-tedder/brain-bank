# Receive contacts and appointments from an external CRM

This walkthrough is for operators whose contacts and bookings live in another system (a studio CRM, a booking tool, a practice-management app) that should be the source of truth. Brain Bank keeps its `clients` and `business_events` rows, and everything that reads them (`find_client`, `client_context`, the wiki's client pages, the morning digest) keeps working. The CRM pushes its rows in; Brain Bank never calls back and never learns the CRM's database exists.

If you have not completed [`deploy-from-scratch.md`](../deploy-from-scratch.md) through Step 10, stop and do that first.

## Why a separate function with its own key

Brain Bank's whole authentication is one comparison: the presented `x-brain-key` against `MCP_ACCESS_KEY`. That value unlocks every MCP tool and every REST route. Handing it to a service other people sign into, so that service can upsert two tables, is a full-read grant for a two-write job. `external-crm-sync` is unlocked by a second secret, `EXTERNAL_CRM_PUSH_KEY`, that opens exactly two write operations and nothing else. `MCP_ACCESS_KEY` does not unlock it, and the push key does not unlock anything else; both directions are tested in `supabase/functions/external-crm-sync/_auth_test.ts`.

## Deploy and set the key

```bash
supabase db push   # applies 20260903_external_crm_sync_unique_keys.sql
supabase functions deploy external-crm-sync --no-verify-jwt --project-ref <your-project-ref>
supabase secrets set --env-file <(openssl rand -hex 32 | sed 's/^/EXTERNAL_CRM_PUSH_KEY=/') --project-ref <your-project-ref>
```

Generate the key locally and place it by stdin, as above, so the value never sits in a command line, a file or a chat transcript. The same value has to reach the pushing service, so keep a copy somewhere you can read it back from (a password manager or the OS keychain); `supabase secrets list` shows digests only.

## The two operations

Base URL: `https://<your-project-ref>.supabase.co/functions/v1/external-crm-sync`. Header: `x-push-key: <EXTERNAL_CRM_PUSH_KEY>`. POST JSON.

### `POST /upsert_client`

```json
{
  "crm_id": "<the CRM's own client id>",
  "name": "Alex Rivera",
  "email": "alex@example.com",
  "phone": "555-0100",
  "instagram": null,
  "first_contact": "2026-05-01",
  "last_contact": "2026-09-01",
  "release_form_signed_on": "2026-05-02",
  "brain_bank_id": "<optional: the exact clients.id to claim on the first run>"
}
```

- Keyed on `clients.metadata.crm_id`. Look up by that id, update if found, insert if not.
- `name`, `email`, `phone`, `instagram` and `last_contact` are the CRM's: written whenever the key is present in the payload (an explicit `null` clears the column, an absent key leaves it alone). `first_contact` is filled only when the row has none. `notes` and `preferred_styles` belong to Brain Bank and its agents and are never touched; the function does not even select them.
- Metadata is merged, never replaced: adds `crm_id`, `crm_synced_at`, `source: "external-crm"` and `release_form_signed_on`, keeps whatever else was there (a `notion_client_id`, an `intake_status`, a project blob).
- `brain_bank_id` is for the first run, after you have matched CRM cards to existing Brain Bank rows by whatever rule suits you (an external id, then email, then phone; never by name alone). When given, that exact row is claimed and stamped. When the card has already claimed a different row, the named row gets only `metadata.crm_duplicate_of = <canonical row id>` and nothing else changes on it.
- Returns `{"status": "created", "id"}` (201), `{"status": "updated", "id"}` (200), or `{"status": "duplicate_marked", "id", "canonical_id"}` (200). 404 when `brain_bank_id` names no row; 409 when it names a row already claimed by a different CRM card.

### `POST /upsert_event`

```json
{
  "crm_appointment_id": "<the CRM's own appointment id>",
  "crm_client_id": "<the CRM's client id>",
  "gcal_event_id": "<Google event id, bare or with @google.com>",
  "event_type": "tattoo_session",
  "title": "Alex Rivera - Session 2",
  "date_start": "2026-09-20",
  "date_end": "2026-09-20",
  "location": "Main Studio",
  "attendees": ["alex@example.com"],
  "calendar": "you@example.com",
  "start_time": "13:00",
  "end_time": "17:00",
  "status": "scheduled",
  "kind": "session"
}
```

- `event_type` is `tattoo_session`, `consultation` or `cancelled_session` (the digest briefs on the first two). Dates are `YYYY-MM-DD`; `date_end` defaults to `date_start`.
- Found by `metadata.crm_appointment_id` first, then by `metadata.gcal_event_id` in EITHER form. This matters if you also run the [Calendar Sync](calendar-sync.md): its rows carry the id as `<id>@google.com`, and an unkeyed insert would double every booking. The push adopts the existing row, stamps the appointment id on it, and stores the gcal id in the `@google.com` form so the Calendar Sync keeps finding it too.
- Metadata is merged. `attendees` should carry the client's email; that is what the digest matches against `clients`. `pushed_at` is server-stamped unless you send one.
- A cancel keeps the row: send `event_type: "cancelled_session"` and the title is prefixed `CANCELLED - ` exactly once. A date change records the previous date as `metadata.rescheduled_from` unless you send your own. Rows are never deleted.
- Returns `{"status": "created"|"updated", "id"}`.

## How idempotency holds

Two partial unique indexes, on `clients.metadata->>'crm_id'` and `business_events.metadata->>'crm_appointment_id'`, make the database the arbiter of one row per id. supabase-js has no transaction, so an Edge Function cannot hold an advisory lock across its lookup and its write; instead the function retries once when a write hits a unique violation, and the second pass finds the winner's row and updates it. Two pushes of one appointment cannot race into two rows. The remaining narrow window is a Calendar Sync insert landing in the same second as the first push of a brand-new booking; the next push adopts neither row's twin, so watch for that if you run both at high frequency.

## Wiring the pushing side

The pushing service needs two settings, a URL and the key, and one job: read every client and appointment changed since a stored watermark, push clients before their appointments, advance the watermark only after a fully successful pass. A five-minute interval is plenty. Keep a per-service rate limiter on the outbound side; the function is yours, but a runaway loop into it is still a runaway loop. If your CRM holds other people's data (a shared studio), select the slice to push by ownership of the ROW (the appointment's artist, the project's artist), never by the client's visibility, so a colleague booking one of your clients does not cross into your brain.

## What to switch off once the push is live

Any other writer that creates client rows for the same people will fight the push. The usual suspects are the Notion sync's optional `/client` step (`docs/capture-sources/notion-sync.md`, Advanced section) and agents calling `add_client` for people who are really CRM clients; the tool's description now says to use it only for people who are not. The Calendar Sync can keep running: it shares event rows with the push safely because the push merges metadata rather than replacing it.
