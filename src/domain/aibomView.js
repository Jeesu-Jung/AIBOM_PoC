// Converts an AIBOM write payload (AI research draft, `PUT .../aibom` shape) into the read shape that
// AibomAreas renders, so drafts can be previewed before they are saved.

const PARENT_ROLES = new Set(["base", "merge_source"]);
const DATASET_ROLE_GROUP = { pretraining: "pretraining" };

export function aibomDraftToView(write, modelId) {
  if (!write) return null;
  const transformation = write.transformation;
  const inputs = transformation?.input || [];
  const roles = new Map();
  (transformation?.datasets || []).forEach((item) => {
    const role = DATASET_ROLE_GROUP[item.role] || "finetuning";
    roles.set(item.dataset, new Set([...(roles.get(item.dataset) || []), role]));
  });
  (write.evaluation || []).forEach((item) => {
    if (item.dataset) roles.set(item.dataset, new Set([...(roles.get(item.dataset) || []), "evaluation"]));
  });

  return {
    model: { identity: modelId, ...(write.model || {}), provenance: null },
    provenance: {
      subject: modelId ? `model:${modelId}` : null,
      ...(write.provenance || {}),
      parent: inputs.filter((item) => PARENT_ROLES.has(item.role)).map((item) => `model:${item.model}`)
    },
    transformation: transformation ? { ...transformation, output: modelId } : null,
    dataset: (write.dataset || []).map((item) => ({
      ...item,
      role: [...(roles.get(item.identity) || [])].sort(),
      provenance: item.provenance
        ? { ...item.provenance, parent: (item.provenance.parent || []).map((parent) => `dataset:${parent}`) }
        : null
    })),
    evaluation: (write.evaluation || []).map((item, index) => ({ id: index + 1, model: modelId, ...item })),
    safety_ethics: write.safety_ethics ? { subject: modelId, ...write.safety_ethics } : null,
    license_policy: (write.license_policy || []).map((item, index) => ({
      id: index + 1, subject: modelId ? `model:${modelId}` : null, ...item
    })),
    reference: (write.reference || []).map((item, index) => ({ id: index + 1, ...item }))
  };
}
