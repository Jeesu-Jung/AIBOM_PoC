-- MySQL 8.0.14+
-- Merge datasets that a stored research result lists twice. Run once after sql/013.
--
-- The merge step was asked to keep one dataset per identity, but the research model sometimes
-- returned the same identity twice (another evidence URL or description). The dataset table has
-- one row per identity, so such a result could not be saved. New results are deduplicated in
-- code (backend/app/aibom_research.py). This script repairs the results stored before that,
-- without researching the models again.
--
-- For every result whose `aibom.dataset` repeats an identity:
--   - the first entry of each identity is kept, in its original position,
--   - its `provenance.evidence` becomes the union of the evidence of all its entries
--     (order of first appearance), so no source URL is lost,
--   - and `aibomSummary.datasets` is set to the new number of datasets.
-- The other fields of the later entries (description, provider spelling, disclosure status) are
-- dropped. `aibomDraft`, the research model's raw answer, is left as it was.
--
-- Safe to run again: a result without repeated identities is not touched.
USE aibom;

DROP TEMPORARY TABLE IF EXISTS tmp_merged_research_datasets;

CREATE TEMPORARY TABLE tmp_merged_research_datasets AS
WITH repeated AS (
  -- results whose dataset list names an identity more than once
  SELECT r.id
  FROM model_research_result r
  JOIN JSON_TABLE(r.result_json, '$.aibom.dataset[*]' COLUMNS (
         identity VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$.identity')) d
  GROUP BY r.id
  HAVING COUNT(*) > COUNT(DISTINCT d.identity)
),
items AS (
  -- one row per dataset entry of those results
  SELECT r.id, t.ord, t.identity, t.item
  FROM model_research_result r
  JOIN repeated ON repeated.id = r.id
  JOIN JSON_TABLE(r.result_json, '$.aibom.dataset[*]' COLUMNS (
         ord FOR ORDINALITY,
         identity VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$.identity',
         item JSON PATH '$')) t
),
firsts AS (
  SELECT id, identity, MIN(ord) AS first_ord, COUNT(*) AS entries
  FROM items
  GROUP BY id, identity
),
evidence AS (
  -- every evidence URL of an identity once, at the position it first appears
  -- (read from the table again: JSON_TABLE does not accept a column of a CTE)
  SELECT r.id, t.identity, t.url, MIN(t.ord * 100000 + t.pos) AS first_pos
  FROM model_research_result r
  JOIN repeated ON repeated.id = r.id
  JOIN JSON_TABLE(r.result_json, '$.aibom.dataset[*]' COLUMNS (
         ord FOR ORDINALITY,
         identity VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$.identity',
         NESTED PATH '$.provenance.evidence[*]' COLUMNS (
           pos FOR ORDINALITY,
           url VARCHAR(1000) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin PATH '$'))) t
  WHERE t.url IS NOT NULL
  GROUP BY r.id, t.identity, t.url
),
evidence_lists AS (
  SELECT id, identity, urls
  FROM (
    SELECT id, identity,
           JSON_ARRAYAGG(url) OVER (PARTITION BY id, identity ORDER BY first_pos
                                    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS urls,
           ROW_NUMBER() OVER (PARTITION BY id, identity ORDER BY first_pos) AS rn
    FROM evidence
  ) ranked
  WHERE rn = 1
),
kept AS (
  SELECT i.id, i.ord,
         CASE WHEN f.entries > 1 AND l.urls IS NOT NULL
                   AND JSON_TYPE(JSON_EXTRACT(i.item, '$.provenance')) = 'OBJECT'
              THEN JSON_SET(i.item, '$.provenance.evidence', l.urls)
              ELSE i.item END AS item
  FROM items i
  JOIN firsts f ON f.id = i.id AND f.identity = i.identity AND f.first_ord = i.ord
  LEFT JOIN evidence_lists l ON l.id = i.id AND l.identity = i.identity
)
SELECT id, datasets, dataset_count
FROM (
  SELECT id,
         JSON_ARRAYAGG(item) OVER (PARTITION BY id ORDER BY ord
                                   ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS datasets,
         COUNT(*) OVER (PARTITION BY id) AS dataset_count,
         ROW_NUMBER() OVER (PARTITION BY id ORDER BY ord) AS rn
  FROM kept
) ranked
WHERE rn = 1;

-- The results that will change, with their dataset count before and after.
SELECT r.id AS result_id, r.run_id, r.requested_model, r.source,
       JSON_LENGTH(r.result_json, '$.aibom.dataset') AS datasets_before, t.dataset_count AS datasets_after
FROM model_research_result r
JOIN tmp_merged_research_datasets t ON t.id = r.id
ORDER BY r.id;

UPDATE model_research_result r
JOIN tmp_merged_research_datasets t ON t.id = r.id
SET r.result_json = JSON_SET(r.result_json,
                             '$.aibom.dataset', t.datasets,
                             '$.aibomSummary.datasets', t.dataset_count);

DROP TEMPORARY TABLE tmp_merged_research_datasets;
