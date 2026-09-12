import { useCallback, useEffect, useMemo, useState } from "react";
import AibomPanel from "./components/aibom/AibomPanel.jsx";
import DashboardHeader from "./components/layout/DashboardHeader.jsx";
import LineageBoard from "./components/lineage/LineageBoard.jsx";
import { familyContexts, getInitialNodeId, getSummaryMetrics, nodeMap } from "./domain/lineage.js";
import { useLineageConnections } from "./hooks/useLineageConnections.js";

export default function App() {
  const [activeNodeId, setActiveNodeId] = useState(getInitialNodeId);
  const activeNode = nodeMap.get(activeNodeId);
  const activeFamilyId = activeNode?.familyId || familyContexts[0]?.familyId;
  const activeContext = familyContexts.find((context) => context.familyId === activeFamilyId);
  const metrics = useMemo(getSummaryMetrics, []);

  const selectNode = useCallback((nodeId, scrollIntoView = false) => {
    if (!nodeMap.has(nodeId)) return;
    setActiveNodeId(nodeId);
    if (scrollIntoView) {
      requestAnimationFrame(() => {
        document.getElementById("full-aibom-panel")?.scrollIntoView({
          behavior: "smooth",
          block: "nearest"
        });
      });
    }
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("node", activeNodeId);
    window.history.replaceState({}, "", url);
  }, [activeNodeId]);

  useLineageConnections(activeContext, activeNodeId);

  if (!activeContext || !activeNode) return <main>Unable to load AIBOM data.</main>;

  return (
    <div className="page-shell">
      <DashboardHeader metrics={metrics} />

      <section className="workspace">
        <div className="lineage-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">Supply-chain view</p>
              <h2>Hierarchy and transformations</h2>
            </div>
            <div className="section-controls">
              <p className="section-note">The graph centers the technical report as the evidence root and shows how descendant models add or modify behavior relative to the inherited AIBOM.</p>
              <label className="family-picker" htmlFor="family-select">
                <span>Model family</span>
                <select
                  id="family-select"
                  aria-label="Select model family"
                  value={activeFamilyId}
                  onChange={(event) => {
                    const context = familyContexts.find((item) => item.familyId === event.target.value);
                    if (context) selectNode(context.family.default_node_id);
                  }}
                >
                  {familyContexts.map((context) => (
                    <option value={context.familyId} key={context.familyId}>{context.family.label}</option>
                  ))}
                </select>
              </label>
            </div>
          </div>

          <div className="lineage-board" id="lineage-board">
            <LineageBoard context={activeContext} activeNodeId={activeNodeId} onSelect={selectNode} />
          </div>

          <div className="focus-section">
            <div className="focus-head">
              <div><p className="eyebrow">Selected node</p><h3>Full AIBOM</h3></div>
              <p className="section-note">Click any node above to replace the table below with its full AIBOM view.</p>
            </div>
            <div id="full-aibom-panel">
              <AibomPanel node={activeNode} onSelect={selectNode} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
