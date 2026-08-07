window.AIBOM_FAMILIES = {
  llama31: {
    id: "llama31",
    label: "Llama 3.1",
    default_node_id: "meta-llama/Llama-3.1-8B-Instruct",
    document_node: {
      id: "document:llama-3.1-report",
      title: "Llama 3.1 technical report",
      subtitle: "The evidence root used to populate the initial family AIBOM."
    },
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
      focus_variant: {
        label: "8B slice",
        layers: 32,
        hidden_size: 4096,
        ffn_size: 14336,
        attention_heads: 32,
        key_value_heads: 8,
        context_length: 131072,
        generation_length: null,
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
    root_nodes: [
      {
        id: "meta-llama/Llama-3.1-8B",
        kind: "root",
        title: "meta-llama/Llama-3.1-8B",
        subtitle: "Base checkpoint for the 8B lineage slice."
      },
      {
        id: "meta-llama/Llama-3.1-8B-Instruct",
        kind: "root",
        title: "meta-llama/Llama-3.1-8B-Instruct",
        subtitle: "Post-trained instruction model used by most downstream examples."
      }
    ],
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
  },
  qwen25: {
    id: "qwen25",
    label: "Qwen 2.5",
    default_node_id: "Qwen/Qwen2.5-7B-Instruct",
    document_node: {
      id: "document:qwen2.5-release-materials",
      title: "Qwen2.5 release materials",
      subtitle:
        "Official Qwen2.5 release blog, model cards, and configuration files used as the evidence root."
    },
    root_family: {
      family_id: "Qwen/Qwen2.5",
      developer: "Qwen Team (Alibaba Cloud)",
      release_date: "2024-09-19",
      license: "Apache-2.0 for the 7B slice shown here",
      model_variants: [
        "Qwen2.5-0.5B",
        "Qwen2.5-1.5B",
        "Qwen2.5-3B",
        "Qwen2.5-7B",
        "Qwen2.5-14B",
        "Qwen2.5-32B",
        "Qwen2.5-72B"
      ],
      architecture: {
        family: "dense decoder-only Transformer",
        objective: "autoregressive next-token prediction",
        activation: "SwiGLU",
        normalization: "RMSNorm",
        position_embedding: "RoPE",
        rope_theta: 1000000,
        vocabulary_size_reported: 152064,
        attention: "grouped-query attention with QKV bias"
      },
      focus_variant: {
        label: "7B slice",
        layers: 28,
        hidden_size: 3584,
        ffn_size: 18944,
        attention_heads: 28,
        key_value_heads: 4,
        context_length: 131072,
        generation_length: 8192,
        parameter_scale: "7.61B"
      },
      pretraining: {
        data_cutoff: null,
        corpus_size_family: "up to 18T multilingual tokens",
        flagship_405b_tokens: null,
        stages: [
          "large-scale multilingual pretraining"
        ],
        data_processing: [
          "128K long-context support",
          "multilingual coverage across 29+ languages",
          "structured data and JSON-oriented post-training goals"
        ],
        exact_dataset_inventory: null
      },
      post_training: {
        methods: [
          "instruction tuning",
          "post-training alignment"
        ],
        data_types: [
          "chat-format instruction data",
          "structured output tasks",
          "role-play and prompt-robustness data"
        ],
        capabilities_added: [
          "instruction following",
          "long-form generation",
          "structured data understanding",
          "JSON generation",
          "multilingual interaction"
        ]
      },
      sources: [
        {
          type: "official_blog",
          title: "Qwen2.5: A Party of Foundation Models!",
          url: "https://qwenlm.github.io/blog/qwen2.5/"
        },
        {
          type: "official_model_card",
          url: "https://huggingface.co/Qwen/Qwen2.5-7B"
        },
        {
          type: "official_model_card",
          url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct"
        },
        {
          type: "technical_report",
          title: "Qwen2 Technical Report",
          url: "https://arxiv.org/abs/2407.10671"
        }
      ]
    },
    root_nodes: [
      {
        id: "Qwen/Qwen2.5-7B",
        kind: "root",
        title: "Qwen/Qwen2.5-7B",
        subtitle: "Base checkpoint for the 7B lineage slice."
      },
      {
        id: "Qwen/Qwen2.5-7B-Instruct",
        kind: "root",
        title: "Qwen/Qwen2.5-7B-Instruct",
        subtitle: "Official 7B instruct checkpoint for downstream adaptation."
      }
    ],
    derived_models: [
      {
        model_id: "Qwen/Qwen2.5-7B-Instruct-1M",
        parent_model: "Qwen/Qwen2.5-7B",
        relationship: "contextExtendedFrom",
        supplier: "Qwen Team",
        license_reported: "apache-2.0",
        artifact: {
          format: "safetensors",
          tensor_type: "BF16",
          parameter_scale: "7.61B",
          library: "transformers"
        },
        delta: {
          added_capabilities_claimed: [
            "up to 1M-token context handling",
            "better long-context task performance",
            "short-task capability retention"
          ],
          added_operational_feature:
            "custom vLLM sparse attention and length extrapolation guidance for ultra-long inputs",
          modified_primary_purpose:
            "base checkpoint -> ultra-long-context instruct-style 1M-token model",
          retained: [
            "7.61B architecture",
            "RoPE, SwiGLU, RMSNorm, and QKV-bias design",
            "8192-token generation limit"
          ],
          unknown: [
            "model card metadata lists base_model as Qwen/Qwen2.5-7B while the card describes an instruct long-context variant",
            "exact training recipe used to reach the 1M context window"
          ]
        },
        sources: [
          {
            type: "huggingface_model_card",
            url: "https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-1M"
          },
          {
            type: "paper",
            url: "https://arxiv.org/abs/2501.15383"
          }
        ]
      },
      {
        model_id: "HPAI-BSC/Qwen2.5-7B-Instruct-Egida-DPO",
        parent_model: "Qwen/Qwen2.5-7B-Instruct",
        relationship: "preferenceOptimizedFrom",
        supplier: "HPAI-BSC",
        license_reported: "apache-2.0",
        artifact: {
          format: "safetensors",
          tensor_type: "BF16",
          parameter_scale: "8B"
        },
        delta: {
          added_security_goal: "reduced jailbreak success and safer responses under adversarial prompting",
          added_training_data: [
            {
              name: "Egida-DPO-Qwen2.5-7B-Instruct",
              role: "custom DPO dataset built from Egida adversarial prompts and chosen/rejected answers"
            }
          ],
          added_training_method: "DPO safety retrofitting on Egida triplets",
          added_evaluation: {
            egida_test_asr: "0.322 vs 0.471 on the parent model",
            delphi_asr: "0.118 vs 0.138 on the parent model",
            alert_adv_asr: "0.045 vs 0.080 on the parent model"
          },
          modified_primary_purpose:
            "general instruct assistant -> jailbreak-resistant instruct assistant",
          known_risk:
            "Refusal ratio rises on some benchmarks even while attack success falls.",
          unknown: [
            "long-run behavioral tradeoffs beyond the published safety and refusal metrics"
          ]
        },
        sources: [
          {
            type: "huggingface_model_card",
            url: "https://huggingface.co/HPAI-BSC/Qwen2.5-7B-Instruct-Egida-DPO"
          },
          {
            type: "paper",
            url: "https://arxiv.org/abs/2502.13603"
          }
        ]
      },
      {
        model_id: "mellee030/MedQwen-7B-LoRA",
        parent_model: "Qwen/Qwen2.5-7B-Instruct",
        relationship: "adapterTrainedFrom",
        supplier: "mellee030",
        license_reported: "apache-2.0",
        artifact: {
          type: "PEFT LoRA adapter",
          library: "peft",
          parameter_scale: "~150MB adapter"
        },
        delta: {
          added_domain: "Chinese medical question answering",
          adapter_configuration: {
            rank: 8,
            alpha: 16
          },
          added_training_data: [
            {
              name: "30,284 Chinese medical dialogue pairs",
              role: "medical Q&A adaptation",
              processing: [
                "converted to the Qwen2.5 chat template format"
              ]
            }
          ],
          added_training_method: "LoRA PEFT fine-tuning",
          added_evaluation: {
            bertscore: "0.6670 vs 0.5959 on the base comparison",
            note: "ROUGE is lower because the adapter favors concise on-format answers"
          },
          modified_primary_purpose:
            "general instruct assistant -> Chinese medical dialogue adapter",
          retained: [
            "base model general capabilities",
            "Qwen2.5 chat template compatibility"
          ]
        },
        sources: [
          {
            type: "huggingface_model_card",
            url: "https://huggingface.co/mellee030/MedQwen-7B-LoRA"
          }
        ]
      },
      {
        model_id: "mlx-community/Qwen2.5-7B-Instruct-bf16",
        parent_model: "Qwen/Qwen2.5-7B-Instruct",
        relationship: "convertedFrom",
        supplier: "mlx-community",
        license_reported: "apache-2.0",
        artifact: {
          format: "MLX",
          tensor_type: "BF16",
          parameter_scale: "8B",
          conversion_tool: "mlx-lm 0.18.1"
        },
        delta: {
          added_operational_feature: "native MLX runtime packaging for Apple silicon",
          modified_artifact_format:
            "Transformers/PyTorch distribution -> MLX",
          modified_runtime_dependency: "mlx-lm",
          semantic_training_delta: "none reported",
          retained: [
            "weights at BF16 precision",
            "chat template",
            "Qwen2.5-7B-Instruct behavior"
          ],
          unknown: [
            "conversion command and exact numerical equivalence checks"
          ]
        },
        sources: [
          {
            type: "huggingface_model_card",
            url: "https://huggingface.co/mlx-community/Qwen2.5-7B-Instruct-bf16"
          }
        ]
      }
    ]
  }
};
