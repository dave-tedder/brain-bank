-- Audit Finding 13: codify "soak passed" in measurable SQL.
--
-- wiki_soak_status — single-row boolean gate. Flips to passed=true when
-- 7-day rolling window shows enough agent traffic AND wiki-tool share
-- AND at least one drill chain.
--
-- wiki_framing_signal — observability view (NOT a gate). Measures whether
-- the agent prefers wiki tools over search_thoughts when the query looks
-- entity-shaped (args has slug/name, or query matches a compiled_pages
-- title). Watched in dashboard over time, not gated on.

CREATE VIEW public.wiki_soak_status AS
WITH window_calls AS (
  SELECT tool_name, source, created_at, args
  FROM mcp_tool_invocations
  WHERE source = 'mcp'
    AND created_at > now() - interval '7 days'
),
total AS (SELECT count(*) AS n FROM window_calls),
wiki  AS (
  SELECT count(*) AS n FROM window_calls
  WHERE tool_name IN ('get_compiled_page','search_compiled_pages','list_compiled_pages')
),
chain AS (
  SELECT count(*) AS n FROM window_calls a
  JOIN window_calls b
    ON b.tool_name = 'get_thought_by_id'
   AND b.created_at > a.created_at
   AND b.created_at <= a.created_at + interval '5 minutes'
  WHERE a.tool_name = 'get_compiled_page'
)
SELECT
  (total.n >= 20)  AS has_volume,
  (wiki.n  >= 5)   AS has_wiki_share,
  (chain.n >= 1)   AS has_drill_chain,
  (total.n >= 20 AND wiki.n >= 5 AND chain.n >= 1) AS passed,
  total.n AS total_calls,
  wiki.n  AS wiki_calls,
  chain.n AS drill_chains,
  now()   AS computed_at
FROM total, wiki, chain;

CREATE VIEW public.wiki_framing_signal AS
WITH entity_shaped AS (
  SELECT tool_name, args
  FROM mcp_tool_invocations
  WHERE source = 'mcp'
    AND created_at > now() - interval '7 days'
    AND (
      args ? 'slug' OR args ? 'name'
      OR (
        args ? 'query'
        AND EXISTS (
          SELECT 1 FROM compiled_pages cp
          WHERE cp.title ILIKE '%' || (args->>'query') || '%'
        )
      )
    )
)
SELECT
  count(*) FILTER (WHERE tool_name IN ('get_compiled_page','search_compiled_pages','list_compiled_pages')) AS wiki_calls,
  count(*) FILTER (WHERE tool_name = 'search_thoughts') AS thoughts_calls,
  CASE WHEN count(*) FILTER (WHERE tool_name = 'search_thoughts') = 0 THEN NULL
       ELSE count(*) FILTER (WHERE tool_name IN ('get_compiled_page','search_compiled_pages','list_compiled_pages'))::numeric
            / count(*) FILTER (WHERE tool_name = 'search_thoughts')::numeric
  END AS wiki_to_thoughts_ratio,
  now() AS computed_at
FROM entity_shaped;
