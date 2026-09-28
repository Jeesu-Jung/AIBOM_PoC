import Value from "../common/Value.jsx";

// Renders the 8 AIBOM areas (AIBOM_스키마_설계안.md): one section per table, one row per field.

const isEmpty = (value) => value == null || value === "" || (Array.isArray(value) && !value.length)
  || (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length);

function describe(value) {
  if (isEmpty(value)) return "—";
  if (Array.isArray(value)) {
    return value.map((item) => (item && typeof item === "object" && !Array.isArray(item)
      ? item.description ?? Object.entries(item).filter(([, v]) => !isEmpty(v)).map(([k, v]) => `${k}: ${describe(v)}`).join(" · ")
      : describe(item)));
  }
  if (typeof value === "object") {
    return Object.entries(value).filter(([, v]) => !isEmpty(v)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : v}`);
  }
  return value;
}

function FieldTable({ title, table, rows }) {
  return (
    <section className="aibom-section aibom-area">
      <h4>{title} <code className="aibom-area-table">{table}</code></h4>
      <div className="aibom-table-wrap">
        <table className="aibom-table aibom-area-fields">
          <thead><tr><th scope="col">Field (column)</th><th scope="col">Value</th></tr></thead>
          <tbody>{rows.map(([field, value]) => (
            <tr key={field} className={isEmpty(value) ? "is-empty" : ""}>
              <th scope="row"><code>{field}</code></th>
              <td><Value value={describe(value)} /></td>
            </tr>
          ))}</tbody>
        </table>
      </div>
    </section>
  );
}

function ListTable({ title, table, columns, items, empty }) {
  return (
    <section className="aibom-section aibom-area">
      <h4>{title} <code className="aibom-area-table">{table}</code> <span className="aibom-area-count">{items.length}</span></h4>
      {items.length ? (
        <div className="aibom-table-wrap">
          <table className="aibom-table aibom-area-list">
            <thead><tr>{columns.map(([key, label]) => <th scope="col" key={key}>{label}</th>)}</tr></thead>
            <tbody>{items.map((item, index) => (
              <tr key={item.id ?? item.identity ?? index}>
                {columns.map(([key, , render]) => <td key={key}><Value value={describe(render ? render(item) : item[key])} /></td>)}
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="section-note">{empty}</p>}
    </section>
  );
}

const score = (item) => {
  const baseline = item.extensions?.baseline_score;
  const text = item.score ?? item.extensions?.score_text;
  return baseline == null ? text : `${text} (baseline ${baseline})`;
};

export default function AibomAreas({ aibom }) {
  const model = aibom.model || {};
  const provenance = aibom.provenance || {};
  const transformation = aibom.transformation;
  const safety = aibom.safety_ethics || {};
  const referenceById = new Map((aibom.reference || []).map((ref) => [ref.id, ref.uri]));

  return (
    <div className="aibom-section-stack">
      <FieldTable title="MODEL" table="model" rows={[
        ["identity", model.identity], ["architecture", model.architecture], ["tokenizer", model.tokenizer],
        ["modality", model.modality], ["intended_use", model.intended_use], ["capabilities", model.capabilities],
        ["limitations", model.limitations], ["provenance", model.provenance ? `→ provenance #${model.provenance}` : null]
      ]} />
      <FieldTable title="PROVENANCE" table="provenance" rows={[
        ["subject", provenance.subject], ["origin", provenance.origin], ["provider", provenance.provider],
        ["parent", isEmpty(provenance.parent) ? "— (root)" : provenance.parent], ["relation", provenance.relation],
        ["evidence", (provenance.evidence || []).map((id) => (typeof id === "string" ? id : referenceById.get(id) || `#${id}`))],
        ["disclosure_status", provenance.extensions?.disclosure_status]
      ]} />
      {transformation ? <FieldTable title="TRANSFORMATION" table="transformation" rows={[
        ["input", (transformation.input || []).map((item) => `${item.model} (${item.role}${item.external ? ", external" : ""})`)],
        ["output", transformation.output], ["method", (transformation.method || []).join(" → ")],
        ["objective", transformation.objective], ["hyperparameters", transformation.hyperparameters],
        ["datasets", (transformation.datasets || []).map((item) => `${item.dataset} (${item.role})`)],
        ["timestamp", transformation.timestamp]
      ]} /> : <FieldTable title="TRANSFORMATION" table="transformation" rows={[["method", null]]} />}
      <ListTable title="DATASET" table="dataset" items={aibom.dataset || []} empty="연결된 학습·평가 데이터셋이 없습니다." columns={[
        ["identity", "identity", (item) => item.extensions?.uri ? `${item.extensions?.name || item.identity} — ${item.extensions.uri}` : item.extensions?.name || item.identity],
        ["version", "version"], ["role", "role"], ["license", "license"], ["processing", "processing"],
        ["provenance", "provenance", (item) => [item.provenance?.relation, ...(item.provenance?.parent || []), item.provenance?.extensions?.disclosure_status].filter(Boolean)]
      ]} />
      <ListTable title="EVALUATION" table="evaluation" items={aibom.evaluation || []} empty="이 모델 자체의 평가 결과가 보고되지 않았습니다." columns={[
        ["configuration", "configuration", (item) => item.configuration?.benchmark || item.configuration],
        ["dataset", "dataset"], ["metric", "metric"], ["score", "score", score], ["timestamp", "timestamp"],
        ["source", "source", (item) => item.extensions?.reference]
      ]} />
      <FieldTable title="SAFETY_ETHICS" table="safety_ethics" rows={[
        ["subject", safety.subject], ["safety_risk", safety.safety_risk], ["ethical_considerations", safety.ethical_considerations],
        ["prohibited_use", safety.prohibited_use], ["mitigation", safety.mitigation]
      ]} />
      <ListTable title="LICENSE_POLICY" table="license_policy" items={aibom.license_policy || []} empty="라이선스 정보가 없습니다." columns={[
        ["subject", "subject"], ["license", "license"], ["usage_policy", "usage_policy"], ["restrictions", "restrictions"]
      ]} />
      <ListTable title="REFERENCE" table="reference" items={aibom.reference || []} empty="연결된 근거 자료가 없습니다." columns={[
        ["type", "type"], ["uri", "uri"], ["revision", "revision"], ["retrieved_at", "retrieved_at"],
        ["hash", "hash", (item) => item.hash ? `${item.hash.slice(0, 12)}…` : null]
      ]} />
    </div>
  );
}
