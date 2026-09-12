/* Generates sql/002_import_families.sql from src/data/families.js. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { familyRegistry as families } from "../src/data/families.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const q = (value) => value == null ? "NULL" : `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
const j = (value) => value === undefined ? "NULL" : q(JSON.stringify(value));
const rows = [];
let nextEntity = 1, nextRelation = 1, nextEvidence = 1, nextAssertion = 1;
const entityIds = new Map();
const familyIds = new Map();

const addEntity = (key, type, title, subtitle, attributes) => {
  if (entityIds.has(key)) return entityIds.get(key);
  const id = nextEntity++;
  entityIds.set(key, id);
  rows.push(`INSERT INTO aibom_entity (entity_id, entity_key, entity_type, title, subtitle, attributes) VALUES (${id}, ${q(key)}, ${q(type)}, ${q(title)}, ${q(subtitle)}, ${j(attributes)});`);
  return id;
};

rows.push("-- Generated from src/data/families.js. Re-run: node scripts/export-families-to-sql.js");
rows.push("-- Import into empty tables created by 001_aibom_schema.sql.");
rows.push("USE aibom;", "SET NAMES utf8mb4;", "SET FOREIGN_KEY_CHECKS = 1;", "START TRANSACTION;");

let familyNo = 0;
for (const family of Object.values(families)) {
  const familyId = ++familyNo;
  familyIds.set(family.id, familyId);
  const rf = family.root_family;
  rows.push(`INSERT INTO aibom_family (family_id, family_key, label, default_model_key, developer, release_date, license_name, family_metadata) VALUES (${familyId}, ${q(family.id)}, ${q(family.label)}, ${q(family.default_node_id)}, ${q(rf.developer)}, ${q(rf.release_date)}, ${q(rf.license)}, ${j(rf)});`);

  const doc = family.document_node;
  const docId = addEntity(doc.id, "DOCUMENT", doc.title, doc.subtitle, doc);
  rows.push(`INSERT INTO family_entity VALUES (${familyId}, ${docId}, 'DOCUMENT_ROOT', 0);`);

  family.root_nodes.forEach((node, index) => {
    const id = addEntity(node.id, "MODEL", node.title, node.subtitle, node);
    const kind = /instruct/i.test(node.id) ? "INSTRUCT" : "BASE";
    rows.push(`INSERT INTO model (entity_id, model_kind) VALUES (${id}, ${q(kind)});`);
    rows.push(`INSERT INTO family_entity VALUES (${familyId}, ${id}, 'ROOT_MODEL', ${index});`);
  });

  family.derived_models.forEach((item, index) => {
    const modelId = addEntity(item.model_id, "MODEL", item.model_id, null, item);
    rows.push(`INSERT INTO model (entity_id, model_kind, supplier, license_reported) VALUES (${modelId}, 'DERIVED', ${q(item.supplier)}, ${j(item.license_reported)});`);
    rows.push(`INSERT INTO family_entity VALUES (${familyId}, ${modelId}, 'DERIVED_MODEL', ${index});`);

    const parentId = entityIds.get(item.parent_model);
    if (!parentId) throw new Error(`Parent must be declared first: ${item.parent_model}`);
    const transformKey = `transformation:${family.id}:${item.model_id}`;
    const transformId = addEntity(transformKey, "TRANSFORMATION", `${item.relationship}: ${item.model_id}`, null, item.delta);
    rows.push(`INSERT INTO transformation (entity_id, input_model_entity_id, output_model_entity_id, method_type, transformation_metadata) VALUES (${transformId}, ${parentId}, ${modelId}, ${q(item.relationship)}, ${j(item.delta)});`);
    rows.push(`INSERT INTO family_entity VALUES (${familyId}, ${transformId}, 'RELATED', ${index});`);

    const relationId = nextRelation++;
    rows.push(`INSERT INTO entity_relation (relation_id, source_entity_id, target_entity_id, relation_type, transformation_entity_id) VALUES (${relationId}, ${parentId}, ${modelId}, ${q(item.relationship)}, ${transformId});`);
    rows.push(`INSERT INTO model_primary_parent (child_model_entity_id, parent_model_entity_id, relation_id, sibling_order) VALUES (${modelId}, ${parentId}, ${relationId}, ${index});`);

    if (item.artifact) {
      const artifactKey = `artifact:${item.model_id}:reported`;
      const artifactId = addEntity(artifactKey, "ARTIFACT", `${item.model_id} reported artifact`, null, item.artifact);
      rows.push(`INSERT INTO artifact (entity_id, model_entity_id, format_name, tensor_type, parameter_scale, revision_id, artifact_metadata) VALUES (${artifactId}, ${modelId}, ${q(item.artifact.format || item.artifact.type)}, ${q(item.artifact.tensor_type || item.artifact.dtype)}, ${q(item.artifact.parameter_scale)}, ${q(item.artifact.revision)}, ${j(item.artifact)});`);
      rows.push(`INSERT INTO family_entity VALUES (${familyId}, ${artifactId}, 'RELATED', ${index});`);
      rows.push(`INSERT INTO entity_relation (relation_id, source_entity_id, target_entity_id, relation_type) VALUES (${nextRelation++}, ${modelId}, ${artifactId}, 'HAS_ARTIFACT');`);
    }

    const trainingData = item.delta && item.delta.added_training_data;
    if (Array.isArray(trainingData)) trainingData.forEach((data, dataIndex) => {
      const dataObject = typeof data === "string" ? { name: data } : data;
      const datasetKey = `dataset:${family.id}:${item.model_id}:${dataIndex}`;
      const datasetId = addEntity(datasetKey, "DATASET", dataObject.name || datasetKey, null, dataObject);
      rows.push(`INSERT INTO dataset (entity_id, dataset_name, dataset_role, disclosure_status, dataset_metadata) VALUES (${datasetId}, ${q(dataObject.name || datasetKey)}, ${q(dataObject.role)}, 'PARTIAL', ${j(dataObject)});`);
      rows.push(`INSERT INTO family_entity VALUES (${familyId}, ${datasetId}, 'RELATED', ${dataIndex});`);
      rows.push(`INSERT INTO entity_relation (relation_id, source_entity_id, target_entity_id, relation_type, transformation_entity_id) VALUES (${nextRelation++}, ${transformId}, ${datasetId}, 'USED_DATASET', ${transformId});`);
    });

    const assertionIds = [];
    for (const [name, value] of Object.entries(item.delta || {})) {
      let status = "ADDED";
      if (/^retained/.test(name)) status = "INHERITED";
      else if (/^modified/.test(name)) status = "MODIFIED";
      else if (/^(removed|removed_or_out_of_scope)/.test(name)) status = "REMOVED";
      else if (/^unknown/.test(name)) status = "UNKNOWN";
      const assertionId = nextAssertion++;
      assertionIds.push(assertionId);
      rows.push(`INSERT INTO assertion (assertion_id, subject_entity_id, predicate, value_json, assertion_type, inheritance_status) VALUES (${assertionId}, ${modelId}, ${q(`delta.${name}`)}, ${j(value)}, 'PUBLISHER_CLAIMED', ${q(status)});`);
    }

    (item.sources || []).forEach((source) => {
      const evidenceId = nextEvidence++;
      rows.push(`INSERT INTO evidence (evidence_id, source_type, title, source_uri, source_revision, evidence_metadata) VALUES (${evidenceId}, ${q(source.type)}, ${q(source.title)}, ${q(source.url)}, ${q(source.version)}, ${j(source)});`);
      rows.push(`INSERT INTO entity_evidence VALUES (${modelId}, ${evidenceId}, 'DESCRIBES');`);
      assertionIds.forEach((assertionId) => rows.push(`INSERT INTO assertion_evidence VALUES (${assertionId}, ${evidenceId}, 'SUPPORTS');`));
    });
  });

  (rf.sources || []).forEach((source) => {
    const evidenceId = nextEvidence++;
    rows.push(`INSERT INTO evidence (evidence_id, source_type, title, source_uri, source_revision, evidence_metadata) VALUES (${evidenceId}, ${q(source.type)}, ${q(source.title)}, ${q(source.url)}, ${q(source.version)}, ${j(source)});`);
    rows.push(`INSERT INTO entity_evidence VALUES (${docId}, ${evidenceId}, 'DESCRIBES');`);
  });
}

rows.push("CALL sp_rebuild_model_lineage_closure();", "COMMIT;", "");
fs.writeFileSync(path.join(root, "sql", "002_import_families.sql"), rows.join("\n"), "utf8");
console.log(`Generated ${rows.length} statements, ${nextEntity - 1} entities, ${nextAssertion - 1} assertions.`);
