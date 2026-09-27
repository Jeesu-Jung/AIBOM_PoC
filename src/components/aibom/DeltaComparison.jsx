import { RelationChip } from "../common/Chips.jsx";
import Value from "../common/Value.jsx";
import { aibomParentId, buildAibomDeltaSections, isEmptyValue } from "../../domain/aibomDelta.js";

function ComparisonValue({ value, side, type }) {
  if (!isEmptyValue(value)) return <span><Value value={value} /></span>;
  const hints = side === "before"
    ? { added: "Not present in the base AIBOM", modified: "No base value documented" }
    : { removed: "Not present in the selected AIBOM", modified: "No selected-model value documented" };

  return (
    <>
      <span className="comparison-empty" aria-label="No corresponding value">—</span>
      <small>{hints[type] || `No ${side === "before" ? "base" : "selected-model"} value documented`}</small>
    </>
  );
}

/** Base model for the comparison: AIBOM provenance.parent first, then the catalog hierarchy parent. */
export function comparisonBaseId(node, aibomRegistry = {}) {
  return aibomParentId(aibomRegistry[node.id]) || node.parent_model || node.parent || null;
}

export default function DeltaComparison({ node, onSelect, nodeMap, aibomRegistry = {} }) {
  if (node.kind === "document") return null;
  const parentId = comparisonBaseId(node, aibomRegistry);
  if (!parentId) return null;
  const parent = nodeMap.get(parentId);
  const parentLabel = parent?.title || parentId;
  const selected = aibomRegistry[node.id];
  const base = aibomRegistry[parentId];
  const sections = buildAibomDeltaSections(selected, base);
  const typeLabels = { added: "Added", modified: "Modified", removed: "Removed" };
  const changeCount = sections.reduce((sum, section) => sum + section.rows.length, 0);

  return (
    <section className="delta-comparison" aria-label="Changes from the base model">
      <div className="delta-head">
        <div>
          <p className="eyebrow">Compared with base · AIBOM</p>
          <h5>What changed in this model?</h5>
        </div>
        {parent && (
          <button type="button" className="delta-parent-button" onClick={() => onSelect(parent.id, true)}>
            View base model
          </button>
        )}
      </div>
      <p className="delta-source-note">
        Field values of the 8 AIBOM areas that differ from the base model ({changeCount} changes).
        Identifiers, subjects and reference lists are excluded; evaluations are matched by benchmark and metric.
      </p>
      <div className="comparison-models">
        <div className="comparison-model-spacer" aria-hidden="true">Field</div>
        <div className="comparison-model comparison-base-model">
          <span>Before · Base AIBOM</span><strong>{parentLabel}</strong>
        </div>
        <div className="comparison-model comparison-selected-model">
          <span>After · Selected AIBOM</span><strong>{node.title}</strong>
          {node.relationship && <div className="comparison-relation"><RelationChip relation={node.relationship} /></div>}
          {!node.relationship && selected?.provenance?.relation && <em className="comparison-relation-inline">{selected.provenance.relation}</em>}
        </div>
      </div>
      {!selected || !base ? (
        <p className="section-note">{!selected ? "이 모델의 AIBOM이 없어 비교할 수 없습니다." : "base 모델의 AIBOM을 불러오는 중이거나 저장된 AIBOM이 없습니다."}</p>
      ) : (
        <div className="comparison-sections">
          {sections.map((section) => (
            <section className="comparison-section" key={section.label}>
              <h6>{section.label} <code className="aibom-area-table">{section.table}</code></h6>
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
          {!sections.length && <p className="section-note">base 모델과 AIBOM 필드 값이 같습니다.</p>}
        </div>
      )}
    </section>
  );
}
