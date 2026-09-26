-- MySQL 8.0.17+ (multi-valued JSON indexes)
-- AIBOM area tables: one table per area of AIBOM_스키마_설계안.md §2, one column per field.
--   MODEL, DATASET, TRANSFORMATION, EVALUATION, PROVENANCE, SAFETY_ETHICS, LICENSE_POLICY, REFERENCE
--
-- Conventions
--   * Column names are the design's field names. Multi-valued fields are JSON arrays; the ones used
--     for reverse lookups (inputs, datasets, parents, evidence) carry multi-valued indexes, so
--     `'<id>' MEMBER OF (col->'$[*].x')` queries stay indexed.
--   * Subjects shared by models and datasets (PROVENANCE.subject, LICENSE_POLICY.subject,
--     PROVENANCE.parent) are written as 'model:<hf id>' or 'dataset:<dataset id>'.
--   * Facts outside the design fields go to each table's `extensions` JSON column.
--   * model_info / model_hierarchy (sql/001) stay the catalog tables used by the UI;
--     model.identity references model_info.model_id.
-- Data is loaded by scripts/aibom/load_research.py.
USE aibom;

CREATE TABLE IF NOT EXISTS reference (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `type`       ENUM('paper', 'technical_report', 'model_card', 'dataset_card', 'repository',
                    'config', 'documentation', 'license', 'blog', 'webpage') NOT NULL,
  uri          VARCHAR(1000) NOT NULL,
  revision     VARCHAR(255) NULL COMMENT 'git sha, arXiv version, ...',
  retrieved_at DATE NULL,
  `hash`       CHAR(64) NULL COMMENT 'SHA-256 of the content fetched at retrieved_at',
  extensions   JSON NULL COMMENT '{title, published_at, http_status}',
  uri_hash     CHAR(64) AS (SHA2(uri, 256)) STORED,
  PRIMARY KEY (id),
  UNIQUE KEY ux_reference_uri (uri_hash)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS provenance (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject    VARCHAR(520) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'model:<id> | dataset:<id>',
  origin     VARCHAR(255) NULL,
  provider   VARCHAR(255) NULL,
  parent     JSON NULL COMMENT 'direct parents: ["model:<id>", "dataset:<id>", ...]',
  relation   VARCHAR(50) NULL COMMENT 'pretrained | fine_tuned_from | adapter_trained_from | converted_from | derived_from | ...',
  evidence   JSON NULL COMMENT 'reference ids: [1, 2]',
  extensions JSON NULL COMMENT '{disclosure_status, notes}',
  PRIMARY KEY (id),
  UNIQUE KEY ux_provenance_subject (subject),
  KEY ix_provenance_parent ((CAST(parent AS CHAR(255) ARRAY))),
  KEY ix_provenance_evidence ((CAST(evidence AS UNSIGNED ARRAY)))
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS model (
  `identity`   VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  architecture JSON NULL COMMENT '{family, parameter_count, context_length, layers, hidden_size, ...}',
  tokenizer    JSON NULL COMMENT '{name, vocab_size}',
  modality     JSON NULL COMMENT '{input: [...], output: [...], languages: [...]}',
  intended_use TEXT NULL,
  capabilities JSON NULL,
  limitations  JSON NULL,
  provenance   BIGINT UNSIGNED NULL,
  extensions   JSON NULL COMMENT '{knowledge_cutoff, release_date, unknowns, evidence: reference ids for the MODEL fields}',
  PRIMARY KEY (`identity`),
  CONSTRAINT fk_model_catalog    FOREIGN KEY (`identity`) REFERENCES model_info(model_id) ON DELETE CASCADE,
  CONSTRAINT fk_model_provenance FOREIGN KEY (provenance) REFERENCES provenance(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS dataset (
  `identity`  VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
              COMMENT 'HF dataset id, or slug:<name> when there is none',
  version     VARCHAR(255) NULL,
  role        SET('pretraining', 'finetuning', 'evaluation') NULL
              COMMENT 'Roles this dataset plays across the catalog; per-model roles are in transformation.datasets / evaluation.dataset',
  processing  JSON NULL,
  license     VARCHAR(255) NULL COMMENT 'As stated by the source; details in license_policy (subject = dataset:<id>)',
  provenance  BIGINT UNSIGNED NULL,
  extensions  JSON NULL COMMENT '{name, hf_id, uri, description, size, modality, provider}',
  PRIMARY KEY (`identity`),
  CONSTRAINT fk_dataset_provenance FOREIGN KEY (provenance) REFERENCES provenance(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS transformation (
  id              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  input           JSON NULL COMMENT '[{model, role: base|merge_source|teacher|generator|verifier|reward_model, external}]',
  output          VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  method          JSON NOT NULL COMMENT 'ordered step list',
  objective       TEXT NULL,
  hyperparameters JSON NULL COMMENT 'training settings; adapter settings under "adapter"',
  datasets        JSON NULL COMMENT '[{dataset, role: pretraining|finetuning|preference|distillation|calibration|other}]',
  `timestamp`     DATE NULL,
  extensions      JSON NULL COMMENT '{notes}',
  PRIMARY KEY (id),
  UNIQUE KEY ux_transformation_output (output),
  KEY ix_transformation_input ((CAST(input->'$[*].model' AS CHAR(255) ARRAY))),
  KEY ix_transformation_datasets ((CAST(datasets->'$[*].dataset' AS CHAR(255) ARRAY))),
  CONSTRAINT fk_transformation_output FOREIGN KEY (output) REFERENCES model_info(model_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS evaluation (
  id            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  model         VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  dataset       VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  configuration JSON NULL COMMENT '{benchmark, shots, cot, notes, ...}',
  metric        VARCHAR(255) NULL,
  score         DECIMAL(14,4) NULL,
  `timestamp`   DATE NULL COMMENT 'Date the result was reported (publication date of the source revision)',
  extensions    JSON NULL COMMENT '{score_text, baseline_model, baseline_score, evaluator_model, reference}',
  PRIMARY KEY (id),
  KEY ix_evaluation_model (model),
  KEY ix_evaluation_dataset (dataset),
  CONSTRAINT fk_evaluation_model   FOREIGN KEY (model) REFERENCES model_info(model_id) ON DELETE CASCADE,
  CONSTRAINT fk_evaluation_dataset FOREIGN KEY (dataset) REFERENCES dataset(`identity`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS safety_ethics (
  subject                VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL
                         COMMENT 'Model id',
  safety_risk            JSON NULL COMMENT '[{description, reference}]',
  ethical_considerations JSON NULL,
  prohibited_use         JSON NULL,
  mitigation             JSON NULL,
  extensions             JSON NULL COMMENT '{risk_summary}',
  PRIMARY KEY (subject),
  CONSTRAINT fk_safety_ethics_model FOREIGN KEY (subject) REFERENCES model_info(model_id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS license_policy (
  id           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  subject      VARCHAR(520) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'model:<id> | dataset:<id>',
  license      VARCHAR(200) NOT NULL,
  usage_policy VARCHAR(255) NULL,
  restrictions JSON NULL,
  extensions   JSON NULL COMMENT '{license_key, spdx_id, license_uri, usage_policy_uri, kind, scope_note, commercial_use}',
  PRIMARY KEY (id),
  UNIQUE KEY ux_license_policy (subject, license),
  KEY ix_license_policy_license (license)
) ENGINE=InnoDB;
