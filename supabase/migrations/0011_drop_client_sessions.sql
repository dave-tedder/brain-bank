-- 0011_drop_client_sessions.sql
-- Drops the deprecated client_sessions table. The table was carried over from
-- the engine's pre-public history, was never populated in any active deploy,
-- and held tattoo-shop-flavored column names ("piece_description", etc.) that
-- pinned the public schema to one operator's vocabulary. Removing the table
-- and all 12 source call-sites in one cut. Operators who want a per-client
-- session log can model it in their own profile.json downstream surface.

DROP TABLE IF EXISTS public.client_sessions CASCADE;
