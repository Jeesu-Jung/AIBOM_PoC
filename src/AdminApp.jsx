import { useEffect, useMemo, useState } from "react";
import Skeleton, { SkeletonTheme } from "react-loading-skeleton";
import "react-loading-skeleton/dist/skeleton.css";
import { createAdminModel, deleteAdminModel, fetchAdminModels, updateAdminModel } from "./api/admin.js";

const EMPTY_MODEL = {
  modelId: "", namespace: "", modelName: "", familyKey: "", familyName: "", modelRole: "DERIVED",
  supplier: "", familyDeveloper: "", familyReleaseDate: "", familyLicenseName: "", primaryPurpose: "",
  modelVersion: "", packageUrl: "", modelUrl: "", licenseReported: null, artifactFormat: "", tensorType: "",
  parameterScale: "", artifactRevision: "", description: "", bomFormat: "CycloneDX", bomSpecVersion: "1.6",
  bomSerialNumber: "", bomVersion: "1", checklistPresentFields: null, checklistTotalFields: null,
  checklistScore: null, checklistPenaltyFactor: null, sourceGeneratedAt: null, detailsJson: {}, parentModelId: null,
  relationshipType: null, hierarchyDepth: 0, siblingOrder: 0, changeDetailsJson: null
};

const textFields = [
  ["supplier", "Supplier"], ["familyDeveloper", "Family developer"], ["familyLicenseName", "Family license"],
  ["primaryPurpose", "Primary purpose"], ["modelVersion", "Model version"], ["artifactFormat", "Artifact format"],
  ["tensorType", "Tensor type"], ["parameterScale", "Parameter scale"], ["artifactRevision", "Artifact revision"],
  ["packageUrl", "Package URL"], ["bomFormat", "BOM format"], ["bomSpecVersion", "BOM spec version"],
  ["bomSerialNumber", "BOM serial number"], ["bomVersion", "BOM version"]
];

function treeOrder(models) {
  const byParent = new Map();
  models.forEach((model) => {
    const key = model.parentModelId || "__root__";
    byParent.set(key, [...(byParent.get(key) || []), model]);
  });
  byParent.forEach((items) => items.sort((a, b) => a.siblingOrder - b.siblingOrder || a.modelId.localeCompare(b.modelId)));
  const result = [];
  const visited = new Set();
  const visit = (model, depth) => {
    if (visited.has(model.modelId)) return;
    visited.add(model.modelId);
    result.push({ model, depth });
    (byParent.get(model.modelId) || []).forEach((child) => visit(child, depth + 1));
  };
  (byParent.get("__root__") || []).forEach((root) => visit(root, 0));
  models.filter((model) => !visited.has(model.modelId)).forEach((model) => visit(model, model.hierarchyDepth || 0));
  return result;
}

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

function normalizeForForm(model) {
  const next = { ...EMPTY_MODEL, ...model };
  Object.keys(next).forEach((key) => { if (next[key] === null && typeof EMPTY_MODEL[key] === "string") next[key] = ""; });
  return next;
}

function Field({ label, children, wide = false }) {
  return <label className={`admin-field${wide ? " admin-field-wide" : ""}`}><span>{label}</span>{children}</label>;
}

function Input({ field, form, setForm, ...props }) {
  return <input value={form[field] ?? ""} onChange={(event) => setForm({ ...form, [field]: event.target.value })} {...props} />;
}

function mockAiResult(query) {
  const modelId = query.includes("/") ? query.trim() : `community/${query.trim().replace(/\s+/g, "-")}`;
  const [namespace, ...nameParts] = modelId.split("/");
  const modelName = nameParts.join("/") || namespace;
  const familyName = modelName.split(/[-_]/).slice(0, 2).join(" ") || modelName;
  const familyKey = familyName.toLowerCase().replace(/[^a-z0-9가-힣]+/g, "-").replace(/^-|-$/g, "") || "new-family";
  return {
    ...EMPTY_MODEL,
    modelId,
    namespace: nameParts.length ? namespace : "community",
    modelName,
    familyKey,
    familyName,
    modelRole: "BASE",
    supplier: nameParts.length ? namespace : "Community",
    primaryPurpose: "Text generation",
    modelVersion: "1.0",
    modelUrl: `https://huggingface.co/${modelId}`,
    artifactFormat: "safetensors",
    tensorType: "BF16",
    description: `${modelName} 모델의 공개 웹 자료를 기반으로 생성된 검토용 초안입니다.`,
    licenseReported: "apache-2.0",
    detailsJson: {
      model: { title: modelId, subtitle: "AI-assisted metadata draft", sources: [`https://huggingface.co/${modelId}`] },
      checklist: { modelId, categories: [] },
      ai_assisted: { status: "mock", reviewed: false }
    }
  };
}

function CreateModelDialog({ mode, onModeChange, onManual, onUseDraft, onClose }) {
  const [query, setQuery] = useState("");
  const [stage, setStage] = useState("input");
  const [result, setResult] = useState(null);

  useEffect(() => {
    if (stage !== "loading") return undefined;
    const timer = window.setTimeout(() => {
      setResult(mockAiResult(query));
      setStage("review");
    }, 2400);
    return () => window.clearTimeout(timer);
  }, [stage, query]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === "Escape" && stage !== "loading") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [stage, onClose]);

  const beginSearch = (event) => {
    event.preventDefault();
    if (!query.trim()) return;
    setStage("loading");
  };

  return (
    <div className="admin-modal-backdrop create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && stage !== "loading") onClose(); }}>
      <section className={`create-dialog ${mode === "ai" ? "is-ai" : ""}`} role="dialog" aria-modal="true" aria-labelledby="create-dialog-title">
        <div className="create-dialog-head">
          <div><p className="eyebrow">CREATE MODEL</p><h2 id="create-dialog-title">새 모델을 어떻게 등록할까요?</h2></div>
          {stage !== "loading" && <button type="button" className="create-close" aria-label="닫기" onClick={onClose}>×</button>}
        </div>

        {mode === "method" && <div className="create-methods">
          <button type="button" className="create-method-card featured" onClick={() => onModeChange("ai")}>
            <span className="create-method-icon">✦</span><span className="create-method-copy"><strong>AI로 정보 채우기</strong><small>모델명만 입력하면 웹 자료를 탐색해 메타데이터 초안을 만듭니다.</small><em>추천</em></span><span className="create-arrow">→</span>
          </button>
          <button type="button" className="create-method-card" onClick={onManual}>
            <span className="create-method-icon manual">＋</span><span className="create-method-copy"><strong>직접 입력하기</strong><small>빈 양식에서 모델 정보와 계층 관계를 하나씩 입력합니다.</small></span><span className="create-arrow">→</span>
          </button>
        </div>}

        {mode === "ai" && stage === "input" && <form className="ai-search-form" onSubmit={beginSearch}>
          <button type="button" className="create-back" onClick={() => onModeChange("method")}>← 등록 방식 다시 선택</button>
          <div className="ai-intro"><span className="ai-spark">✦</span><div><h3>AI 모델 정보 검색</h3><p>Hugging Face 형식의 모델 ID나 모델명을 입력해 주세요. 검색 결과는 등록 전 수정할 수 있습니다.</p></div></div>
          <label><span>모델명 또는 모델 ID</span><div className="ai-search-input"><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="예: mistralai/Mistral-7B-Instruct-v0.3" /><button type="submit" disabled={!query.trim()}>웹에서 찾기</button></div></label>
          <p className="ai-beta-note">현재 데모에서는 실제 검색 대신 예시 메타데이터를 생성합니다.</p>
        </form>}

        {mode === "ai" && stage === "loading" && <div className="ai-loading" aria-live="polite">
          <div className="ai-orbit"><span>✦</span></div><h3>“{query}” 정보를 찾고 있습니다</h3><p>여러 공개 소스를 비교하고 신뢰할 수 있는 항목을 정리하는 중입니다.</p>
          <ol><li className="done"><span>✓</span>모델 저장소 검색</li><li className="active"><span className="mini-spinner" />모델 카드와 라이선스 분석</li><li><span>3</span>계층 관계 및 메타데이터 정리</li></ol>
          <SkeletonTheme baseColor="#e9eef6" highlightColor="#f8faff"><div className="ai-skeleton"><Skeleton height={14} width="62%" /><Skeleton height={14} count={2} /><Skeleton height={38} /></div></SkeletonTheme>
        </div>}

        {mode === "ai" && stage === "review" && result && <div className="ai-review">
          <div className="ai-review-banner"><span>✓</span><div><strong>초안 생성 완료</strong><p>아래 내용은 목 데이터입니다. 편집 화면에서 검토한 뒤 최종 등록해 주세요.</p></div><em>DEMO</em></div>
          <div className="ai-review-grid">
            <div><span>Model ID</span><strong>{result.modelId}</strong></div><div><span>Supplier</span><strong>{result.supplier}</strong></div>
            <div><span>Family</span><strong>{result.familyName}</strong></div><div><span>Role</span><strong>{result.modelRole}</strong></div>
            <div><span>Format</span><strong>{result.artifactFormat}</strong></div><div><span>License</span><strong>{result.licenseReported}</strong></div>
          </div>
          <div className="ai-sources"><span>참고한 소스</span><a href={result.modelUrl} target="_blank" rel="noreferrer">Hugging Face 모델 페이지 ↗</a><small>실제 연동 시 공식 문서와 모델 카드가 여기에 표시됩니다.</small></div>
          <div className="create-dialog-actions"><button type="button" className="admin-secondary" onClick={() => setStage("input")}>다시 검색</button><button type="button" className="admin-primary" onClick={() => onUseDraft(result)}>편집 화면에서 검토</button></div>
        </div>}
      </section>
    </div>
  );
}

function NoticeModal({ notice, onClose }) {
  useEffect(() => {
    if (!notice) return undefined;
    const previousOverflow = document.body.style.overflow;
    const closeOnEscape = (event) => { if (event.key === "Escape") onClose(); };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [notice, onClose]);

  if (!notice) return null;
  const success = notice.type === "success";
  return (
    <div className="admin-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={`admin-modal ${notice.type}`} role="alertdialog" aria-modal="true" aria-labelledby="admin-modal-title" aria-describedby="admin-modal-message">
        <div className="admin-modal-icon" aria-hidden="true">{success ? "✓" : "!"}</div>
        <div className="admin-modal-copy">
          <p className="eyebrow">{success ? "SUCCESS" : "ERROR"}</p>
          <h2 id="admin-modal-title">{success ? "저장이 완료되었습니다" : "요청을 처리하지 못했습니다"}</h2>
          <p id="admin-modal-message">{notice.text}</p>
        </div>
        <button type="button" className="admin-primary" autoFocus onClick={onClose}>확인</button>
      </section>
    </div>
  );
}

export default function AdminApp() {
  const [models, setModels] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(normalizeForForm(EMPTY_MODEL));
  const [detailsText, setDetailsText] = useState("{}");
  const [changeText, setChangeText] = useState("");
  const [licenseText, setLicenseText] = useState("");
  const [search, setSearch] = useState("");
  const [familyFilter, setFamilyFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [createMode, setCreateMode] = useState(null);
  const [aiDraft, setAiDraft] = useState(false);

  const reload = async (preferredId = selectedId) => {
    const data = await fetchAdminModels();
    setModels(data);
    if (preferredId) {
      const selected = data.find((model) => model.modelId === preferredId);
      if (selected) selectModel(selected);
    }
    return data;
  };

  useEffect(() => {
    fetchAdminModels().then((data) => {
      setModels(data);
      if (data[0]) selectModel(data[0]);
    }).catch((error) => setNotice({ type: "error", text: error.message })).finally(() => setLoading(false));
  }, []);

  const families = useMemo(() => [...new Map(models.map((model) => [model.familyKey, model.familyName])).entries()], [models]);
  const visibleModels = useMemo(() => models.filter((model) => {
    const query = search.trim().toLowerCase();
    return (familyFilter === "all" || model.familyKey === familyFilter)
      && (!query || `${model.modelId} ${model.modelName} ${model.supplier || ""}`.toLowerCase().includes(query));
  }), [models, search, familyFilter]);
  const orderedModels = useMemo(() => treeOrder(visibleModels), [visibleModels]);
  const descendants = useMemo(() => {
    if (!selectedId) return new Set();
    const found = new Set([selectedId]);
    let changed = true;
    while (changed) {
      changed = false;
      models.forEach((model) => {
        if (model.parentModelId && found.has(model.parentModelId) && !found.has(model.modelId)) {
          found.add(model.modelId); changed = true;
        }
      });
    }
    return found;
  }, [models, selectedId]);

  function selectModel(model) {
    setSelectedId(model.modelId);
    setForm(normalizeForForm(model));
    setDetailsText(jsonText(model.detailsJson || {}));
    setChangeText(model.changeDetailsJson ? jsonText(model.changeDetailsJson) : "");
    setLicenseText(model.licenseReported == null ? "" : jsonText(model.licenseReported));
    setAiDraft(false);
    setNotice(null);
  }

  function startCreate() {
    const family = familyFilter !== "all" ? families.find(([key]) => key === familyFilter) : null;
    const fresh = { ...EMPTY_MODEL, familyKey: family?.[0] || "", familyName: family?.[1] || "" };
    setSelectedId(null); setForm(normalizeForForm(fresh)); setDetailsText("{}"); setChangeText(""); setLicenseText(""); setNotice(null); setCreateMode(null); setAiDraft(false);
  }

  function useAiDraft(draft) {
    setSelectedId(null);
    setForm(normalizeForForm(draft));
    setDetailsText(jsonText(draft.detailsJson || {}));
    setChangeText("");
    setLicenseText(draft.licenseReported == null ? "" : jsonText(draft.licenseReported));
    setCreateMode(null);
    setAiDraft(true);
  }

  function parseJson(value, label, fallback) {
    if (!value.trim()) return fallback;
    try { return JSON.parse(value); } catch { throw new Error(`${label} JSON 형식이 올바르지 않습니다.`); }
  }

  async function save(event) {
    event.preventDefault();
    setSaving(true); setNotice(null);
    try {
      const parentId = form.parentModelId || null;
      const payload = {
        ...form,
        parentModelId: parentId,
        relationshipType: parentId ? (form.relationshipType || null) : null,
        siblingOrder: Number(form.siblingOrder || 0),
        detailsJson: parseJson(detailsText, "Details", {}),
        changeDetailsJson: parseJson(changeText, "Change details", null),
        licenseReported: parseJson(licenseText, "License reported", null),
        checklistPresentFields: form.checklistPresentFields === "" ? null : Number(form.checklistPresentFields),
        checklistTotalFields: form.checklistTotalFields === "" ? null : Number(form.checklistTotalFields),
        checklistScore: form.checklistScore === "" ? null : Number(form.checklistScore),
        checklistPenaltyFactor: form.checklistPenaltyFactor === "" ? null : Number(form.checklistPenaltyFactor),
        sourceGeneratedAt: form.sourceGeneratedAt || null,
        familyReleaseDate: form.familyReleaseDate || null
      };
      const saved = selectedId ? await updateAdminModel(selectedId, payload) : await createAdminModel(payload);
      await reload(saved.modelId);
      setNotice({ type: "success", text: selectedId ? "모델 정보가 수정되었습니다." : "새 모델이 등록되었습니다." });
    } catch (error) {
      setNotice({ type: "error", text: error.message });
    } finally { setSaving(false); }
  }

  async function remove() {
    if (!selectedId || !window.confirm(`'${selectedId}' 모델을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    setSaving(true); setNotice(null);
    try {
      await deleteAdminModel(selectedId);
      const data = await reload(null);
      setSelectedId(null); startCreate();
      setModels(data);
      setNotice({ type: "success", text: "모델이 삭제되었습니다." });
    } catch (error) { setNotice({ type: "error", text: error.message }); }
    finally { setSaving(false); }
  }

  if (loading) return <main className="app-state"><p>모델 카탈로그를 불러오는 중입니다...</p></main>;

  return (
    <div className="admin-shell">
      <NoticeModal notice={notice} onClose={() => setNotice(null)} />
      {createMode && <CreateModelDialog mode={createMode} onModeChange={setCreateMode} onManual={startCreate} onUseDraft={useAiDraft} onClose={() => setCreateMode(null)} />}
      <header className="admin-header">
        <div><p className="eyebrow">AIBOM ADMIN</p><h1>Model catalog</h1><p>등록된 모델 정보와 모델 간 연결 관계를 조회하고 수정할 수 있습니다.</p></div>
        <div className="admin-header-actions"><a href="/" className="admin-secondary">메인으로</a><button type="button" className="admin-primary" onClick={() => setCreateMode("method")}>+ 새 모델</button></div>
      </header>
      <div className="admin-stats">
        <span><strong>{models.length}</strong> Models</span><span><strong>{families.length}</strong> Families</span>
        <span><strong>{models.filter((model) => !model.parentModelId).length}</strong> Roots</span>
      </div>
      <main className="admin-layout">
        <aside className="admin-tree-panel">
          <div className="admin-tree-head"><h2>Hierarchy</h2><span>{visibleModels.length}</span></div>
          <div className="admin-filters">
            <input type="search" aria-label="Search models" placeholder="모델명 또는 공급자 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label="Filter by family" value={familyFilter} onChange={(e) => setFamilyFilter(e.target.value)}>
              <option value="all">모든 패밀리</option>{families.map(([key, name]) => <option key={key} value={key}>{name}</option>)}
            </select>
          </div>
          <div className="admin-tree" role="tree" aria-label="Model hierarchy">
            {orderedModels.length ? orderedModels.map(({ model, depth }) => (
              <button type="button" role="treeitem" aria-selected={selectedId === model.modelId} className={selectedId === model.modelId ? "is-selected" : ""}
                style={{ "--tree-depth": depth }} key={model.modelId} onClick={() => selectModel(model)}>
                <span className={`admin-tree-dot ${model.parentModelId ? "derived" : "root"}`} />
                <span><strong>{model.modelName}</strong><small>{model.modelId}</small></span>
                <em>{model.modelRole}</em>
              </button>
            )) : <p className="admin-empty">조건에 맞는 모델이 없습니다.</p>}
          </div>
        </aside>

        <section className="admin-editor">
          <div className="admin-editor-title">
            <div><p className="eyebrow">{selectedId ? "EDIT MODEL" : "CREATE MODEL"}</p><h2>{selectedId || "새 모델 등록"}</h2></div>
            {selectedId && <span className="admin-depth">Depth {form.hierarchyDepth}</span>}
          </div>
          {aiDraft && <div className="ai-draft-banner"><span>✦</span><div><strong>AI가 작성한 초안입니다</strong><p>내용과 출처를 확인하고 필요한 항목을 수정한 뒤 등록해 주세요.</p></div><em>검토 필요</em></div>}
          <form onSubmit={save}>
            <fieldset><legend>기본 정보</legend><div className="admin-form-grid">
              <Field label="Model ID"><Input field="modelId" form={form} setForm={setForm} required disabled={Boolean(selectedId)} /></Field>
              <Field label="Namespace"><Input field="namespace" form={form} setForm={setForm} required /></Field>
              <Field label="Model name"><Input field="modelName" form={form} setForm={setForm} required /></Field>
              <Field label="Role"><select value={form.modelRole} onChange={(e) => setForm({ ...form, modelRole: e.target.value })}><option>BASE</option><option>INSTRUCT</option><option>DERIVED</option></select></Field>
              <Field label="Family key"><Input field="familyKey" form={form} setForm={setForm} required /></Field>
              <Field label="Family name"><Input field="familyName" form={form} setForm={setForm} required /></Field>
              <Field label="Model URL" wide><Input field="modelUrl" form={form} setForm={setForm} type="url" required /></Field>
              <Field label="Description" wide><textarea value={form.description || ""} onChange={(e) => setForm({ ...form, description: e.target.value })} rows="3" /></Field>
            </div></fieldset>

            <fieldset><legend>계층 구조</legend><p className="admin-help">부모를 바꾸면 현재 모델과 모든 하위 모델의 depth가 자동으로 재계산됩니다.</p><div className="admin-form-grid">
              <Field label="Parent model"><select value={form.parentModelId || ""} onChange={(e) => setForm({ ...form, parentModelId: e.target.value || null })}>
                <option value="">없음 (Root)</option>{models.filter((model) => !descendants.has(model.modelId) && (!form.familyKey || model.familyKey === form.familyKey)).map((model) => <option value={model.modelId} key={model.modelId}>{model.modelName} — {model.modelId}</option>)}
              </select></Field>
              <Field label="Relationship type"><Input field="relationshipType" form={form} setForm={setForm} disabled={!form.parentModelId} placeholder="fineTunedFrom" required={Boolean(form.parentModelId)} /></Field>
              <Field label="Sibling order"><Input field="siblingOrder" form={form} setForm={setForm} type="number" min="0" /></Field>
              <Field label="Change details JSON" wide><textarea className="code-input" value={changeText} onChange={(e) => setChangeText(e.target.value)} rows="5" placeholder={'{\n  "added_task": "..."\n}'} /></Field>
            </div></fieldset>

            <fieldset><legend>모델 메타데이터</legend><div className="admin-form-grid">
              <Field label="Family release date"><Input field="familyReleaseDate" form={form} setForm={setForm} type="date" /></Field>
              {textFields.map(([field, label]) => <Field label={label} key={field} wide={field === "packageUrl"}><Input field={field} form={form} setForm={setForm} /></Field>)}
              <Field label="License reported JSON" wide><textarea className="code-input" value={licenseText} onChange={(e) => setLicenseText(e.target.value)} rows="3" placeholder='"apache-2.0" 또는 ["license-a"]' /></Field>
            </div></fieldset>

            <fieldset><legend>품질 및 원본 데이터</legend><div className="admin-form-grid">
              <Field label="Checklist present"><Input field="checklistPresentFields" form={form} setForm={setForm} type="number" min="0" /></Field>
              <Field label="Checklist total"><Input field="checklistTotalFields" form={form} setForm={setForm} type="number" min="0" /></Field>
              <Field label="Checklist score"><Input field="checklistScore" form={form} setForm={setForm} type="number" min="0" max="100" step="0.01" /></Field>
              <Field label="Penalty factor"><Input field="checklistPenaltyFactor" form={form} setForm={setForm} type="number" min="0" max="1" step="0.0001" /></Field>
              <Field label="Source generated at"><Input field="sourceGeneratedAt" form={form} setForm={setForm} type="datetime-local" step="any" /></Field>
              <Field label="Details JSON" wide><textarea className="code-input" value={detailsText} onChange={(e) => setDetailsText(e.target.value)} rows="14" required /></Field>
            </div></fieldset>

            <div className="admin-form-actions">
              {selectedId && <button type="button" className="admin-danger" onClick={remove} disabled={saving}>삭제</button>}
              <span />
              <button type="button" className="admin-secondary" onClick={() => selectedId ? selectModel(models.find((m) => m.modelId === selectedId)) : startCreate()} disabled={saving}>변경 취소</button>
              <button type="submit" className="admin-primary" disabled={saving}>{saving ? "저장 중..." : selectedId ? "변경사항 저장" : aiDraft ? "검토 완료 및 모델 등록" : "모델 등록"}</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}
