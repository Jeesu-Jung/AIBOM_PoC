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

  const { buildLineageCatalog } = await vite.ssrLoadModule("/src/domain/lineage.js");
  const { buildModelChecklist } = await vite.ssrLoadModule("/src/domain/aibom.js");
  const { default: LineageBoard } = await vite.ssrLoadModule("/src/components/lineage/LineageBoard.jsx");
  const { default: AibomPanel } = await vite.ssrLoadModule("/src/components/aibom/AibomPanel.jsx");
  const sparseFamily = {
    id: "gpt-oss",
    label: "gpt-oss",
    default_node_id: "openai/gpt-oss-20b",
    document_node: { id: "document:gpt-oss", title: "gpt-oss source materials", subtitle: "Evidence source" },
    root_family: {},
    root_nodes: [{
      id: "openai/gpt-oss-20b",
      title: "openai/gpt-oss-20b",
      subtitle: "OpenAI's smaller open-weight reasoning model."
    }],
    derived_models: []
  };
  const sparseRegistry = { "gpt-oss": sparseFamily };
  const sparseLineage = buildLineageCatalog(sparseRegistry);
  const sparseNode = sparseLineage.nodeMap.get("openai/gpt-oss-20b");
  const sparseModel = {
    modelId: sparseNode.id,
    modelName: "gpt-oss-20b",
    supplier: "OpenAI",
    familyDeveloper: "OpenAI",
    modelUrl: "https://openai.com/index/introducing-gpt-oss/",
    packageUrl: "https://huggingface.co/openai/gpt-oss-20b",
    licenseReported: ["apache-2.0"],
    parameterScale: "20.91B total parameters",
    description: sparseNode.subtitle,
    details: { model: { title: sparseNode.id } }
  };
  const sparseChecklistRegistry = { [sparseNode.id]: buildModelChecklist(sparseModel) };
  const boardHtml = renderToStaticMarkup(React.createElement(LineageBoard, {
    context: sparseLineage.familyContexts[0],
    activeNodeId: sparseNode.id,
    onSelect: () => {},
    familyRegistry: sparseRegistry
  }));
  const panelHtml = renderToStaticMarkup(React.createElement(AibomPanel, {
    node: sparseNode,
    onSelect: () => {},
    familyRegistry: sparseRegistry,
    checklistRegistry: sparseChecklistRegistry,
    nodeMap: sparseLineage.nodeMap
  }));
  assert(boardHtml.includes("No example descendants added for this root yet."));
  assert(boardHtml.includes("openai/gpt-oss-20b"));
  assert(panelHtml.includes("20.91B total parameters"));
  assert(panelHtml.includes("apache-2.0"));

  const aibomPanelHtml = renderToStaticMarkup(React.createElement(AibomPanel, {
    node: sparseNode,
    onSelect: () => {},
    familyRegistry: sparseRegistry,
    checklistRegistry: sparseChecklistRegistry,
    aibomRegistry: {
      [sparseNode.id]: {
        model: { identity: sparseNode.id, architecture: { family: "MoE Transformer" }, capabilities: ["reasoning"] },
        provenance: { subject: `model:${sparseNode.id}`, provider: "OpenAI", parent: [], relation: "pretrained", evidence: [1] },
        transformation: null,
        dataset: [],
        evaluation: [{ id: 1, configuration: { benchmark: "GPQA" }, metric: "acc", score: 71.5 }],
        safety_ethics: null,
        license_policy: [{ id: 1, subject: `model:${sparseNode.id}`, license: "Apache-2.0", restrictions: [] }],
        reference: [{ id: 1, type: "model_card", uri: "https://huggingface.co/openai/gpt-oss-20b" }]
      }
    },
    nodeMap: sparseLineage.nodeMap
  }));
  ["AIBOM schema", "MoE Transformer", "GPQA", "71.5", "Apache-2.0", "https://huggingface.co/openai/gpt-oss-20b", "— (root)"]
    .forEach((text) => assert(aibomPanelHtml.includes(text), `AIBOM view is missing: ${text}`));

  const { default: DeltaComparison } = await vite.ssrLoadModule("/src/components/aibom/DeltaComparison.jsx");
  const fullLineage = buildLineageCatalog(testCatalog.familyRegistry);
  const derivedNode = fullLineage.nodeMap.get("FreedomIntelligence/HuatuoGPT-o1-8B");
  const baseId = "meta-llama/Llama-3.1-8B-Instruct";
  const deltaHtml = renderToStaticMarkup(React.createElement(DeltaComparison, {
    node: derivedNode,
    onSelect: () => {},
    nodeMap: fullLineage.nodeMap,
    aibomRegistry: {
      [baseId]: { model: { intended_use: "assistant chat" }, provenance: { parent: [] },
        evaluation: [{ configuration: { benchmark: "MedQA" }, metric: "acc", score: 58.7 }] },
      [derivedNode.id]: { model: { intended_use: "medical reasoning" }, provenance: { parent: [`model:${baseId}`] },
        evaluation: [{ configuration: { benchmark: "MedQA" }, metric: "acc", score: 72.6 }] }
    }
  }));
  ["Compared with base · AIBOM", "intended_use", "medical reasoning", "MedQA · acc", "72.6", "58.7"]
    .forEach((text) => assert(deltaHtml.includes(text), `AIBOM delta is missing: ${text}`));

  console.log("PASS: React renders query-selected and sparse single-model AIBOM views.");
} finally {
  await vite.close();
}
