import { RELATION_SHORT_NOTES } from "../constants/relationships.js";

function mergeSources(...sourceLists) {
  const seen = new Set();
  return sourceLists.flat().filter((source) => {
    if (!source?.url || seen.has(source.url)) return false;
    seen.add(source.url);
    return true;
  });
}

function buildFamilyContext(familyRegistry, familyId) {
  const family = familyRegistry[familyId];
  const documentNode = {
    ...family.document_node,
    kind: "document",
    familyId,
    sources: family.root_family.sources
  };
  const rootNodes = family.root_nodes.map((node) => ({
    ...node,
    kind: "root",
    familyId,
    parent: documentNode.id,
    sources: family.root_family.sources
  }));
  const derivedNodes = family.derived_models.map((model) => ({
    ...model,
    id: model.model_id,
    kind: "derived",
    title: model.model_id,
    familyId,
    parent: model.parent_model,
    sources: mergeSources(family.root_family.sources, model.sources || [])
  }));

  return {
    familyId,
    family,
    documentNode,
    rootNodes,
    derivedNodes,
    nodes: [documentNode, ...rootNodes, ...derivedNodes]
  };
}

export function buildLineageCatalog(familyRegistry) {
  const familyContexts = Object.keys(familyRegistry).map((familyId) =>
    buildFamilyContext(familyRegistry, familyId)
  );
  const allNodes = familyContexts.flatMap((context) => context.nodes);
  const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
  return { familyContexts, allNodes, nodeMap };
}

export function getInitialNodeId(lineageCatalog, familyRegistry, search = window.location.search) {
  const { allNodes, nodeMap } = lineageCatalog;
  const requestedNodeId = new URLSearchParams(search).get("node");
  if (requestedNodeId && nodeMap.has(requestedNodeId)) return requestedNodeId;
  const defaultNode = familyRegistry.llama31?.default_node_id;
  return defaultNode && nodeMap.has(defaultNode) ? defaultNode : allNodes[0]?.id;
}

function summarizeDelta(delta) {
  if (delta?.added_capabilities_claimed?.length) {
    return delta.added_capabilities_claimed.slice(0, 3).join(", ");
  }
  if (delta?.added_domain) return `Domain focus: ${delta.added_domain}`;
  if (delta?.added_task) return delta.added_task;
  if (delta?.added_security_goal) return delta.added_security_goal;
  if (delta?.added_operational_feature) return delta.added_operational_feature;
  return "Incremental delta extracted from descendant evidence.";
}

export function getNodePreview(node, familyRegistry) {
  const family = familyRegistry[node.familyId];
  if (node.kind === "document") return node.subtitle;
  if (node.kind === "root") {
    const variant = family.root_family.focus_variant;
    return node.id.toLowerCase().includes("instruct")
      ? `Official post-trained ${variant.label.toLowerCase()} instruct checkpoint.`
      : `Base ${variant.label.toLowerCase()} checkpoint inherited directly from the family evidence root.`;
  }
  return RELATION_SHORT_NOTES[node.relationship] || summarizeDelta(node.delta);
}

export function getSummaryMetrics(familyContexts) {
  return [
    ["Model families", familyContexts.length],
    ["Root variants", familyContexts.reduce((count, context) => count + context.family.root_family.model_variants.length, 0)],
    ["Derived models", familyContexts.reduce((count, context) => count + context.derivedNodes.length, 0)],
    ["Transformation types", new Set(familyContexts.flatMap((context) => context.derivedNodes.map((node) => node.relationship))).size]
  ];
}
