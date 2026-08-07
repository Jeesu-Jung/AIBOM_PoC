const familyRegistry = window.AIBOM_FAMILIES || {};
const familyIds = Object.keys(familyRegistry);
const defaultFamilyId = familyRegistry.llama31 ? "llama31" : familyIds[0];

const RELATION_LABELS = {
  instructionTunedFrom: "Instruction tuned",
  domainFineTunedAndReinforcementOptimizedFrom: "Domain FT + PPO",
  taskFineTunedFrom: "Task fine-tuned",
  adapterTrainedFrom: "Adapter trained",
  convertedFrom: "Converted",
  contextExtendedFrom: "Context extended",
  preferenceOptimizedFrom: "Preference optimized"
};

const RELATION_SHORT_NOTES = {
  instructionTunedFrom: "Instruction tuning and chat alignment",
  domainFineTunedAndReinforcementOptimizedFrom: "Domain adaptation with reinforcement optimization",
  taskFineTunedFrom: "Task-specific adaptation",
  adapterTrainedFrom: "PEFT or LoRA adapter on top of the base model",
  convertedFrom: "Packaging or runtime conversion without a reported semantic retraining change",
  contextExtendedFrom: "Extended context handling and long-sequence adaptation",
  preferenceOptimizedFrom: "Preference or DPO-style alignment"
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toTitleCase(value) {
  return value
    .replaceAll("_", " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function formatDate(dateString) {
  return new Intl.DateTimeFormat("en", {
    year: "numeric",
    month: "long",
    day: "numeric"
  }).format(new Date(dateString));
}

function buildNodes(family, familyId) {
  const mergeSources = (...sourceLists) => {
    const seen = new Set();
    const merged = [];
    sourceLists.flat().forEach((source) => {
      if (!source || !source.url || seen.has(source.url)) return;
      seen.add(source.url);
      merged.push(source);
    });
    return merged;
  };

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
    sources: family.root_family.sources
  }));
  const derivedNodes = family.derived_models.map((model) => ({
    ...model,
    id: model.model_id,
    kind: "derived",
    title: model.model_id,
    familyId,
    sources: mergeSources(family.root_family.sources, model.sources || [])
  }));
  return [documentNode, ...rootNodes, ...derivedNodes];
}

function allNodesWithFamilies() {
  return familyIds.flatMap((familyId) => buildNodes(familyRegistry[familyId], familyId));
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

function summarizeRoot(node, family) {
  const variant = family.root_family.focus_variant;
  if (node.id.toLowerCase().includes("instruct")) {
    return `Official post-trained ${variant.label.toLowerCase()} instruct checkpoint.`;
  }
  return `Base ${variant.label.toLowerCase()} checkpoint inherited directly from the family evidence root.`;
}

function getNodePreview(node, family) {
  if (node.kind === "document") return node.subtitle;
  if (node.kind === "root") return summarizeRoot(node, family);
  return RELATION_SHORT_NOTES[node.relationship] || summarizeDelta(node.delta);
}

function relationChip(relation) {
  return `<span class="chip rel-${escapeHtml(relation)}">${escapeHtml(
    RELATION_LABELS[relation] || relation
  )}</span>`;
}

function kindChip(kind) {
  return `<span class="chip kind-${escapeHtml(kind)}">${escapeHtml(toTitleCase(kind))}</span>`;
}

function stringifyLicense(license) {
  if (!license) return "Not disclosed";
  if (typeof license === "string") return license;
  return Object.entries(license)
    .map(([key, value]) => `${toTitleCase(key)}: ${value}`)
    .join(" | ");
}

function normalizeItems(value) {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeItems(item));
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if ("name" in value) {
      const pieces = [value.name];
      if (value.role) pieces.push(value.role);
      if (value.size) pieces.push(String(value.size));
      if (value.generation) pieces.push(value.generation);
      if (value.model) pieces.push(`${value.role || "model"}: ${value.model}`);
      if (value.derived_from?.length) pieces.push(`Derived from ${value.derived_from.join(", ")}`);
      if (value.features?.length) pieces.push(value.features.join(", "));
      if (value.processing?.length) pieces.push(`Processing: ${value.processing.join(", ")}`);
      return [pieces.join(" | ")];
    }
    if (keys.length) {
      return [
        keys
          .map((key) => `${toTitleCase(key)}: ${Array.isArray(value[key]) ? value[key].join(", ") : value[key]}`)
          .join(" | ")
      ];
    }
    return [];
  }
  return [String(value)];
}

function buildDeltaSections(model) {
  const sections = [];
  const sectionMap = [
    ["Added capabilities", model.delta.added_capabilities_claimed],
    ["Training data", model.delta.added_training_data],
    ["Training methods", model.delta.added_training_methods || model.delta.added_training_method],
    ["Prompt or output protocol", model.delta.added_prompt_protocol || model.delta.added_output_protocol],
    ["Task or domain shift", [model.delta.added_domain, model.delta.added_task, model.delta.added_security_goal]],
    ["Modified behavior", [model.delta.modified_primary_purpose, model.delta.modified_artifact_format, model.delta.modified_runtime_dependency, model.delta.semantic_training_delta]],
    ["Retained or inherited", model.delta.retained || model.delta.inherited_risks],
    ["Known unknowns", model.delta.unknown]
  ];

  sectionMap.forEach(([label, value]) => {
    const items = normalizeItems(value).filter(Boolean);
    if (items.length) {
      sections.push({
        label,
        items
      });
    }
  });

  if (model.delta.operational_dependency) {
    sections.push({
      label: "Operational dependency",
      items: [model.delta.operational_dependency]
    });
  }

  if (model.delta.known_risk) {
    sections.push({
      label: "Known risk",
      items: [model.delta.known_risk]
    });
  }

  return sections;
}

function buildRootSections(node, family) {
  const variant = family.root_family.focus_variant;
  return [
    {
      label: "Architecture",
      items: [
        `${family.root_family.architecture.family}`,
        `${family.root_family.architecture.attention} attention with ${family.root_family.architecture.position_embedding}`,
        `${variant.label}: ${variant.layers} layers, hidden ${variant.hidden_size}, context ${variant.context_length.toLocaleString()}`
      ]
    },
    {
      label: node.id.toLowerCase().includes("instruct") ? "Post-training methods" : "Pretraining stages",
      items: node.id.toLowerCase().includes("instruct")
        ? family.root_family.post_training.methods.concat(family.root_family.post_training.capabilities_added)
        : family.root_family.pretraining.stages.concat(family.root_family.pretraining.data_processing.slice(0, 3))
    }
  ];
}

function buildDocumentSections(family) {
  return [
    {
      label: "Scope note",
      items: [
        `${family.label} family evidence root assembled from official release materials and model cards.`
      ]
    },
    {
      label: "Family coverage",
      items: [
        `${family.root_family.developer} released ${family.root_family.model_variants.length} variants on ${formatDate(family.root_family.release_date)}.`,
        `This page focuses on the ${family.root_family.focus_variant.label.toLowerCase()} while keeping the larger family in view.`,
        `License baseline: ${family.root_family.license}`
      ]
    }
  ];
}

function buildFactLines(node, family) {
  if (node.kind === "document") {
    return [
      ["Entity", "Evidence root"],
      ["Family", family.root_family.family_id],
      ["Developer", family.root_family.developer],
      ["Release date", formatDate(family.root_family.release_date)]
    ];
  }

  if (node.kind === "root") {
    return [
      ["Entity", "Root AIBOM node"],
      ["Parent evidence", family.document_node.title],
      ["License", family.root_family.license],
      ["Context length", `${family.root_family.focus_variant.context_length.toLocaleString()} tokens`]
    ];
  }

  return [
    ["Entity", "Derived model"],
    ["Parent model", node.parent_model],
    ["Supplier", node.supplier],
    ["License", stringifyLicense(node.license_reported)],
    ["Artifact", Object.values(node.artifact || {}).join(" | ")]
  ];
}

function buildJsonExcerpt(node, family) {
  if (node.kind === "document") {
    return {
      family_id: family.root_family.family_id,
      sources: family.root_family.sources
    };
  }
  if (node.kind === "root") {
    return {
      model_id: node.id,
      inherited_architecture: family.root_family.architecture,
      focus_variant: family.root_family.focus_variant,
      training_baseline: node.id.toLowerCase().includes("instruct")
        ? family.root_family.post_training
        : family.root_family.pretraining
    };
  }
  return {
    model_id: node.model_id,
    parent_model: node.parent_model,
    relationship: node.relationship,
    artifact: node.artifact,
    delta: node.delta
  };
}

function renderSources(sources) {
  return `
    <ul class="source-list">
      ${(sources || [])
        .map((source) => {
          const labelParts = [toTitleCase(source.type)];
          if (source.title) labelParts.push(source.title);
          if (source.version) labelParts.push(source.version);
          return `
            <li>
              <a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer noopener">
                ${escapeHtml(labelParts.join(" | "))}
              </a>
            </li>
          `;
        })
        .join("")}
    </ul>
  `;
}

function renderMissingState(familyId, nodeId) {
  document.title = "AIBOM Detail";
  document.getElementById("detail-family-label").textContent = `${familyRegistry[familyId]?.label || "AIBOM"} detail page`;
  document.getElementById("detail-page-title").textContent = "Node not found";
  document.getElementById("detail-page-subtitle").textContent =
    `No node matched "${nodeId}". Return to the overview and choose one of the rendered lineage nodes.`;
  document.getElementById("detail-page-panel").innerHTML = `
    <div class="detail-stack">
      <section class="detail-slab">
        <h3>Available fallback</h3>
        <p class="detail-subtitle">Open the overview again and select a node from the lineage graph.</p>
      </section>
    </div>
  `;
}

function renderDetail(node, family) {
  document.title = `${node.title} | ${family.label} AIBOM Detail`;
  document.getElementById("detail-family-label").textContent = `${family.label} detail page`;
  document.getElementById("detail-page-title").textContent = node.title;
  document.getElementById("detail-page-subtitle").textContent = getNodePreview(node, family);

  const sections =
    node.kind === "document"
      ? buildDocumentSections(family)
      : node.kind === "root"
        ? buildRootSections(node, family)
        : buildDeltaSections(node);

  const facts = buildFactLines(node, family)
    .map(
      ([label, value]) => `
        <div class="fact-line">
          <span class="fact-label">${escapeHtml(label)}</span>
          <span class="fact-value">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");

  const sectionHtml = sections
    .map(
      (section) => `
        <section class="detail-slab">
          <h3>${escapeHtml(section.label)}</h3>
          <ul class="detail-list">
            ${section.items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
          </ul>
        </section>
      `
    )
    .join("");

  const excerpt = JSON.stringify(buildJsonExcerpt(node, family), null, 2);
  const relation = node.kind === "derived" ? relationChip(node.relationship) : "";

  document.getElementById("detail-page-panel").innerHTML = `
    <div class="detail-stack">
      <header class="detail-header">
        <div class="chip-row">
          ${kindChip(node.kind)}
          ${relation}
        </div>
      </header>

      <section class="detail-slab">
        <h3>Key fields</h3>
        <div class="fact-grid">${facts}</div>
      </section>

      ${sectionHtml}

      <section class="detail-slab">
        <h3>Evidence trail</h3>
        ${renderSources(node.sources || family.root_family.sources)}
      </section>

      <section class="detail-slab">
        <h3>JSON excerpt</h3>
        <pre class="json-block"><code>${escapeHtml(excerpt)}</code></pre>
        <p class="json-note">This excerpt is a focused view for the selected node rather than the full family document.</p>
      </section>
    </div>
  `;
}

function initialize() {
  const nodes = allNodesWithFamilies();
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const params = new URLSearchParams(window.location.search);
  const fallbackFamily = familyRegistry[defaultFamilyId];
  const nodeId =
    params.get("node") ||
    fallbackFamily.default_node_id ||
    fallbackFamily.root_nodes[0]?.id;
  const node = nodeMap.get(nodeId);
  const family = node ? familyRegistry[node.familyId] : fallbackFamily;

  document.getElementById("detail-back-link").href = `index.html?node=${encodeURIComponent(nodeId)}`;

  if (!node) {
    renderMissingState(defaultFamilyId, nodeId);
    return;
  }

  renderDetail(node, family);
}

initialize();
