import { KindChip, RelationChip } from "../common/Chips.jsx";
import { getNodePreview } from "../../domain/lineage.js";

export default function NodeCard({ node, activeNodeId, onSelect }) {
  return (
    <button
      type="button"
      className={`node-card${activeNodeId === node.id ? " is-active" : ""}`}
      data-node-id={node.id}
      data-kind={node.kind}
      aria-pressed={activeNodeId === node.id}
      onClick={() => onSelect(node.id, true)}
    >
      <div className="chip-row">
        <KindChip kind={node.kind} />
        {node.kind === "derived" && <RelationChip relation={node.relationship} />}
      </div>
      <div className="node-title">{node.title}</div>
      <p className="node-preview">{getNodePreview(node)}</p>
    </button>
  );
}
