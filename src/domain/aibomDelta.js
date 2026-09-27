// Field-level diff between a model's AIBOM and its base model's AIBOM (the 8 design areas).

export const isEmptyValue = (value) => value == null || value === ""
  || (Array.isArray(value) && !value.length)
  || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

/** Base model of an AIBOM: the first `model:` parent in provenance.parent. */
export function aibomParentId(aibom) {
  const parent = (aibom?.provenance?.parent || []).find((subject) => subject.startsWith("model:"));
  return parent ? parent.slice("model:".length) : null;
}

const same = (left, right) => (isEmptyValue(left) && isEmptyValue(right)) || JSON.stringify(left) === JSON.stringify(right);

function changeType(before, after) {
  if (isEmptyValue(before)) return "added";
  if (isEmptyValue(after)) return "removed";
  return "modified";
}

function row(aspect, before, after) {
  return same(before, after) ? [] : [{ aspect, type: changeType(before, after), before, after }];
}

/** Dict-valued fields (architecture, tokenizer, ...) are compared key by key. */
function objectRows(field, before = {}, after = {}) {
  const keys = [...new Set([...Object.keys(after || {}), ...Object.keys(before || {})])];
  return keys.flatMap((key) => row(`${field}.${key}`, before?.[key], after?.[key]));
}

const descriptions = (items) => (items || []).map((item) => (item && typeof item === "object" ? item.description ?? JSON.stringify(item) : item));
const inputs = (items) => (items || []).map((item) => `${item.model} (${item.role})`);
const trDatasets = (items) => (items || []).map((item) => `${item.dataset} (${item.role})`);

function listRows(aspect, before, after) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((item) => !beforeSet.has(item));
  const removed = before.filter((item) => !afterSet.has(item));
  const rows = [];
  if (added.length) rows.push({ aspect: `${aspect} (added)`, type: "added", before: null, after: added });
  if (removed.length) rows.push({ aspect: `${aspect} (removed)`, type: "removed", before: removed, after: null });
  return rows;
}

function evaluationRows(before = [], after = []) {
  const key = (item) => `${item.configuration?.benchmark || item.dataset || "?"} · ${item.metric || "score"}`;
  const value = (item) => (item ? item.score ?? item.extensions?.score_text ?? null : null);
  const beforeMap = new Map(before.map((item) => [key(item), item]));
  const afterMap = new Map(after.map((item) => [key(item), item]));
  return [...new Set([...afterMap.keys(), ...beforeMap.keys()])]
    .flatMap((aspect) => row(aspect, value(beforeMap.get(aspect)), value(afterMap.get(aspect))));
}

export function buildAibomDeltaSections(selected, base) {
  if (!selected || !base) return [];
  const sm = selected.model || {};
  const bm = base.model || {};
  const sp = selected.provenance || {};
  const bp = base.provenance || {};
  const st = selected.transformation || {};
  const bt = base.transformation || {};
  const ss = selected.safety_ethics || {};
  const bs = base.safety_ethics || {};

  return [
    { label: "MODEL", table: "model", rows: [
      ...objectRows("architecture", bm.architecture, sm.architecture),
      ...objectRows("tokenizer", bm.tokenizer, sm.tokenizer),
      ...objectRows("modality", bm.modality, sm.modality),
      ...row("intended_use", bm.intended_use, sm.intended_use),
      ...listRows("capabilities", bm.capabilities || [], sm.capabilities || []),
      ...listRows("limitations", bm.limitations || [], sm.limitations || [])
    ]},
    { label: "PROVENANCE", table: "provenance", rows: [
      ...row("origin", bp.origin, sp.origin),
      ...row("provider", bp.provider, sp.provider),
      ...row("parent", bp.parent, sp.parent),
      ...row("relation", bp.relation, sp.relation)
    ]},
    { label: "TRANSFORMATION", table: "transformation", rows: [
      ...row("input", inputs(bt.input), inputs(st.input)),
      ...row("method", bt.method, st.method),
      ...row("objective", bt.objective, st.objective),
      ...objectRows("hyperparameters", bt.hyperparameters, st.hyperparameters),
      ...listRows("datasets", trDatasets(bt.datasets), trDatasets(st.datasets)),
      ...row("timestamp", bt.timestamp, st.timestamp)
    ]},
    { label: "DATASET", table: "dataset", rows: listRows("identity",
      (base.dataset || []).map((item) => item.identity), (selected.dataset || []).map((item) => item.identity)) },
    { label: "EVALUATION", table: "evaluation", rows: evaluationRows(base.evaluation, selected.evaluation) },
    { label: "SAFETY_ETHICS", table: "safety_ethics", rows: ["safety_risk", "ethical_considerations", "prohibited_use", "mitigation"]
      .flatMap((field) => listRows(field, descriptions(bs[field]), descriptions(ss[field]))) },
    { label: "LICENSE_POLICY", table: "license_policy", rows: [
      ...listRows("license", (base.license_policy || []).map((item) => item.license), (selected.license_policy || []).map((item) => item.license)),
      ...row("usage_policy", (base.license_policy || []).map((item) => item.usage_policy).filter(Boolean),
        (selected.license_policy || []).map((item) => item.usage_policy).filter(Boolean))
    ]}
  ].filter((section) => section.rows.length);
}
