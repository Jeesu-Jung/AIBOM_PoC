-- MySQL 8.0+
-- Filter the AI research history by family name and parent model. Run once after sql/014.
--
--   model_research_result  + family_name, parent_model_id (draft.familyName / draft.parentModelId)
--
-- Both values already live in result_json; reading them from the JSON of every result on each
-- list request is slow, so they are kept as columns like result_model_id. New results fill them
-- when they are saved.
USE aibom;

ALTER TABLE model_research_result
  ADD COLUMN family_name VARCHAR(255) NULL COMMENT 'draft.familyName of the result' AFTER result_model_id,
  ADD COLUMN parent_model_id VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT 'draft.parentModelId of the result' AFTER family_name;

-- Results stored before this migration. `WHERE id > 0` covers every row and keeps MySQL
-- Workbench's safe update mode (error 1175) from refusing the statement.
UPDATE model_research_result
SET family_name = CASE WHEN JSON_TYPE(JSON_EXTRACT(result_json, '$.draft.familyName')) = 'STRING'
                       THEN NULLIF(LEFT(TRIM(JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.draft.familyName'))), 255), '') END,
    parent_model_id = CASE WHEN JSON_TYPE(JSON_EXTRACT(result_json, '$.draft.parentModelId')) = 'STRING'
                           THEN NULLIF(LEFT(TRIM(JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.draft.parentModelId'))), 512), '') END
WHERE id > 0;
