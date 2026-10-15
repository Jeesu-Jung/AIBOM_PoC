# AIBOM DB 테이블 구조 분석

- 대상: `Dump20260929.sql` (MySQL 8.0.44, DB `aibom`, 2026-09-29 덤프)
- 구성: 테이블 12개 + 뷰 3개
- 관련 마이그레이션: `sql/001` ~ `sql/006`

---

## 1. 전체 구조 한눈에 보기

테이블은 역할에 따라 세 그룹으로 나뉩니다.

| 그룹 | 테이블 | 역할 | 출처 마이그레이션 |
|---|---|---|---|
| **카탈로그 (UI용)** | `model_info`, `model_hierarchy` | 모델 목록, 패밀리/계보 트리, 체크리스트 점수 | `001` |
| **AIBOM 영역 테이블** | `model`, `dataset`, `transformation`, `evaluation`, `provenance`, `safety_ethics`, `license_policy`, `reference` | `AIBOM_스키마_설계안.md` §2의 8개 영역을 영역당 1개 테이블로 옮긴 것 | `004` |
| **AI 리서치 이력** | `model_research_run`, `model_research_result` | 관리자 화면에서 실행한 AI 리서치 1회와 그 결과(소스별)를 보관 | `003`, `006` |
| **뷰** | `v_model_aibom`, `v_model_evaluation`, `v_model_lineage` | 영역 테이블을 모델 단위로 다시 모아 보여 줌 | `005` |

### 관계도

```
                         ┌──────────────────────┐
                         │      model_info      │  (카탈로그 중심, PK model_id)
                         └──────────┬───────────┘
      ┌──────────────┬──────────────┼──────────────┬───────────────┬──────────────────┐
      │1:1 CASCADE   │1:1 CASCADE   │1:N CASCADE   │1:1 CASCADE    │1:1 CASCADE       │N:1 SET NULL
      ▼              ▼              ▼              ▼               ▼                  │
 model_hierarchy   model        evaluation   transformation   safety_ethics   model_research_run
 (parent_model_id                │    │       (output UNIQUE)                         │1:N CASCADE
  → model_info,                  │    │N:1 SET NULL                                   ▼
  RESTRICT)                      │    ▼                                     model_research_result
                                 │  dataset ──N:1 SET NULL──┐
                     N:1 SET NULL│                          ▼
                                 └────────────────────► provenance
                                                            ┊ evidence(JSON id 배열)
   license_policy ┄┄ subject='model:<id>'|'dataset:<id>'     ┊
   provenance     ┄┄ subject / parent (문자열 참조)          ▼
   transformation ┄┄ input[].model, datasets[].dataset   reference
   evaluation     ┄┄ extensions.reference (URI)  ┄┄┄┄┄┄┄► (uri)

   ─── 실제 FK 제약     ┄┄┄ JSON/문자열로만 연결된 소프트 참조(FK 없음)
```

**핵심 설계 포인트**

1. **`model_info`가 모든 모델 데이터의 루트**입니다. 모델 관련 테이블(`model`, `model_hierarchy`, `evaluation`, `transformation`, `safety_ethics`)은 전부 `model_info.model_id`를 FK로 참조하고 `ON DELETE CASCADE`라서, 카탈로그에서 모델을 지우면 AIBOM 데이터도 같이 지워집니다.
2. **모델과 데이터셋을 함께 다루는 테이블**(`provenance`, `license_policy`)은 FK 대신 `subject` 문자열에 `model:<hf id>` 또는 `dataset:<id>` 접두어를 붙여 대상을 구분합니다(다형 참조).
3. **다중값 필드는 JSON 배열**이고, 역방향 조회가 필요한 필드(`provenance.parent`, `provenance.evidence`, `transformation.input[*].model`, `transformation.datasets[*].dataset`)에는 **MySQL 8.0.17+ 다중값 인덱스(multi-valued index)**가 걸려 있어 `'<id>' MEMBER OF (...)` 조회도 인덱스를 탑니다.
4. **설계안 필드 외의 정보는 각 테이블의 `extensions` JSON 컬럼**에 넣습니다. 컬럼 주석에 예상 키가 적혀 있습니다.
5. HF 모델 ID처럼 대소문자를 구분해야 하는 식별자 컬럼은 `utf8mb4_bin` 콜레이션을 씁니다(테이블 기본값은 `utf8mb4_0900_ai_ci`).

---

## 2. 카탈로그 테이블

### 2.1 `model_info` — 모델 카탈로그 (13행)

UI가 쓰는 모델 목록이자 모든 모델 데이터의 기준 테이블입니다. HF 모델 카드, CycloneDX AIBOM, 필드 체크리스트 결과를 한 행으로 평탄화합니다.

| 컬럼 | 타입 | 설명 |
|---|---|---|
| `model_id` **PK** | varchar(512) bin | HF 모델 ID (`namespace/name`) |
| `namespace`, `model_name` | varchar(255) | `model_id`를 나눈 값 |
| `family_key`, `family_name` | varchar | 모델 패밀리 (`llama31`/`Llama 3.1`, `qwen25`/`Qwen 2.5`) |
| `model_role` | enum `BASE`/`INSTRUCT`/`DERIVED` | 패밀리 안에서의 역할 |
| `supplier`, `family_developer`, `family_release_date`, `family_license_name` | | 공급자·패밀리 메타데이터 |
| `primary_purpose`, `model_version`, `package_url`, `model_url`(NOT NULL) | | 모델 기본 정보 |
| `license_reported` | json | 원천에 적힌 라이선스 값 |
| `artifact_format`, `tensor_type`, `parameter_scale`, `artifact_revision` | | 아티팩트 정보 |
| `description` | text | 설명 |
| `bom_format`, `bom_spec_version`, `bom_serial_number`, `bom_version` | | CycloneDX BOM 헤더 |
| `checklist_present_fields`, `checklist_total_fields`, `checklist_score`, `checklist_penalty_factor` | | 필드 체크리스트 결과 (채워진 필드 수/전체, 0~100 점수, 0~1 페널티) |
| `source_generated_at` | datetime(6) | 원천 생성 시각 (UTC) |
| `details_json` | json NOT NULL | 원본 문서 전체: `model`, `family`, `checklist`, `cyclonedx`, `family_config`, `legacy_lineage_context` |
| `created_at`, `updated_at` | timestamp(6) | 자동 관리 |

- **인덱스**: `(family_key, model_role)`, `supplier`, `checklist_score` → 패밀리별 목록, 공급자 필터, 점수 정렬용
- **CHECK 제약**: JSON 유효성(`license_reported`, `details_json`), 점수 범위 0–100, 페널티 0–1, `present_fields ≤ total_fields`
- **데이터**: Llama 3.1 계열 7개, Qwen 2.5 계열 6개. BASE 2, INSTRUCT 2, DERIVED 9. 체크리스트 점수는 54.40 ~ 62.20.

### 2.2 `model_hierarchy` — 모델 계보 트리 (13행)

모델당 한 행으로 "직접 부모 1개"만 저장하는 인접 리스트(adjacency list) 트리입니다.

| 컬럼 | 설명 |
|---|---|
| `model_id` **PK, FK→model_info** (CASCADE) | 자식 모델 |
| `parent_model_id` FK→model_info (**RESTRICT**) | 부모 모델. 루트는 NULL |
| `relationship_type` | `adapterTrainedFrom`, `convertedFrom`, `instructionTunedFrom`, `preferenceOptimizedFrom`, `contextExtendedFrom`, `taskFineTunedFrom`, `domainFineTunedAndReinforcementOptimizedFrom` 등 (camelCase) |
| `hierarchy_depth` | 루트 0, 자식 1 이상 |
| `sibling_order` | 같은 부모 아래 정렬 순서 |
| `change_details_json` | 부모 대비 변경 내역 |

- **CHECK 제약**
  - 자기 자신을 부모로 둘 수 없음
  - "루트 ⇔ `parent`·`relationship_type` NULL이고 depth=0", "자식 ⇔ 둘 다 NOT NULL이고 depth>0"
- **부모 FK가 RESTRICT**: 자식이 있는 모델은 먼저 지울 수 없습니다. 반면 `model_info` 삭제 시 자신의 hierarchy 행은 CASCADE로 지워지므로, 리프부터 지워야 합니다.
- **데이터 특징**: BASE뿐 아니라 INSTRUCT(`Llama-3.1-8B-Instruct`, `Qwen2.5-7B-Instruct`)도 depth 0 루트로 저장되어 있습니다. 즉 이 트리는 "BASE → INSTRUCT" 관계를 표현하지 않고, 파생 모델이 붙는 기준점으로 BASE/INSTRUCT를 모두 루트로 둡니다. BASE↔INSTRUCT 관계는 `provenance`/`transformation` 쪽에 있습니다.

---

## 3. AIBOM 영역 테이블

`AIBOM_스키마_설계안.md` §2의 8개 영역(MODEL, DATASET, TRANSFORMATION, EVALUATION, PROVENANCE, SAFETY_ETHICS, LICENSE_POLICY, REFERENCE)과 1:1로 대응하며, 컬럼명이 설계안 필드명과 같습니다. 데이터는 `scripts/aibom/load_research.py`가 적재합니다.

### 3.1 `model` — MODEL 영역 (13행)

| 컬럼 | 설명 |
|---|---|
| `identity` **PK, FK→model_info** (CASCADE) | 모델 ID (`model_info`와 1:1) |
| `architecture` json | `{family, parameter_count, context_length, layers, hidden_size, ...}` |
| `tokenizer` json | `{name, vocab_size}` |
| `modality` json | `{input: [...], output: [...], languages: [...]}` |
| `intended_use` text | 사용 목적 |
| `capabilities`, `limitations` json | 능력·한계 목록 |
| `provenance` FK→provenance (SET NULL) | 이 모델의 출처 레코드 |
| `extensions` json | `{knowledge_cutoff, release_date, unknowns, evidence}` — `evidence`는 MODEL 필드 근거가 되는 `reference.id` 목록 |

`model_info`는 "카탈로그/점수" 관점, `model`은 "AIBOM 기술 사양" 관점으로 같은 모델을 나눠 담습니다.

### 3.2 `dataset` — DATASET 영역 (47행)

| 컬럼 | 설명 |
|---|---|
| `identity` **PK** (bin) | HF 데이터셋 ID. HF에 없으면 `slug:<name>` |
| `version` | 리비전(커밋 해시 등) |
| `role` **SET**(`pretraining`,`finetuning`,`evaluation`) | 카탈로그 전체에서 이 데이터셋이 맡는 역할 (복수 가능). 모델별 역할은 `transformation.datasets` / `evaluation.dataset`에 있음 |
| `processing` json | 전처리 내용 |
| `license` | 원천 표기 라이선스 (상세는 `license_policy`의 `dataset:<id>`) |
| `provenance` FK→provenance (SET NULL) | 출처 |
| `extensions` json | `{name, hf_id, uri, description, size, modality, provider}` |

- 데이터: evaluation 전용 29, finetuning 10, finetuning+evaluation 4, pretraining 2, 미지정 2. 47개 모두 `provenance`가 연결되어 있습니다.
- 데이터셋은 특정 모델에 종속되지 않는 **공유 엔터티**이며, 모델과는 `transformation.datasets`(학습)와 `evaluation.dataset`(평가)을 통해 N:M으로 연결됩니다.

### 3.3 `transformation` — TRANSFORMATION 영역 (13행)

모델을 만들어 낸 학습/변환 과정입니다. **산출 모델당 1행** (`output` UNIQUE).

| 컬럼 | 설명 |
|---|---|
| `id` PK | |
| `input` json | `[{model, role, external}]` — role: `base`/`merge_source`/`teacher`/`generator`/`verifier`/`reward_model`. `external=true`면 카탈로그 밖 모델 |
| `output` **UNIQUE, FK→model_info** (CASCADE) | 산출 모델 |
| `method` json NOT NULL | 순서가 있는 단계 목록 (예: `["instruction tuning (inherited base)", "DPO via SecAlign++", "LoRA adapter fine-tuning"]`) |
| `objective` text | 목적 |
| `hyperparameters` json | 학습 설정. 어댑터 설정은 `"adapter"` 키 아래 |
| `datasets` json | `[{dataset, role}]` — role: `pretraining`/`finetuning`/`preference`/`distillation`/`calibration`/`other` |
| `timestamp` date | |
| `extensions` json | `{notes, evidence}` (뷰가 `$.evidence[*]` URI를 reference와 매칭) |

- **다중값 인덱스**: `input[*].model`, `datasets[*].dataset` → "이 모델을 base로 쓴 모델", "이 데이터셋으로 학습한 모델" 역조회용
- `input`은 FK가 아니라 문자열이므로 `teacher`/`generator`처럼 카탈로그에 없는 외부 모델(예: GPT-4o)도 담을 수 있습니다.
- 데이터: input role은 base 11, generator 2, verifier 1. BASE 모델 2개는 `input`이 NULL(사전학습). datasets role은 finetuning 8, preference 5, distillation 3, pretraining 2.

### 3.4 `evaluation` — EVALUATION 영역 (152행)

벤치마크 결과 한 건이 한 행입니다.

| 컬럼 | 설명 |
|---|---|
| `id` PK | |
| `model` FK→model_info (CASCADE) | 평가 대상 모델 |
| `dataset` FK→dataset (SET NULL) | 평가 데이터셋. 데이터셋으로 등록되지 않은 벤치마크는 NULL |
| `configuration` json | `{benchmark, shots, cot, notes, model_tested, ...}` |
| `metric` | `acc`, `pass@1`, `ASR`, `em`, `cohen_kappa` 등 |
| `score` decimal(14,4) | 수치 점수 |
| `timestamp` date | 결과가 보고된 날짜(원천 리비전 공개일) |
| `extensions` json | `{score_text, baseline_model, baseline_score, evaluator_model, reference}` — `reference`는 근거 URI |

- 데이터: 152건 중 60건은 `dataset`이 NULL이고 벤치마크 이름은 `configuration.benchmark`에만 있습니다. 모델별로 4~25건이며, `mlx-community` 변환 모델 2개는 평가 결과가 없습니다.

### 3.5 `provenance` — PROVENANCE 영역 (60행)

모델과 데이터셋의 **출처와 직접 부모**를 기록합니다.

| 컬럼 | 설명 |
|---|---|
| `id` PK | |
| `subject` **UNIQUE** (bin) | `model:<id>` 또는 `dataset:<id>` — 대상당 1행 |
| `origin` | 원 출처(기관/프로젝트) |
| `provider` | 배포 주체 |
| `parent` json | 직접 부모 목록 `["model:<id>", "dataset:<id>", ...]` |
| `relation` | `pretrained`, `fine_tuned_from`, `adapter_trained_from`, `converted_from`, `derived_from`, ... (snake_case) |
| `evidence` json | 근거 `reference.id` 배열 `[1, 2]` |
| `extensions` json | `{disclosure_status, notes}` |

- **다중값 인덱스**: `parent`(문자열 배열), `evidence`(정수 배열)
- `model.provenance`, `dataset.provenance`가 이 테이블을 FK로 가리키고, 반대로 `subject`도 대상을 가리키므로 연결이 양방향입니다(`subject` 쪽은 FK 없음).
- 데이터: model 13, dataset 47. relation은 `original` 40건(대부분 데이터셋), 나머지는 파생 관계. `disclosure_status`는 disclosed 41 / partially_disclosed 15 / undisclosed 4.
- `model_hierarchy.relationship_type`(camelCase, 부모 1개)과 `provenance.relation`(snake_case, 부모 여러 개 + 데이터셋 부모 가능)은 같은 관계를 서로 다른 표기와 세분도로 담고 있습니다.

### 3.6 `safety_ethics` — SAFETY_ETHICS 영역 (10행)

| 컬럼 | 설명 |
|---|---|
| `subject` **PK, FK→model_info** (CASCADE) | 모델 ID (1:1) |
| `safety_risk` json | `[{description, reference}]` |
| `ethical_considerations`, `prohibited_use`, `mitigation` json | |
| `extensions` json | `{risk_summary}` |

- 데이터: 13개 모델 중 10개만 있고 `Qwen/Qwen2.5-7B`, `Qwen/Qwen2.5-7B-Instruct`, `Qwen/Qwen2.5-7B-Instruct-1M`은 행이 없습니다.

### 3.7 `license_policy` — LICENSE_POLICY 영역 (51행)

| 컬럼 | 설명 |
|---|---|
| `id` PK | |
| `subject` (bin) | `model:<id>` 또는 `dataset:<id>` |
| `license` NOT NULL | 라이선스 이름 |
| `usage_policy` | 사용 정책(AUP 등) |
| `restrictions` json | 제한 사항 |
| `extensions` json | `{license_key, spdx_id, license_uri, usage_policy_uri, kind, scope_note, commercial_use}` |

- **UNIQUE `(subject, license)`**: 한 대상이 여러 라이선스를 가질 수 있습니다. 예: `HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge`는 Llama 3.1 Community License와 Apache 2.0 두 행(base 모델 라이선스 + 자체 배포 라이선스).
- `license` 단독 인덱스로 "특정 라이선스를 쓰는 대상" 조회를 지원합니다.
- 데이터: model 14행, dataset 37행.

### 3.8 `reference` — REFERENCE 영역 (91행)

모든 영역이 근거로 삼는 출처 문서입니다.

| 컬럼 | 설명 |
|---|---|
| `id` PK | 다른 테이블의 `evidence` 배열이 이 값을 가리킴 |
| `type` enum | `paper`, `technical_report`, `model_card`, `dataset_card`, `repository`, `config`, `documentation`, `license`, `blog`, `webpage` |
| `uri` varchar(1000) | |
| `revision` | git sha, arXiv 버전 등 |
| `retrieved_at` date | 수집일 |
| `hash` char(64) | 수집 시점 콘텐츠의 SHA-256 |
| `extensions` json | `{title, published_at, http_status}` |
| `uri_hash` **GENERATED STORED**, UNIQUE | `SHA2(uri, 256)` |

- `uri`가 최대 1000자라 직접 UNIQUE 인덱스를 걸기 어려워서, **생성 컬럼 `uri_hash`로 URI 중복을 막습니다**.
- 참조 방식이 두 가지입니다. `provenance.evidence`와 `model.extensions.evidence`는 **id**로, `evaluation.extensions.reference`와 `transformation.extensions.evidence`는 **URI**로 참조합니다(뷰에서 둘 다 처리).
- 데이터: webpage 22, model_card 21, paper 18, dataset_card 8, repository 7, license 6, technical_report 5, config 4. 91건 중 `hash`는 90건, `revision`은 85건에 있습니다.

---

## 4. AI 리서치 이력 테이블

관리자 화면에서 모델 이름을 입력해 AI(OpenRouter) 리서치를 돌린 이력입니다.

### 4.1 `model_research_run` — 리서치 실행 1회 (1행)

| 컬럼 | 설명 |
|---|---|
| `id` PK | |
| `requested_model` | 관리자가 입력한 모델 이름/ID (정규화) |
| `model_id` FK→model_info (SET NULL) | 이 실행의 초안을 저장해 카탈로그에 등록하면 채워짐 |
| `created_at`, `updated_at` | |

- 인덱스 `(requested_model, created_at)`로 "같은 모델의 과거 실행" 조회를 지원합니다.
- 덤프의 1건(`openai/gpt-oss-120b`)은 `model_id`가 NULL입니다. 리서치는 끝났지만 카탈로그에 저장되지 않은 상태입니다.

### 4.2 `model_research_result` — 실행별·소스별 결과 (3행)

| 컬럼 | 설명 |
|---|---|
| `id` PK | |
| `run_id` FK→model_research_run (CASCADE) | |
| `requested_model` | 입력값 (trim) |
| `source` enum | `huggingface` / `paper` / `merged` |
| `status` | `found` / `ambiguous` / `not_found` |
| `result_model_id` (bin) | 결과 초안의 `draft.modelId` (FK 없음) |
| `research_model` | 결과를 만든 OpenRouter 모델 |
| `web_search_requests`, `cost_usd` | 사용량·비용 |
| `result_json` json NOT NULL | `ModelResearchResult` / `ModelMergeResult` 전체 페이로드 |

- **UNIQUE `(run_id, source)`**: 실행 1회마다 HF 리서치, 논문 리서치, 병합 결과가 각각 최대 1건입니다.
- 덤프 데이터: run 1에 3건(모두 `found`, `openai/gpt-5.6-luna`). 비용은 각각 $0.1718 / $0.1231 / $0.0196.

---

## 5. 뷰

### 5.1 `v_model_aibom` — 모델별 AIBOM 전체 문서

`model_info LEFT JOIN model`을 기준으로, 모델 한 행에 8개 영역을 JSON으로 모아 줍니다.

| 출력 컬럼 | 구성 |
|---|---|
| `model_id`, `family_key`, `family_name`, `model_role` | `model_info` |
| `model` | `model` 전체 + `catalog{model_url, revision, primary_purpose}` |
| `provenance` | 모델의 provenance 레코드 + `evidence_uris`(evidence id → reference.uri) |
| `transformation` | `output = model_id`인 1행 |
| `datasets` | 학습 데이터셋(`transformation.datasets[*].dataset`) ∪ 평가 데이터셋(`evaluation.dataset`), 각 데이터셋의 provenance `parent`/`relation`/`disclosure_status` 포함 |
| `evaluation` | 해당 모델의 평가 배열 |
| `safety_ethics` | 1:1 레코드 |
| `license_policy` | `subject = 'model:' + model_id`인 행 배열 |
| `reference` | `model.extensions.evidence` ∪ `provenance.evidence`(id) ∪ `evaluation.extensions.reference`(URI) ∪ `transformation.extensions.evidence[*]`(URI, `JSON_TABLE`) |

`MEMBER OF`, `JSON_ARRAYAGG`, `JSON_TABLE`을 사용하므로 MySQL 8.0.17 이상이 필요합니다. 상관 서브쿼리가 많아 전체 스캔은 무겁고, `WHERE model_id = ?` 단건 조회에 맞춰져 있습니다.

### 5.2 `v_model_evaluation` — 평가 결과 평탄화

`evaluation LEFT JOIN dataset`. JSON 안의 값을 컬럼으로 꺼냅니다: `benchmark`, `score_text`, `baseline_model`, `baseline_score`, **`delta_vs_baseline`(= score − baseline_score)**, `evaluator_model`, `dataset_name`, `source_uri` 등.

### 5.3 `v_model_lineage` — 계보 비교

`model JOIN model_info LEFT JOIN provenance / transformation / model_hierarchy`. 한 행에 두 계보 표현을 나란히 둡니다:
- AIBOM 쪽: `relation`, `origin`, `provider`, `parent`, `disclosure_status`, `method`, `input`, `datasets`
- 카탈로그 쪽: `hierarchy_parent_model_id`, `hierarchy_relationship_type`

두 계보 데이터가 서로 맞는지 확인할 때 씁니다.

---

## 6. 무결성 정리

### 6.1 FK 제약과 삭제 동작

| 자식 → 부모 | ON DELETE | 의미 |
|---|---|---|
| `model.identity` → `model_info` | CASCADE | 카탈로그 삭제 시 AIBOM 삭제 |
| `model_hierarchy.model_id` → `model_info` | CASCADE | |
| `model_hierarchy.parent_model_id` → `model_info` | **RESTRICT** | 자식이 있는 부모는 삭제 불가 |
| `evaluation.model` → `model_info` | CASCADE | |
| `transformation.output` → `model_info` | CASCADE | |
| `safety_ethics.subject` → `model_info` | CASCADE | |
| `model_research_run.model_id` → `model_info` | SET NULL | 모델이 지워져도 리서치 이력은 남김 |
| `model_research_result.run_id` → `model_research_run` | CASCADE | |
| `evaluation.dataset` → `dataset` | SET NULL | |
| `model.provenance`, `dataset.provenance` → `provenance` | SET NULL | |

### 6.2 FK 없는 소프트 참조 (적재 스크립트가 보장해야 함)

| 위치 | 가리키는 대상 |
|---|---|
| `provenance.subject`, `license_policy.subject` | `model:<id>` → model_info / `dataset:<id>` → dataset |
| `provenance.parent[*]` | 같은 접두어 형식 |
| `provenance.evidence[*]`, `model.extensions.evidence[*]` | `reference.id` |
| `transformation.input[*].model` | model_info (`external=true`면 카탈로그 밖 모델) |
| `transformation.datasets[*].dataset` | dataset |
| `evaluation.extensions.reference`, `transformation.extensions.evidence[*]` | `reference.uri` |
| `model_research_result.result_model_id` | model_info (아직 저장되지 않은 초안일 수 있음) |

`provenance`/`license_policy`에서 모델을 지우면 CASCADE가 동작하지 않으므로 `model:<id>` 행이 남습니다. 모델 삭제 로직에서 따로 정리해야 합니다.

---

## 7. 관찰 사항 / 검토 포인트

1. **계보가 두 군데에 있음**: `model_hierarchy`(UI 트리, camelCase, 부모 1개)와 `provenance`+`transformation`(AIBOM, snake_case, 부모 여러 개). 관계 표기 매핑표가 없어서 `v_model_lineage`로 눈으로 비교해야 합니다. 한쪽을 원본으로 정하고 다른 쪽은 파생시키는 방안을 검토할 만합니다.
2. **INSTRUCT 모델이 hierarchy 루트**: `Llama-3.1-8B-Instruct`, `Qwen2.5-7B-Instruct`가 depth 0입니다. 트리만 보면 BASE와 INSTRUCT 사이 관계가 보이지 않습니다.
3. **마이그레이션과 덤프 차이**: `provenance.subject`가 `sql/004`에서는 `VARCHAR(520)`인데 덤프에서는 `VARCHAR(600)`입니다. 이후 ALTER가 마이그레이션 파일에 반영되지 않았을 수 있습니다.
4. **영역별 커버리지 공백**: `safety_ethics`에 Qwen 3종이 없고, `evaluation`에 mlx-community 변환 모델 2종이 없습니다. 평가 152건 중 60건은 `dataset` 연결이 없습니다.
5. **`dataset.role`(SET)과 모델별 역할의 중복**: 카탈로그 전체 역할을 따로 저장하므로 `transformation`/`evaluation` 변경 시 같이 갱신해야 합니다(파생값).
6. **`model_info.details_json`에 원본 전체 보관**: 평탄화한 컬럼과 원본 JSON이 같이 있어, 컬럼만 수정하면 둘이 어긋날 수 있습니다.
7. **리서치 이력과 카탈로그 연결**: `model_research_run.model_id`는 FK(SET NULL)지만 `model_research_result.result_model_id`는 FK가 없습니다. 초안 단계의 ID를 담아야 하므로 의도된 설계로 보입니다.
