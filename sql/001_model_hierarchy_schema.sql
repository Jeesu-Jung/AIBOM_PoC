-- MySQL 8.0+
-- Database schema for the AIBOM model catalog.

CREATE DATABASE IF NOT EXISTS aibom
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE aibom;

CREATE TABLE IF NOT EXISTS model_info (
  model_id                 VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  namespace                VARCHAR(255) NOT NULL,
  model_name               VARCHAR(255) NOT NULL,
  family_key               VARCHAR(100) NOT NULL,
  family_name              VARCHAR(255) NOT NULL,
  model_role               ENUM('BASE', 'INSTRUCT', 'DERIVED') NOT NULL,
  supplier                 VARCHAR(255) NULL,
  family_developer         VARCHAR(255) NULL,
  family_release_date      DATE NULL,
  family_license_name      VARCHAR(255) NULL,
  primary_purpose          VARCHAR(255) NULL,
  model_version            VARCHAR(255) NULL,
  package_url              VARCHAR(1000) NULL,
  model_url                VARCHAR(1000) NOT NULL,
  license_reported         JSON NULL,
  artifact_format          VARCHAR(100) NULL,
  tensor_type              VARCHAR(100) NULL,
  parameter_scale          VARCHAR(100) NULL,
  artifact_revision        VARCHAR(255) NULL,
  description              TEXT NULL,
  bom_format               VARCHAR(50) NULL,
  bom_spec_version         VARCHAR(20) NULL,
  bom_serial_number        VARCHAR(100) NULL,
  bom_version              VARCHAR(50) NULL,
  checklist_present_fields SMALLINT UNSIGNED NULL,
  checklist_total_fields   SMALLINT UNSIGNED NULL,
  checklist_score          DECIMAL(5,2) NULL,
  checklist_penalty_factor DECIMAL(6,4) NULL,
  source_generated_at      DATETIME(6) NULL COMMENT 'Source generation time normalized to UTC',
  details_json             JSON NOT NULL,
  created_at               TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at               TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                           ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (model_id),
  KEY ix_model_info_family (family_key, model_role),
  KEY ix_model_info_supplier (supplier),
  KEY ix_model_info_score (checklist_score),
  CHECK (license_reported IS NULL OR JSON_VALID(license_reported)),
  CHECK (JSON_VALID(details_json)),
  CHECK (checklist_score IS NULL OR checklist_score BETWEEN 0 AND 100),
  CHECK (checklist_penalty_factor IS NULL OR checklist_penalty_factor BETWEEN 0 AND 1),
  CHECK (checklist_present_fields IS NULL OR checklist_total_fields IS NULL
         OR checklist_present_fields <= checklist_total_fields)
) ENGINE=InnoDB;

-- One row per model. Root models have no parent or relationship type.
-- The current source is a tree projection: each model has at most one parent.
CREATE TABLE IF NOT EXISTS model_hierarchy (
  model_id             VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  parent_model_id      VARCHAR(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  relationship_type   VARCHAR(100) NULL,
  hierarchy_depth     SMALLINT UNSIGNED NOT NULL,
  sibling_order        INT UNSIGNED NOT NULL DEFAULT 0,
  change_details_json JSON NULL,
  created_at           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at           TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                       ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (model_id),
  KEY ix_model_hierarchy_parent (parent_model_id, sibling_order),
  KEY ix_model_hierarchy_depth (hierarchy_depth),
  CONSTRAINT fk_model_hierarchy_model
    FOREIGN KEY (model_id) REFERENCES model_info(model_id) ON DELETE CASCADE,
  CONSTRAINT fk_model_hierarchy_parent
    FOREIGN KEY (parent_model_id) REFERENCES model_info(model_id) ON DELETE RESTRICT,
  CHECK (parent_model_id IS NULL OR parent_model_id <> model_id),
  CHECK ((parent_model_id IS NULL AND relationship_type IS NULL AND hierarchy_depth = 0)
      OR (parent_model_id IS NOT NULL AND relationship_type IS NOT NULL AND hierarchy_depth > 0)),
  CHECK (change_details_json IS NULL OR JSON_VALID(change_details_json))
) ENGINE=InnoDB;
