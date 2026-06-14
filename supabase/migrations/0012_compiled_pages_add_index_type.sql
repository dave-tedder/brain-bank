-- Phase 12.C: self-compiled wiki index page.
-- Add 'index' to compiled_pages.page_type CHECK constraint to support
-- self-compiled wiki index pages (slug 'index/wiki' is the first; future
-- index pages may include 'index/clients', 'index/topics', etc.).
-- Drops + recreates the CHECK because PostgreSQL has no in-place ALTER for
-- a CHECK constraint's allowed values.

ALTER TABLE public.compiled_pages
  DROP CONSTRAINT IF EXISTS compiled_pages_page_type_check;

ALTER TABLE public.compiled_pages
  ADD CONSTRAINT compiled_pages_page_type_check
  CHECK (page_type = ANY (ARRAY['client', 'topic', 'project', 'index']));
