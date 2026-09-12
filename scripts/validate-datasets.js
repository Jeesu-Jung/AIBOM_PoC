import assert from "node:assert";
import { checklistRegistry } from "../src/data/checklists.js";
import { cycloneDxRegistry } from "../src/data/cyclonedxValues.js";

for (const [modelId, entry] of Object.entries(cycloneDxRegistry)) {
  const modelCard = entry.categories["model-card"];
  assert(!Object.hasOwn(modelCard, "datasets"), `${modelId}: legacy datasets field remains`);
  assert(Object.hasOwn(modelCard, "datasetNames"), `${modelId}: datasetNames is missing`);
  assert(Object.hasOwn(modelCard, "datasetUrls"), `${modelId}: datasetUrls is missing`);

  if (modelCard.datasetNames === null || modelCard.datasetUrls === null) {
    assert.strictEqual(modelCard.datasetNames, null, `${modelId}: datasetNames must be null`);
    assert.strictEqual(modelCard.datasetUrls, null, `${modelId}: datasetUrls must be null`);
    continue;
  }

  assert(Array.isArray(modelCard.datasetNames), `${modelId}: datasetNames must be an array`);
  assert(Array.isArray(modelCard.datasetUrls), `${modelId}: datasetUrls must be an array`);
  assert.strictEqual(
    modelCard.datasetNames.length,
    modelCard.datasetUrls.length,
    `${modelId}: dataset name and URL counts differ`
  );
  modelCard.datasetUrls.forEach((url) => {
    assert(/^https:\/\/huggingface\.co\/datasets\//.test(url), `${modelId}: invalid dataset URL ${url}`);
  });
}

const huatuoDatasetValue = checklistRegistry["FreedomIntelligence/HuatuoGPT-o1-8B"]
  .categories.find((category) => category.id === "model-card")
  .fields.find((field) => field.name === "datasets").value;

huatuoDatasetValue.datasetNames.forEach((name, index) => {
  assert(name, "dataset name is missing");
  assert(huatuoDatasetValue.datasetUrls[index], `dataset URL is missing for ${name}`);
});

console.log(`PASS: ${Object.keys(cycloneDxRegistry).length} model dataset records validated.`);
console.log("PASS: HuatuoGPT dataset names and URLs are paired correctly.");
