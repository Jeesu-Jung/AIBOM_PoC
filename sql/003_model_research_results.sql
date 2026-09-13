-- MySQL 8.0+
-- Stored AI research results for the admin "AI로 정보 채우기" flow.
-- One row per (requested model name, research source). Sources: huggingface, paper, merged.
-- A new research run for the same requested name replaces every previous row for that name.
USE aibom;

CREATE TABLE IF NOT EXISTS model_research_result (
  id                 BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  requested_model    VARCHAR(512) NOT NULL COMMENT 'Model name or id typed by the admin (trimmed)',
  source             ENUM('huggingface', 'paper', 'merged') NOT NULL,
  status             VARCHAR(20) NULL COMMENT 'found | ambiguous | not_found',
  result_model_id    VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL COMMENT 'draft.modelId of the result',
  research_model     VARCHAR(255) NULL COMMENT 'OpenRouter model that produced the result',
  result_json        JSON NOT NULL COMMENT 'Full ModelResearchResult / ModelMergeResult payload',
  created_at         TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  UNIQUE KEY ux_model_research_result_request_source (requested_model, source),
  KEY ix_model_research_result_model_id (result_model_id),
  KEY ix_model_research_result_created (created_at),
  CHECK (JSON_VALID(result_json))
) ENGINE=InnoDB;
