-- CAP-1 (post-audit remediation Session 2): per-page consecutive-failure
-- counter for compile-pages. After COMPILE_FAILURE_QUARANTINE_THRESHOLD (3)
-- consecutive scheduled-compile failures a page is quarantined from scheduled
-- runs and surfaced through compile_pages_runs.errored, which the deployed
-- brain-digest degraded-run warning (E6) already reads. Any successful
-- compile (targeted or scheduled) resets the counter to 0.
alter table public.compiled_pages
  add column if not exists compile_failures integer not null default 0,
  add column if not exists last_compile_error text;

comment on column public.compiled_pages.compile_failures is
  'Consecutive compile failures; >=3 quarantines the page from scheduled compile runs. Reset to 0 on any successful compile.';
comment on column public.compiled_pages.last_compile_error is
  'Truncated error message from the most recent failed compile; cleared on success.';
