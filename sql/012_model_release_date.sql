-- MySQL 8.0+
-- Keep the release date of each model instead of family-level facts. Run once after sql/011.
--
--   model_info.release_date   release date of this model (researched in the AIBOM, shown in the catalog)
--
-- Dropped: family_developer, family_release_date, family_license_name. The supplier and the
-- reported license of each model already cover them.
USE aibom;

ALTER TABLE model_info
  ADD COLUMN release_date DATE NULL COMMENT 'release date of this model (not of its family)' AFTER supplier;

-- The AIBOM already holds each model's own release date.
UPDATE model_info i
JOIN model m ON m.identity = i.model_id
SET i.release_date = CAST(JSON_UNQUOTE(JSON_EXTRACT(m.extensions, '$.release_date')) AS DATE)
WHERE JSON_UNQUOTE(JSON_EXTRACT(m.extensions, '$.release_date')) REGEXP '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';

-- Root models without one: the family release date was theirs. Derivatives stay NULL (the family
-- date is not their release date).
UPDATE model_info i
JOIN model_hierarchy h ON h.model_id = i.model_id
SET i.release_date = i.family_release_date
WHERE i.release_date IS NULL AND h.hierarchy_depth = 0;

ALTER TABLE model_info
  DROP COLUMN family_developer,
  DROP COLUMN family_release_date,
  DROP COLUMN family_license_name;
