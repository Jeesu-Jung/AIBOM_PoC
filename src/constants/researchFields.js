// Catalog (model_info) fields an AI research draft carries, with their labels.
export const mergeFields = [
  ["modelId", "Model ID"], ["namespace", "Namespace"], ["modelName", "Model name"], ["familyKey", "Family key"],
  ["familyName", "Family name"], ["modelRole", "Role"], ["supplier", "Supplier"], ["primaryPurpose", "Primary purpose"],
  ["modelVersion", "Model version"], ["packageUrl", "Package URL"], ["modelUrl", "Model URL"], ["description", "Description"]
];
// Catalog columns filled from the AIBOM draft instead of being researched separately.
export const aibomDerivedFields = ["licenseReported", "artifactFormat", "tensorType", "parameterScale", "artifactRevision", "releaseDate"];
// Fields listed for each result in the research history.
export const historyFields = [...mergeFields, ["releaseDate", "Release date (AIBOM)"], ["licenseReported", "License reported (AIBOM)"], ["artifactFormat", "Artifact format (AIBOM)"],
  ["tensorType", "Tensor type (AIBOM)"], ["parameterScale", "Parameter scale (AIBOM)"]];
