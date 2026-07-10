-- WS-3: make the MCP intake duplicate guards durable under concurrent calls.
-- Completed and archived history can repeat links; only live board work is
-- unique per durable source row.

create unique index if not exists agent_tasks_active_linked_action_item_unique_idx
  on public.agent_tasks (linked_action_item_id)
  where linked_action_item_id is not null
    and archived_at is null
    and status in (
      'Standing',
      'Agent Todo',
      'Agent Working',
      'Agent Needs Input',
      'Agent Review',
      'Needs Operator'
    );

create unique index if not exists agent_tasks_active_source_thought_unique_idx
  on public.agent_tasks (source_thought_id)
  where source_thought_id is not null
    and archived_at is null
    and status in (
      'Standing',
      'Agent Todo',
      'Agent Working',
      'Agent Needs Input',
      'Agent Review',
      'Needs Operator'
    );
