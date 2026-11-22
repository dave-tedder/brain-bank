-- Loop-closing Task 3.2, PRODUCER PART: the age-based archive proposal job.
--
-- The schema part (archive_proposed_at, archive_review_outcome,
-- archive_reviewed_at, and the reopen trigger that clears them) shipped in
-- 20261109a_action_items_archive_proposals.sql and is LIVE since 2026-11-18 UTC.
-- This file does not touch it and does not re-ship the reopen reset.
--
-- What this file adds:
--   1. Five policy functions that mirror supabase/functions/_shared/archive-policy.ts
--      (the TypeScript is the reference; scripts/loop-closing/archive-proposals-diff.ts
--      runs both over the same rows and diffs the result sets):
--        archive_policy_js_lower(text)                        JavaScript toLowerCase, ASCII part
--        archive_policy_is_work_report(content, captured_at)  Task 1.2's classifier
--        archive_policy_deadline(description)                 the deadline rule
--        archive_policy_client_shaped(description)            the client exemption
--        archive_proposals_due(now)                           the whole due set
--   2. run_archive_proposals(now): the multi-item writer. Computes the due set,
--      pre-locks it in id order FOR NO KEY UPDATE (Task 3.1's lock contract),
--      recomputes under the lock, then in one statement sets archive_proposed_at
--      (clearing a 90-day-old keep) and inserts one archive/proposed decision row
--      per item. It never changes status: nothing archives automatically.
--   3. archive_proposals_last_run(): the digest's read of the job's last
--      cron.job_run_details row, so a failed or missing run is printed where the operator
--      reads (pg-cron-patterns I4), not left in a table nobody opens.
--   4. The pg_cron job action_items_archive_proposals at 05:30 UTC daily. It only
--      needs to finish before the 11:00 UTC digest, so it is not a DST anchor.
--
-- A pg_cron job has no in-transaction retry: a deadlock victim fails that run,
-- cron.job_run_details records it, the digest prints it, and it runs again the
-- next morning. Two such failures in a row are a defect to fix, not a retry to add.
--
-- Rollback: select cron.unschedule('action_items_archive_proposals'); then drop
-- the seven functions below. Proposals already written stay as rows; clearing them
-- is a separate, deliberate update (archive_proposed_at = null where
-- archive_review_outcome is null) plus deleting the pending archive/proposed
-- decision rows, never part of an automatic rollback.

-- ---------------------------------------------------------------------------
-- 0. Locale-free mirrors of two JavaScript primitives (Codex re-review of PR 24,
-- 2026-11-18). Postgres \s, lower() and the regex engine's character classes
-- read the database locale; JavaScript's do not. Each is spelled out here from
-- an exhaustive scan of every code point under Deno 2.9.3 / V8 14.9:
--
--   JavaScript \s is exactly these 25 code points, and nothing else:
--     U+0009-000D, U+0020, U+00A0, U+1680, U+2000-200A, U+2028, U+2029,
--     U+202F, U+205F, U+3000, U+FEFF
--   It is written out below as an explicit bracket class wherever the reference
--   says \s. Postgres \s under en_US.UTF-8 misses U+FEFF, so "reply
--   by<U+FEFF>2026-12-30" lost its deadline and "commit<U+FEFF>abcdef1" its
--   commit shape. U+0085, U+180E and U+200B are NOT JavaScript whitespace.
--
--   JavaScript toLowerCase() yields an ASCII letter or digit from exactly two
--   non-ASCII code points: U+0130 (capital I with dot) becomes "i" + U+0307,
--   and U+212A (Kelvin sign) becomes "k". Every other non-ASCII code point
--   lowercases to non-ASCII only.
--   archive_policy_js_lower(s) applies those two mappings and ASCII A-Z to a-z,
--   and leaves every other character as it is. Its output therefore has the
--   same ASCII characters, in the same places relative to one another, as
--   JavaScript's s.toLowerCase(): the two strings differ only in which
--   non-ASCII characters sit between the ASCII runs. Every caller looks only at
--   ASCII runs (a split on [^a-z0-9]+, a strip to [a-z], or a search for an
--   ASCII needle), so for every caller the result equals JavaScript's. Postgres
--   lower() does not: it maps U+0130 to a bare "i", so client "İpek Kaya" was
--   one token "ipek" to SQL and two tokens "i", "pek" to JavaScript.
-- ---------------------------------------------------------------------------
create or replace function public.archive_policy_js_lower(p_text text)
returns text
language sql
immutable
set search_path = pg_catalog, public
as $$
  select translate(
    replace(replace(coalesce(p_text, ''), chr(304), 'i' || chr(775)), chr(8490), 'k'),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')
$$;

-- ---------------------------------------------------------------------------
-- 1a. Task 1.2's work-report classifier (metadata-validation.ts
-- isWorkReportCapture), mirrored. Two shapes are required.
--
-- Word boundaries are spelled out in ASCII, never \y. JavaScript's \b (no u
-- flag) splits on [A-Za-z0-9_] only, while Postgres \y and [[:alnum:]] read the
-- database locale, where an accented letter is a word character: under
-- en_US.UTF-8 "ésession 12 handoff" is two shapes to JavaScript and one to \y
-- (Codex review of PR 24, 2026-11-18). Every \b in the JavaScript shapes sits
-- next to a pattern character that is itself a word character, so each is
-- exactly one lookaround: a \b before a word character is
-- (?<![A-Za-z0-9_]), and a \b after one is (?![A-Za-z0-9_]). An ASCII bracket
-- class stays ASCII under ~* and the 'i' flag (no Kelvin sign, no long s),
-- matching JavaScript's /i without u. JavaScript \w is spelled [A-Za-z0-9_].
--
-- The dated session header ("session 86 (2026-11-02)") counts only when one of
-- its dates is not after the capture day plus one day. JavaScript reads it as
-- /\bsession \d+\b[^\n]{0,24}?\b\d{4}-\d\d-\d\d\b/gi and checks each match's
-- first date. Equivalent formulation used here, without relying on mixed
-- greediness: for every "session N" occurrence, the FIRST date that starts
-- within 24 characters after it, with no newline in between, is that match's
-- date. The 24 is UTF-16 code units, not characters: JavaScript runs this
-- pattern without the u flag, so [^\n]{0,24}? spends two of its 24 on any
-- character above U+FFFF (an emoji), where Postgres positions count one. The
-- gap is therefore measured as its character count plus one per supplementary
-- character (Codex re-review of PR 24, 2026-11-18: "session 1 ", twelve
-- U+1F600, " 2026-11-01" is 14 characters but 26 units, a header to SQL and
-- not to JavaScript). Splitting on the header gives each occurrence's tail up to the next
-- header; a date beyond the next header is that next header's first date too,
-- so nothing is lost. A sentinel 's' stands in for the next header's first
-- character, so a date running into it is not followed by a word boundary,
-- exactly as in the full string. A tail is searched as its own string, so its
-- first character has no left neighbour for the date's lookbehind to see; that
-- is safe because the split's trailing (?![A-Za-z0-9_]) makes every tail start
-- with a non-word character (or be empty), and a date cannot start there.
-- ---------------------------------------------------------------------------
create or replace function public.archive_policy_is_work_report(
  p_content text, p_captured_at timestamptz
) returns boolean
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  c text := coalesce(p_content, '');
  v_hits integer := 0;
  v_parts text[];
  v_n integer;
  v_tail text;
  v_pos integer;
  v_gap text;
  v_y integer; v_mo integer; v_d integer;
begin
  if p_captured_at is null or c = '' then
    return false;
  end if;
  if c ~* '(?<![A-Za-z0-9_])session [0-9]+(?![A-Za-z0-9_])' then v_hits := v_hits + 1; end if;
  if c ~* '(?<![A-Za-z0-9_])handoff(?![A-Za-z0-9_])' then v_hits := v_hits + 1; end if;
  if c ~* '((?<![A-Za-z0-9_])commit[\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+[0-9a-f]{7,40}(?![A-Za-z0-9_])|\([0-9a-f]{7,40}\))' then v_hits := v_hits + 1; end if;
  if c ~ '(?<![A-Za-z0-9_])(PROJECT-TRACKER\.md|SESSION-LOG\.md)(?![A-Za-z0-9_])' then v_hits := v_hits + 1; end if;
  if c ~ '(?<![A-Za-z0-9_])deliverables/[A-Za-z0-9_./-]+\.[A-Za-z0-9_]+' then v_hits := v_hits + 1; end if;
  if c ~ '\[OE:[0-9a-f]{8}' then v_hits := v_hits + 1; end if;
  if c ~* '(?<![A-Za-z0-9_])(closed|paused|built|deployed|shipped) (2026|2027)-[0-9]{2}-[0-9]{2}(?![A-Za-z0-9_])' then v_hits := v_hits + 1; end if;
  if c ~* '(?<![A-Za-z0-9_])task [0-9a-f]{8}(?![A-Za-z0-9_])' then v_hits := v_hits + 1; end if;
  if v_hits >= 2 then
    return true;
  end if;

  -- The dated session header, the eighth shape.
  v_parts := regexp_split_to_array(c, '(?<![A-Za-z0-9_])session [0-9]+(?![A-Za-z0-9_])', 'i');
  v_n := coalesce(array_length(v_parts, 1), 0);
  for i in 2..v_n loop
    v_tail := v_parts[i] || case when i < v_n then 's' else '' end;
    v_pos := regexp_instr(v_tail, '(?<![A-Za-z0-9_])[0-9]{4}-[0-9]{2}-[0-9]{2}(?![A-Za-z0-9_])');
    continue when v_pos = 0 or v_pos - 1 > 24;
    v_gap := left(v_tail, v_pos - 1);
    -- UTF-16 length of the gap: characters, plus one per supplementary character.
    continue when char_length(v_gap)
      + char_length(regexp_replace(v_gap, '[^\U00010000-\U0010FFFF]', '', 'g')) > 24;
    continue when position(E'\n' in v_gap) > 0;
    v_y := substr(v_tail, v_pos, 4)::integer;
    v_mo := substr(v_tail, v_pos + 5, 2)::integer;
    v_d := substr(v_tail, v_pos + 8, 2)::integer;
    -- A mistyped or first-century date is not real and does not count.
    continue when v_y < 100 or v_mo < 1 or v_mo > 12 or v_d < 1
      or v_d > extract(day from (make_date(v_y, v_mo, 1) + interval '1 month - 1 day'))::integer;
    if (make_date(v_y, v_mo, v_d)::timestamp at time zone 'UTC') <= p_captured_at + interval '24 hours' then
      return v_hits + 1 >= 2;
    end if;
  end loop;
  return false;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1b. The deadline rule (archive-policy.ts deadlineFrom). Tokens split on
-- JavaScript's \s (section 0's 25 code points, not the locale's \s); a
-- token's first ISO date counts when one of the three tokens before it,
-- lowercased as JavaScript does and stripped to a-z, is by/before/until/due/after, with no token
-- ending in , ; or . between them or on the keyword. The latest such date wins.
-- ---------------------------------------------------------------------------
create or replace function public.archive_policy_deadline(p_description text)
returns date
language plpgsql
immutable
set search_path = pg_catalog, public
as $$
declare
  v_toks text[];
  v_m text[];
  v_y integer; v_mo integer; v_d integer;
  v_date date;
  v_best date;
begin
  v_toks := array_remove(regexp_split_to_array(coalesce(p_description, ''), '[\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+'), '');
  for i in 1..coalesce(array_length(v_toks, 1), 0) loop
    v_m := regexp_match(v_toks[i], '(^|[^0-9])([0-9]{4})-([0-9]{2})-([0-9]{2})([^0-9]|$)');
    continue when v_m is null;
    v_y := v_m[2]::integer; v_mo := v_m[3]::integer; v_d := v_m[4]::integer;
    continue when v_y < 100 or v_mo < 1 or v_mo > 12 or v_d < 1
      or v_d > extract(day from (make_date(v_y, v_mo, 1) + interval '1 month - 1 day'))::integer;
    v_date := make_date(v_y, v_mo, v_d);
    for j in reverse i - 1 .. greatest(1, i - 3) loop
      exit when v_toks[j] ~ '[,;.]$';
      if regexp_replace(public.archive_policy_js_lower(v_toks[j]), '[^a-z]', '', 'g') in ('by', 'before', 'until', 'due', 'after') then
        if v_best is null or v_date > v_best then
          v_best := v_date;
        end if;
        exit;
      end if;
    end loop;
  end loop;
  return v_best;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1c. Client-shaped (archive-policy.ts isClientShaped): a client's full name
-- (two or more lowercase alphanumeric tokens, in order, as whole tokens), or a
-- capitalised word of three or more letters that find_client's partial match
-- returns two or more clients for. Every lowercasing is JavaScript's
-- (archive_policy_js_lower, section 0), never the locale's lower(): with client
-- "İpek Kaya", "notify i<U+0307>pek kaya" names the client to JavaScript and
-- "notify ipek kaya" does not. STABLE: it reads clients.
-- ---------------------------------------------------------------------------
create or replace function public.archive_policy_client_shaped(p_description text)
returns boolean
language sql
stable
set search_path = pg_catalog, public
as $$
  with toks as (
    select ' ' || array_to_string(
      array_remove(regexp_split_to_array(public.archive_policy_js_lower(coalesce(p_description, '')), '[^a-z0-9]+'), ''), ' ') || ' ' as hay
  ), names as (
    select array_remove(regexp_split_to_array(public.archive_policy_js_lower(c.name), '[^a-z0-9]+'), '') as ct
    from public.clients c
  )
  select exists (
    select 1 from names, toks
    where coalesce(array_length(names.ct, 1), 0) >= 2
      and position(' ' || array_to_string(names.ct, ' ') || ' ' in toks.hay) > 0
  ) or exists (
    select 1
    from regexp_split_to_table(coalesce(p_description, ''), '[^A-Za-z]+') as w(word)
    where w.word ~ '^[A-Z][A-Za-z]{2,}$'
      and (select count(*) from public.clients c
           where position(public.archive_policy_js_lower(w.word) in public.archive_policy_js_lower(c.name)) > 0) >= 2
  );
$$;

-- ---------------------------------------------------------------------------
-- 1d. The due set (archive-policy.ts archiveDueRows): every open, non-exempt
-- item whose due time has come, its reason, and what the job does with it:
-- propose, repropose (kept 90+ days ago), pending (proposed, unreviewed),
-- kept_recently, accepted (unreachable on an open item). Durations are exact
-- hours, never calendar intervals, so a session time zone cannot move them.
-- ---------------------------------------------------------------------------
create or replace function public.archive_proposals_due(p_now timestamptz)
returns table (item_id uuid, reason text, due_at timestamptz, action text)
language sql
stable
set search_path = pg_catalog, public
as $$
  select a.id,
    r.reason,
    r.due_at,
    case
      when a.archive_review_outcome = 'accepted' then 'accepted'
      when a.archive_review_outcome = 'kept' then
        case when a.archive_reviewed_at > p_now - interval '2160 hours'
          then 'kept_recently' else 'repropose' end
      when a.archive_proposed_at is not null then 'pending'
      else 'propose'
    end
  from public.action_items a
  left join public.thoughts th on th.id = a.source_thought_id
  cross join lateral (select public.archive_policy_deadline(a.description) as dl) d
  cross join lateral (
    select
      case
        when d.dl is not null then 'deadline_passed'
        when public.archive_policy_is_work_report(th.content, th.created_at)
          or exists (
            select 1 from public.auto_resolve_decisions f
            where f.item_id = a.id and f.layer = 'fragment'
              and f.item_generation = a.reopen_generation
          ) then 'age_work_report'
        else 'age_standard'
      end as reason
  ) k
  cross join lateral (
    select k.reason,
      case k.reason
        when 'deadline_passed' then (d.dl::timestamp at time zone 'UTC') + interval '336 hours'
        when 'age_work_report' then a.created_at + interval '720 hours'
        else a.created_at + interval '1440 hours'
      end as due_at
  ) r
  where a.status = 'open'
    and not (public.archive_policy_js_lower(a.description) like '%perpetual%'
             and (public.archive_policy_js_lower(a.description) like '%canary%'
                  or public.archive_policy_js_lower(a.description) like '%tripwire%'))
    and not exists (
      select 1 from public.agent_tasks t
      where t.linked_action_item_id = a.id
        and t.archived_at is null
        and t.status <> 'Agent Done'
    )
    and (a.reopened_at is null or a.reopened_at <= p_now - interval '2160 hours')
    and not public.archive_policy_client_shaped(a.description)
    and r.due_at <= p_now
  order by a.id;
$$;

-- ---------------------------------------------------------------------------
-- 2. The writer. Compute, lock in id order, recompute under the lock, write.
-- An item that stopped being due between the two reads (closed, deferred,
-- linked to a card, reviewed by a concurrent reply) is skipped; one that became
-- due in between waits for the next run. Returns the number of proposals.
-- ---------------------------------------------------------------------------
create or replace function public.run_archive_proposals(p_now timestamptz default now())
returns integer
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  v_ids uuid[];
  v_locked uuid[];
  v_written integer;
begin
  select coalesce(array_agg(d.item_id order by d.item_id), '{}') into v_ids
  from public.archive_proposals_due(p_now) d
  where d.action in ('propose', 'repropose');
  if cardinality(v_ids) = 0 then
    return 0;
  end if;

  select coalesce(array_agg(locked.id), '{}') into v_locked from (
    select id from public.action_items
    where id = any(v_ids)
    order by id
    for no key update
  ) locked;

  with due as (
    select d.item_id, d.reason
    from public.archive_proposals_due(p_now) d
    where d.action in ('propose', 'repropose')
      and d.item_id = any(v_locked)
  ), marked as (
    update public.action_items a
    set archive_proposed_at = p_now,
        archive_review_outcome = null,
        archive_reviewed_at = null
    from due
    where a.id = due.item_id
    returning a.id, a.description, due.reason
  )
  insert into public.auto_resolve_decisions (item_id, candidate_description, layer, outcome, reason)
  select m.id, m.description, 'archive', 'proposed', m.reason
  from marked m
  order by m.id;
  get diagnostics v_written = row_count;
  return v_written;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. The job's last run, for the digest. SECURITY DEFINER because cron is not
-- exposed to service_role through PostgREST.
-- ---------------------------------------------------------------------------
create or replace function public.archive_proposals_last_run()
returns table (status text, start_time timestamptz, end_time timestamptz, return_message text)
language sql
stable
security definer
set search_path = pg_catalog, public, cron
as $$
  select d.status, d.start_time, d.end_time, d.return_message
  from cron.job_run_details d
  join cron.job j on j.jobid = d.jobid
  where j.jobname = 'action_items_archive_proposals'
  order by d.start_time desc nulls last
  limit 1;
$$;

revoke execute on function public.archive_policy_js_lower(text) from public, anon, authenticated;
revoke execute on function public.archive_policy_is_work_report(text, timestamptz) from public, anon, authenticated;
revoke execute on function public.archive_policy_deadline(text) from public, anon, authenticated;
revoke execute on function public.archive_policy_client_shaped(text) from public, anon, authenticated;
revoke execute on function public.archive_proposals_due(timestamptz) from public, anon, authenticated;
revoke execute on function public.run_archive_proposals(timestamptz) from public, anon, authenticated;
revoke execute on function public.archive_proposals_last_run() from public, anon, authenticated;
grant execute on function public.archive_policy_js_lower(text) to service_role;
grant execute on function public.archive_policy_is_work_report(text, timestamptz) to service_role;
grant execute on function public.archive_policy_deadline(text) to service_role;
grant execute on function public.archive_policy_client_shaped(text) to service_role;
grant execute on function public.archive_proposals_due(timestamptz) to service_role;
grant execute on function public.run_archive_proposals(timestamptz) to service_role;
grant execute on function public.archive_proposals_last_run() to service_role;

-- ---------------------------------------------------------------------------
-- 4. The schedule. cron.schedule upserts by job name.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'action_items_archive_proposals',
  '30 5 * * *',
  $cron$select public.run_archive_proposals()$cron$
);
