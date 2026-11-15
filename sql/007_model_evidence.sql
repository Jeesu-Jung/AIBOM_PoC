-- MySQL 8.0+
-- Per-model evidence for researched values. Run once after sql/006.
--
-- Why a separate table: the AIBOM area tables keep evidence next to rows that are shared between
-- models (DATASET is keyed by `identity`, REFERENCE by `uri`), so a later research run for another
-- model can change them. This table records, for ONE model, which URL supported which value in
-- the research result that was registered, so a human reviewer can check each value against its
-- source.
--
--   area      catalog (model_info columns) or an AIBOM area
--   item_key  which row inside a multi-row area; '' for catalog / model / provenance / transformation
--               dataset         dataset identity            (cais/mmlu)
--               evaluation      '<benchmark> | <metric>[ | <n>-shot]'
--               license_policy  license name
--               safety_ethics   the item's description text
--   field     field the URL supports (familyReleaseDate, architecture.parameter_count), '*' when
--             the source backs the whole area / item; for safety_ethics the category (safety_risk, ...)
--   url       one evidence URL per row
USE aibom;

CREATE TABLE IF NOT EXISTS model_evidence (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  model_id   VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  area       VARCHAR(30)  NOT NULL COMMENT 'catalog | model | provenance | transformation | dataset | evaluation | safety_ethics | license_policy',
  item_key   VARCHAR(512) NOT NULL DEFAULT '' COMMENT 'row inside a multi-row area (dataset identity, evaluation key, license, safety item)',
  field      VARCHAR(150) NOT NULL DEFAULT '*' COMMENT 'field name, or * for the whole area / item',
  url        VARCHAR(1000) NOT NULL,
  confidence ENUM('high', 'medium', 'low') NULL COMMENT 'confidence stated by the research model',
  note       TEXT NULL COMMENT 'caveat the research model attached to this evidence',
  source     VARCHAR(20) NULL COMMENT 'huggingface | paper | merged | manual',
  run_id     BIGINT UNSIGNED NULL COMMENT 'research run the evidence comes from',
  created_at TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (id),
  KEY ix_model_evidence_model (model_id, area),
  KEY ix_model_evidence_run (run_id),
  CONSTRAINT fk_model_evidence_model FOREIGN KEY (model_id) REFERENCES model_info(model_id) ON DELETE CASCADE,
  CONSTRAINT fk_model_evidence_run   FOREIGN KEY (run_id) REFERENCES model_research_run(id) ON DELETE SET NULL
) ENGINE=InnoDB;
