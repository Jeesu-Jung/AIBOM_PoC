(function () {
  const GENERATOR_URL =
    "https://huggingface.co/spaces/GenAISecurityProject/OWASP-AIBOM-Generator";
  const cycloneDxRegistry = window.AIBOM_CYCLONEDX_VALUES || {};

  const requiredFields = [
    ["bomFormat", "$.bomFormat", "Critical", "CDX"],
    ["specVersion", "$.specVersion", "Critical", "CDX"],
    ["serialNumber", "$.serialNumber", "Critical", "CDX"],
    ["version", "$.version", "Critical", "CDX"]
  ];

  const metadataFields = [
    ["primaryPurpose", "$.components[0].modelCard.modelParameters.task", "Critical", "CDX"],
    ["suppliedBy", "$.components[0].supplier.name", "Critical", "CDX"],
    ["standardCompliance", null, "Supplementary", "AITX"],
    ["domain", null, "Supplementary", "AITX"],
    ["autonomyType", null, "Supplementary", "AITX"]
  ];

  // The live page reports 6/7 for this category while rendering six rows.
  const componentBasicFields = [
    ["name", "$.components[0].name", "Critical", "CDX"],
    ["type", "$.components[0].type", "Critical", "CDX"],
    ["version", "$.components[0].version", "Critical", "CDX"],
    ["purl", "$.components[0].purl", "Important", "CDX"],
    ["description", "$.components[0].description", "Important", "CDX"],
    ["licenses", "$.components[0].licenses", "Important", "CDX"]
  ];

  const modelCardDefinitions = [
    ["datasets", "component.modelCard.modelParameters.datasets", "Important", "CDX"],
    ["ethicalConsiderations", null, "Important", "CDX"],
    ["energyConsumption", null, "Important", "AITX"],
    ["hyperparameter", null, "Important", "AITX"],
    ["technicalLimitations", "component.modelCard.considerations.technicalLimitations[0]", "Important", "CDX"],
    ["safetyRiskAssessment", "metadata.properties[?(@.name=='safetyRiskAssessment')].value", "Important", "AITX"],
    ["intendedUse", null, "Important", "CDX"],
    ["typeOfModel", "modelCard.modelParameters.modelArchitecture", "Important", "CDX"],
    ["modelExplainability", null, "Supplementary", "AITX"],
    ["energyQuantity", null, "Supplementary", "AITX"],
    ["energyUnit", null, "Supplementary", "AITX"],
    ["informationAboutTraining", null, "Supplementary", "AITX"],
    ["informationAboutApplication", null, "Supplementary", "AITX"],
    ["metric", null, "Supplementary", "AITX"],
    ["metricDecisionThreshold", null, "Supplementary", "AITX"],
    ["modelDataPreprocessing", null, "Supplementary", "AITX"],
    ["useSensitivePersonalInformation", null, "Supplementary", "AITX"],
    ["vocab_size", "modelCard.properties[?(@.name=='genai:aibom:modelcard:vocabSize')].value", "Supplementary", "AITX"],
    ["tokenizer_class", "modelCard.properties[?(@.name=='genai:aibom:modelcard:tokenizerClass')].value", "Supplementary", "AITX"]
  ];

  const externalReferenceDefinitions = [
    ["paper", "metadata.component.externalReferences[?(@.type=='documentation')]", "Supplementary", "CDX"],
    ["vcs", "externalReferences[?(@.type=='vcs')].url", "Supplementary", "CDX"],
    ["website", "externalReferences[?(@.type=='website')].url", "Supplementary", "CDX"],
    ["downloadLocation", "externalReferences[?(@.type=='distribution' || @.type=='website')].url", "Important", "CDX"]
  ];

  const modelResults = {
    "meta-llama/Llama-3.1-8B": {
      generatedAt: "2026-08-08T04:10:01+00:00",
      modelCardTotal: 17,
      modelCardPresent: ["datasets", "technicalLimitations", "safetyRiskAssessment", "typeOfModel"],
      modelCardScore: 7.1,
      externalPaper: true,
      externalScore: 10,
      subtotal: 62.2,
      finalScore: 62.2,
      penaltyFactor: 1
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
      generatedAt: "2026-08-08T04:10:09+00:00",
      modelCardTotal: 17,
      modelCardPresent: ["datasets", "technicalLimitations", "safetyRiskAssessment", "typeOfModel"],
      modelCardScore: 7.1,
      externalPaper: true,
      externalScore: 10,
      subtotal: 62.2,
      finalScore: 62.2,
      penaltyFactor: 1
    },
    "NousResearch/Hermes-3-Llama-3.1-8B": {
      generatedAt: "2026-08-08T04:10:10+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["datasets", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 6.3,
      externalPaper: true,
      externalScore: 10,
      subtotal: 61.4,
      finalScore: 58.3,
      penaltyFactor: 0.95
    },
    "FreedomIntelligence/HuatuoGPT-o1-8B": {
      generatedAt: "2026-08-08T04:10:12+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["datasets", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 6.3,
      externalPaper: true,
      externalScore: 10,
      subtotal: 61.4,
      finalScore: 58.3,
      penaltyFactor: 0.95
    },
    "HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge": {
      generatedAt: "2026-08-08T04:10:13+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["datasets", "technicalLimitations", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 7.9,
      externalPaper: true,
      externalScore: 10,
      subtotal: 63,
      finalScore: 59.8,
      penaltyFactor: 0.95
    },
    "FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp": {
      generatedAt: "2026-08-08T04:10:14+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 4.7,
      externalPaper: false,
      externalScore: 7.5,
      subtotal: 57.3,
      finalScore: 54.4,
      penaltyFactor: 0.95
    },
    "mlx-community/Meta-Llama-3.1-8B-Instruct-bf16": {
      generatedAt: "2026-08-08T04:10:15+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["technicalLimitations", "safetyRiskAssessment", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 7.9,
      externalPaper: false,
      externalScore: 7.5,
      subtotal: 60.5,
      finalScore: 57.5,
      penaltyFactor: 0.95
    },
    "Qwen/Qwen2.5-7B": {
      generatedAt: "2026-08-08T04:10:16+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["safetyRiskAssessment", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 6.3,
      externalPaper: true,
      externalScore: 10,
      subtotal: 61.4,
      finalScore: 58.3,
      penaltyFactor: 0.95
    },
    "Qwen/Qwen2.5-7B-Instruct": {
      generatedAt: "2026-08-07T23:09:02+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["safetyRiskAssessment", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 6.3,
      externalPaper: true,
      externalScore: 10,
      subtotal: 61.4,
      finalScore: 58.3,
      penaltyFactor: 0.95
    },
    "Qwen/Qwen2.5-7B-Instruct-1M": {
      generatedAt: "2026-08-08T04:10:17+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["safetyRiskAssessment", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 6.3,
      externalPaper: true,
      externalScore: 10,
      subtotal: 61.4,
      finalScore: 58.3,
      penaltyFactor: 0.95
    },
    "HPAI-BSC/Qwen2.5-7B-Instruct-Egida-DPO": {
      generatedAt: "2026-08-08T04:10:18+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["datasets", "safetyRiskAssessment", "typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 7.9,
      externalPaper: true,
      externalScore: 10,
      subtotal: 63,
      finalScore: 59.8,
      penaltyFactor: 0.95
    },
    "mellee030/MedQwen-7B-LoRA": {
      generatedAt: "2026-08-08T04:10:20+00:00",
      modelCardTotal: 18,
      modelCardPresent: ["datasets", "technicalLimitations", "typeOfModel", "tokenizer_class"],
      modelCardScore: 6.7,
      externalPaper: false,
      externalScore: 7.5,
      subtotal: 59.3,
      finalScore: 56.3,
      penaltyFactor: 0.95
    },
    "mlx-community/Qwen2.5-7B-Instruct-bf16": {
      generatedAt: "2026-08-08T04:10:21+00:00",
      modelCardTotal: 19,
      modelCardPresent: ["typeOfModel", "vocab_size", "tokenizer_class"],
      modelCardScore: 4.7,
      externalPaper: false,
      externalScore: 7.5,
      subtotal: 57.3,
      finalScore: 54.4,
      penaltyFactor: 0.95
    }
  };

  function fieldRows(definitions, presentNames, values = {}) {
    const presentSet = new Set(presentNames);
    return definitions.map(([name, location, tier, type]) => ({
      name,
      present: presentSet.has(name),
      actualLocation: presentSet.has(name) ? location : "Not found",
      value: presentSet.has(name) ? values[name] ?? "Not found" : "Not found",
      tier,
      type
    }));
  }

  function buildChecklist(modelId, result) {
    const cycloneDx = cycloneDxRegistry[modelId] || { categories: {} };
    const categoryValues = cycloneDx.categories || {};
    const modelCardDefinitionsForModel =
      result.modelCardTotal === 17
        ? modelCardDefinitions.slice(0, 17)
        : result.modelCardTotal === 18
          ? modelCardDefinitions.filter(([name]) => name !== "vocab_size")
          : modelCardDefinitions;
    const externalPresent = result.externalPaper
      ? ["paper", "vcs", "website", "downloadLocation"]
      : ["vcs", "website", "downloadLocation"];
    const categories = [
      {
        id: "required",
        label: "Required Fields",
        present: 4,
        total: 4,
        score: 20,
        maxScore: 20,
        fields: fieldRows(
          requiredFields,
          requiredFields.map(([name]) => name),
          categoryValues.required
        )
      },
      {
        id: "metadata",
        label: "Metadata",
        present: 2,
        total: 5,
        score: 8,
        maxScore: 20,
        fields: fieldRows(
          metadataFields,
          ["primaryPurpose", "suppliedBy"],
          categoryValues.metadata
        )
      },
      {
        id: "component-basic",
        label: "Component Basic",
        present: 6,
        total: 7,
        score: 17.1,
        maxScore: 20,
        fields: fieldRows(
          componentBasicFields,
          componentBasicFields.map(([name]) => name),
          categoryValues["component-basic"]
        ),
        displayNote: "The live page renders 6 rows but reports 6/7 present."
      },
      {
        id: "model-card",
        label: "Component Model Card",
        present: result.modelCardPresent.length,
        total: result.modelCardTotal,
        score: result.modelCardScore,
        maxScore: 30,
        fields: fieldRows(
          modelCardDefinitionsForModel,
          result.modelCardPresent,
          categoryValues["model-card"]
        )
      },
      {
        id: "external-references",
        label: "External References",
        present: externalPresent.length,
        total: 4,
        score: result.externalScore,
        maxScore: 10,
        fields: fieldRows(
          externalReferenceDefinitions,
          externalPresent,
          categoryValues["external-references"]
        )
      }
    ];
    const presentFields = categories.reduce((sum, category) => sum + category.present, 0);
    const totalFields = categories.reduce((sum, category) => sum + category.total, 0);

    return {
      modelId,
      modelUrl: `https://huggingface.co/${modelId}`,
      generatorUrl: GENERATOR_URL,
      sourceDocument: `docs/${modelId.replaceAll("/", "_")}_Field_Checklist.md`,
      generatedAt: result.generatedAt,
      valueGeneratedAt: cycloneDx.generatedAt || null,
      profile: {
        name: "Basic",
        description: "Minimal fields required for identification"
      },
      presentFields,
      totalFields,
      subtotal: result.subtotal,
      penaltyFactor: result.penaltyFactor,
      finalScore: result.finalScore,
      categories
    };
  }

  window.AIBOM_CHECKLISTS = Object.fromEntries(
    Object.entries(modelResults).map(([modelId, result]) => [
      modelId,
      buildChecklist(modelId, result)
    ])
  );
})();
