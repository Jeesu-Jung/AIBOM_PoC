const assert = require("assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const sandbox = { window: {} };

vm.runInNewContext(
  fs.readFileSync(path.join(root, "data", "cyclonedx-values.js"), "utf8"),
  sandbox
);
vm.runInNewContext(
  fs.readFileSync(path.join(root, "data", "checklists.js"), "utf8"),
  sandbox
);

const registry = sandbox.window.AIBOM_CYCLONEDX_VALUES;

for (const [modelId, entry] of Object.entries(registry)) {
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
    assert(
      /^https:\/\/huggingface\.co\/datasets\//.test(url),
      `${modelId}: invalid dataset URL ${url}`
    );
  });
}

const huatuoDatasetValue = sandbox.window.AIBOM_CHECKLISTS[
  "FreedomIntelligence/HuatuoGPT-o1-8B"
].categories
  .find((category) => category.id === "model-card")
  .fields.find((field) => field.name === "datasets").value;

const scriptSource = fs.readFileSync(path.join(root, "script.js"), "utf8");
const renderSandbox = {};
const escapeHtmlSource = scriptSource.slice(
  scriptSource.indexOf("function escapeHtml"),
  scriptSource.indexOf("function toTitleCase")
);
const renderTableValueSource = scriptSource.slice(
  scriptSource.indexOf("function renderTableValue"),
  scriptSource.indexOf("function formatLegacyValue")
);
vm.runInNewContext(escapeHtmlSource + renderTableValueSource, renderSandbox);

const renderedHtml = renderSandbox.renderTableValue(huatuoDatasetValue);
for (const [name, url] of huatuoDatasetValue.datasetNames.map((name, index) => [
  name,
  huatuoDatasetValue.datasetUrls[index]
])) {
  assert(renderedHtml.includes(`>${name}</a>`), `rendered dataset name is missing: ${name}`);
  assert(renderedHtml.includes(`href="${url}"`), `rendered dataset URL is missing: ${url}`);
}
assert(renderedHtml.includes('target="_blank" rel="noreferrer noopener"'));

console.log(`PASS: ${Object.keys(registry).length} model dataset records validated.`);
console.log("PASS: HuatuoGPT dataset names and hyperlinks rendered correctly.");
