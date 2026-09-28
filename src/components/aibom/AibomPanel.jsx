import { KindChip, RelationChip } from "../common/Chips.jsx";
import { buildDocumentSections } from "../../domain/aibom.js";
import { getNodePreview } from "../../domain/lineage.js";
import AibomAreas from "./AibomAreas.jsx";
import AibomTable from "./AibomTable.jsx";
import DeltaComparison from "./DeltaComparison.jsx";

/** `aibomRegistry[id]` is the model's AIBOM once loaded (null when none is stored; absent while loading). */
export default function AibomPanel({ node, onSelect, familyRegistry, aibomRegistry = {}, nodeMap, loading = false }) {
  const family = familyRegistry[node.familyId];
  const isDocument = node.kind === "document";
  const loaded = Object.hasOwn(aibomRegistry, node.id);
  if (!isDocument && (loading || !loaded) && !aibomRegistry[node.id]) {
    return <article className="focus-card"><p className="section-note">Loading the selected model AIBOM...</p></article>;
  }
  const aibom = aibomRegistry[node.id];

  return (
    <article className="focus-card">
      <div className="focus-summary-row">
        <div>
          <div className="chip-row">
            <span className="chip soft-family">{family.label}</span>
            <KindChip kind={node.kind} />
            {node.kind === "derived" && <RelationChip relation={node.relationship} />}
          </div>
          <h4>{node.title}</h4>
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
            : <p className="section-note">이 모델에는 저장된 AIBOM이 없습니다. 관리자 화면의 AIBOM 섹션에서 등록할 수 있습니다.</p>}
        </>
      )}
    </article>
  );
}
