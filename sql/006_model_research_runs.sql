-- MySQL 8.0+
-- Keep every AI research run instead of overwriting it.
--   model_research_run     one row per "AI로 정보 채우기" run (Hugging Face + paper research, then merge)
--   model_research_result  one row per (run, source); previously one row per (requested model, source)
-- Existing rows are moved into one run per requested model. Run once after sql/003.
USE aibom;

CREATE TABLE IF NOT EXISTS model_research_run (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requested_model VARCHAR(512) NOT NULL COMMENT 'Model name or id typed by the admin (normalized)',
  model_id        VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL
                  COMMENT 'Catalog model registered from this run, set when the admin saves the draft',
  created_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at      TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_model_research_run_requested (requested_model, created_at),
  KEY ix_model_research_run_model (model_id),
  CONSTRAINT fk_model_research_run_model FOREIGN KEY (model_id) REFERENCES model_info(model_id) ON DELETE SET NULL
) ENGINE=InnoDB;

ALTER TABLE model_research_result
  ADD COLUMN run_id              BIGINT UNSIGNED NULL AFTER id,
  ADD COLUMN web_search_requests INT UNSIGNED NULL AFTER research_model,
  ADD COLUMN cost_usd            DECIMAL(12,6) NULL AFTER web_search_requests;

-- Backfill: one run per requested model for the rows stored so far.
INSERT INTO model_research_run (requested_model, created_at)
SELECT requested_model, MIN(created_at) FROM model_research_result GROUP BY requested_model;

UPDATE model_research_result r
JOIN model_research_run run ON run.requested_model = r.requested_model
SET r.run_id = run.id,
    r.cost_usd = CAST(JSON_UNQUOTE(JSON_EXTRACT(r.result_json, '$.research.usage.cost')) AS DECIMAL(12,6)),
    r.web_search_requests = COALESCE(
      JSON_EXTRACT(r.result_json, '$.research.usage.server_tool_use.web_search_requests'),
      JSON_EXTRACT(r.result_json, '$.research.usage.server_tool_use_details.web_search_requests'));

ALTER TABLE model_research_result
  MODIFY COLUMN run_id BIGINT UNSIGNED NOT NULL,
  DROP INDEX ux_model_research_result_request_source,
  ADD UNIQUE KEY ux_model_research_result_run_source (run_id, source),
  ADD KEY ix_model_research_result_requested (requested_model, created_at),
  ADD CONSTRAINT fk_model_research_result_run FOREIGN KEY (run_id) REFERENCES model_research_run(id) ON DELETE CASCADE;
