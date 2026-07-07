-- Session 272: route map for cross-project action routing.
-- Adds projects.route_phrases — operator-maintained content phrases (domains,
-- product names) that deterministically route a capture to this project when
-- the LLM-extracted metadata.project is null and exactly one project matches.
-- Phrase VALUES are operator data seeded separately via SQL, not migrated.
-- No new table/view/function, so no RLS or grant changes are needed here.

alter table public.projects
  add column if not exists route_phrases text[] not null default '{}';

comment on column public.projects.route_phrases is
  'Lowercased content phrases (domains, product names) that route a null-project capture to this project. Unique-match only: if phrases from two projects match one capture, no route is applied.';
