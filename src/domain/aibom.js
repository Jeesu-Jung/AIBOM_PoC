import { toTitleCase } from "../utils/format.js";

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
  const rootFamily = family.root_family || {};
  const variant = rootFamily.focus_variant || {};
  const rootSources = Array.isArray(rootFamily.sources) ? rootFamily.sources : [];
  const pretraining = rootFamily.pretraining || {};
  const postTraining = rootFamily.post_training || {};
  const architecture = rootFamily.architecture || {};
  const hfUrl = rootSources.find((source) => ["official_model_card", "huggingface_model_card"].includes(source.type))?.url || null;
  const reportUrl = rootSources.find((source) => ["paper", "technical_report", "official_blog", "official_model_card", "huggingface_model_card"].includes(source.type))?.url || null;
  const trainingDataNames = pretraining.exact_dataset_inventory || (pretraining.corpus_size_family ? [pretraining.corpus_size_family] : []);
  const evidenceRows = rootSources.map((source) => legacyRow(
    source.title ? `${toTitleCase(source.type)} | ${source.title}` : toTitleCase(source.type),
    source.url,
    source.version || source.title ? "Extracted" : "Context"
  ));

  return [
    { legacy: true, title: "Identity", rows: [
      legacyRow("Model family", family.label, "Context"),
      legacyRow("Model name", rootFamily.family_id || family.label),
      legacyRow("Model version", rootFamily.release_date, "Context"),
      legacyRow("Model description", node.subtitle),
      legacyRow("Model download location", hfUrl, hfUrl ? "Derived" : "Not disclosed"),
      legacyRow("Source repository", null),
      legacyRow("Supplier", rootFamily.developer),
      legacyRow("License", rootFamily.license)
    ]},
    { legacy: true, title: "Purpose and architecture", rows: [
      legacyRow("Primary purpose", `Root evidence for the initial ${family.label} family AIBOM extraction`, "Context"),
      legacyRow("Domain", "general-purpose multilingual language modeling", "Context"),
      legacyRow("Type of model", architecture.family),
      legacyRow("Hyperparameters", { layers: variant.layers, hidden_size: variant.hidden_size, attention_heads: variant.attention_heads, context_length: variant.context_length }, "Context"),
      legacyRow("Performance metrics", null),
      legacyRow("Decision thresholds", null),
      legacyRow("Energy consumption", null)
    ]},
    { legacy: true, title: "Training and data", rows: [
      legacyRow("Training information", [
        `Pretraining stages: ${(pretraining.stages || []).join(" -> ") || "Not disclosed"}`,
        `Post-training methods: ${(postTraining.methods || []).join(", ") || "Not disclosed"}`
      ]),
      legacyRow("Data preprocessing", pretraining.data_processing),
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
      legacyRow("Model lineage", `${node.title} -> ${rootFamily.family_id || family.label}`, "Derived"),
      legacyRow("Supporting document", reportUrl, reportUrl ? "Extracted" : "Not disclosed")
    ]},
    { legacy: true, title: "Evidence references", rows: evidenceRows }
  ];
}

/** Summary table for a family's evidence-document node (e.g. the technical report). */
export function buildDocumentSections(node, familyRegistry) {
  return buildDocumentAibomSections(node, familyRegistry[node.familyId]);
}
