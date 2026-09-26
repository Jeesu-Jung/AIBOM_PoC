-- MySQL 8.0.17+
-- Per-model read views over the AIBOM area tables (sql/004_aibom_extended_schema.sql).
--   v_model_lineage     one row per model: provenance + transformation input / datasets
--   v_model_evaluation  one row per evaluation result, with baseline delta and source
--   v_model_aibom       one row per model: each of the 8 areas as one JSON column
USE aibom;

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
