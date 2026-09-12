import { KindChip, RelationChip } from "../common/Chips.jsx";
import { buildAibomSections } from "../../domain/aibom.js";
import { getNodePreview } from "../../domain/lineage.js";
import AibomTable from "./AibomTable.jsx";
import DeltaComparison from "./DeltaComparison.jsx";

export default function AibomPanel({ node, onSelect, familyRegistry, checklistRegistry, nodeMap, loading = false }) {
  const family = familyRegistry[node.familyId];
  if (loading && node.kind !== "document" && !checklistRegistry[node.id]) {
    return <article className="focus-card"><p className="section-note">Loading the selected model AIBOM...</p></article>;
  }
  const sections = buildAibomSections(node, checklistRegistry, familyRegistry);

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
      <DeltaComparison node={node} onSelect={onSelect} nodeMap={nodeMap} checklistRegistry={checklistRegistry} />
      <div className="aibom-section-stack">
        {sections.map((section) => <AibomTable key={section.title} section={section} />)}
      </div>
    </article>
  );
}
