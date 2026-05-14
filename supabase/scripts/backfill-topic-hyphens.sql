-- Backfill: topic hyphen preservation
-- Spec: docs/superpowers/specs/2026-05-14-topic-hyphen-preservation-design.md
--
-- Scans thoughts whose captured content has an explicit `Tags:` line,
-- finds hyphenated tokens in that Tags line whose halves were stored
-- separately in metadata.topics (LLM split them), and rejoins the halves
-- into the original hyphenated compound. Idempotent: marks affected
-- rows with metadata.topics_backfilled_v1 = true so reruns skip them.
--
-- Note: only the FIRST Tags: line per thought is processed (regexp_match,
-- not regexp_matches). Multi-Tags-line thoughts are rare; their second
-- and later Tags lines are not backfilled.
--
-- Default mode: DRY-RUN. Inspect the rejoin_preview view, then re-run
-- with DRY_RUN := false in the DO block.

BEGIN;

-- Build the candidate set + the rebuilt-topics array as a temp table.
CREATE TEMP TABLE candidates ON COMMIT DROP AS
WITH base AS (
  SELECT
    id,
    content,
    metadata,
    -- Capture every Tags: line, lowercase, split on comma, trim, take
    -- only the hyphenated tokens.
    ARRAY(
      SELECT lower(trim(t))
      FROM unnest(
        string_to_array(
          regexp_replace(
            (regexp_match(content, '(?:^|\n)\s*Tags:\s*([^\n]+)', 'i'))[1],
            '\s+', '', 'g'
          ),
          ','
        )
      ) AS t
      WHERE t LIKE '%-%'
    ) AS hyphenated_tags,
    ARRAY(
      SELECT jsonb_array_elements_text(metadata -> 'topics')
    ) AS current_topics
  FROM thoughts
  WHERE content ~* '(^|\n)\s*Tags:\s'
    AND metadata ? 'topics'
    AND (metadata ->> 'topics_backfilled_v1') IS NULL
),
rebuilt AS (
  SELECT
    id,
    current_topics,
    hyphenated_tags,
    -- For each hyphenated tag, if both halves appear in current_topics,
    -- remove the halves and add the compound. Done as a fold.
    (
      SELECT array_agg(DISTINCT t ORDER BY t)
      FROM unnest(
        (
          SELECT ARRAY(
                   SELECT t
                   FROM unnest(current_topics) t
                   WHERE t <> ALL(
                     ARRAY(
                       SELECT unnest(string_to_array(h, '-'))
                       FROM unnest(hyphenated_tags) h
                       WHERE (
                         SELECT bool_and(part = ANY(current_topics))
                         FROM unnest(string_to_array(h, '-')) part
                       )
                     )
                   )
                 )
                 || ARRAY(
                     SELECT h
                     FROM unnest(hyphenated_tags) h
                     WHERE (
                       SELECT bool_and(part = ANY(current_topics))
                       FROM unnest(string_to_array(h, '-')) part
                     )
                   )
        )
      ) AS t
    ) AS new_topics
  FROM base
)
SELECT
  id,
  current_topics,
  new_topics,
  (ARRAY(SELECT t FROM unnest(current_topics) t ORDER BY t) IS DISTINCT FROM new_topics) AS changed
FROM rebuilt;

-- Inspection view (dry-run output).
CREATE TEMP VIEW rejoin_preview AS
SELECT id, current_topics, new_topics
FROM candidates
WHERE changed
ORDER BY id;

-- Counts for the operator.
SELECT
  count(*) FILTER (WHERE changed) AS rows_to_rejoin,
  count(*) AS rows_examined
FROM candidates;

-- Sample 10 rejoin proposals for eyeball review.
SELECT * FROM rejoin_preview LIMIT 10;

DO $$
DECLARE
  DRY_RUN boolean := true;  -- flip to false for the real run
BEGIN
  IF DRY_RUN THEN
    RAISE NOTICE 'DRY-RUN MODE: no UPDATEs performed. Inspect counts + sample above. Flip DRY_RUN := false and re-run to apply.';
  ELSE
    -- Real run: write the rejoined topics + always set the marker.
    UPDATE thoughts t
    SET metadata =
      CASE
        WHEN c.changed THEN
          jsonb_set(t.metadata, '{topics}', to_jsonb(c.new_topics))
            || jsonb_build_object('topics_backfilled_v1', true)
        ELSE
          t.metadata || jsonb_build_object('topics_backfilled_v1', true)
      END
    FROM candidates c
    WHERE t.id = c.id;

    RAISE NOTICE 'Backfill applied. Rejoined: %.', (SELECT count(*) FROM candidates WHERE changed);
  END IF;
END $$;

-- Always rollback in dry-run, commit in real run. Caller decides.
-- (We leave the COMMIT to the operator's psql session / MCP execute_sql
-- so dry-run aborts cleanly.)
