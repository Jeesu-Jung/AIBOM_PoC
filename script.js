const familyRegistry = window.AIBOM_FAMILIES || {};
const checklistRegistry = window.AIBOM_CHECKLISTS || {};
const familyIds = Object.keys(familyRegistry);

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
    month: "short",
    day: "numeric"
  }).format(new Date(dateString));
}

function buildFamilyContext(familyId) {
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

function mergeSources(...sourceLists) {
  const seen = new Set();
  const merged = [];
  sourceLists.flat().forEach((source) => {
    if (!source || !source.url || seen.has(source.url)) return;
    seen.add(source.url);
    merged.push(source);
  });
  return merged;
}

const familyContexts = familyIds.map(buildFamilyContext);
const allNodes = familyContexts.flatMap((context) => context.nodes);
const nodeMap = new Map(allNodes.map((node) => [node.id, node]));

function initialNodeId() {
  const requestedNodeId = new URLSearchParams(window.location.search).get("node");
  if (requestedNodeId && nodeMap.has(requestedNodeId)) {
    return requestedNodeId;
  }
  const llamaDefault = familyRegistry.llama31?.default_node_id;
  return llamaDefault && nodeMap.has(llamaDefault) ? llamaDefault : allNodes[0]?.id;
}

function familyIdForNode(nodeId) {
  return nodeMap.get(nodeId)?.familyId || familyIds[0];
}

const initialActiveNodeId = initialNodeId();
const state = {
  activeNodeId: initialActiveNodeId,
  activeFamilyId: familyIdForNode(initialActiveNodeId)
};

function syncUrl() {
  const url = new URL(window.location.href);
  url.searchParams.set("node", state.activeNodeId);
  window.history.replaceState({}, "", url);
}

function relationChip(relation) {
  return `<span class="chip rel-${escapeHtml(relation)}">${escapeHtml(
    RELATION_LABELS[relation] || relation
  )}</span>`;
}

function kindChip(kind) {
  return `<span class="chip kind-${escapeHtml(kind)}">${escapeHtml(toTitleCase(kind))}</span>`;
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

function getNodePreview(node) {
  const family = familyRegistry[node.familyId];
  if (node.kind === "document") return node.subtitle;
  if (node.kind === "root") return summarizeRoot(node, family);
  return RELATION_SHORT_NOTES[node.relationship] || summarizeDelta(node.delta);
}

function renderNodeCard(node) {
  const relation = node.kind === "derived" ? relationChip(node.relationship) : "";
  return `
    <button
      type="button"
      class="node-card"
      data-node-id="${escapeHtml(node.id)}"
      data-kind="${escapeHtml(node.kind)}"
      aria-pressed="${state.activeNodeId === node.id ? "true" : "false"}"
    >
      <div class="chip-row">
        ${kindChip(node.kind)}
        ${relation}
      </div>
      <div class="node-title">${escapeHtml(node.title)}</div>
      <p class="node-preview">${escapeHtml(getNodePreview(node))}</p>
    </button>
  `;
}

function renderHero() {
  const metaItems = [
    ["Families", familyContexts.length],
    ["Nodes", allNodes.length],
    [
      "Latest root release",
      formatDate(
        familyContexts
          .map((context) => context.family.root_family.release_date)
          .sort()
          .at(-1)
      )
    ]
  ];

  document.getElementById("hero-meta").innerHTML = metaItems
    .map(
      ([label, value]) => `
        <div class="meta-pill">
          <span class="meta-label">${escapeHtml(label)}</span>
          <span class="meta-value">${escapeHtml(value)}</span>
        </div>
      `
    )
    .join("");
}

function renderMetrics() {
  const metrics = [
    {
      label: "Model families",
      value: familyContexts.length
    },
    {
      label: "Root variants",
      value: familyContexts.reduce(
        (count, context) => count + context.family.root_family.model_variants.length,
        0
      )
    },
    {
      label: "Derived models",
      value: familyContexts.reduce((count, context) => count + context.derivedNodes.length, 0)
    },
    {
      label: "Transformation types",
      value: new Set(
        familyContexts.flatMap((context) =>
          context.derivedNodes.map((node) => node.relationship)
        )
      ).size
    }
  ];

  document.getElementById("metrics").innerHTML = metrics
    .map(
      (metric) => `
        <article class="metric-card">
          <span class="metric-value">${escapeHtml(metric.value)}</span>
          <span class="metric-label">${escapeHtml(metric.label)}</span>
        </article>
      `
    )
    .join("");
}

function branchLabel(rootNode) {
  return rootNode.title.toLowerCase().includes("instruct") ? "Instruct branch" : "Base branch";
}

function isMissingChecklistValue(value) {
  return value == null || value === "" || value === "Not found" || (Array.isArray(value) && !value.length);
}

function checklistValuesEqual(left, right) {
  if (isMissingChecklistValue(left) && isMissingChecklistValue(right)) return true;
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildDeltaComparisonSections(node) {
  const parentId = node.parent_model || node.parent;
  const baseChecklist = checklistRegistry[parentId];
  const selectedChecklist = checklistRegistry[node.id];
  if (!baseChecklist || !selectedChecklist) return [];

  const baseCategories = new Map(baseChecklist.categories.map((category) => [category.id, category]));
  const selectedCategories = new Map(
    selectedChecklist.categories.map((category) => [category.id, category])
  );
  const categoryIds = [
    ...selectedChecklist.categories.map((category) => category.id),
    ...baseChecklist.categories
      .map((category) => category.id)
      .filter((categoryId) => !selectedCategories.has(categoryId))
  ];

  return categoryIds
    .map((categoryId) => {
      const baseCategory = baseCategories.get(categoryId);
      const selectedCategory = selectedCategories.get(categoryId);
      const baseFields = new Map((baseCategory?.fields || []).map((field) => [field.name, field]));
      const selectedFields = new Map(
        (selectedCategory?.fields || []).map((field) => [field.name, field])
      );
      const fieldNames = [
        ...(selectedCategory?.fields || []).map((field) => field.name),
        ...(baseCategory?.fields || [])
          .map((field) => field.name)
          .filter((fieldName) => !selectedFields.has(fieldName))
      ];
      const rows = fieldNames.flatMap((fieldName) => {
        if (categoryId === "required" && fieldName === "serialNumber") return [];
        const before = baseFields.get(fieldName)?.value;
        const after = selectedFields.get(fieldName)?.value;
        if (checklistValuesEqual(before, after)) return [];

        const beforeMissing = isMissingChecklistValue(before);
        const afterMissing = isMissingChecklistValue(after);
        return [
          {
            aspect: fieldName,
            type: beforeMissing ? "added" : afterMissing ? "removed" : "modified",
            before,
            after
          }
        ];
      });

      return {
        label: selectedCategory?.label || baseCategory?.label || toTitleCase(categoryId),
        rows
      };
    })
    .filter((section) => section.rows.length);
}

function renderComparisonValue(value, side, type) {
  if (!isMissingChecklistValue(value)) return `<span>${renderTableValue(value)}</span>`;
  const beforeHints = {
    added: "Not present in base JSON",
    modified: "No base value documented"
  };
  const afterHints = {
    removed: "Not present in selected JSON",
    modified: "No selected-model value documented"
  };
  return `
    <span class="comparison-empty" aria-label="No corresponding value">—</span>
    <small>${side === "before" ? beforeHints[type] || "No base value documented" : afterHints[type] || "No selected-model value documented"}</small>
  `;
}

function renderComparisonRow(row) {
  const typeLabels = {
    added: "Added",
    modified: "Modified",
    removed: "Removed"
  };

  return `
    <div class="comparison-row">
      <div class="comparison-aspect">
        <span class="comparison-badge comparison-${escapeHtml(row.type)}">${typeLabels[row.type]}</span>
        <strong>${escapeHtml(row.aspect)}</strong>
      </div>
      <div class="comparison-value comparison-before">
        <span class="comparison-mobile-label">Before · Base</span>
        ${renderComparisonValue(row.before, "before", row.type)}
      </div>
      <div class="comparison-value comparison-after">
        <span class="comparison-mobile-label">After · Selected</span>
        ${renderComparisonValue(row.after, "after", row.type)}
      </div>
    </div>
  `;
}

function renderDeltaComparison(node) {
  if (node.kind !== "derived") return "";
  const parent = nodeMap.get(node.parent_model || node.parent);
  const parentLabel = parent?.title || node.parent_model || node.parent;
  const sections = buildDeltaComparisonSections(node);

  return `
    <section class="delta-comparison" aria-label="Changes from the base model">
      <div class="delta-head">
        <div>
          <p class="eyebrow">Compared with base · CycloneDX 1.7</p>
          <h5>What changed in this model?</h5>
        </div>
        ${parent ? `<button type="button" class="delta-parent-button" data-delta-parent="${escapeHtml(parent.id)}">View base model</button>` : ""}
      </div>

      <p class="delta-source-note">Only changed CycloneDX 1.7 field values are shown. The generation-specific serial number is excluded.</p>

      <div class="comparison-models">
        <div class="comparison-model-spacer" aria-hidden="true">Field</div>
        <div class="comparison-model comparison-base-model">
          <span>Before · CycloneDX 1.7</span>
          <strong>${escapeHtml(parentLabel)}</strong>
        </div>
        <div class="comparison-model comparison-selected-model">
          <span>After · CycloneDX 1.7</span>
          <strong>${escapeHtml(node.title)}</strong>
          <div class="comparison-relation">${relationChip(node.relationship)}</div>
        </div>
      </div>

      <div class="comparison-sections">
        ${sections
          .map(
            (section) => `
              <section class="comparison-section">
                <h6>${escapeHtml(section.label)}</h6>
                <div class="comparison-rows">
                  ${section.rows.map(renderComparisonRow).join("")}
                </div>
              </section>
            `
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderFamilySelect() {
  const select = document.getElementById("family-select");
  select.innerHTML = familyContexts
    .map(
      (context) => `
        <option value="${escapeHtml(context.familyId)}"${
          context.familyId === state.activeFamilyId ? " selected" : ""
        }>${escapeHtml(context.family.label)}</option>
      `
    )
    .join("");

  select.addEventListener("change", () => {
    const context = familyContexts.find((item) => item.familyId === select.value);
    if (!context) return;

    state.activeFamilyId = context.familyId;
    state.activeNodeId = context.family.default_node_id;
    renderLineageBoard();
    renderFullAibomPanel();
    syncSelection();
    syncUrl();
    drawConnections();
  });
}

function renderLineageBoard() {
  document.getElementById("lineage-board").innerHTML = familyContexts
    .filter((context) => context.familyId === state.activeFamilyId)
    .map((context) => {
      const { familyId, family, documentNode, rootNodes, derivedNodes } = context;
      const branchColumns = rootNodes
        .map((rootNode) => {
          const branchChildren = derivedNodes.filter((node) => node.parent === rootNode.id);
          return `
            <section class="derived-column">
              <header class="branch-header">
                <h3>${escapeHtml(branchLabel(rootNode))}</h3>
                <p>${escapeHtml(
                  branchChildren.length > 0
                    ? `${branchChildren.length} example descendant${
                        branchChildren.length > 1 ? "s" : ""
                      } from this root.`
                    : "No example descendants added for this root yet."
                )}</p>
              </header>
              <div class="lane-stack">
                ${branchChildren.map(renderNodeCard).join("")}
              </div>
            </section>
          `;
        })
        .join("");

      return `
        <section class="family-cluster" data-family-cluster="${escapeHtml(familyId)}">
          <div class="cluster-head">
            <div>
              <p class="eyebrow">${escapeHtml(family.label)}</p>
              <h3>${escapeHtml(family.root_family.family_id)}</h3>
            </div>
            <p class="section-note">
              ${escapeHtml(
                `${family.root_family.focus_variant.label} focus slice, released ${formatDate(
                  family.root_family.release_date
                )}.`
              )}
            </p>
          </div>

          <div class="family-cluster-board">
            <svg class="cluster-svg" aria-hidden="true"></svg>

            <div class="lane lane-document">
              <div class="lane-header">
                <span class="lane-title">Source document</span>
              </div>
              <div class="lane-stack">
                ${renderNodeCard(documentNode)}
              </div>
            </div>

            <div class="lane lane-roots">
              <div class="lane-header">
                <span class="lane-title">Root AIBOM nodes</span>
              </div>
              <div class="root-grid">
                ${rootNodes.map(renderNodeCard).join("")}
              </div>
            </div>

            <div class="lane lane-derived">
              <div class="lane-header">
                <span class="lane-title">Derived models</span>
              </div>
              <div class="derived-grid">
                ${branchColumns}
              </div>
            </div>
          </div>
        </section>
      `;
    })
    .join("");

  document.querySelectorAll(".node-card").forEach((button) => {
    button.addEventListener("click", () => {
      selectNode(button.dataset.nodeId, true);
    });
  });
}

function renderTableValue(value) {
  if (Array.isArray(value)) {
    return value.map((item) => renderTableValue(item)).join("<br>");
  }
  if (value && Array.isArray(value.datasetNames) && Array.isArray(value.datasetUrls)) {
    return value.datasetNames
      .map((name, index) => {
        const url = value.datasetUrls[index];
        if (!url) return escapeHtml(name);
        return `<a class="table-link" href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(name)}</a>`;
      })
      .join("<br>");
  }
  if (value && typeof value === "object") {
    return escapeHtml(JSON.stringify(value));
  }
  const text = String(value ?? "Not found");
  if (/^https?:\/\//.test(text)) {
    const label = text.length > 72 ? `${text.slice(0, 69)}...` : text;
    return `<a class="table-link" href="${escapeHtml(text)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
  }
  const linkedValue = text.match(/^(.*?) — (https?:\/\/\S+)$/);
  if (linkedValue) {
    return `${escapeHtml(linkedValue[1])} — ${renderTableValue(linkedValue[2])}`;
  }
  return escapeHtml(text);
}

function formatLegacyValue(value) {
  if (value == null || value === "") return "Not disclosed";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not disclosed";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${toTitleCase(key)}: ${Array.isArray(item) ? item.join(", ") : item}`)
      .join(" | ");
  }
  return String(value);
}

function legacyRow(field, value, status = "Extracted") {
  return {
    field,
    value: formatLegacyValue(value),
    status:
      value == null || value === "" || (Array.isArray(value) && !value.length)
        ? "Not disclosed"
        : status
  };
}

function buildDocumentAibomSections(node, family) {
  const variant = family.root_family.focus_variant;
  const rootSources = family.root_family.sources;
  const hfUrl =
    rootSources.find((source) =>
      ["official_model_card", "huggingface_model_card"].includes(source.type)
    )?.url || null;
  const reportUrl = rootSources.find((source) =>
    ["paper", "technical_report", "official_blog", "official_model_card", "huggingface_model_card"].includes(
      source.type
    )
  )?.url || null;
  const trainingDataNames = family.root_family.pretraining.exact_dataset_inventory || [
    family.root_family.pretraining.corpus_size_family
  ];
  const evidenceRows = rootSources.map((source) =>
    legacyRow(
      source.title ? `${toTitleCase(source.type)} | ${source.title}` : toTitleCase(source.type),
      source.url,
      source.version || source.title ? "Extracted" : "Context"
    )
  );

  return [
    {
      legacy: true,
      title: "Identity",
      rows: [
        legacyRow("Model family", family.label, "Context"),
        legacyRow("Model name", family.root_family.family_id),
        legacyRow("Model version", family.root_family.release_date, "Context"),
        legacyRow("Model description", node.subtitle),
        legacyRow("Model download location", hfUrl, hfUrl ? "Derived" : "Not disclosed"),
        legacyRow("Source repository", null),
        legacyRow("Supplier", family.root_family.developer),
        legacyRow("License", family.root_family.license)
      ]
    },
    {
      legacy: true,
      title: "Purpose and architecture",
      rows: [
        legacyRow("Primary purpose", `Root evidence for the initial ${family.label} family AIBOM extraction`, "Context"),
        legacyRow("Domain", "general-purpose multilingual language modeling", "Context"),
        legacyRow("Type of model", family.root_family.architecture.family),
        legacyRow("Hyperparameters", {
          layers: variant.layers,
          hidden_size: variant.hidden_size,
          attention_heads: variant.attention_heads,
          context_length: variant.context_length
        }, "Context"),
        legacyRow("Performance metrics", null),
        legacyRow("Decision thresholds", null),
        legacyRow("Energy consumption", null)
      ]
    },
    {
      legacy: true,
      title: "Training and data",
      rows: [
        legacyRow("Training information", [
          `Pretraining stages: ${family.root_family.pretraining.stages.join(" -> ")}`,
          `Post-training methods: ${family.root_family.post_training.methods.join(", ")}`
        ]),
        legacyRow("Data preprocessing", family.root_family.pretraining.data_processing),
        legacyRow("Sensitive data usage", "Not disclosed in the root evidence", "Context"),
        legacyRow("Training datasets", trainingDataNames),
        legacyRow("Test datasets", null)
      ]
    },
    {
      legacy: true,
      title: "Risk and operations",
      rows: [
        legacyRow("Explainability information", null),
        legacyRow("Known limitations", null),
        legacyRow("Safety risk assessment", [
          "Safety and alignment behavior is only partially disclosed in the root evidence.",
          "Downstream models may add their own safety or refusal tuning."
        ]),
        legacyRow("Runtime dependencies", null),
        legacyRow("Model lineage", `${node.title} -> ${family.root_family.family_id}`, "Derived"),
        legacyRow("Supporting document", reportUrl, reportUrl ? "Extracted" : "Not disclosed")
      ]
    },
    {
      legacy: true,
      title: "Evidence references",
      rows: evidenceRows
    }
  ];
}

function buildAibomSections(node) {
  const family = familyRegistry[node.familyId];
  const checklist = checklistRegistry[node.id];

  if (!checklist) {
    return buildDocumentAibomSections(node, family);
  }

  return checklist.categories.map((category) => ({
    title: category.label,
    summary: `${category.present}/${category.total} present · ${category.score}/${category.maxScore} points`,
    note: category.displayNote,
    rows: category.fields
  }));
}

function renderAibomTable(section) {
  if (section.legacy) {
    return `
      <section class="aibom-section">
        <h4>${escapeHtml(section.title)}</h4>
        <div class="aibom-table-wrap">
          <table class="aibom-table">
            <thead>
              <tr>
                <th scope="col">Field</th>
                <th scope="col">Value</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              ${section.rows
                .map(
                  (entry) => `
                    <tr>
                      <th scope="row">${escapeHtml(entry.field)}</th>
                      <td>${renderTableValue(entry.value)}</td>
                      <td><span class="status-pill status-${escapeHtml(
                        entry.status.toLowerCase().replaceAll(" ", "-")
                      )}">${escapeHtml(entry.status)}</span></td>
                    </tr>
                  `
                )
                .join("")}
            </tbody>
          </table>
        </div>
      </section>
    `;
  }

  return `
    <section class="aibom-section">
      <h4>${escapeHtml(section.title)}</h4>
      <div class="aibom-table-wrap">
        <table class="aibom-table">
          <thead>
            <tr>
              <th scope="col">Status</th>
              <th scope="col">Field</th>
              <th scope="col">Value (CycloneDX 1.7)</th>
              <th scope="col">Tier</th>
              <th scope="col">Type</th>
            </tr>
          </thead>
          <tbody>
            ${section.rows
              .map(
                (entry) => `
                  <tr>
                    <td><span class="status-pill status-${entry.present ? "present" : "missing"}">${entry.present ? "Present" : "Missing"}</span></td>
                    <th scope="row">${escapeHtml(entry.name)}</th>
                    <td>${renderTableValue(entry.value)}</td>
                    <td>${escapeHtml(entry.tier)}</td>
                    <td>${escapeHtml(entry.type)}</td>
                  </tr>
                `
              )
              .join("")}
          </tbody>
        </table>
      </div>
    </section>
  `;
}

function renderFullAibomPanel() {
  const node = nodeMap.get(state.activeNodeId);
  if (!node) return;

  const family = familyRegistry[node.familyId];
  const relation = node.kind === "derived" ? relationChip(node.relationship) : "";
  const sections = buildAibomSections(node);

  document.getElementById("full-aibom-panel").innerHTML = `
    <article class="focus-card">
      <div class="focus-summary-row">
        <div>
          <div class="chip-row">
            <span class="chip soft-family">${escapeHtml(family.label)}</span>
            ${kindChip(node.kind)}
            ${relation}
          </div>
          <h4>${escapeHtml(node.title)}</h4>
          <p class="focus-summary">${escapeHtml(getNodePreview(node))}</p>
        </div>
      </div>
      ${renderDeltaComparison(node)}
      <div class="aibom-section-stack">
        ${sections.map(renderAibomTable).join("")}
      </div>
    </article>
  `;

  document.querySelector("[data-delta-parent]")?.addEventListener("click", (event) => {
    selectNode(event.currentTarget.dataset.deltaParent, true);
  });
}

function syncSelection() {
  document.querySelectorAll(".node-card").forEach((button) => {
    const active = button.dataset.nodeId === state.activeNodeId;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function selectNode(nodeId, scrollIntoView) {
  if (!nodeMap.has(nodeId)) return;
  state.activeNodeId = nodeId;
  state.activeFamilyId = familyIdForNode(nodeId);
  syncSelection();
  renderFullAibomPanel();
  syncUrl();

  if (scrollIntoView) {
    document.getElementById("full-aibom-panel")?.scrollIntoView({
      behavior: "smooth",
      block: "nearest"
    });
  }
}

function drawConnections() {
  if (window.innerWidth <= 640) {
    document.querySelectorAll(".cluster-svg").forEach((svg) => {
      svg.innerHTML = "";
    });
    return;
  }

  familyContexts.forEach((context) => {
    const board = document.querySelector(
      `[data-family-cluster="${CSS.escape(context.familyId)}"] .family-cluster-board`
    );
    const svg = board?.querySelector(".cluster-svg");
    if (!board || !svg) return;

    const connections = [
      ...context.rootNodes.map((node) => ({
        from: context.documentNode.id,
        to: node.id,
        type: "document"
      })),
      ...context.derivedNodes.map((node) => ({
        from: node.parent,
        to: node.id,
        type: "root"
      }))
    ];

    const boardRect = board.getBoundingClientRect();
    svg.setAttribute("viewBox", `0 0 ${boardRect.width} ${boardRect.height}`);
    svg.innerHTML = "";

    connections.forEach((connection) => {
      const fromEl = board.querySelector(`[data-node-id="${CSS.escape(connection.from)}"]`);
      const toEl = board.querySelector(`[data-node-id="${CSS.escape(connection.to)}"]`);
      if (!fromEl || !toEl) return;

      const fromRect = fromEl.getBoundingClientRect();
      const toRect = toEl.getBoundingClientRect();

      const startX = fromRect.left - boardRect.left + fromRect.width / 2;
      const startY = fromRect.top - boardRect.top + fromRect.height;
      const endX = toRect.left - boardRect.left + toRect.width / 2;
      const endY = toRect.top - boardRect.top;
      const controlY = startY + (endY - startY) * 0.5;

      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute(
        "d",
        `M ${startX} ${startY} C ${startX} ${controlY}, ${endX} ${controlY}, ${endX} ${endY}`
      );
      path.setAttribute("class", `edge-path edge-${connection.type}`);
      svg.appendChild(path);
    });
  });
}

function initialize() {
  renderHero();
  renderMetrics();
  renderFamilySelect();
  renderLineageBoard();
  renderFullAibomPanel();
  syncSelection();
  syncUrl();
  drawConnections();

  window.addEventListener("resize", drawConnections);
  if ("ResizeObserver" in window) {
    const observer = new ResizeObserver(() => drawConnections());
    document.querySelectorAll(".family-cluster-board").forEach((board) => observer.observe(board));
  }
}

initialize();
