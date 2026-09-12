import assert from "node:assert";
import path from "node:path";
import { fileURLToPath } from "node:url";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";
import { checklistRegistry } from "../src/data/checklists.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
globalThis.window = { location: new URL("http://localhost/") };

const vite = await createServer({
  root,
  server: { middlewareMode: true },
  appType: "custom"
});

try {
  window.location = new URL("http://localhost/?node=meta-llama%2FLlama-3.1-8B-Instruct");
  const { default: App } = await vite.ssrLoadModule("/src/App.jsx");
  const defaultHtml = renderToStaticMarkup(React.createElement(App));
  assert(defaultHtml.includes("Foundation-model lineage explorer"));
  assert(defaultHtml.includes("meta-llama/Llama-3.1-8B-Instruct"));
  assert(defaultHtml.includes('id="family-select"'));
  assert(defaultHtml.includes('id="full-aibom-panel"'));

  window.location = new URL("http://localhost/?node=FreedomIntelligence%2FHuatuoGPT-o1-8B");
  const datasetHtml = renderToStaticMarkup(React.createElement(App));
  const datasetValue = checklistRegistry["FreedomIntelligence/HuatuoGPT-o1-8B"]
    .categories.find((category) => category.id === "model-card")
    .fields.find((field) => field.name === "datasets").value;
  datasetValue.datasetNames.forEach((name) => assert(datasetHtml.includes(name)));
  datasetValue.datasetUrls.forEach((url) => assert(datasetHtml.includes(url)));

  console.log("PASS: React renders the default and query-selected AIBOM views.");
} finally {
  await vite.close();
}
