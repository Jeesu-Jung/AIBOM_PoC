import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = { location: new URL("http://localhost/") };

const field = (name, value) => ({
  name, value, present: true, actualLocation: "test", tier: "Critical", type: "CDX"
});
const checklist = (modelId, datasetName) => ({
  modelId,
  categories: [{
    id: "model-card",
    label: "Component Model Card",
    present: 1,
    total: 1,
    score: 30,
    maxScore: 30,
    fields: [field("datasets", { datasetNames: [datasetName], datasetUrls: [`https://example.test/${datasetName}`] })]
  }]
});
const testCatalog = {
  familyRegistry: {
    llama31: {
      id: "llama31",
      label: "Llama 3.1",
      default_node_id: "meta-llama/Llama-3.1-8B-Instruct",
      document_node: { id: "document:llama", title: "Llama report", subtitle: "Evidence root" },
      root_family: {
        family_id: "meta-llama/Llama-3.1",
        release_date: "2024-07-23",
        developer: "Meta",
        license: "Llama license",
        model_variants: ["8B", "8B Instruct"],
        architecture: { family: "Transformer" },
        focus_variant: { label: "8B slice", layers: 32, hidden_size: 4096, attention_heads: 32, context_length: 131072 },
        pretraining: { stages: [], data_processing: [], exact_dataset_inventory: null, corpus_size_family: "15T" },
        post_training: { methods: [] },
        sources: []
      },
      root_nodes: [{ id: "meta-llama/Llama-3.1-8B-Instruct", title: "meta-llama/Llama-3.1-8B-Instruct", subtitle: "Root model" }],
      derived_models: [{
        model_id: "FreedomIntelligence/HuatuoGPT-o1-8B",
        parent_model: "meta-llama/Llama-3.1-8B-Instruct",
        relationship: "domainFineTunedAndReinforcementOptimizedFrom",
        delta: { added_domain: "medicine" },
        sources: []
      }]
    }
  },
  checklistRegistry: {
    "meta-llama/Llama-3.1-8B-Instruct": checklist("meta-llama/Llama-3.1-8B-Instruct", "base-dataset"),
    "FreedomIntelligence/HuatuoGPT-o1-8B": checklist("FreedomIntelligence/HuatuoGPT-o1-8B", "medical-dataset")
  }
};

const vite = await createServer({
  root,
  server: { middlewareMode: true },
  appType: "custom"
});

try {
  window.location = new URL("http://localhost/?node=meta-llama%2FLlama-3.1-8B-Instruct");
  const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
  const defaultHtml = renderToStaticMarkup(React.createElement(App, { initialCatalog: testCatalog }));
  assert(defaultHtml.includes("Foundation-model lineage explorer"));
  assert(defaultHtml.includes("meta-llama/Llama-3.1-8B-Instruct"));
  assert(defaultHtml.includes('id="family-select"'));
  assert(defaultHtml.includes('id="full-aibom-panel"'));

  window.location = new URL("http://localhost/?node=FreedomIntelligence%2FHuatuoGPT-o1-8B");
  const datasetHtml = renderToStaticMarkup(React.createElement(App, { initialCatalog: testCatalog }));
  const datasetValue = testCatalog.checklistRegistry["FreedomIntelligence/HuatuoGPT-o1-8B"]
    .categories.find((category) => category.id === "model-card")
    .fields.find((field) => field.name === "datasets").value;
  datasetValue.datasetNames.forEach((name) => assert(datasetHtml.includes(name)));
  datasetValue.datasetUrls.forEach((url) => assert(datasetHtml.includes(url)));

  console.log("PASS: React renders the default and query-selected AIBOM views.");
} finally {
  await vite.close();
}
