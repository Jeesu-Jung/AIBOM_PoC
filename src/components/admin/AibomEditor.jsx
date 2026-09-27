import { useCallback, useEffect, useState } from "react";
import { fetchAdminAibomOptions, fetchAdminModelAibom, saveAdminModelAibom } from "../../api/admin.js";

// Edits one model's AIBOM (the 8 areas of AIBOM_스키마_설계안.md) as JSON per area.
// PUT /api/v1/admin/models/{id}/aibom replaces the model-owned rows; `dataset` / `reference`
// entries are upserted shared rows, so they start empty and are only filled to add new ones.

const AREAS = [
  ["model", "MODEL", "architecture, tokenizer, modality, intended_use, capabilities, limitations, extensions"],
  ["provenance", "PROVENANCE", "origin, provider, relation, evidence (reference id 또는 URI), extensions — parent는 transformation.input에서 자동 계산"],
  ["transformation", "TRANSFORMATION", "input [{model, role}], method [...], objective, hyperparameters, datasets [{dataset, role}], timestamp — 없으면 null"],
  ["evaluation", "EVALUATION", "[{dataset, configuration: {benchmark}, metric, score, timestamp, extensions}]"],
  ["safety_ethics", "SAFETY_ETHICS", "safety_risk, ethical_considerations, prohibited_use, mitigation — 각 [{description, reference}], 없으면 null"],
  ["license_policy", "LICENSE_POLICY", "[{license, usage_policy, restrictions, extensions}]"],
  ["dataset", "DATASET (추가·수정)", "[{identity, version, processing, license, extensions}] — 새 데이터셋을 참조할 때만 입력"],
  ["reference", "REFERENCE (추가·수정)", "[{type, uri, revision, extensions: {title}}] — 새 근거 자료를 등록할 때만 입력"]
];

const omit = (value, keys) => value && Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));

export function toEditable(aibom) {
  const source = aibom || {};
  const transformation = source.transformation;
  return {
    model: omit(source.model, ["identity", "provenance"]) || {},
    provenance: omit(source.provenance, ["id", "subject", "parent"]) || {},
    transformation: transformation ? {
      ...omit(transformation, ["id", "output"]),
      input: (transformation.input || []).map((item) => omit(item, ["external"]))
    } : null,
    evaluation: (source.evaluation || []).map((item) => omit(item, ["id", "model"])),
    safety_ethics: omit(source.safety_ethics, ["subject"]) || null,
    license_policy: (source.license_policy || []).map((item) => omit(item, ["id", "subject"])),
    dataset: [],
    reference: []
  };
}

const toTexts = (editable) => Object.fromEntries(AREAS.map(([key]) => [key, JSON.stringify(editable[key], null, 2)]));

export default function AibomEditor({ modelId, refreshKey, onNotice }) {
  const [texts, setTexts] = useState(null);
  const [options, setOptions] = useState(null);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(() => {
    setLoadError(null);
    return Promise.all([fetchAdminModelAibom(modelId), fetchAdminAibomOptions()])
      .then(([aibom, opts]) => { setTexts(toTexts(toEditable(aibom))); setOptions(opts); })
      .catch((error) => setLoadError(error.message));
  }, [modelId]);

  useEffect(() => { setTexts(null); load(); }, [load, refreshKey]);

  async function save(event) {
    event.preventDefault();
    let payload;
    try {
      payload = Object.fromEntries(AREAS.map(([key, label]) => {
        try { return [key, JSON.parse(texts[key] || "null")]; } catch { throw new Error(`${label} JSON 형식이 올바르지 않습니다.`); }
      }));
    } catch (error) { onNotice({ type: "error", text: error.message }); return; }
    ["dataset", "reference", "evaluation", "license_policy"].forEach((key) => { if (payload[key] == null) payload[key] = []; });
    ["model", "provenance"].forEach((key) => { if (payload[key] == null) payload[key] = {}; });
    setSaving(true);
    try {
      const saved = await saveAdminModelAibom(modelId, payload);
      setTexts(toTexts(toEditable(saved)));
      setOptions(await fetchAdminAibomOptions());
      onNotice({ type: "success", text: "AIBOM이 저장되었습니다." });
    } catch (error) {
      onNotice({ type: "error", text: error.message });
    } finally { setSaving(false); }
  }

  if (loadError) return <p className="admin-help">AIBOM을 불러오지 못했습니다: {loadError}</p>;
  if (!texts) return <p className="admin-help">AIBOM을 불러오는 중입니다...</p>;

  return (
    <form className="aibom-editor" onSubmit={save}>
      <fieldset>
        <legend>AIBOM (설계안 8개 영역)</legend>
        <p className="admin-help">영역마다 JSON으로 편집합니다. 저장하면 이 모델의 AIBOM 행 전체를 교체합니다. 카탈로그의 부모를 바꾸면 provenance.parent와 transformation.input의 base가 자동으로 맞춰집니다.</p>
        <div className="admin-form-grid">
          {AREAS.map(([key, label, hint]) => (
            <label className="admin-field admin-field-wide" key={key}>
              <span>{label} <code>{key}</code></span>
              <small className="aibom-editor-hint">{hint}</small>
              <textarea className="code-input" rows={key === "evaluation" ? 12 : 6} value={texts[key]}
                onChange={(event) => setTexts({ ...texts, [key]: event.target.value })} />
            </label>
          ))}
        </div>
        {options && (
          <details className="aibom-editor-options">
            <summary>참조 가능한 dataset {options.datasets.length}개 · reference {options.references.length}개</summary>
            <div className="aibom-editor-option-lists">
              <ul>{options.datasets.map((item) => <li key={item.identity}><code>{item.identity}</code> {item.name !== item.identity && item.name}</li>)}</ul>
              <ul>{options.references.map((item) => <li key={item.id}><code>#{item.id}</code> {item.type} · {item.title || item.uri}</li>)}</ul>
            </div>
          </details>
        )}
      </fieldset>
      <div className="admin-form-actions">
        <span />
        <button type="button" className="admin-secondary" onClick={load} disabled={saving}>AIBOM 다시 불러오기</button>
        <button type="submit" className="admin-primary" disabled={saving}>{saving ? "저장 중..." : "AIBOM 저장"}</button>
      </div>
    </form>
  );
}
