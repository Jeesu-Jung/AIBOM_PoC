# AIBOM 스키마 설계안

## 1. 설계 목적

본 AIBOM(AI Bill of Materials) 스키마는 AI 모델을 구성하는 기술적 요소를 단순히 나열하는 것을 넘어, 모델과 데이터의 출처 및 파생 관계를 계층적으로 추적할 수 있는 구조를 제공하는 것을 목적으로 한다.

기존의 AIBOM 또는 모델 카드 기반 정보는 모델명, 아키텍처, 라이선스, 데이터셋, 평가 결과 등 개별 모델의 정적인 정보를 기술하는 데에는 적합하지만, 현재의 AI 생태계에서는 하나의 모델이 기반 모델의 미세조정, 정렬 학습, 양자화, 병합 등의 과정을 거쳐 지속적으로 파생되는 경우가 많다. 또한 학습 데이터 역시 원본 데이터의 정제·필터링·변환 등을 통해 새로운 데이터셋으로 재구성될 수 있다.

따라서 본 스키마는 "현재 모델이 무엇인가"뿐만 아니라 "어떤 모델과 데이터로부터, 어떠한 과정을 거쳐 현재 모델이 만들어졌는가"를 추적하는 provenance 중심의 AIBOM을 지향한다.

이를 위해 다음 정보를 핵심 관리 대상으로 정의한다.

- **모델 출처 및 계보**: 기반 모델과 파생 모델 간의 관계와 직접적인 부모 모델, 최초 출처를 추적한다.
- **학습 데이터 출처**: 사전학습(pretraining)과 미세조정(finetuning)에 사용된 데이터셋을 구분하고 각 데이터의 출처 및 파생 관계를 추적한다.
- **평가 데이터 및 결과**: 모델이 어떤 데이터셋과 평가 설정을 통해 검증되었는지를 기록한다.
- **모델 변환 과정**: 사전학습, 미세조정, 정렬, LoRA, 양자화, 병합 등 모델을 변화시킨 과정을 명시적으로 관리한다.
- **안전 및 윤리 정보**: 모델의 알려진 위험, 윤리적 고려사항, 금지 용도 및 위험 완화 조치를 기록한다.
- **라이선스 및 사용 정책**: 모델과 데이터에 적용되는 라이선스, 사용 정책 및 제한사항을 관리한다.
- **근거 자료**: 논문, 모델 카드, 데이터셋 카드, 저장소 및 공식 문서 등 각 정보의 근거가 되는 자료를 관리한다.

특히 동일한 정보를 여러 영역에서 반복해서 저장하는 것을 최소화하기 위해, 모델 및 데이터의 자체 속성과 출처 정보를 분리한다. MODEL과 DATASET은 대상 자체의 특성을 기술하고, 출처와 파생 관계는 PROVENANCE에서 관리하며, 관련 사실을 확인할 수 있는 외부 근거는 REFERENCE를 통해 연결한다.

전체 스키마는 다음 8개 핵심 영역으로 구성한다.

```
AIBOM
│
├── MODEL
├── DATASET
├── TRANSFORMATION
├── EVALUATION
├── PROVENANCE
├── SAFETY_ETHICS
├── LICENSE_POLICY
└── REFERENCE
```

각 영역의 역할은 다음과 같이 구분된다.

MODEL과 DATASET은 "무엇인가(What)"를, TRANSFORMATION은 "어떻게 만들어졌는가(How)"를, PROVENANCE는 "어디에서 왔는가(Where from)"를, EVALUATION은 "어떻게 검증되었는가(How evaluated)"를 나타낸다. SAFETY_ETHICS와 LICENSE_POLICY는 해당 모델의 위험 및 사용 조건을 관리하며, REFERENCE는 이러한 정보가 어떠한 근거에 의해 확인되었는지를 나타낸다.

## 2. AIBOM 스키마 구조

```
AIBOM
│
├── MODEL
│   ├── identity
│   ├── architecture
│   ├── tokenizer
│   ├── modality
│   ├── intended_use
│   ├── capabilities
│   ├── limitations
│   └── provenance
│
├── DATASET
│   ├── identity
│   ├── version
│   ├── role
│   │   ├── pretraining
│   │   ├── finetuning
│   │   └── evaluation
│   ├── processing
│   ├── license
│   └── provenance
│
├── TRANSFORMATION
│   ├── input
│   ├── output
│   ├── method
│   ├── objective
│   ├── hyperparameters
│   ├── datasets
│   └── timestamp
│
├── EVALUATION
│   ├── model
│   ├── dataset
│   ├── configuration
│   ├── metric
│   ├── score
│   └── timestamp
│
├── PROVENANCE
│   ├── subject
│   ├── origin
│   ├── provider
│   ├── parent
│   ├── relation
│   └── evidence
│
├── SAFETY_ETHICS
│   ├── subject
│   ├── safety_risk
│   ├── ethical_considerations
│   ├── prohibited_use
│   └── mitigation
│
├── LICENSE_POLICY
│   ├── subject
│   ├── license
│   ├── usage_policy
│   └── restrictions
│
└── REFERENCE
    ├── type
    ├── uri
    ├── revision
    ├── retrieved_at
    └── hash
```

## 3. 세부 필드 정의

| 영역 | 필드 | 설명 | DB 매핑 (테이블.컬럼) |
|---|---|---|---|
| MODEL | identity | 모델의 고유 식별 정보이다. 모델명, 버전, 모델 ID 또는 저장소 식별자 등 모델을 특정할 수 있는 정보를 포함한다. | `model.identity` (PK, = `model_info.model_id`) |
| MODEL | architecture | 모델의 구조적 특성을 기술한다. Transformer 계열 여부, decoder-only/encoder-decoder 구조, 모델 규모 등 모델 구조를 식별하는 정보를 포함한다. | `model.architecture` (JSON: family, parameter_count, context_length, layers …) |
| MODEL | tokenizer | 모델이 사용하는 토크나이저의 종류 및 식별 정보이다. 파생 모델 간 호환성 및 모델 계보 추적에 활용할 수 있다. | `model.tokenizer` (JSON: name, vocab_size) |
| MODEL | modality | 모델이 입력 또는 출력으로 처리하는 데이터 유형이다. 예: text, image, audio, multimodal. | `model.modality` (JSON: input, output, languages) |
| MODEL | intended_use | 모델이 공식적으로 설계되거나 제공자에 의해 권장되는 사용 목적 및 적용 시나리오이다. | `model.intended_use` |
| MODEL | capabilities | 모델이 제공하거나 공식적으로 문서화된 주요 기능 및 수행 가능한 작업을 기술한다. | `model.capabilities` (JSON 배열) |
| MODEL | limitations | 알려진 성능상의 한계, 적용 범위의 제약 및 기술적 한계를 기술한다. | `model.limitations` (JSON 배열) |
| MODEL | provenance | 모델의 원천, 제공자 및 파생 관계를 기술하는 PROVENANCE 정보에 대한 참조이다. | `model.provenance` → `provenance.id` |
| DATASET | identity | 데이터셋의 고유 식별 정보이다. 데이터셋명, ID 또는 저장소 식별자 등을 포함한다. | `dataset.identity` (PK: HF id 또는 `slug:<name>`) |
| DATASET | version | 실제 사용된 데이터셋의 특정 버전 또는 리비전을 나타낸다. 동일한 데이터셋의 변경 이력을 구분하는 데 사용한다. | `dataset.version` |
| DATASET | role | 해당 데이터셋이 모델 생애주기에서 어떠한 목적으로 사용되었는지를 나타낸다. | `dataset.role` (SET: pretraining, finetuning, evaluation) |
| DATASET | role.pretraining | 해당 데이터셋이 모델의 사전학습에 사용되었음을 나타낸다. | `dataset.role` ∋ 'pretraining' |
| DATASET | role.finetuning | 해당 데이터셋이 지도 미세조정, instruction tuning, preference tuning 등 후속 학습 과정에 사용되었음을 나타낸다. | `dataset.role` ∋ 'finetuning' |
| DATASET | role.evaluation | 해당 데이터셋이 모델 성능 평가 또는 벤치마킹에 사용되었음을 나타낸다. | `dataset.role` ∋ 'evaluation' |
| DATASET | processing | 원본 데이터에 적용된 주요 전처리, 정제, 필터링, 변환 또는 가공 과정을 기술한다. | `dataset.processing` (JSON 배열) |
| DATASET | license | 데이터셋 자체에 적용되는 라이선스 정보를 나타낸다. 필요 시 LICENSE_POLICY의 상세 정책 정보와 연결한다. | `dataset.license` (상세는 `license_policy`, subject=`dataset:<id>`) |
| DATASET | provenance | 데이터셋의 원천, 제공자 및 다른 데이터셋으로부터의 파생 관계를 기술하는 PROVENANCE 정보에 대한 참조이다. | `dataset.provenance` → `provenance.id` |
| TRANSFORMATION | input | 변환 과정의 입력이 되는 모델 또는 관련 엔터티를 나타낸다. | `transformation.input` (JSON: `[{model, role, external}]`) |
| TRANSFORMATION | output | 해당 변환을 통해 생성된 모델 또는 결과 엔터티를 나타낸다. | `transformation.output` (FK, UNIQUE) |
| TRANSFORMATION | method | 입력을 출력으로 변화시킨 방법을 기술한다. 예: pretraining, SFT, DPO, LoRA, quantization, model merging. | `transformation.method` (순서 있는 JSON 배열) |
| TRANSFORMATION | objective | 해당 변환 또는 학습이 수행된 목적 및 최적화 목표를 기술한다. | `transformation.objective` |
| TRANSFORMATION | hyperparameters | 변환 과정에 사용된 주요 학습 및 최적화 설정값을 기록한다. | `transformation.hyperparameters` (JSON, 어댑터 설정은 `adapter` 키) |
| TRANSFORMATION | datasets | 해당 변환 과정에 실제 사용된 DATASET 엔터티를 참조한다. 이를 통해 특정 학습 단계와 학습 데이터의 관계를 연결한다. | `transformation.datasets` (JSON: `[{dataset, role}]`) |
| TRANSFORMATION | timestamp | 변환이 수행되었거나 결과물이 생성된 시점을 기록한다. 모델 계보의 시간적 순서를 추적하는 데 활용한다. | `transformation.timestamp` |
| EVALUATION | model | 평가 대상이 된 모델 및 해당 모델 버전을 참조한다. | `evaluation.model` (FK) |
| EVALUATION | dataset | 평가에 사용된 벤치마크 또는 평가용 DATASET을 참조한다. | `evaluation.dataset` (FK) |
| EVALUATION | configuration | 평가 당시 사용한 설정과 평가 프로토콜을 기록한다. Prompt template, decoding 조건, zero/few-shot 설정 등이 포함될 수 있다. | `evaluation.configuration` (JSON: benchmark, shots …) |
| EVALUATION | metric | 모델 평가에 사용된 성능 지표를 나타낸다. 예: Accuracy, F1, BLEU, Pass@k, Win Rate. | `evaluation.metric` |
| EVALUATION | score | 지정된 metric을 통해 측정된 실제 평가 결과를 기록한다. | `evaluation.score` (비교 대상 점수는 `extensions`) |
| EVALUATION | timestamp | 평가가 수행되었거나 해당 평가 결과가 보고된 시점을 기록한다. | `evaluation.timestamp` (출처 revision의 공개일) |
| PROVENANCE | subject | 출처 및 계보 정보를 기술하는 대상 엔터티를 지정한다. MODEL 또는 DATASET 등이 대상이 될 수 있다. | `provenance.subject` (`model:<id>` / `dataset:<id>`) |
| PROVENANCE | origin | 해당 엔터티의 최초 또는 근본적인 출처를 나타낸다. 원천 모델, 원본 데이터셋 또는 기타 원천 리소스가 될 수 있다. | `provenance.origin` |
| PROVENANCE | provider | 해당 모델 또는 데이터셋을 개발, 공개 또는 제공한 개인, 조직 또는 기관을 나타낸다. | `provenance.provider` |
| PROVENANCE | parent | 현재 엔터티가 직접적으로 파생된 직전 모델 또는 데이터셋을 나타낸다. 계층적 lineage를 구성하기 위한 직접 부모 관계이다. | `provenance.parent` (JSON 배열: `["model:<id>"]`) |
| PROVENANCE | relation | subject와 parent 또는 origin 사이의 파생 관계 유형을 기술한다. 예: derived_from, fine_tuned_from, quantized_from, filtered_from. | `provenance.relation` |
| PROVENANCE | evidence | 해당 출처 및 파생 관계를 확인할 수 있는 근거 자료에 대한 REFERENCE를 참조한다. | `provenance.evidence` (JSON 배열: reference id) |
| SAFETY_ETHICS | subject | 안전 및 윤리 정보가 적용되는 대상 모델을 지정한다. 모델마다 하나의 SAFETY_ETHICS가 대응한다. | `safety_ethics.subject` (PK, FK → `model_info.model_id`) |
| SAFETY_ETHICS | safety_risk | 모델 사용 과정에서 알려졌거나 공식적으로 평가된 안전 관련 위험 요소를 기술한다. | `safety_ethics.safety_risk` (JSON: `[{description, reference}]`) |
| SAFETY_ETHICS | ethical_considerations | 편향, 공정성, 사회적 영향 등 모델 개발 및 활용과 관련하여 고려해야 할 윤리적 사항을 기술한다. | `safety_ethics.ethical_considerations` |
| SAFETY_ETHICS | prohibited_use | 모델 제공자 또는 정책에 의해 명시적으로 금지되거나 허용되지 않는 사용 목적 및 방식을 기술한다. | `safety_ethics.prohibited_use` |
| SAFETY_ETHICS | mitigation | 알려진 안전 위험이나 윤리적 문제를 완화하기 위해 적용된 기술적 또는 운영적 조치를 기술한다. | `safety_ethics.mitigation` |
| LICENSE_POLICY | subject | 해당 라이선스 또는 정책이 적용되는 모델, 데이터셋 또는 관련 엔터티를 지정한다. | `license_policy.subject` (`model:<id>` / `dataset:<id>`) |
| LICENSE_POLICY | license | 대상 엔터티에 적용되는 공식 라이선스와 이용 조건을 기록한다. | `license_policy.license` |
| LICENSE_POLICY | usage_policy | 라이선스 이외에 모델 또는 데이터 제공자가 정의한 사용 정책 및 허용되는 이용 범위를 기술한다. | `license_policy.usage_policy` |
| LICENSE_POLICY | restrictions | 상업적 이용, 재배포, 파생 모델 생성, 특정 목적의 사용 등과 관련하여 명시적으로 규정된 제한사항을 기술한다. | `license_policy.restrictions` (JSON 배열) |
| REFERENCE | type | 근거 자료의 유형을 나타낸다. 예: paper, technical report, model card, dataset card, repository, documentation, webpage. | `reference.type` |
| REFERENCE | uri | 해당 근거 자료를 식별하거나 접근하기 위한 URI 또는 URL을 기록한다. | `reference.uri` |
| REFERENCE | revision | 참조한 문서, 코드, 모델 카드 또는 저장소 등의 특정 버전이나 리비전을 기록한다. | `reference.revision` |
| REFERENCE | retrieved_at | 해당 자료를 실제로 조회하거나 수집한 시점을 기록한다. 변경 가능한 웹 기반 자료의 시점 추적에 활용한다. | `reference.retrieved_at` |
| REFERENCE | hash | 참조한 자료의 내용 무결성과 동일성을 확인하기 위한 해시값이다. 동일 URI의 내용이 변경되는 경우에도 실제 참조 자료를 식별하는 데 활용할 수 있다. | `reference.hash` (SHA-256) |

### DB 구현 참고

위 표의 "DB 매핑"은 `sql/004_aibom_extended_schema.sql` 기준이다. 영역 하나가 테이블 하나이고, 필드 하나가 같은 이름의 컬럼 하나이다. 모델별 전체 값은 `v_model_aibom` view나 `docs/aibom-models/`에서 볼 수 있고, 관계 구성은 `AIBOM_엔터티_관계도.md`에 정리했다.

- **값이 여러 개인 필드**(`input`, `datasets`, `parent`, `evidence`, `restrictions` 등)는 JSON 배열 컬럼이다. 역방향 조회에 쓰는 컬럼에는 multi-valued index를 걸었다.
- **설계안에 없는 정보**는 테이블마다 `extensions` JSON 컬럼에 모았다. 예: 공개 여부(`disclosure_status`), 비교 대상 모델·점수, 평가자 모델, 자료 제목, 확인되지 않은 정보(`unknowns`).
- **설계안과 다르게 구현한 부분**:
  - `DATASET.role`: 카탈로그 전체에서 그 데이터셋이 맡은 역할을 모은 값이다. 모델별 역할은 `transformation.datasets[].role`과 `evaluation.dataset`에 있다.
  - `EVALUATION.timestamp`: 평가를 실제로 수행한 날짜는 대부분 공개되지 않는다. 그래서 결과가 실린 출처(논문 버전, 모델 카드 커밋)의 공개일을 저장한다.
- **UI 카탈로그 테이블**인 `model_info`와 `model_hierarchy`(sql/001)는 그대로 두었다. `model.identity`가 `model_info.model_id`를 참조한다.

## 4. 스키마의 핵심 관계

본 구조에서 MODEL, DATASET, TRANSFORMATION 및 PROVENANCE는 서로 독립적인 정보가 아니라 모델의 생성 계보를 표현하기 위해 연결된다. 예를 들어 파생 모델의 생성 과정은 다음과 같이 표현할 수 있다.

```
[Pretraining Dataset]
        │
        ▼
   Base Model ────────────────┐
        │                     │
[Finetuning Dataset]          │
        │                     │
        ▼                     │
  TRANSFORMATION               │
        │                     │
        ▼                     │
  Fine-tuned Model             │
        │                     │
        └──── PROVENANCE ──────┘
                    │
                    └─ parent = Base Model
                       relation = fine_tuned_from

Fine-tuned Model
        │
        ▼
   EVALUATION
        │
        └─ Evaluation Dataset
```

이때 origin은 계보의 근본적인 출처를, parent는 바로 이전 단계의 직접적인 출처를 의미한다. 따라서 여러 차례의 파생 과정을 거친 모델에서도 최초 모델과 직접 부모 모델을 구분하여 추적할 수 있다.

DATASET에도 동일한 provenance 구조를 적용함으로써 원본 데이터셋이 정제, 필터링 또는 변환되어 학습 데이터로 사용된 경우 데이터 계보 역시 동일한 방식으로 추적할 수 있다.

결과적으로 본 AIBOM은 개별 모델에 대한 정적인 명세를 넘어, 모델–데이터–학습/변환–평가 간의 관계와 각각의 출처 및 근거를 계층적으로 연결하는 provenance-oriented AIBOM을 구성하는 것을 목표로 한다. 이를 통해 특정 모델의 기반 모델, 사전학습 및 미세조정 데이터, 평가 데이터, 안전·윤리 정보, 라이선스 및 정책, 그리고 각 정보의 근거 자료까지 일관된 구조에서 추적할 수 있다.

## 5. 실제 예시 (HF vs Tech paper: Llama 3.1 8B Instruct)

### 0. 동일 필드의 정보 차이

**Technical Report에서 강한 정보**: How was the model developed?

```
Architecture
    ↓
Training Data
    ↓
Data Processing
    ↓
Transformation
    ↓
Evaluation
    ↓
Safety Evaluation
```

**반면 Hugging Face에서 강한 정보**: What exactly is this released artifact, where did it come from, and how can it be used?

```
Exact Model Identity
    ↓
Repository / Revision
    ↓
Base Model
    ↓
Artifact / Tokenizer
    ↓
Intended Use
    ↓
License / Policy
```

실제로 HF model card는 Llama 3.1 8B Instruct가 meta-llama/Llama-3.1-8B를 base model로 하는 관계를 명시하고 있으며, model card에는 128K context, GQA, 15T+ pretraining tokens, 8개 공식 지원 언어, 2023년 12월 knowledge cutoff 등 배포 관점의 구체적 metadata도 제공된다.

반면 Technical Report는 Llama 3를 multilinguality, coding, reasoning, tool use 등을 지원하는 모델군으로 정의하고 그 학습 및 평가 방법론을 훨씬 깊게 다룬다.

| AIBOM Field | Technical Report | Hugging Face | 차이 |
|---|---|---|---|
| MODEL.identity | Llama 3.1 8B/Instruct라는 논문상의 모델 | 정확한 repository ID | HF 우세 |
| architecture | 상세한 설계 및 학습 맥락 | 요약 architecture | Paper 우세 |
| tokenizer | 설계 및 tokenizer 설명 | 실제 tokenizer artifact/config | 서로 보완 |
| modality | 상세 | 명시적 | 유사 |
| intended_use | capability 중심 | 실제 intended use 명시 | HF 우세 |
| capabilities | 매우 상세 | 요약 | Paper 우세 |
| limitations | 실험적/기술적 한계 | 사용자 관점 limitation | 서로 보완 |
| MODEL.provenance | 학습 계보를 서술적으로 설명 | base-model 관계를 명시적으로 제공 | HF가 구조화에 유리 |
| pretraining data | 데이터 구성·처리 방법이 상대적으로 상세 | "publicly available online data mix" 수준 | Paper 우세 |
| finetuning data | synthetic/human data 및 구축 방법 설명 | 구체적 dataset은 부족 | Paper 우세 |
| processing | filtering, quality control 등의 방법론 | 매우 제한적 | Paper 우세 |
| TRANSFORMATION.method | post-training pipeline 상세 | SFT/RLHF 수준의 요약 | Paper 우세 |
| hyperparameters | 일부 확보 가능 | 매우 제한적 | Paper 우세 |
| evaluation dataset | 매우 풍부 | 주요 benchmark 제공 | Paper 우세 |
| evaluation configuration | 비교적 상세 | 제한적 | Paper 우세 |
| evaluation score | 상세 tables | 핵심 결과 제공 | Paper 우세 |
| provider | Meta | Meta / meta-llama namespace | HF가 식별에 편리 |
| parent | 문맥으로 복원 | Base model metadata | HF 우세 |
| relation | post-training 과정에서 추론 가능 | fine-tuned/base-model 관계 | HF 우세 |
| safety_risk | 상세 safety experiments | deployment-oriented summary | Paper 우세 |
| prohibited_use | 제한적 | 명시적 | HF 우세 |
| mitigation | 기술적 방법 상세 | 실제 사용 권고 중심 | 서로 보완 |
| license | 상세하지 않음 | Llama 3.1 Community License | HF 우세 |
| usage_policy | 제한적 | Acceptable Use Policy | HF 우세 |
| restrictions | 제한적 | 실제 사용 제한 명시 | HF 우세 |
| REFERENCE.revision | arXiv revision | Git/repository revision | 서로 다른 종류의 versioning |

### 1. Technical Report 기반 AIBOM

Technical Report는 개별 checkpoint의 저장소 metadata보다는 Llama 3.1 family가 어떻게 만들어졌는가를 설명하는 데 집중되어 있다. 특히 pretraining, post-training, evaluation 및 safety methodology가 상세하다.

| Category | Field | Technical Report에서 추출되는 정보 |
|---|---|---|
| MODEL | identity | Llama 3.1 8B Instruct |
| | architecture | Dense Transformer 계열의 autoregressive LLM |
| | tokenizer | Llama 3 tokenizer 관련 기술 정보 제공 |
| | modality | Text input / text output |
| | intended_use | Multilingual dialogue, instruction following, coding, reasoning, tool use 등 |
| | capabilities | Multilinguality, coding, reasoning, tool usage |
| | limitations | 모델 및 safety 관련 한계 논의 |
| | provenance | Llama 3.1 8B pretrained → post-trained/instruction model |
| DATASET | identity | 개별 pretraining dataset 이름은 대부분 공개하지 않음 |
| | version | 명시적 dataset version 없음 |
| | role.pretraining | 약 15T+ token 규모의 pretraining corpus |
| | role.finetuning | SFT 및 preference/alignment용 post-training data |
| | role.evaluation | MMLU, GPQA, HumanEval, GSM8K 등 다수 benchmark |
| | processing | Quality filtering, deduplication 등 데이터 처리 방법 설명 |
| | license | 개별 training dataset license는 충분히 공개되지 않음 |
| | provenance | Pretraining/post-training 데이터 구성 방법은 설명되지만 개별 source까지 완전히 추적하기 어려움 |
| TRANSFORMATION | input | Llama 3.1 8B pretrained model |
| | output | Llama 3.1 8B Instruct |
| | method | SFT + Rejection Sampling + preference optimization/DPO 등 post-training pipeline |
| | objective | Instruction following, helpfulness, safety 향상 |
| | hyperparameters | 학습 방법 및 일부 설정 제공 |
| | datasets | Human preference 및 synthetic post-training data 등 |
| | timestamp | Llama 3.1 release/training timeline 관련 정보 |
| EVALUATION | model | Llama 3.1 8B / 8B Instruct |
| | dataset | MMLU, GPQA, HumanEval, GSM8K 및 safety benchmark 등 |
| | configuration | Benchmark별 평가 protocol 제공 |
| | metric | Accuracy, pass@1 등 |
| | score | 다수 benchmark 결과 제공 |
| | timestamp | Technical report publication 시점 |
| PROVENANCE | subject | Llama 3.1 8B Instruct |
| | origin | Llama 3 family / Llama 3.1 pretrained model |
| | provider | Meta |
| | parent | Llama 3.1 8B pretrained |
| | relation | post_trained_from / instruction_tuned_from |
| | evidence | The Llama 3 Herd of Models |
| SAFETY_ETHICS | subject | Llama 3.1 8B Instruct |
| | safety_risk | Cybersecurity, harmful content 등 여러 위험에 대한 평가 및 완화 논의 |
| | ethical_considerations | Responsible development 및 모델 위험 논의 |
| | prohibited_use | Technical report 자체에서는 정책 문서만큼 구체적이지 않음 |
| | mitigation | Safety tuning, safety evaluation, Llama Guard 등의 방어 체계 |
| LICENSE_POLICY | subject | Llama 3.1 family |
| | license | 상세 license text보다는 공개/배포 정책을 중심으로 설명 |
| | usage_policy | 제한적 |
| | restrictions | 상세 restrictions는 별도 정책 문서 필요 |
| REFERENCE | type | Technical report |
| | uri | arXiv 2407.21783 |
| | revision | v1–v3 존재 |
| | retrieved_at | AIBOM 수집 시점 |
| | hash | 별도 계산 필요 |

Technical Report의 핵심 장점은 TRANSFORMATION과 EVALUATION을 복원할 수 있으며, 논문은 Llama 3.1을 단순 checkpoint가 아니라 어떻게 학습하고 post-training했는지 설명한다.

### 2. Hugging Face 기반 AIBOM

반면 공식 Hugging Face model card를 보면 실제 배포되는 모델의 identity와 사용 정보가 훨씬 명확하다. Model card는 Llama 3.1을 8B/70B/405B의 pretrained 및 instruction-tuned 모델로 설명하며, 8B Instruct는 multilingual text 기반 assistant/chat 용도로 제시한다.

| Category | Field | Hugging Face에서 추출되는 정보 |
|---|---|---|
| MODEL | identity | meta-llama/Llama-3.1-8B-Instruct |
| | architecture | Autoregressive LLM, optimized Transformer |
| | tokenizer | Repository tokenizer/configuration으로 직접 식별 가능 |
| | modality | Multilingual text → multilingual text/code |
| | intended_use | Assistant-like chat; commercial/research use |
| | capabilities | Multilingual dialogue, text generation, tool use 등 |
| | limitations | Model card에 deployment/safety limitations 제공 |
| | provenance | Base model = meta-llama/Llama-3.1-8B |
| DATASET | identity | 구체적인 개별 training dataset은 공개되지 않음 |
| | version | 없음 |
| | role.pretraining | "new mix of publicly available online data" |
| | role.finetuning | 구체적인 dataset identity는 없음 |
| | role.evaluation | Model card의 evaluation benchmark 결과 |
| | processing | 제한적으로 설명 |
| | license | 개별 training dataset license 없음 |
| | provenance | 상세 dataset-level lineage 확보 어려움 |
| TRANSFORMATION | input | meta-llama/Llama-3.1-8B |
| | output | meta-llama/Llama-3.1-8B-Instruct |
| | method | SFT + RLHF라고 model card에서 요약 |
| | objective | Helpful/safe instruction following |
| | hyperparameters | 상세 training hyperparameters 부족 |
| | datasets | 구체적 fine-tuning dataset ID 없음 |
| | timestamp | Release date: 2024-07-23 |
| EVALUATION | model | Llama 3.1 8B Instruct |
| | dataset | Model card에 여러 benchmark 결과 |
| | configuration | 일부 evaluation configuration |
| | metric | Benchmark별 metric |
| | score | 공개된 benchmark score |
| | timestamp | 명시적 개별 evaluation timestamp는 대체로 없음 |
| PROVENANCE | subject | meta-llama/Llama-3.1-8B-Instruct |
| | origin | Meta Llama 3.1 |
| | provider | Meta |
| | parent | meta-llama/Llama-3.1-8B |
| | relation | fine_tuned_from |
| | evidence | HF model card / repository metadata |
| SAFETY_ETHICS | subject | meta-llama/Llama-3.1-8B-Instruct |
| | safety_risk | 모델 배포 전 application-specific safety testing 필요 |
| | ethical_considerations | Responsible-use guidance 제공 |
| | prohibited_use | 법률 위반, AUP 및 Community License에서 금지한 용도 |
| | mitigation | Safety testing/tuning 및 관련 Trust & Safety resource 사용 권고 |
| LICENSE_POLICY | subject | Llama 3.1 8B Instruct |
| | license | Llama 3.1 Community License |
| | usage_policy | Acceptable Use Policy |
| | restrictions | 법률·규제 및 AUP/Community License 기반 restrictions |
| REFERENCE | type | Model card / model repository |
| | uri | Hugging Face model repository |
| | revision | repository revision으로 특정 가능 |
| | retrieved_at | AIBOM 생성 시점 |
| | hash | repository revision/file hash 기반으로 기록 가능 |

HF는 특히 model lineage를 machine-readable하게 잡는 데 유리. 현재 model tree에서도 base model을 meta-llama/Llama-3.1-8B로 표시하고, 해당 Instruct checkpoint에서 다시 수천 개의 finetune/adapters/quantization 등이 파생된 구조를 보여준다.

### 3. multi-source AIBOM construction

```
Technical Report
        │
   ┌─────────┼─────────┐
   ▼         ▼         ▼
Training  Evaluation  Safety
   │
   │
   ▼
┌─────────┐
│  AIBOM  │
└─────────┘
   ▲
   │
┌────┴─────────────┐
│                   │
Model Card    Repository Metadata
│                   │
▼                   ▼
Intended Use     Identity
License          Revision
Policy           Parent Model
Limitations      Artifact
```

예를 들어 최종 PROVENANCE는:

```
PROVENANCE
  subject:
    meta-llama/Llama-3.1-8B-Instruct

  origin:
    Llama 3.1

  provider:
    Meta

  parent:
    meta-llama/Llama-3.1-8B

  relation:
    instruction_tuned_from

  evidence:
    - REF-PAPER-001
    - REF-HF-001
```

처럼 하나의 provenance fact에 여러 evidence를 연결 가능함

이게 꽤 중요해. Technical report와 HF가 같은 사실을 말하면 cross-source corroboration이 되고, 한쪽에만 있으면 source-specific enrichment가 된다.

그리고 두 출처를 합쳐도 training dataset의 정확한 provenance는 복원되지 않는다. HF는 pretraining data를 "새로운 publicly available online data mixture" 수준으로 기술하고 15T+ token이라고 밝히지만 개별 source dataset의 완전한 목록을 제공하지 않는다.

따라서 최종 AIBOM에는 억지로 값을 채우기보다:

```
DATASET
  identity: undisclosed_pretraining_mixture
  role: pretraining
  provenance:
    provider: Meta
    origin: partially_disclosed
    evidence: REF-PAPER-001
```

처럼 unknown / partially disclosed를 명시적으로 빈 곳을 표현
