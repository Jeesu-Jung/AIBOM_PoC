import { RelationChip } from "../common/Chips.jsx";
import Value from "../common/Value.jsx";
import { buildDeltaComparisonSections, isMissingChecklistValue } from "../../domain/aibom.js";

function ComparisonValue({ value, side, type }) {
  if (!isMissingChecklistValue(value)) return <span><Value value={value} /></span>;
  const hints = side === "before"
    ? { added: "Not present in base JSON", modified: "No base value documented" }
    : { removed: "Not present in selected JSON", modified: "No selected-model value documented" };

  return (
    <>
      <span className="comparison-empty" aria-label="No corresponding value">—</span>
      <small>{hints[type] || `No ${side === "before" ? "base" : "selected-model"} value documented`}</small>
    </>
  );
}

export default function DeltaComparison({ node, onSelect, nodeMap, checklistRegistry }) {
  if (node.kind !== "derived") return null;
  const parent = nodeMap.get(node.parent_model || node.parent);
  const parentLabel = parent?.title || node.parent_model || node.parent;
  const sections = buildDeltaComparisonSections(node, checklistRegistry);
  const typeLabels = { added: "Added", modified: "Modified", removed: "Removed" };

  return (
    <section className="delta-comparison" aria-label="Changes from the base model">
      <div className="delta-head">
        <div>
          <p className="eyebrow">Compared with base · CycloneDX 1.7</p>
          <h5>What changed in this model?</h5>
        </div>
        {parent && (
          <button type="button" className="delta-parent-button" onClick={() => onSelect(parent.id, true)}>
            View base model
          </button>
        )}
      </div>
      <p className="delta-source-note">Only changed CycloneDX 1.7 field values are shown. The generation-specific serial number is excluded.</p>
      <div className="comparison-models">
        <div className="comparison-model-spacer" aria-hidden="true">Field</div>
        <div className="comparison-model comparison-base-model">
          <span>Before · CycloneDX 1.7</span><strong>{parentLabel}</strong>
        </div>
        <div className="comparison-model comparison-selected-model">
          <span>After · CycloneDX 1.7</span><strong>{node.title}</strong>
          <div className="comparison-relation"><RelationChip relation={node.relationship} /></div>
        </div>
      </div>
      <div className="comparison-sections">
        {sections.map((section) => (
          <section className="comparison-section" key={section.label}>
            <h6>{section.label}</h6>
            <div className="comparison-rows">
              {section.rows.map((row) => (
                <div className="comparison-row" key={row.aspect}>
                  <div className="comparison-aspect">
                    <span className={`comparison-badge comparison-${row.type}`}>{typeLabels[row.type]}</span>
                    <strong>{row.aspect}</strong>
                  </div>
                  <div className="comparison-value comparison-before">
                    <span className="comparison-mobile-label">Before · Base</span>
                    <ComparisonValue value={row.before} side="before" type={row.type} />
                  </div>
                  <div className="comparison-value comparison-after">
                    <span className="comparison-mobile-label">After · Selected</span>
                    <ComparisonValue value={row.after} side="after" type={row.type} />
                  </div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}
