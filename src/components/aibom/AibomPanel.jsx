import { useState } from "react";
import { KindChip, RelationChip } from "../common/Chips.jsx";
import { buildAibomSections } from "../../domain/aibom.js";
import { getNodePreview } from "../../domain/lineage.js";
import AibomAreas from "./AibomAreas.jsx";
import AibomTable from "./AibomTable.jsx";
import DeltaComparison from "./DeltaComparison.jsx";

export default function AibomPanel({ node, onSelect, familyRegistry, checklistRegistry, aibomRegistry = {}, nodeMap, loading = false }) {
  const [view, setView] = useState("aibom");
  const family = familyRegistry[node.familyId];
  if (loading && node.kind !== "document" && !checklistRegistry[node.id]) {
    return <article className="focus-card"><p className="section-note">Loading the selected model AIBOM...</p></article>;
  }
  const sections = buildAibomSections(node, checklistRegistry, familyRegistry);
  const aibom = aibomRegistry[node.id];
  const activeView = aibom ? view : "checklist";

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
      <DeltaComparison node={node} onSelect={onSelect} nodeMap={nodeMap} aibomRegistry={aibomRegistry} />
      {aibom && (
        <div className="aibom-view-tabs" role="tablist" aria-label="AIBOM view">
          <button type="button" role="tab" aria-selected={activeView === "aibom"} className={activeView === "aibom" ? "is-active" : ""} onClick={() => setView("aibom")}>
            AIBOM schema <small>8 areas</small>
          </button>
          <button type="button" role="tab" aria-selected={activeView === "checklist"} className={activeView === "checklist" ? "is-active" : ""} onClick={() => setView("checklist")}>
            CycloneDX checklist
          </button>
        </div>
      )}
      {activeView === "aibom"
        ? <AibomAreas aibom={aibom} />
        : (
          <div className="aibom-section-stack">
            {sections.map((section) => <AibomTable key={section.title} section={section} />)}
          </div>
        )}
    </article>
  );
}
