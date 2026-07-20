-- GCP & Cloud SQL compatibility schema adjustments (End).
-- Targets file: supabase/migrations/20260720_gcp_compat.sql
--
-- This script runs at the very end of migrations, seeding the unified
-- local executor identity in the agent_task_ledger table.

-- Update check constraint to allow antigravity as a valid runtime alongside claude and triage-critic
ALTER TABLE public.agent_task_ledger DROP CONSTRAINT IF EXISTS agent_task_ledger_runtime_check;
ALTER TABLE public.agent_task_ledger ADD CONSTRAINT agent_task_ledger_runtime_check CHECK (runtime IN ('claude', 'triage-critic', 'antigravity'));

-- Seed Option A unified local executor row in the ledger
INSERT INTO public.agent_task_ledger (agent_code, operator, runtime, automation, automation_state, notes)
VALUES (
  'local-antigravity',
  'Local Operator',
  'antigravity',
  'manual',
  'manual-required',
  'Seeded Antigravity unified local executor runtime (Option A).'
)
ON CONFLICT (agent_code) DO NOTHING;
