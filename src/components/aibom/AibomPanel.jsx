import { KindChip, RelationChip } from "../common/Chips.jsx";
import { buildDocumentSections } from "../../domain/aibom.js";
import { getNodePreview } from "../../domain/lineage.js";
import AibomAreas from "./AibomAreas.jsx";
import AibomTable from "./AibomTable.jsx";
import DeltaComparison from "./DeltaComparison.jsx";
import { downloadJson, jsonFilename } from "../../utils/download.js";

/** `aibomRegistry[id]` is the model's AIBOM once loaded (null when none is stored; absent while loading). */
export default function AibomPanel({ node, onSelect, familyRegistry, aibomRegistry = {}, nodeMap, loading = false }) {
  const family = familyRegistry[node.familyId];
  const isDocument = node.kind === "document";
  const loaded = Object.hasOwn(aibomRegistry, node.id);
  if (!isDocument && (loading || !loaded) && !aibomRegistry[node.id]) {
    return <article className="focus-card"><p className="section-note">Loading the selected model AIBOM...</p></article>;
  }
  const aibom = aibomRegistry[node.id];
  const downloadModelAibom = () => downloadJson({
    model: node,
    aibom: aibom ?? null
  }, `${jsonFilename(node.id || node.title, "model")}-aibom.json`);

  return (
    <article className="focus-card">
      <div className="focus-summary-row">
        <div>
          <div className="chip-row">
            <span className="chip soft-family">{family.label}</span>
            <KindChip kind={node.kind} />
            {node.kind === "derived" && <RelationChip relation={node.relationship} />}
          </div>
          <div className="focus-model-heading">
            <h4>{node.title}</h4>
            {!isDocument && <button type="button" className="json-download-button" onClick={downloadModelAibom}>
              AIBOM JSON Download
            </button>}
          </div>
          <p className="focus-summary">{getNodePreview(node, familyRegistry)}</p>
        </div>
      </div>
      {isDocument ? (
        <div className="aibom-section-stack">
          {buildDocumentSections(node, familyRegistry).map((section) => <AibomTable key={section.title} section={section} />)}
        </div>
      ) : (
        <>
          <DeltaComparison node={node} onSelect={onSelect} nodeMap={nodeMap} aibomRegistry={aibomRegistry} />
          {aibom
            ? <AibomAreas aibom={aibom} />
            : <p className="section-note">이 모델에는 저장된 AIBOM이 없습니다. 관리자 편집 화면에서 모델 정보와 함께 등록할 수 있습니다.</p>}
        </>
      )}
    </article>
  );
}
