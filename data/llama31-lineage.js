window.LLAMA31_DELTA_AIBOM = {
  schema_name: "DeltaAIBOM-canonical",
  schema_version: "0.1",
  generated_at: "2026-08-06T07:25:24.516301+00:00",
  scope_note:
    "Evidence-grounded prototype extracted from the Llama 3 technical report, official Hugging Face model cards/configuration descriptions, linked papers, and one revision-pinned repository record. Unknown fields remain null.",
  root_family: {
    family_id: "meta-llama/Llama-3.1",
    developer: "Meta",
    release_date: "2024-07-23",
    license: "Llama 3.1 Community License",
    model_variants: [
      "Llama 3.1 8B",
      "Llama 3.1 8B Instruct",
      "Llama 3.1 70B",
      "Llama 3.1 70B Instruct",
      "Llama 3.1 405B",
      "Llama 3.1 405B Instruct"
    ],
    architecture: {
      family: "dense decoder-only Transformer",
      objective: "autoregressive next-token prediction",
      activation: "SwiGLU",
      position_embedding: "RoPE",
      rope_theta: 500000,
      vocabulary_size_reported: 128000,
      attention: "grouped-query attention"
    },
    variant_8b: {
      layers: 32,
      hidden_size: 4096,
      ffn_size: 14336,
      attention_heads: 32,
      key_value_heads: 8,
      context_length: 131072,
      parameter_scale: "8B"
    },
    pretraining: {
      data_cutoff: "end of 2023",
      corpus_size_family: "about 15T multilingual tokens",
      flagship_405b_tokens: "15.6T",
      stages: [
        "initial pre-training",
        "long-context continued pre-training",
        "annealing on selected high-quality data"
      ],
      data_processing: [
        "deduplication",
        "HTML extraction and cleaning",
        "quality filtering",
        "PII-heavy domain filtering",
        "unsafe/adult-domain filtering",
        "domain-specific code and math processing",
        "multilingual processing"
      ],
      exact_dataset_inventory: null
    },
    post_training: {
      methods: [
        "supervised fine-tuning",
        "rejection sampling",
        "direct preference optimization",
        "model averaging"
      ],
      data_types: [
        "human annotation",
        "rejection-sampled responses",
        "synthetic/model-generated data",
        "preference pairs",
        "safety and borderline data"
      ],
      capabilities_added: [
        "instruction following",
        "multilingual interaction",
        "coding",
        "reasoning",
        "tool use",
        "long-context use"
      ]
    },
    sources: [
      {
        type: "technical_report",
        title: "The Llama 3 Herd of Models",
        url: "https://arxiv.org/pdf/2407.21783",
        version: "v3"
      },
      {
        type: "official_model_card",
        url: "https://huggingface.co/meta-llama/Llama-3.1-8B-Instruct"
      }
    ]
  },
  derived_models: [
    {
      model_id: "NousResearch/Hermes-3-Llama-3.1-8B",
      parent_model: "meta-llama/Llama-3.1-8B",
      relationship: "instructionTunedFrom",
      supplier: "Nous Research",
      license_reported: "llama3",
      artifact: {
        format: "safetensors",
        tensor_type: "BF16",
        parameter_scale: "8B",
        library: "transformers"
      },
      delta: {
        added_capabilities_claimed: [
          "generalist instruction following",
          "advanced agentic behavior",
          "function calling",
          "JSON/structured output",
          "roleplaying",
          "multi-turn conversation",
          "long-context coherence",
          "improved code generation"
        ],
        added_prompt_protocol: "ChatML with added turn/role special tokens",
        added_data_characteristics: [
          "synthetic data",
          "distillation-oriented data"
        ],
        modified_primary_purpose:
          "base language model -> generalist instruct/tool-use assistant",
        retained: [
          "Llama 3.1 8B Transformer backbone",
          "8B parameter scale"
        ],
        unknown: [
          "complete training dataset inventory",
          "complete dataset mixture ratios",
          "training compute",
          "exact artifact checksums in this extraction"
        ]
      },
      sources: [
        {
          type: "huggingface_model_card",
          url: "https://huggingface.co/NousResearch/Hermes-3-Llama-3.1-8B"
        },
        {
          type: "technical_report",
          url: "https://arxiv.org/abs/2408.11857"
        }
      ]
    },
    {
      model_id: "FreedomIntelligence/HuatuoGPT-o1-8B",
      parent_model: "meta-llama/Llama-3.1-8B-Instruct",
      relationship: "domainFineTunedAndReinforcementOptimizedFrom",
      supplier: "FreedomIntelligence",
      license_reported: "apache-2.0",
      artifact: {
        format: "safetensors",
        tensor_type: "BF16",
        parameter_scale: "8B"
      },
      delta: {
        added_domain: "medicine",
        added_capabilities_claimed: [
          "complex medical reasoning",
          "iterative reflection and correction",
          "thinks-before-it-answers output"
        ],
        added_output_protocol: [
          "## Thinking",
          "## Final Response"
        ],
        added_training_data: [
          {
            name: "medical-o1-verifiable-problem",
            size: "40K final verifiable medical problems",
            derived_from: [
              "MedQA-USMLE training set",
              "MedMCQA training set"
            ],
            source_pool: "192K medical multiple-choice questions",
            processing: [
              "difficulty filtering",
              "unique-answer filtering",
              "GPT-4o-assisted ambiguity filtering",
              "conversion to open-ended problems"
            ]
          },
          {
            name: "medical-o1-reasoning-SFT",
            generation:
              "reasoning trajectories synthesized through search and verifier feedback"
          }
        ],
        added_training_methods: [
          "SFT on verifier-guided complex reasoning trajectories",
          "PPO with verifier-based sparse rewards"
        ],
        added_external_models: [
          {
            role: "reasoning trajectory generator and medical verifier",
            model: "GPT-4o"
          }
        ],
        modified_primary_purpose:
          "general assistant -> medical reasoning model",
        known_risk:
          "Medical outputs require expert validation and must not be treated as clinical advice.",
        unknown: [
          "full SFT/PPO hyperparameters for the released 8B artifact in the model card",
          "exact repository revision and artifact hashes"
        ]
      },
      sources: [
        {
          type: "huggingface_model_card",
          url: "https://huggingface.co/FreedomIntelligence/HuatuoGPT-o1-8B"
        },
        {
          type: "paper",
          url: "https://arxiv.org/pdf/2412.18925"
        },
        {
          type: "github",
          url: "https://github.com/FreedomIntelligence/HuatuoGPT-o1"
        }
      ]
    },
    {
      model_id: "HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge",
      parent_model: "meta-llama/Llama-3.1-8B-Instruct",
      relationship: "taskFineTunedFrom",
      supplier: "HiTZ Center and collaborators",
      license_reported: {
        base_model: "Llama 3.1 license",
        fine_tuned_weights_code_dataset: "Apache-2.0 as stated in model card"
      },
      artifact: {
        format: "safetensors",
        parameter_scale: "8B"
      },
      delta: {
        added_task: "LLM-as-a-Judge for truthfulness assessment",
        added_languages: [
          "English",
          "Basque",
          "Catalan",
          "Galician",
          "Spanish"
        ],
        added_training_data: [
          {
            name: "HiTZ/truthful_judge",
            role: "multilingual truthfulness judge fine-tuning"
          }
        ],
        added_evaluation: {
          primary_metric: "Spearman correlation with human truthfulness judgments",
          additional_reported_metric: "language-specific Kappa"
        },
        modified_primary_purpose:
          "general assistant -> multilingual truthfulness evaluator",
        removed_or_out_of_scope: [
          "general-purpose dialogue generation",
          "direct factual answering",
          "unvalidated safety-critical use"
        ],
        inherited_risks: [
          "base-model biases",
          "TruthfulQA-derived benchmark biases"
        ],
        unknown: [
          "complete training hyperparameters in this extraction",
          "artifact hashes and immutable HF revision"
        ]
      },
      sources: [
        {
          type: "huggingface_model_card",
          url: "https://huggingface.co/HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge"
        },
        {
          type: "paper",
          url: "https://arxiv.org/abs/2502.09387"
        },
        {
          type: "github",
          url: "https://github.com/hitz-zentroa/truthfulqa-multi"
        }
      ]
    },
    {
      model_id: "FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp",
      parent_model: "meta-llama/Llama-3.1-8B-Instruct",
      relationship: "adapterTrainedFrom",
      supplier: "FlorianJK; method based on Meta SecAlign",
      license_reported: "llama3.1",
      artifact: {
        type: "PEFT LoRA adapter",
        library: "peft",
        dtype: "bfloat16",
        revision: "0424f26c1714fd488bad63c348c96070d46de30f"
      },
      delta: {
        added_security_goal: "resistance to prompt-injection attacks",
        added_training_method: "DPO via SecAlign++",
        adapter_configuration: {
          rank: 32,
          alpha: 8,
          target_modules: [
            "q_proj",
            "v_proj",
            "gate_proj",
            "up_proj",
            "down_proj"
          ]
        },
        added_training_data: [
          {
            name: "synthetic_alpaca",
            size: 19157,
            features: [
              "self-generated chosen/rejected responses",
              "randomly positioned adversarial instructions"
            ]
          }
        ],
        training_hyperparameters: {
          epochs: 3,
          batch_size: 1,
          gradient_accumulation_steps: 16,
          learning_rate: 0.00016,
          dpo_beta: 0.1
        },
        retained: [
          "all base weights remain external to the adapter",
          "base tokenizer"
        ],
        operational_dependency:
          "Must be loaded on top of meta-llama/Llama-3.1-8B-Instruct using PEFT.",
        unknown: [
          "independent security evaluation results in the repository excerpt",
          "full data-generation provenance"
        ]
      },
      sources: [
        {
          type: "revision_pinned_huggingface_commit",
          url: "https://huggingface.co/FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp/commit/0424f26c1714fd488bad63c348c96070d46de30f"
        },
        {
          type: "github",
          url: "https://github.com/facebookresearch/Meta_SecAlign"
        }
      ]
    },
    {
      model_id: "mlx-community/Meta-Llama-3.1-8B-Instruct-bf16",
      parent_model: "meta-llama/Llama-3.1-8B-Instruct",
      relationship: "convertedFrom",
      supplier: "mlx-community",
      license_reported: null,
      artifact: {
        format: "MLX",
        tensor_type: "BF16",
        parameter_scale: "8B",
        reported_size: "16.1 GB",
        conversion_tool: "mlx-lm 0.19.0"
      },
      delta: {
        added_operational_feature: "native MLX runtime packaging for Apple silicon",
        modified_artifact_format:
          "original Transformers/PyTorch distribution -> MLX",
        modified_runtime_dependency: "mlx-lm",
        semantic_training_delta: "none reported",
        retained: [
          "model architecture",
          "weights at BF16 precision",
          "tokenizer/chat template",
          "intended conversational behavior"
        ],
        unknown: [
          "conversion command and flags",
          "numerical equivalence tests",
          "artifact checksums and immutable revision",
          "explicit license field on the inspected page"
        ]
      },
      sources: [
        {
          type: "huggingface_model_card",
          url: "https://huggingface.co/mlx-community/Meta-Llama-3.1-8B-Instruct-bf16"
        }
      ]
    }
  ]
};
