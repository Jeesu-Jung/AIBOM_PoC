-- MySQL 8.0.17+
-- Empty AIBOM database for a new server: every table and view the application uses, without any
-- data. It is the structure that sql/001 and sql/003 - sql/013 build up step by step (sql/002 only
-- imports sample models), generated from the working database, so a server created from this
-- file behaves exactly like the current one.
--
--   mysql -u root -p < sql/000_schema.sql
--
-- Use this file alone on a new server; do not run the numbered scripts after it. When a later
-- migration is added (sql/015, ...), run that script on servers created from this file.
-- The MySQL account for the MCP connection is created separately: scripts/mysql-mcp/grant_aibom_mcp.sql.

CREATE DATABASE IF NOT EXISTS aibom
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
USE aibom;

-- Tables reference each other, so foreign keys are checked only once everything exists.
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------------
-- Catalog: one row per model and its place in the family tree
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `model_info` (
  `model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `namespace` varchar(255) NOT NULL,
  `model_name` varchar(255) NOT NULL,
  `family_key` varchar(100) NOT NULL,
  `family_name` varchar(255) NOT NULL,
  `model_role` enum('BASE','DERIVED') NOT NULL,
  `supplier` varchar(255) DEFAULT NULL,
  `release_date` date DEFAULT NULL COMMENT 'release date of this model (not of its family)',
  `primary_purpose` varchar(255) DEFAULT NULL,
  `model_version` varchar(255) DEFAULT NULL,
  `package_url` varchar(1000) DEFAULT NULL,
  `model_url` varchar(1000) NOT NULL,
  `license_reported` json DEFAULT NULL,
  `artifact_format` varchar(500) DEFAULT NULL,
  `tensor_type` varchar(500) DEFAULT NULL,
  `parameter_scale` varchar(100) DEFAULT NULL,
  `artifact_revision` varchar(255) DEFAULT NULL,
  `description` text,
  `bom_format` varchar(50) DEFAULT NULL,
  `bom_spec_version` varchar(20) DEFAULT NULL,
  `bom_serial_number` varchar(100) DEFAULT NULL,
  `bom_version` varchar(50) DEFAULT NULL,
  `checklist_present_fields` smallint unsigned DEFAULT NULL,
  `checklist_total_fields` smallint unsigned DEFAULT NULL,
  `checklist_score` decimal(5,2) DEFAULT NULL,
  `checklist_penalty_factor` decimal(6,4) DEFAULT NULL,
  `source_generated_at` datetime(6) DEFAULT NULL COMMENT 'Source generation time normalized to UTC',
  `details_json` json NOT NULL,
  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`model_id`),
  KEY `ix_model_info_family` (`family_key`,`model_role`),
  KEY `ix_model_info_supplier` (`supplier`),
  KEY `ix_model_info_score` (`checklist_score`),
  CONSTRAINT `model_info_chk_1` CHECK (((`license_reported` is null) or json_valid(`license_reported`))),
  CONSTRAINT `model_info_chk_2` CHECK (json_valid(`details_json`)),
  CONSTRAINT `model_info_chk_3` CHECK (((`checklist_score` is null) or (`checklist_score` between 0 and 100))),
  CONSTRAINT `model_info_chk_4` CHECK (((`checklist_penalty_factor` is null) or (`checklist_penalty_factor` between 0 and 1))),
  CONSTRAINT `model_info_chk_5` CHECK (((`checklist_present_fields` is null) or (`checklist_total_fields` is null) or (`checklist_present_fields` <= `checklist_total_fields`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `model_hierarchy` (
  `model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `parent_model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `relationship_type` varchar(100) DEFAULT NULL,
  `hierarchy_depth` smallint unsigned NOT NULL,
  `sibling_order` int unsigned NOT NULL DEFAULT '0',
  `change_details_json` json DEFAULT NULL,
  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`model_id`),
  KEY `ix_model_hierarchy_parent` (`parent_model_id`,`sibling_order`),
  KEY `ix_model_hierarchy_depth` (`hierarchy_depth`),
  CONSTRAINT `fk_model_hierarchy_model` FOREIGN KEY (`model_id`) REFERENCES `model_info` (`model_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_model_hierarchy_parent` FOREIGN KEY (`parent_model_id`) REFERENCES `model_info` (`model_id`) ON DELETE RESTRICT,
  CONSTRAINT `model_hierarchy_chk_1` CHECK (((`parent_model_id` is null) or (`parent_model_id` <> `model_id`))),
  CONSTRAINT `model_hierarchy_chk_2` CHECK ((((`parent_model_id` is null) and (`relationship_type` is null) and (`hierarchy_depth` = 0)) or ((`parent_model_id` is not null) and (`relationship_type` is not null) and (`hierarchy_depth` > 0)))),
  CONSTRAINT `model_hierarchy_chk_3` CHECK (((`change_details_json` is null) or json_valid(`change_details_json`)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- AIBOM areas: REFERENCE, PROVENANCE, MODEL, DATASET, TRANSFORMATION, EVALUATION, SAFETY_ETHICS, LICENSE_POLICY
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `reference` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `type` enum('paper','technical_report','model_card','dataset_card','repository','config','documentation','license','blog','webpage') NOT NULL,
  `uri` varchar(1000) NOT NULL,
  `revision` varchar(255) DEFAULT NULL COMMENT 'git sha, arXiv version, ...',
  `retrieved_at` date DEFAULT NULL,
  `hash` char(64) DEFAULT NULL COMMENT 'SHA-256 of the content fetched at retrieved_at',
  `extensions` json DEFAULT NULL COMMENT '{title, published_at, http_status}',
  `uri_hash` char(64) GENERATED ALWAYS AS (sha2(`uri`,256)) STORED,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_reference_uri` (`uri_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `provenance` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `subject` varchar(600) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'model:<id> | dataset:<id>',
  `origin` varchar(255) DEFAULT NULL,
  `provider` varchar(255) DEFAULT NULL,
  `parent` json DEFAULT NULL COMMENT 'direct parents: ["model:<id>", "dataset:<id>", ...]',
  `relation` varchar(50) DEFAULT NULL COMMENT 'pretrained | fine_tuned_from | adapter_trained_from | converted_from | derived_from | ...',
  `evidence` json DEFAULT NULL COMMENT 'reference ids: [1, 2]',
  `extensions` json DEFAULT NULL COMMENT '{disclosure_status, notes}',
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_provenance_subject` (`subject`),
  KEY `ix_provenance_parent` ((cast(`parent` as char(255) array))),
  KEY `ix_provenance_evidence` ((cast(`evidence` as unsigned array)))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `model` (
  `identity` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `architecture` json DEFAULT NULL COMMENT '{family, parameter_count, context_length, layers, hidden_size, ...}',
  `tokenizer` json DEFAULT NULL COMMENT '{name, vocab_size}',
  `modality` json DEFAULT NULL COMMENT '{input: [...], output: [...], languages: [...]}',
  `intended_use` text,
  `capabilities` json DEFAULT NULL,
  `limitations` json DEFAULT NULL,
  `provenance` bigint unsigned DEFAULT NULL,
  `extensions` json DEFAULT NULL COMMENT '{knowledge_cutoff, release_date, unknowns, evidence: reference ids for the MODEL fields}',
  PRIMARY KEY (`identity`),
  KEY `fk_model_provenance` (`provenance`),
  CONSTRAINT `fk_model_catalog` FOREIGN KEY (`identity`) REFERENCES `model_info` (`model_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_model_provenance` FOREIGN KEY (`provenance`) REFERENCES `provenance` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `dataset` (
  `identity` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'HF dataset id, or slug:<name> when there is none',
  `version` varchar(255) DEFAULT NULL,
  `role` set('pretraining','finetuning','evaluation') DEFAULT NULL COMMENT 'Roles this dataset plays across the catalog; per-model roles are in transformation.datasets / evaluation.dataset',
  `processing` json DEFAULT NULL,
  `license` varchar(255) DEFAULT NULL COMMENT 'As stated by the source; details in license_policy (subject = dataset:<id>)',
  `provenance` bigint unsigned DEFAULT NULL,
  `extensions` json DEFAULT NULL COMMENT '{name, hf_id, uri, description, size, modality, provider}',
  PRIMARY KEY (`identity`),
  KEY `fk_dataset_provenance` (`provenance`),
  CONSTRAINT `fk_dataset_provenance` FOREIGN KEY (`provenance`) REFERENCES `provenance` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `transformation` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `input` json DEFAULT NULL COMMENT '[{model, role: base|merge_source|teacher|generator|verifier|reward_model, external}]',
  `output` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `method` json NOT NULL COMMENT 'ordered step list',
  `objective` text,
  `hyperparameters` json DEFAULT NULL COMMENT 'training settings; adapter settings under "adapter"',
  `datasets` json DEFAULT NULL COMMENT '[{dataset, role: pretraining|finetuning|preference|distillation|calibration|other}]',
  `timestamp` date DEFAULT NULL,
  `extensions` json DEFAULT NULL COMMENT '{notes}',
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_transformation_output` (`output`),
  KEY `ix_transformation_input` ((cast(json_extract(`input`,_utf8mb4'$[*].model') as char(255) array))),
  KEY `ix_transformation_datasets` ((cast(json_extract(`datasets`,_utf8mb4'$[*].dataset') as char(255) array))),
  CONSTRAINT `fk_transformation_output` FOREIGN KEY (`output`) REFERENCES `model_info` (`model_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `evaluation` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `model` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `dataset` varchar(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `configuration` json DEFAULT NULL COMMENT '{benchmark, shots, cot, notes, ...}',
  `metric` varchar(255) DEFAULT NULL,
  `score` decimal(14,4) DEFAULT NULL,
  `timestamp` date DEFAULT NULL COMMENT 'Date the result was reported (publication date of the source revision)',
  `extensions` json DEFAULT NULL COMMENT '{score_text, baseline_model, baseline_score, evaluator_model, reference}',
  PRIMARY KEY (`id`),
  KEY `ix_evaluation_model` (`model`),
  KEY `ix_evaluation_dataset` (`dataset`),
  CONSTRAINT `fk_evaluation_dataset` FOREIGN KEY (`dataset`) REFERENCES `dataset` (`identity`) ON DELETE SET NULL,
  CONSTRAINT `fk_evaluation_model` FOREIGN KEY (`model`) REFERENCES `model_info` (`model_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `safety_ethics` (
  `subject` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'Model id',
  `safety_risk` json DEFAULT NULL COMMENT '[{description, reference}]',
  `ethical_considerations` json DEFAULT NULL,
  `prohibited_use` json DEFAULT NULL,
  `mitigation` json DEFAULT NULL,
  `extensions` json DEFAULT NULL COMMENT '{risk_summary}',
  PRIMARY KEY (`subject`),
  CONSTRAINT `fk_safety_ethics_model` FOREIGN KEY (`subject`) REFERENCES `model_info` (`model_id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `license_policy` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `subject` varchar(520) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL COMMENT 'model:<id> | dataset:<id>',
  `license` varchar(200) NOT NULL,
  `usage_policy` varchar(255) DEFAULT NULL,
  `restrictions` json DEFAULT NULL,
  `extensions` json DEFAULT NULL COMMENT '{license_key, spdx_id, license_uri, usage_policy_uri, kind, scope_note, commercial_use}',
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_license_policy` (`subject`,`license`),
  KEY `ix_license_policy_license` (`license`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ---------------------------------------------------------------------------
-- AI research: reviewers, research runs with their results, and per-model evidence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `reviewer` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `name` varchar(100) NOT NULL COMMENT 'display name',
  `email` varchar(255) DEFAULT NULL,
  `is_active` tinyint(1) NOT NULL DEFAULT '1' COMMENT 'inactive reviewers get no new runs but keep their history',
  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_reviewer_name` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `model_research_run` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `requested_model` varchar(512) NOT NULL COMMENT 'Model name or id typed by the admin (normalized)',
  `model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'Catalog model registered from this run, set when the admin saves the draft',
  `reviewer_id` bigint unsigned DEFAULT NULL COMMENT 'no longer read: assignments are in model_research_review (sql/016)',
  `assigned_at` timestamp(6) NULL DEFAULT NULL,
  `reviewed_by` bigint unsigned DEFAULT NULL COMMENT 'reviewer who reviewed the run and saved the model',
  `reviewed_at` timestamp(6) NULL DEFAULT NULL COMMENT 'when the run was saved to the catalog',
  `finalize_status` varchar(20) DEFAULT NULL COMMENT 'saving | merging | failed while the reviews are being saved, NULL otherwise',
  `finalize_error` text COMMENT 'why the save failed',
  `finalize_started_at` timestamp(6) NULL DEFAULT NULL,
  `finalize_json` json DEFAULT NULL COMMENT 'how each value was decided: unanimous, majority or AI merge',
  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_model_research_run_requested` (`requested_model`,`created_at`),
  KEY `ix_model_research_run_model` (`model_id`),
  KEY `ix_model_research_run_reviewer` (`reviewer_id`,`model_id`),
  KEY `ix_model_research_run_reviewed_by` (`reviewed_by`),
  CONSTRAINT `fk_model_research_run_model` FOREIGN KEY (`model_id`) REFERENCES `model_info` (`model_id`) ON DELETE SET NULL,
  CONSTRAINT `fk_model_research_run_reviewed_by` FOREIGN KEY (`reviewed_by`) REFERENCES `reviewer` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_model_research_run_reviewer` FOREIGN KEY (`reviewer_id`) REFERENCES `reviewer` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `model_research_review` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `run_id` bigint unsigned NOT NULL,
  `reviewer_id` bigint unsigned NOT NULL,
  `status` varchar(20) NOT NULL DEFAULT 'assigned' COMMENT 'assigned | submitted',
  `review_json` json DEFAULT NULL COMMENT 'the submitted answer: { model, aibom, evidence }',
  `assigned_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `submitted_at` timestamp(6) NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_model_research_review_run_reviewer` (`run_id`,`reviewer_id`),
  KEY `ix_model_research_review_reviewer` (`reviewer_id`,`status`),
  CONSTRAINT `fk_model_research_review_run` FOREIGN KEY (`run_id`) REFERENCES `model_research_run` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_model_research_review_reviewer` FOREIGN KEY (`reviewer_id`) REFERENCES `reviewer` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `model_research_result` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `run_id` bigint unsigned NOT NULL,
  `requested_model` varchar(512) NOT NULL COMMENT 'Model name or id typed by the admin (trimmed)',
  `source` enum('huggingface','paper','merged') NOT NULL,
  `status` varchar(20) DEFAULT NULL COMMENT 'found | ambiguous | not_found',
  `result_model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'draft.modelId of the result',
  `family_name` varchar(255) DEFAULT NULL COMMENT 'draft.familyName of the result',
  `parent_model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT 'draft.parentModelId of the result',
  `research_model` varchar(255) DEFAULT NULL COMMENT 'OpenRouter model that produced the result',
  `web_search_requests` int unsigned DEFAULT NULL,
  `cost_usd` decimal(12,6) DEFAULT NULL,
  `response_time_ms` int unsigned DEFAULT NULL COMMENT 'OpenRouter call: request sent to stream finished, in ms',
  `event_count` int unsigned DEFAULT NULL COMMENT 'events OpenRouter sent on the stream',
  `content_characters` int unsigned DEFAULT NULL COMMENT 'characters of the answer the model generated',
  `result_json` json NOT NULL COMMENT 'Full ModelResearchResult / ModelMergeResult payload',
  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `ux_model_research_result_run_source` (`run_id`,`source`),
  KEY `ix_model_research_result_model_id` (`result_model_id`),
  KEY `ix_model_research_result_created` (`created_at`),
  KEY `ix_model_research_result_requested` (`requested_model`,`created_at`),
  CONSTRAINT `fk_model_research_result_run` FOREIGN KEY (`run_id`) REFERENCES `model_research_run` (`id`) ON DELETE CASCADE,
  CONSTRAINT `model_research_result_chk_1` CHECK (json_valid(`result_json`))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS `model_evidence` (
  `id` bigint unsigned NOT NULL AUTO_INCREMENT,
  `model_id` varchar(512) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `area` varchar(30) NOT NULL COMMENT 'catalog | model | provenance | transformation | dataset | evaluation | safety_ethics | license_policy',
  `item_key` varchar(512) NOT NULL DEFAULT '' COMMENT 'row inside a multi-row area (dataset identity, evaluation key, license, safety item)',
  `field` varchar(150) NOT NULL DEFAULT '*' COMMENT 'field name, or * for the whole area / item',
  `url` varchar(1000) NOT NULL,
  `locator` varchar(500) DEFAULT NULL COMMENT 'place inside the source: "Table 2 (Main results), row ..., column ...", "Section 4.2"',
  `confidence` enum('high','medium','low') DEFAULT NULL COMMENT 'confidence stated by the research model',
  `note` text COMMENT 'caveat the research model attached to this evidence',
  `source` varchar(20) DEFAULT NULL COMMENT 'huggingface | paper | merged | manual',
  `run_id` bigint unsigned DEFAULT NULL COMMENT 'research run the evidence comes from',
  `created_at` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  KEY `ix_model_evidence_model` (`model_id`,`area`),
  KEY `ix_model_evidence_run` (`run_id`),
  CONSTRAINT `fk_model_evidence_model` FOREIGN KEY (`model_id`) REFERENCES `model_info` (`model_id`) ON DELETE CASCADE,
  CONSTRAINT `fk_model_evidence_run` FOREIGN KEY (`run_id`) REFERENCES `model_research_run` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;


SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------------------------
-- Read views (sql/005)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE VIEW v_model_lineage AS
SELECT
  m.`identity` AS model_id,
  mi.family_key,
  mi.model_role,
  p.relation,
  p.origin,
  p.provider,
  p.parent,
  JSON_UNQUOTE(p.extensions->'$.disclosure_status') AS disclosure_status,
  t.method,
  t.input,
  t.datasets,
  t.`timestamp`,
  h.parent_model_id   AS hierarchy_parent_model_id,
  h.relationship_type AS hierarchy_relationship_type
FROM model m
JOIN model_info mi          ON mi.model_id = m.`identity`
LEFT JOIN provenance p      ON p.id = m.provenance
LEFT JOIN transformation t  ON t.output = m.`identity`
LEFT JOIN model_hierarchy h ON h.model_id = m.`identity`;

CREATE OR REPLACE VIEW v_model_evaluation AS
SELECT
  e.model AS model_id,
  JSON_UNQUOTE(e.configuration->'$.benchmark') AS benchmark,
  e.metric,
  e.score,
  JSON_UNQUOTE(e.extensions->'$.score_text') AS score_text,
  JSON_UNQUOTE(e.extensions->'$.baseline_model') AS baseline_model,
  CAST(NULLIF(JSON_UNQUOTE(e.extensions->'$.baseline_score'), 'null') AS DECIMAL(14,4)) AS baseline_score,
  e.score - CAST(NULLIF(JSON_UNQUOTE(e.extensions->'$.baseline_score'), 'null') AS DECIMAL(14,4)) AS delta_vs_baseline,
  JSON_UNQUOTE(e.extensions->'$.evaluator_model') AS evaluator_model,
  e.configuration,
  e.dataset AS dataset_id,
  JSON_UNQUOTE(d.extensions->'$.name') AS dataset_name,
  e.`timestamp`,
  JSON_UNQUOTE(e.extensions->'$.reference') AS source_uri,
  e.id AS evaluation_id
FROM evaluation e
LEFT JOIN dataset d ON d.`identity` = e.dataset;

CREATE OR REPLACE VIEW v_model_aibom AS
SELECT
  mi.model_id,
  mi.family_key,
  mi.family_name,
  mi.model_role,
  JSON_OBJECT('identity', m.`identity`, 'architecture', m.architecture, 'tokenizer', m.tokenizer,
              'modality', m.modality, 'intended_use', m.intended_use, 'capabilities', m.capabilities,
              'limitations', m.limitations, 'provenance', m.provenance, 'extensions', m.extensions,
              'catalog', JSON_OBJECT('model_url', mi.model_url, 'revision', mi.model_version,
                                     'primary_purpose', mi.primary_purpose)) AS model,
  (SELECT JSON_OBJECT('subject', p.subject, 'origin', p.origin, 'provider', p.provider, 'parent', p.parent,
                      'relation', p.relation, 'evidence', p.evidence, 'extensions', p.extensions,
                      'evidence_uris', (SELECT JSON_ARRAYAGG(r.uri) FROM reference r
                                         WHERE r.id MEMBER OF (p.evidence)))
     FROM provenance p WHERE p.id = m.provenance) AS provenance,
  (SELECT JSON_OBJECT('input', t.input, 'output', t.output, 'method', t.method, 'objective', t.objective,
                      'hyperparameters', t.hyperparameters, 'datasets', t.datasets, 'timestamp', t.`timestamp`,
                      'extensions', t.extensions)
     FROM transformation t WHERE t.output = mi.model_id) AS transformation,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('identity', d.`identity`, 'version', d.version, 'role', d.role,
                                    'processing', d.processing, 'license', d.license, 'extensions', d.extensions,
                                    'parent', dp.parent, 'relation', dp.relation,
                                    'disclosure_status', JSON_UNQUOTE(dp.extensions->'$.disclosure_status')))
     FROM dataset d LEFT JOIN provenance dp ON dp.id = d.provenance
    WHERE d.`identity` MEMBER OF ((SELECT t.datasets->'$[*].dataset' FROM transformation t WHERE t.output = mi.model_id))
       OR d.`identity` IN (SELECT e.dataset FROM evaluation e WHERE e.model = mi.model_id)) AS datasets,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('dataset', e.dataset, 'configuration', e.configuration, 'metric', e.metric,
                                    'score', e.score, 'timestamp', e.`timestamp`, 'extensions', e.extensions))
     FROM evaluation e WHERE e.model = mi.model_id) AS evaluation,
  (SELECT JSON_OBJECT('safety_risk', s.safety_risk, 'ethical_considerations', s.ethical_considerations,
                      'prohibited_use', s.prohibited_use, 'mitigation', s.mitigation, 'extensions', s.extensions)
     FROM safety_ethics s WHERE s.subject = mi.model_id) AS safety_ethics,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('subject', l.subject, 'license', l.license, 'usage_policy', l.usage_policy,
                                    'restrictions', l.restrictions, 'extensions', l.extensions))
     FROM license_policy l WHERE l.subject = CONCAT('model:', mi.model_id)) AS license_policy,
  (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', r.id, 'type', r.`type`, 'uri', r.uri, 'revision', r.revision,
                                    'retrieved_at', r.retrieved_at, 'hash', r.`hash`, 'extensions', r.extensions))
     FROM reference r
    WHERE r.id MEMBER OF (m.extensions->'$.evidence')
       OR r.id MEMBER OF ((SELECT p.evidence FROM provenance p WHERE p.id = m.provenance))
       OR r.uri IN (SELECT JSON_UNQUOTE(e.extensions->'$.reference') FROM evaluation e WHERE e.model = mi.model_id)
       OR r.uri IN (SELECT JSON_UNQUOTE(j.uri) FROM transformation t,
                      JSON_TABLE(t.extensions, '$.evidence[*]' COLUMNS (uri VARCHAR(1000) PATH '$')) j
                     WHERE t.output = mi.model_id)) AS reference
FROM model_info mi
LEFT JOIN model m ON m.`identity` = mi.model_id;
