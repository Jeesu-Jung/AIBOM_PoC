const familyRegistry = window.AIBOM_FAMILIES || {};
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

const state = {
  activeNodeId: initialNodeId()
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

function renderLineageBoard() {
  document.getElementById("lineage-board").innerHTML = familyContexts
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

function stringifyLicense(license) {
  if (!license) return "Not disclosed";
  if (typeof license === "string") return license;
  return Object.entries(license)
    .map(([key, value]) => `${toTitleCase(key)}: ${value}`)
    .join(" | ");
}

function deriveCurrentPurpose(node, family) {
  if (node.kind === "document") {
    return `Root evidence for the initial ${family.label} family AIBOM extraction`;
  }
  if (node.kind === "root") {
    if (node.id.toLowerCase().includes("instruct")) {
      return "General instruction-following assistant";
    }
    return "Foundation language model";
  }
  const purpose = node.delta?.modified_primary_purpose;
  if (!purpose) return getNodePreview(node);
  if (purpose.includes("->")) {
    return purpose.split("->").at(-1).trim();
  }
  return purpose;
}

function formatValue(value) {
  if (value == null || value === "") return "Not disclosed";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "Not disclosed";
  if (typeof value === "object") {
    return Object.entries(value)
      .map(([key, item]) => `${toTitleCase(key)}: ${Array.isArray(item) ? item.join(", ") : item}`)
      .join(" | ");
  }
  return String(value);
}

function row(field, value, status = "Extracted") {
  return {
    field,
    value: formatValue(value),
    status:
      value == null || value === "" || (Array.isArray(value) && !value.length)
        ? "Not disclosed"
        : status
  };
}

function renderTableValue(value) {
  if (/^https?:\/\//.test(value)) {
    const label = value.length > 72 ? `${value.slice(0, 69)}...` : value;
    return `<a class="table-link" href="${escapeHtml(value)}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
  }
  return escapeHtml(value);
}

function buildEvidenceRows(node, family) {
  const sources = mergeSources(
    family.root_family.sources,
    node.sources || []
  );

  if (!sources.length) {
    return [row("Evidence", "No source URLs captured", "Not disclosed")];
  }

  return sources.map((source) =>
    row(
      source.title ? `${toTitleCase(source.type)} | ${source.title}` : toTitleCase(source.type),
      source.url,
      source.version || source.title ? "Extracted" : "Context"
    )
  );
}

function buildAibomSections(node) {
  const family = familyRegistry[node.familyId];
  const variant = family.root_family.focus_variant;
  const rootSources = family.root_family.sources;
  const hfUrl =
    node.kind === "document"
      ? rootSources.find((source) =>
          ["official_model_card", "huggingface_model_card"].includes(source.type)
        )?.url || null
      : `https://huggingface.co/${node.id}`;
  const repoUrl = (node.sources || []).find((source) => source.type === "github")?.url || null;
  const reportUrl =
    mergeSources(rootSources, node.sources || []).find((source) =>
      ["paper", "technical_report", "official_blog", "official_model_card", "huggingface_model_card"].includes(
        source.type
      )
    )?.url || null;

  const trainingDataNames =
    node.kind === "document" || node.kind === "root"
      ? family.root_family.pretraining.exact_dataset_inventory || [
          family.root_family.pretraining.corpus_size_family
        ]
      : (node.delta?.added_training_data || []).map(
          (item) => item.name || item.role || item.generation
        );
  const testDatasets =
    node.kind === "derived" && node.delta?.added_evaluation
      ? Object.values(node.delta.added_evaluation)
      : null;

  const runtimeDependencies =
    node.kind === "derived"
      ? [
          node.artifact?.library,
          node.artifact?.conversion_tool,
          node.delta?.operational_dependency
        ].filter(Boolean)
      : null;

  const hyperparameters =
    node.kind === "derived"
      ? node.delta?.training_hyperparameters || node.delta?.adapter_configuration
      : {
          layers: variant.layers,
          hidden_size: variant.hidden_size,
          attention_heads: variant.attention_heads,
          context_length: variant.context_length
        };

  const trainingInformation =
    node.kind === "document" || node.kind === "root"
      ? [
          `Pretraining stages: ${family.root_family.pretraining.stages.join(" -> ")}`,
          `Post-training methods: ${family.root_family.post_training.methods.join(", ")}`
        ]
      : node.delta?.added_training_methods ||
        node.delta?.added_training_method ||
        node.delta?.modified_primary_purpose ||
        node.delta?.semantic_training_delta;

  const dataPreprocessing =
    node.kind === "document" || node.kind === "root"
      ? family.root_family.pretraining.data_processing
      : (node.delta?.added_training_data || [])
          .flatMap((item) => item.processing || [])
          .filter(Boolean);

  const performanceMetrics = node.kind === "derived" ? node.delta?.added_evaluation : null;

  const limitations =
    node.kind === "derived"
      ? node.delta?.removed_or_out_of_scope || node.delta?.known_risk || node.delta?.unknown
      : null;

  const safetyRisk =
    node.kind === "derived"
      ? node.delta?.added_security_goal || node.delta?.known_risk || node.delta?.inherited_risks
      : [
          "Safety and alignment behavior is only partially disclosed in the root evidence.",
          "Downstream models may add their own safety or refusal tuning."
        ];

  return [
    {
      title: "Identity",
      rows: [
        row("Model family", family.label, "Context"),
        row("Model name", node.kind === "document" ? family.root_family.family_id : node.title),
        row(
          "Model version",
          node.artifact?.revision || family.root_family.release_date,
          node.artifact?.revision ? "Extracted" : "Context"
        ),
        row("Model description", node.kind === "document" ? node.subtitle : getNodePreview(node)),
        row("Model download location", hfUrl, hfUrl ? "Derived" : "Not disclosed"),
        row("Source repository", repoUrl, repoUrl ? "Extracted" : "Not disclosed"),
        row("Supplier", node.supplier || family.root_family.developer),
        row(
          "License",
          node.kind === "derived" ? stringifyLicense(node.license_reported) : family.root_family.license
        )
      ]
    },
    {
      title: "Purpose and architecture",
      rows: [
        row(
          "Primary purpose",
          deriveCurrentPurpose(node, family),
          node.kind === "derived" ? "Derived" : "Context"
        ),
        row(
          "Domain",
          node.delta?.added_domain ||
            (node.kind === "root" && node.id.toLowerCase().includes("instruct")
              ? "general-purpose assistant"
              : "general-purpose multilingual language modeling"),
          node.delta?.added_domain ? "Extracted" : "Context"
        ),
        row(
          "Type of model",
          node.kind === "derived"
            ? node.artifact?.type || node.artifact?.format || family.root_family.architecture.family
            : family.root_family.architecture.family
        ),
        row("Hyperparameters", hyperparameters, typeof hyperparameters === "object" ? "Context" : "Extracted"),
        row("Performance metrics", performanceMetrics, performanceMetrics ? "Extracted" : "Not disclosed"),
        row("Decision thresholds", null),
        row("Energy consumption", null)
      ]
    },
    {
      title: "Training and data",
      rows: [
        row("Training information", trainingInformation, trainingInformation ? "Extracted" : "Not disclosed"),
        row(
          "Data preprocessing",
          dataPreprocessing,
          dataPreprocessing?.length ? "Extracted" : "Not disclosed"
        ),
        row(
          "Sensitive data usage",
          node.kind === "document" || node.kind === "root"
            ? "Not disclosed in the root evidence"
            : null,
          node.kind === "document" || node.kind === "root" ? "Context" : "Not disclosed"
        ),
        row("Training datasets", trainingDataNames, trainingDataNames ? "Extracted" : "Not disclosed"),
        row("Test datasets", testDatasets, testDatasets ? "Extracted" : "Not disclosed")
      ]
    },
    {
      title: "Risk and operations",
      rows: [
        row("Explainability information", null),
        row("Known limitations", limitations, limitations ? "Extracted" : "Not disclosed"),
        row("Safety risk assessment", safetyRisk, safetyRisk ? "Extracted" : "Not disclosed"),
        row(
          "Runtime dependencies",
          runtimeDependencies,
          runtimeDependencies?.length ? "Extracted" : "Not disclosed"
        ),
        row(
          "Model lineage",
          node.kind === "document"
            ? `${node.title} -> ${family.root_family.family_id}`
            : node.kind === "root"
              ? `Derived from ${family.document_node.title}`
              : `${RELATION_LABELS[node.relationship] || node.relationship} from ${node.parent_model}`,
          "Derived"
        ),
        row("Supporting document", reportUrl, reportUrl ? "Extracted" : "Not disclosed")
      ]
    },
    {
      title: "Evidence references",
      rows: buildEvidenceRows(node, family)
    }
  ];
}

function renderAibomTable(section) {
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
      <div class="aibom-section-stack">
        ${sections.map(renderAibomTable).join("")}
      </div>
    </article>
  `;
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
