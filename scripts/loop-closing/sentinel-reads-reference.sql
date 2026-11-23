-- Loop-closing Task 0.2: production SQL twins of the sentinel's four step-3d
-- PostgREST reads. Run with the SAME cutoff T the read used (verify-sentinel-reads.sh
-- prints it) and compare each count to that read's Content-Range total. A PostgREST
-- total below the SQL count means rows were filtered (RLS, grants or a bad filter),
-- never that the backlog is smaller. Replace :T, :START14, :DIGEST_START, :CANARY_TASK_ID.

-- [1] digests (daily, digest_date >= DIGEST_START, created_at <= T)
select count(*) as digests_total
from digests
where digest_type = 'daily' and digest_date >= :'DIGEST_START'::date and created_at <= :'T'::timestamptz;

-- [2] action_items touched in the 14-day window
select count(*) as action_items_total
from action_items
where (created_at >= :'START14'::timestamptz or resolved_at >= :'START14'::timestamptz)
  and created_at <= :'T'::timestamptz;

-- [3] agent_task_events up to T
select count(*) as agent_task_events_total from agent_task_events where created_at <= :'T'::timestamptz;

-- [4] agent_tasks up to T, and a known card the read must be able to see
-- (replace :CANARY_TASK_ID with a Standing canary or any card you know exists)
select count(*) as agent_tasks_total,
       count(*) filter (where id = :'CANARY_TASK_ID'::uuid) as canary_visible
from agent_tasks where created_at <= :'T'::timestamptz;
