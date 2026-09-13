import { useCallback, useEffect, useMemo, useState } from "react";
import AibomPanel from "./components/aibom/AibomPanel.jsx";
import DashboardHeader from "./components/layout/DashboardHeader.jsx";
import LineageBoard from "./components/lineage/LineageBoard.jsx";
import { fetchFamilies, fetchFamilyHierarchy, fetchModel } from "./api/catalog.js";
import { buildModelChecklist } from "./domain/aibom.js";
import { buildLineageCatalog, getInitialNodeId } from "./domain/lineage.js";
import { useLineageConnections } from "./hooks/useLineageConnections.js";

const EMPTY_REGISTRY = Object.freeze({});

function indexFromCatalog(catalog) {
  const items = Object.values(catalog.familyRegistry).map((family) => ({
    familyKey: family.id,
    familyName: family.label,
    releaseDate: family.root_family.release_date,
    modelCount: family.root_nodes.length + family.derived_models.length,
    rootCount: family.root_nodes.length,
    derivedCount: family.derived_models.length,
    defaultNodeId: family.default_node_id
  }));
  const relationships = new Set(items.flatMap((item) =>
    catalog.familyRegistry[item.familyKey].derived_models.map((model) => model.relationship)
  ));
  return {
    items,
    summary: {
      familyCount: items.length,
      modelCount: items.reduce((sum, item) => sum + item.modelCount, 0),
      rootCount: items.reduce((sum, item) => sum + item.rootCount, 0),
      derivedCount: items.reduce((sum, item) => sum + item.derivedCount, 0),
      transformationTypeCount: relationships.size,
      latestRelease: items.map((item) => item.releaseDate).sort().at(-1)
    }
  };
}

function familyForRequestedDocument(items, nodeId) {
  if (!nodeId?.startsWith("document:")) return null;
  return items.find((item) => nodeId === `document:${item.familyKey}`)?.familyKey || null;
}

export default function App({ initialCatalog = null }) {
  const initialIndex = useMemo(() => initialCatalog ? indexFromCatalog(initialCatalog) : null, [initialCatalog]);
  const initialLineage = useMemo(
    () => buildLineageCatalog(initialCatalog?.familyRegistry || EMPTY_REGISTRY),
    [initialCatalog]
  );
  const initialNodeId = initialCatalog ? getInitialNodeId(initialLineage, initialCatalog.familyRegistry) : null;
  const initialFamilyId = initialLineage.nodeMap.get(initialNodeId)?.familyId || null;
  const [familyIndex, setFamilyIndex] = useState(initialIndex);
  const [familyRegistry, setFamilyRegistry] = useState(initialCatalog?.familyRegistry || EMPTY_REGISTRY);
  const [checklistRegistry, setChecklistRegistry] = useState(initialCatalog?.checklistRegistry || EMPTY_REGISTRY);
  const [activeFamilyId, setActiveFamilyId] = useState(initialFamilyId);
  const [activeNodeId, setActiveNodeId] = useState(initialNodeId);
  const [loadError, setLoadError] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);

  useEffect(() => {
    if (initialCatalog) return undefined;
    let active = true;
    const requestedNodeId = new URLSearchParams(window.location.search).get("node");
    fetchFamilies().then(async (payload) => {
      if (!active) return;
      setFamilyIndex(payload);
      if (!payload.items.length) return;
      const documentFamily = familyForRequestedDocument(payload.items, requestedNodeId);
      if (documentFamily) {
        setActiveFamilyId(documentFamily);
        setActiveNodeId(requestedNodeId);
        return;
      }
      if (requestedNodeId) {
        try {
          const model = await fetchModel(requestedNodeId);
          if (!active) return;
          setChecklistRegistry({ [model.modelId]: buildModelChecklist(model) });
          setActiveFamilyId(model.familyKey);
          setActiveNodeId(model.modelId);
          return;
        } catch {
          // Invalid deep links fall back to the first available family.
        }
      }
      if (active) {
        setActiveFamilyId(payload.items[0].familyKey);
        setActiveNodeId(payload.items[0].defaultNodeId);
      }
    }).catch((error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [initialCatalog]);

  useEffect(() => {
    if (initialCatalog || !activeFamilyId || familyRegistry[activeFamilyId]) return undefined;
    let active = true;
    fetchFamilyHierarchy(activeFamilyId).then((family) => {
      if (!active) return;
      setFamilyRegistry((current) => ({ ...current, [activeFamilyId]: family }));
      setActiveNodeId((current) => {
        const nextLineage = buildLineageCatalog({ [activeFamilyId]: family });
        return current && nextLineage.nodeMap.has(current) ? current : family.default_node_id;
      });
      setLoadError(null);
    }).catch((error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [activeFamilyId, familyRegistry, initialCatalog]);

  const activeRegistry = useMemo(() => (
    activeFamilyId && familyRegistry[activeFamilyId]
      ? { [activeFamilyId]: familyRegistry[activeFamilyId] }
      : EMPTY_REGISTRY
  ), [activeFamilyId, familyRegistry]);
  const lineage = useMemo(() => buildLineageCatalog(activeRegistry), [activeRegistry]);
  const { familyContexts, allNodes, nodeMap } = lineage;
  const activeNode = nodeMap.get(activeNodeId);
  const activeContext = familyContexts[0];

  useEffect(() => {
    if (initialCatalog || !activeNode || activeNode.kind === "document") {
      setDetailLoading(false);
      return undefined;
    }
    const modelIds = [activeNode.id];
    const parentId = activeNode.parent_model || activeNode.parent;
    if (activeNode.kind === "derived" && parentId) modelIds.push(parentId);
    const missingIds = modelIds.filter((modelId) => !checklistRegistry[modelId]);
    if (!missingIds.length) {
      setDetailLoading(false);
      return undefined;
    }
    let active = true;
    setDetailLoading(true);
    Promise.all(missingIds.map(fetchModel)).then((models) => {
      if (!active) return;
      setChecklistRegistry((current) => {
        const next = { ...current };
        models.forEach((model) => {
          next[model.modelId] = buildModelChecklist(model);
        });
        return next;
      });
      setDetailLoading(false);
    }).catch((error) => {
      if (active) {
        setDetailLoading(false);
        setLoadError(error.message);
      }
    });
    return () => { active = false; };
  }, [activeNode, checklistRegistry, initialCatalog]);

  const selectNode = useCallback((nodeId, scrollIntoView = false) => {
    if (!nodeMap.has(nodeId)) return;
    setActiveNodeId(nodeId);
    if (scrollIntoView) requestAnimationFrame(() => {
      document.getElementById("full-aibom-panel")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
  }, [nodeMap]);

  useEffect(() => {
    if (!activeNodeId) return;
    const url = new URL(window.location.href);
    url.searchParams.set("node", activeNodeId);
    window.history.replaceState({}, "", url);
  }, [activeNodeId]);

  useLineageConnections(activeContext, activeNodeId);

  if (loadError) return <main className="app-state"><h1>Unable to load AIBOM data</h1><p>{loadError}</p></main>;
  if (familyIndex && familyIndex.items.length === 0) return <main className="app-state"><h1>Unable to load AIBOM data</h1><p>The API returned an empty family index.</p></main>;
  if (!familyIndex || !activeContext || !activeNode) return <main className="app-state"><p>Loading model family...</p></main>;

  const metrics = [
    ["Model families", familyIndex.summary.familyCount],
    ["Root variants", familyIndex.summary.rootCount],
    ["Derived models", familyIndex.summary.derivedCount],
    ["Transformation types", familyIndex.summary.transformationTypeCount]
  ];

  return (
    <div className="page-shell">
      <DashboardHeader metrics={metrics} familyIndex={familyIndex} nodeCount={allNodes.length} />
      <section className="workspace">
        <div className="lineage-panel">
          <div className="section-head">
            <div><p className="eyebrow">Supply-chain view</p><h2>Hierarchy and transformations</h2></div>
            <div className="section-controls">
              <p className="section-note">The graph centers the technical report as the evidence root and shows how descendant models add or modify behavior relative to the inherited AIBOM.</p>
              <label className="family-picker" htmlFor="family-select">
                <span>Model family</span>
                <select id="family-select" aria-label="Select model family" value={activeFamilyId} onChange={(event) => {
                  const nextFamily = familyIndex.items.find((item) => item.familyKey === event.target.value);
                  if (nextFamily) {
                    setActiveFamilyId(nextFamily.familyKey);
                    setActiveNodeId(nextFamily.defaultNodeId);
                  }
                }}>
                  {familyIndex.items.map((family) => <option value={family.familyKey} key={family.familyKey}>{family.familyName}</option>)}
                </select>
              </label>
            </div>
          </div>
          <div className="lineage-board" id="lineage-board">
            <LineageBoard context={activeContext} activeNodeId={activeNodeId} onSelect={selectNode} familyRegistry={activeRegistry} />
          </div>
          <div className="focus-section">
            <div className="focus-head">
              <div><p className="eyebrow">Selected node</p><h3>Full AIBOM</h3></div>
              <p className="section-note">Click any node above to replace the table below with its full AIBOM view.</p>
            </div>
            <div id="full-aibom-panel">
              <AibomPanel
                node={activeNode}
                onSelect={selectNode}
                familyRegistry={activeRegistry}
                checklistRegistry={checklistRegistry}
                nodeMap={nodeMap}
                loading={detailLoading || (activeNode.kind !== "document" && !checklistRegistry[activeNode.id])}
              />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
