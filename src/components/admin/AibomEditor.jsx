import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { fetchAdminAibomOptions, fetchAdminModelAibom, saveAdminModelAibom } from "../../api/admin.js";
import { areaEvidence, evaluationKey } from "../../domain/evidence.js";
import EvidenceLinks from "./EvidenceLinks.jsx";

const INPUT_ROLES = ["base", "merge_source", "teacher", "generator", "verifier", "reward_model"];
const DATASET_ROLES = ["pretraining", "finetuning", "preference", "distillation", "calibration", "other"];
const REF_TYPES = ["paper", "technical_report", "model_card", "dataset_card", "repository", "config", "documentation", "license", "blog", "webpage"];
const omit = (value, keys) => value && Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
const blank = (value) => value ?? "";
const replace = (items, index, value) => items.map((item, i) => i === index ? value : item);

// Evidence rows point at list items by key (backend/app/evidence.py). Each loaded item remembers the
// key it had (`_evidenceKey`) so its evidence stays attached while the reviewer edits the item, and
// the rows can follow the new key when the model is saved.
const ITEM_KEYS = { evaluation: evaluationKey, dataset: (item) => item.identity || "", license_policy: (item) => item.license || "" };
const withEvidenceKeys = (area, items) => items.map((item) => ({ ...item, _evidenceKey: ITEM_KEYS[area](item) }));
const itemEvidenceKey = (area, item) => item._evidenceKey ?? ITEM_KEYS[area](item);
const stripKeys = (items) => items.map((item) => omit(item, ["_evidenceKey"]));
/** The API payload: the form without the editor-only evidence keys. */
export function toPayload(form) {
  return form && { ...form, evaluation: stripKeys(form.evaluation), dataset: stripKeys(form.dataset), license_policy: stripKeys(form.license_policy) };
}
/** [{ area, from, to }] for list items whose key changed since they were loaded. */
export function evidenceRenames(form) {
  if (!form) return [];
  return Object.keys(ITEM_KEYS).flatMap((area) => form[area]
    .filter((item) => item._evidenceKey !== undefined && item._evidenceKey !== ITEM_KEYS[area](item))
    .map((item) => ({ area, from: item._evidenceKey, to: ITEM_KEYS[area](item) })));
}

export function toEditable(aibom) {
  const source = aibom || {};
  const editableDataset = (dataset) => ({
    identity: dataset.identity,
    version: dataset.version,
    processing: dataset.processing || [],
    license: dataset.license,
    extensions: dataset.extensions,
    provenance: dataset.provenance ? {
      origin: dataset.provenance.origin,
      provider: dataset.provenance.provider,
      parent: (dataset.provenance.parent || []).map((parent) => parent.replace(/^dataset:/, "")),
      relation: dataset.provenance.relation,
      evidence: dataset.provenance.evidence || [],
      extensions: dataset.provenance.extensions
    } : undefined
  });
  return {
    model: omit(source.model, ["identity", "provenance"]) || {},
    provenance: omit(source.provenance, ["id", "subject", "parent"]) || {},
    transformation: source.transformation ? { ...omit(source.transformation, ["id", "output"]), input: (source.transformation.input || []).map((item) => omit(item, ["external"])) } : null,
    evaluation: withEvidenceKeys("evaluation", (source.evaluation || []).map((item) => omit(item, ["id", "model"]))),
    safety_ethics: omit(source.safety_ethics, ["subject"]) || null,
    license_policy: withEvidenceKeys("license_policy", (source.license_policy || []).map((item) => omit(item, ["id", "subject"]))),
    // DATASET and REFERENCE are shared records, but they are still part of this
    // model's full AIBOM and must be visible and editable in the admin screen.
    dataset: withEvidenceKeys("dataset", (source.dataset || []).map(editableDataset)),
    reference: source.reference || []
  };
}

// `evidence`: the evidence rows of this value, listed right under its input.
// It is either a row list or `{ rows, label }` from `areaEvidence().under()`.
function Field({ label, hint, children, evidence, evidenceTarget = "field" }) { const shown = Array.isArray(evidence) || !evidence ? { rows: evidence, label: "근거" } : evidence; return <label className="aibom-field"><span>{label}</span>{hint && <small>{hint}</small>}{children}<EvidenceLinks rows={shown.rows} label={shown.label} target={evidenceTarget} hideField={label} /></label>; }
// `evidence`: rows that back the whole area or values without an input of their own.
function Area({ title, description, children, action, evidence }) { return <section className="aibom-area"><header><div><h3>{title}</h3><p>{description}</p></div>{action}</header>{children}<EvidenceLinks rows={evidence} label="영역 근거" target="field" /></section>; }
function Add({ children, onClick }) { return <button type="button" className="aibom-add" onClick={onClick}>+ {children}</button>; }
function Remove({ onClick }) { return <button type="button" className="aibom-remove" onClick={onClick} aria-label="삭제">×</button>; }

function TextList({ value = [], onChange, placeholder }) {
  const items = value.map((item) => typeof item === "object" ? item.description || "" : item);
  return <div className="aibom-list">{items.map((item, index) => <div className="aibom-list-row" key={index}><input value={item} placeholder={placeholder} onChange={(e) => onChange(replace(items, index, e.target.value))} /><Remove onClick={() => onChange(items.filter((_, i) => i !== index))} /></div>)}<Add onClick={() => onChange([...items, ""])}>항목 추가</Add></div>;
}
function FixedStructuredField({ value, onChange, placeholder = "정보를 입력하세요" }) {
  // The design has one fixed field here (architecture, tokenizer, ...), not an
  // arbitrary attribute bag. A text representation keeps the field visible while
  // preserving the API's JSON object contract.
  const [text, setText] = useState(value ? JSON.stringify(value, null, 2) : "");
  useEffect(() => setText(value ? JSON.stringify(value, null, 2) : ""), [value]);
  return <textarea rows="9" className="code-input aibom-structured-input" value={text} placeholder={placeholder}
    onChange={(e) => setText(e.target.value)}
    onBlur={() => { try { onChange(text.trim() ? JSON.parse(text) : null); } catch {} }} />;
}
function Advanced({ value, onChange }) {
  const [text, setText] = useState(JSON.stringify(value || {}, null, 2));
  useEffect(() => setText(JSON.stringify(value || {}, null, 2)), [value]);
  return <details className="aibom-advanced"><summary>고급 extensions JSON</summary><textarea className="code-input" rows="4" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => { try { onChange(JSON.parse(text || "{}")); } catch {} }} /></details>;
}

const MODEL_FIELDS = ["architecture", "tokenizer", "modality", "intended_use", "capabilities", "limitations"];
const PROVENANCE_FIELDS = ["origin", "provider", "relation"];
const TRANSFORMATION_FIELDS = ["input", "method", "objective", "timestamp", "hyperparameters", "datasets"];

function Model({ value, onChange, evidence }) {
  const set = (key, next) => onChange({ ...value, [key]: next });
  const ev = areaEvidence(evidence, "model");
  return <Area title="MODEL" description="모델의 구조, 용도, 기능과 한계를 관리합니다." evidence={ev.except(MODEL_FIELDS)}><div className="aibom-grid"><Field label="architecture" hint="설계안의 고정 필드" evidence={ev.under("architecture", value.architecture)}><FixedStructuredField value={value.architecture} onChange={(v) => set("architecture", v)} /></Field><Field label="tokenizer" hint="설계안의 고정 필드" evidence={ev.under("tokenizer", value.tokenizer)}><FixedStructuredField value={value.tokenizer} onChange={(v) => set("tokenizer", v)} /></Field><Field label="modality" hint="설계안의 고정 필드" evidence={ev.under("modality", value.modality)}><FixedStructuredField value={value.modality} onChange={(v) => set("modality", v)} /></Field><Field label="intended_use" evidence={ev.under("intended_use", value.intended_use)}><textarea rows="3" value={blank(value.intended_use)} onChange={(e) => set("intended_use", e.target.value || null)} /></Field><Field label="capabilities" evidence={ev.under("capabilities", value.capabilities)}><TextList value={value.capabilities} onChange={(v) => set("capabilities", v)} /></Field><Field label="limitations" evidence={ev.under("limitations", value.limitations)}><TextList value={value.limitations} onChange={(v) => set("limitations", v)} /></Field></div><Advanced value={value.extensions} onChange={(v) => set("extensions", v)} /></Area>;
}
function Provenance({ value, onChange, evidence }) {
  const set = (key, next) => onChange({ ...value, [key]: next });
  const ev = areaEvidence(evidence, "provenance");
  return <Area title="PROVENANCE" description="직접 부모는 Transformation의 input(base)에서 자동 계산됩니다." evidence={ev.except(PROVENANCE_FIELDS)}><div className="aibom-grid"><Field label="origin" evidence={ev.under("origin", value.origin)}><input value={blank(value.origin)} onChange={(e) => set("origin", e.target.value || null)} /></Field><Field label="provider" evidence={ev.under("provider", value.provider)}><input value={blank(value.provider)} onChange={(e) => set("provider", e.target.value || null)} /></Field><Field label="relation" evidence={ev.under("relation", value.relation)}><input value={blank(value.relation)} placeholder="fine_tuned_from" onChange={(e) => set("relation", e.target.value || null)} /></Field><Field label="evidence" hint="Reference ID 또는 URL"><TextList value={value.evidence} onChange={(v) => set("evidence", v)} placeholder="#1 또는 URL" /></Field></div><Advanced value={value.extensions} onChange={(v) => set("extensions", v)} /></Area>;
}
function Transformation({ value, onChange, models, datasets, evidence }) {
  const ev = areaEvidence(evidence, "transformation");
  if (!value) return <Area title="TRANSFORMATION" description="모델을 만든 학습·변환 과정입니다."><Add onClick={() => onChange({ input: [], method: [], objective: null, hyperparameters: {}, datasets: [], timestamp: null })}>Transformation 추가</Add></Area>;
  const set = (key, next) => onChange({ ...value, [key]: next });
  const rows = (items, setter, make, first, second, roles) => <div className="aibom-list">{items.map((item, index) => <div className="aibom-list-row aibom-pair" key={index}>{first === "model" ? <input value={item.model || ""} placeholder="모델 ID" onChange={(e) => setter(replace(items, index, { ...item, model: e.target.value }))} /> : <select value={item.dataset || ""} onChange={(e) => setter(replace(items, index, { ...item, dataset: e.target.value }))}><option value="">선택</option>{datasets.map((x) => <option key={x.identity} value={x.identity}>{x.identity}</option>)}</select>}<select value={item[second] || roles[0]} onChange={(e) => setter(replace(items, index, { ...item, [second]: e.target.value }))}>{roles.map((role) => <option key={role}>{role}</option>)}</select><Remove onClick={() => setter(items.filter((_, i) => i !== index))} /></div>)}<Add onClick={() => setter([...items, make])}>항목 추가</Add></div>;
  return <Area title="TRANSFORMATION" description="입력 모델, 방법, 하이퍼파라미터, 데이터셋을 기록합니다." evidence={ev.except(TRANSFORMATION_FIELDS)} action={<button type="button" className="aibom-remove-area" onClick={() => onChange(null)}>영역 삭제</button>}><div className="aibom-grid"><Field label="input" evidence={ev.under("input", value.input)}>{rows(value.input || [], (v) => set("input", v), { model: "", role: "base" }, "model", "role", INPUT_ROLES)}</Field><Field label="method" evidence={ev.under("method", value.method)}><TextList value={value.method} onChange={(v) => set("method", v)} /></Field><Field label="objective" evidence={ev.under("objective", value.objective)}><textarea rows="3" value={blank(value.objective)} onChange={(e) => set("objective", e.target.value || null)} /></Field><Field label="timestamp" evidence={ev.under("timestamp", value.timestamp)}><input type="date" value={blank(value.timestamp)} onChange={(e) => set("timestamp", e.target.value || null)} /></Field><Field label="hyperparameters" hint="설계안의 고정 필드" evidence={ev.under("hyperparameters", value.hyperparameters)}><FixedStructuredField value={value.hyperparameters} onChange={(v) => set("hyperparameters", v)} /></Field><Field label="datasets" evidence={ev.under("datasets", value.datasets)}>{rows(value.datasets || [], (v) => set("datasets", v), { dataset: "", role: "finetuning" }, "dataset", "role", DATASET_ROLES)}</Field></div><Advanced value={value.extensions} onChange={(v) => set("extensions", v)} /></Area>;
}
function Cards({ title, description, items, onChange, empty, render, itemEvidence }) { return <Area title={title} description={description}><div className="aibom-cards">{items.map((item, index) => <div className="aibom-card" key={index}><header><strong>{title} {index + 1}</strong><Remove onClick={() => onChange(items.filter((_, i) => i !== index))} /></header>{render(item, index, (next) => onChange(replace(items, index, next)))}<EvidenceLinks rows={itemEvidence?.(item)} /></div>)}</div><Add onClick={() => onChange([...items, empty])}>{title} 추가</Add></Area>; }
function Evaluation({ value, onChange, datasets, evidence }) { const ev = areaEvidence(evidence, "evaluation"); return <Cards title="EVALUATION" description="평가 결과 하나당 항목 하나입니다." itemEvidence={(item) => ev.item(itemEvidenceKey("evaluation", item))} items={value} onChange={onChange} empty={{ dataset: null, configuration: {}, metric: null, score: null, timestamp: null }} render={(item, _, set) => <div className="aibom-grid"><Field label="dataset"><select value={item.dataset || ""} onChange={(e) => set({ ...item, dataset: e.target.value || null })}><option value="">선택 안 함</option>{datasets.map((d) => <option key={d.identity} value={d.identity}>{d.identity}</option>)}</select></Field><Field label="metric"><input value={blank(item.metric)} onChange={(e) => set({ ...item, metric: e.target.value || null })} /></Field><Field label="score"><input type="number" step="any" value={blank(item.score)} onChange={(e) => set({ ...item, score: e.target.value === "" ? null : Number(e.target.value) })} /></Field><Field label="timestamp"><input type="date" value={blank(item.timestamp)} onChange={(e) => set({ ...item, timestamp: e.target.value || null })} /></Field><Field label="configuration" hint="설계안의 고정 필드"><FixedStructuredField value={item.configuration} onChange={(v) => set({ ...item, configuration: v })} /></Field><Advanced value={item.extensions} onChange={(v) => set({ ...item, extensions: v })} /></div>} />; }
function Safety({ value, onChange, evidence }) { const ev = areaEvidence(evidence, "safety_ethics"); if (!value) return <Area title="SAFETY_ETHICS" description="안전·윤리 정보를 기록합니다."><Add onClick={() => onChange({ safety_risk: [], ethical_considerations: [], prohibited_use: [], mitigation: [] })}>Safety & ethics 추가</Add></Area>; const set = (key, next) => onChange({ ...value, [key]: next }); return <Area title="SAFETY_ETHICS" description="안전 위험, 윤리 고려사항, 금지 사용, 완화책을 구분합니다." action={<button type="button" className="aibom-remove-area" onClick={() => onChange(null)}>영역 삭제</button>}><div className="aibom-grid">{[["safety_risk", "safety risk"], ["ethical_considerations", "ethical considerations"], ["prohibited_use", "prohibited use"], ["mitigation", "mitigation"]].map(([key, label]) => <Field label={label} key={key} evidence={ev.rows.filter((row) => row.field === key)} evidenceTarget="item"><TextList value={value[key]} onChange={(v) => set(key, v)} /></Field>)}</div><Advanced value={value.extensions} onChange={(v) => set("extensions", v)} /></Area>; }
function Licenses({ value, onChange, evidence }) { const ev = areaEvidence(evidence, "license_policy"); return <Cards title="LICENSE_POLICY" description="적용 라이선스와 제한사항을 관리합니다." itemEvidence={(item) => ev.item(itemEvidenceKey("license_policy", item))} items={value} onChange={onChange} empty={{ license: "", usage_policy: null, restrictions: [] }} render={(item, _, set) => <div className="aibom-grid"><Field label="license"><input value={blank(item.license)} onChange={(e) => set({ ...item, license: e.target.value })} /></Field><Field label="usage_policy"><input value={blank(item.usage_policy)} onChange={(e) => set({ ...item, usage_policy: e.target.value || null })} /></Field><Field label="restrictions"><TextList value={item.restrictions} onChange={(v) => set({ ...item, restrictions: v })} /></Field><Advanced value={item.extensions} onChange={(v) => set({ ...item, extensions: v })} /></div>} />; }
function Datasets({ value, onChange, evidence }) { const ev = areaEvidence(evidence, "dataset"); return <Cards title="DATASET" description="현재 모델에 연결된 데이터셋입니다. 수정하면 공유 DATASET 정보도 함께 갱신됩니다." itemEvidence={(item) => ev.item(itemEvidenceKey("dataset", item))} items={value} onChange={onChange} empty={{ identity: "", version: null, processing: [], license: null }} render={(item, _, set) => <div className="aibom-grid"><Field label="identity"><input value={blank(item.identity)} onChange={(e) => set({ ...item, identity: e.target.value })} /></Field><Field label="version"><input value={blank(item.version)} onChange={(e) => set({ ...item, version: e.target.value || null })} /></Field><Field label="license"><input value={blank(item.license)} onChange={(e) => set({ ...item, license: e.target.value || null })} /></Field><Field label="processing"><TextList value={item.processing} onChange={(v) => set({ ...item, processing: v })} /></Field><Advanced value={item.extensions} onChange={(v) => set({ ...item, extensions: v })} /></div>} />; }
function References({ value, onChange }) { return <Cards title="REFERENCE" description="현재 모델 AIBOM이 참조하는 근거 자료입니다. URI와 메타데이터를 수정할 수 있습니다." items={value} onChange={onChange} empty={{ type: "webpage", uri: "", revision: null, retrieved_at: null, hash: null }} render={(item, _, set) => <div className="aibom-grid"><Field label="type"><select value={item.type || "webpage"} onChange={(e) => set({ ...item, type: e.target.value })}>{REF_TYPES.map((type) => <option key={type}>{type}</option>)}</select></Field><Field label="uri"><input type="url" value={blank(item.uri)} onChange={(e) => set({ ...item, uri: e.target.value })} /></Field><Field label="revision"><input value={blank(item.revision)} onChange={(e) => set({ ...item, revision: e.target.value || null })} /></Field><Field label="retrieved_at"><input type="date" value={blank(item.retrieved_at)} onChange={(e) => set({ ...item, retrieved_at: e.target.value || null })} /></Field><Field label="hash"><input value={blank(item.hash)} onChange={(e) => set({ ...item, hash: e.target.value || null })} /></Field><Advanced value={item.extensions} onChange={(v) => set({ ...item, extensions: v })} /></div>} />; }

const AibomEditor = forwardRef(function AibomEditor({ modelId, initialAibom = null, refreshKey, disabled = false, evidence = null }, ref) {
  const [form, setForm] = useState(null); const [options, setOptions] = useState(null); const [saving, setSaving] = useState(false); const [loadError, setLoadError] = useState(null);
  const load = useCallback(() => {
    setLoadError(null);
    const requests = modelId ? [fetchAdminModelAibom(modelId), fetchAdminAibomOptions()] : [Promise.resolve(initialAibom), fetchAdminAibomOptions()];
    return Promise.all(requests).then(([aibom, opts]) => { setForm(toEditable(aibom)); setOptions(opts); }).catch((error) => setLoadError(error.message));
  }, [initialAibom, modelId]);
  useEffect(() => { setForm(null); load(); }, [load, refreshKey]);
  const set = (key, value) => setForm((current) => ({ ...current, [key]: value }));
  async function save() {
    if (!form) throw new Error("AIBOM을 아직 불러오는 중입니다.");
    setSaving(true);
    try {
      const saved = await saveAdminModelAibom(modelId, toPayload(form));
      setForm(toEditable(saved));
      setOptions(await fetchAdminAibomOptions());
      return saved;
    } finally { setSaving(false); }
  }
  useImperativeHandle(ref, () => ({ save, getValue: () => toPayload(form), getEvidenceRenames: () => evidenceRenames(form) }), [form, modelId]);
  if (loadError) return <p className="admin-help">AIBOM을 불러오지 못했습니다: {loadError}</p>; if (!form) return <p className="admin-help">AIBOM을 불러오는 중입니다...</p>;
  const datasets = options?.datasets || [], models = options?.models || [];
  return <section className="aibom-editor"><fieldset disabled={saving || disabled}><legend>AIBOM (설계안 8개 영역)</legend><p className="admin-help">이 모델의 전체 AIBOM을 조회하고 수정합니다. DATASET과 REFERENCE는 다른 모델과 공유될 수 있으므로 수정 내용은 해당 공통 정보에도 적용됩니다. AI 조사로 등록한 모델은 각 값 아래에 조사 당시의 근거 URL이 표시됩니다.</p><Model value={form.model} onChange={(v) => set("model", v)} evidence={evidence} /><Provenance value={form.provenance} onChange={(v) => set("provenance", v)} evidence={evidence} /><Transformation value={form.transformation} onChange={(v) => set("transformation", v)} models={models} datasets={datasets} evidence={evidence} /><Evaluation value={form.evaluation} onChange={(v) => set("evaluation", v)} datasets={datasets} evidence={evidence} /><Safety value={form.safety_ethics} onChange={(v) => set("safety_ethics", v)} evidence={evidence} /><Licenses value={form.license_policy} onChange={(v) => set("license_policy", v)} evidence={evidence} /><Datasets value={form.dataset} onChange={(v) => set("dataset", v)} evidence={evidence} /><References value={form.reference} onChange={(v) => set("reference", v)} /></fieldset></section>;
});

export default AibomEditor;
