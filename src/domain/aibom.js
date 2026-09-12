import { toTitleCase } from "../utils/format.js";

export function isMissingChecklistValue(value) {
  return value == null || value === "" || value === "Not found" || (Array.isArray(value) && !value.length);
}

function checklistValuesEqual(left, right) {
  if (isMissingChecklistValue(left) && isMissingChecklistValue(right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

export function buildDeltaComparisonSections(node, checklistRegistry) {
  const parentId = node.parent_model || node.parent;
  const baseChecklist = checklistRegistry[parentId];
  const selectedChecklist = checklistRegistry[node.id];
  if (!baseChecklist || !selectedChecklist) return [];

  const baseCategories = new Map(baseChecklist.categories.map((category) => [category.id, category]));
  const selectedCategories = new Map(selectedChecklist.categories.map((category) => [category.id, category]));
  const categoryIds = [
    ...selectedChecklist.categories.map((category) => category.id),
    ...baseChecklist.categories.map((category) => category.id).filter((id) => !selectedCategories.has(id))
  ];

  return categoryIds.map((categoryId) => {
    const baseCategory = baseCategories.get(categoryId);
    const selectedCategory = selectedCategories.get(categoryId);
    const baseFields = new Map((baseCategory?.fields || []).map((field) => [field.name, field]));
    const selectedFields = new Map((selectedCategory?.fields || []).map((field) => [field.name, field]));
    const fieldNames = [
      ...(selectedCategory?.fields || []).map((field) => field.name),
      ...(baseCategory?.fields || []).map((field) => field.name).filter((name) => !selectedFields.has(name))
    ];
    const rows = fieldNames.flatMap((fieldName) => {
      if (categoryId === "required" && fieldName === "serialNumber") return [];
      const before = baseFields.get(fieldName)?.value;
      const after = selectedFields.get(fieldName)?.value;
      if (checklistValuesEqual(before, after)) return [];
      return [{
        aspect: fieldName,
        type: isMissingChecklistValue(before) ? "added" : isMissingChecklistValue(after) ? "removed" : "modified",
        before,
        after
      }];
    });
    return { label: selectedCategory?.label || baseCategory?.label || toTitleCase(categoryId), rows };
  }).filter((section) => section.rows.length);
}

function formatLegacyValue(value) {
  if (value == null || value === "") return "Not disclosed";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not disclosed";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${toTitleCase(key)}: ${Array.isArray(item) ? item.join(", ") : item}`)
      .join(" | ");
  }
  return String(value);
}

function legacyRow(field, value, status = "Extracted") {
  return {
    field,
    value: formatLegacyValue(value),
    status: value == null || value === "" || (Array.isArray(value) && !value.length) ? "Not disclosed" : status
  };
}

function buildDocumentAibomSections(node, family) {
  const variant = family.root_family.focus_variant;
  const rootSources = family.root_family.sources;
  const hfUrl = rootSources.find((source) => ["official_model_card", "huggingface_model_card"].includes(source.type))?.url || null;
  const reportUrl = rootSources.find((source) => ["paper", "technical_report", "official_blog", "official_model_card", "huggingface_model_card"].includes(source.type))?.url || null;
  const trainingDataNames = family.root_family.pretraining.exact_dataset_inventory || [family.root_family.pretraining.corpus_size_family];
  const evidenceRows = rootSources.map((source) => legacyRow(
    source.title ? `${toTitleCase(source.type)} | ${source.title}` : toTitleCase(source.type),
    source.url,
    source.version || source.title ? "Extracted" : "Context"
  ));

  return [
    { legacy: true, title: "Identity", rows: [
      legacyRow("Model family", family.label, "Context"),
      legacyRow("Model name", family.root_family.family_id),
      legacyRow("Model version", family.root_family.release_date, "Context"),
      legacyRow("Model description", node.subtitle),
      legacyRow("Model download location", hfUrl, hfUrl ? "Derived" : "Not disclosed"),
      legacyRow("Source repository", null),
      legacyRow("Supplier", family.root_family.developer),
      legacyRow("License", family.root_family.license)
    ]},
    { legacy: true, title: "Purpose and architecture", rows: [
      legacyRow("Primary purpose", `Root evidence for the initial ${family.label} family AIBOM extraction`, "Context"),
      legacyRow("Domain", "general-purpose multilingual language modeling", "Context"),
      legacyRow("Type of model", family.root_family.architecture.family),
      legacyRow("Hyperparameters", { layers: variant.layers, hidden_size: variant.hidden_size, attention_heads: variant.attention_heads, context_length: variant.context_length }, "Context"),
      legacyRow("Performance metrics", null),
      legacyRow("Decision thresholds", null),
      legacyRow("Energy consumption", null)
    ]},
    { legacy: true, title: "Training and data", rows: [
      legacyRow("Training information", [
        `Pretraining stages: ${family.root_family.pretraining.stages.join(" -> ")}`,
        `Post-training methods: ${family.root_family.post_training.methods.join(", ")}`
      ]),
      legacyRow("Data preprocessing", family.root_family.pretraining.data_processing),
      legacyRow("Sensitive data usage", "Not disclosed in the root evidence", "Context"),
      legacyRow("Training datasets", trainingDataNames),
      legacyRow("Test datasets", null)
    ]},
    { legacy: true, title: "Risk and operations", rows: [
      legacyRow("Explainability information", null),
      legacyRow("Known limitations", null),
      legacyRow("Safety risk assessment", [
        "Safety and alignment behavior is only partially disclosed in the root evidence.",
        "Downstream models may add their own safety or refusal tuning."
      ]),
      legacyRow("Runtime dependencies", null),
      legacyRow("Model lineage", `${node.title} -> ${family.root_family.family_id}`, "Derived"),
      legacyRow("Supporting document", reportUrl, reportUrl ? "Extracted" : "Not disclosed")
    ]},
    { legacy: true, title: "Evidence references", rows: evidenceRows }
  ];
}

export function buildAibomSections(node, checklistRegistry, familyRegistry) {
  const checklist = checklistRegistry[node.id];
  if (!checklist) return buildDocumentAibomSections(node, familyRegistry[node.familyId]);
  return checklist.categories.map((category) => ({
    title: category.label,
    summary: `${category.present}/${category.total} present · ${category.score}/${category.maxScore} points`,
    note: category.displayNote,
    rows: category.fields
  }));
}
