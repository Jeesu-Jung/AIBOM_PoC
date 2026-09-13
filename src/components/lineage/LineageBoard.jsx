import NodeCard from "./NodeCard.jsx";
import { formatDate } from "../../utils/format.js";

function branchLabel(rootNode) {
  return rootNode.title.toLowerCase().includes("instruct") ? "Instruct branch" : "Base branch";
}

export default function LineageBoard({ context, activeNodeId, onSelect, familyRegistry }) {
  const { familyId, family, documentNode, rootNodes, derivedNodes } = context;
  const rootFamily = family.root_family || {};
  const focusLabel = rootFamily.focus_variant?.label || `${rootNodes.length} root model${rootNodes.length === 1 ? "" : "s"}`;
  const releaseLabel = rootFamily.release_date ? formatDate(rootFamily.release_date) : "release date not disclosed";

  return (
    <section className="family-cluster" data-family-cluster={familyId}>
      <div className="cluster-head">
        <div>
          <p className="eyebrow">{family.label}</p>
          <h3>{rootFamily.family_id || family.label}</h3>
        </div>
        <p className="section-note">
          {`${focusLabel}, ${releaseLabel}.`}
        </p>
      </div>

      <div className="family-cluster-board">
        <svg className="cluster-svg" aria-hidden="true" />

        <div className="lane lane-document">
          <div className="lane-header"><span className="lane-title">Source document</span></div>
          <div className="lane-stack">
            <NodeCard node={documentNode} activeNodeId={activeNodeId} onSelect={onSelect} familyRegistry={familyRegistry} />
          </div>
        </div>

        <div className="lane lane-roots">
          <div className="lane-header"><span className="lane-title">Root AIBOM nodes</span></div>
          <div className="root-grid">
            {rootNodes.map((node) => (
              <NodeCard key={node.id} node={node} activeNodeId={activeNodeId} onSelect={onSelect} familyRegistry={familyRegistry} />
            ))}
          </div>
        </div>

        <div className="lane lane-derived">
          <div className="lane-header"><span className="lane-title">Derived models</span></div>
          <div className="derived-grid">
            {rootNodes.map((rootNode) => {
              const children = derivedNodes.filter((node) => node.parent === rootNode.id);
              return (
                <section className="derived-column" key={rootNode.id}>
                  <header className="branch-header">
                    <h3>{branchLabel(rootNode)}</h3>
                    <p>
                      {children.length
                        ? `${children.length} example descendant${children.length > 1 ? "s" : ""} from this root.`
                        : "No example descendants added for this root yet."}
                    </p>
                  </header>
                  <div className="lane-stack">
                    {children.map((node) => (
                      <NodeCard key={node.id} node={node} activeNodeId={activeNodeId} onSelect={onSelect} familyRegistry={familyRegistry} />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
