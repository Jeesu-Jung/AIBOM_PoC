// Catalog (model_info) fields an AI research draft carries, with their labels.
export const mergeFields = [
  ["modelId", "Model ID"], ["namespace", "Namespace"], ["modelName", "Model name"], ["familyKey", "Family key"],
  ["familyName", "Family name"], ["modelRole", "Role"], ["supplier", "Supplier"], ["familyDeveloper", "Family developer"],
  ["familyReleaseDate", "Family release date"], ["familyLicenseName", "Family license"], ["primaryPurpose", "Primary purpose"],
  ["modelVersion", "Model version"], ["packageUrl", "Package URL"], ["modelUrl", "Model URL"], ["description", "Description"]
];
// Catalog columns filled from the AIBOM draft instead of being researched separately.
export const aibomDerivedFields = ["licenseReported", "artifactFormat", "tensorType", "parameterScale", "artifactRevision"];
// Fields listed for each result in the research history.
export const historyFields = [...mergeFields, ["licenseReported", "License reported (AIBOM)"], ["artifactFormat", "Artifact format (AIBOM)"],
  ["tensorType", "Tensor type (AIBOM)"], ["parameterScale", "Parameter scale (AIBOM)"]];
