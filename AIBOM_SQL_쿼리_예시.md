# AIBOM SQL 쿼리 예시

- 대상: AIBOM PoC DB (MySQL 8.0, `Dump20260929.sql`과 같은 데이터)
- **모든 쿼리는 실제 DB에서 실행해 결과를 확인했습니다.** 단, 11장의 "완전 정규화 버전"은 현재 DB에 없는 테이블을 가정한 예시입니다.
- 각 쿼리에는 **무엇을 보여 주는지**(면접에서 말할 개념)를 같이 적었습니다.
- 테이블 구조는 `research.md`, 정규화 개념은 `AIBOM_DB_설계와_정규화.md`를 참고하세요.

### 개념별 찾아보기

| 개념 | 쿼리 |
|---|---|
| 기본 SELECT / WHERE / ORDER BY | 1 |
| JOIN, LEFT JOIN, 1:N 관계 | 2, 3 |
| GROUP BY 집계 | 3, 8 |
| 자기 참조 JOIN (계보) | 4 |
| 재귀 쿼리 (`WITH RECURSIVE`) | 5 |
| JSON 값 꺼내기 (`->>`) | 2, 8 |
| JSON 배열을 행으로 펼치기 (`JSON_TABLE`) | 6, 9 |
| 다중값 인덱스 (`MEMBER OF`, `EXPLAIN`) | 7 |
| 다형 참조 조인 (`'model:<id>'`) | 9 |
| 윈도 함수 (`RANK() OVER`) | 10 |
| 뷰 활용 | 10, 11 |
| 데이터 품질·무결성 점검 | 12 |
| 정규화 전후 비교 | 13 |

---

## 1. 기본 조회 — Llama 3.1 계열 모델을 체크리스트 점수 순으로

```sql
SELECT model_id, model_role, checklist_score
FROM model_info
WHERE family_key = 'llama31'
ORDER BY checklist_score DESC;
```

| model_id | model_role | checklist_score |
|---|---|---|
| meta-llama/Llama-3.1-8B | BASE | 62.20 |
| meta-llama/Llama-3.1-8B-Instruct | INSTRUCT | 62.20 |
| HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge | DERIVED | 59.80 |
| FreedomIntelligence/HuatuoGPT-o1-8B | DERIVED | 58.30 |
| NousResearch/Hermes-3-Llama-3.1-8B | DERIVED | 58.30 |
| mlx-community/Meta-Llama-3.1-8B-Instruct-bf16 | DERIVED | 57.50 |
| FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp | DERIVED | 54.40 |

**포인트**: `(family_key, model_role)` 인덱스와 `checklist_score` 인덱스가 이런 목록 화면 조회를 위해 있습니다.

---

## 2. JOIN — 한 모델의 평가 결과와 데이터셋 이름

```sql
SELECT e.configuration->>'$.benchmark' AS benchmark,
       e.metric,
       e.score,
       d.extensions->>'$.name'       AS dataset_name
FROM evaluation e
LEFT JOIN dataset d ON d.identity = e.dataset
WHERE e.model = 'FreedomIntelligence/HuatuoGPT-o1-8B'
ORDER BY benchmark;
```

| benchmark | metric | score | dataset_name |
|---|---|---|---|
| MedQA | acc | 72.6 | MedQA-USMLE (training set) |
| MedMCQA | acc | 60.4 | MedMCQA (training set) |
| PubMedQA | acc | 79.2 | PubMedQA |
| Average (MedQA/MedMCQA/PubMedQA/…) | macro_avg/acc | 63.9 | *(NULL)* |
| … (총 12행) | | | |

**포인트**
- **정규화의 효과**: 평가 테이블에는 데이터셋 ID만 있고, 이름은 데이터셋 테이블에서 JOIN으로 가져옵니다. 데이터셋 이름을 고쳐도 한 곳만 고치면 됩니다.
- **LEFT JOIN을 쓴 이유**: "평균 점수"처럼 데이터셋에 연결되지 않은 평가도 빠지지 않고 나오게 하려고 씁니다. `evaluation.dataset`이 NULL인 행은 INNER JOIN이면 사라집니다.
- `->>`는 JSON 값을 꺼내 따옴표를 뗀 문자열로 돌려주는 MySQL 연산자입니다(`JSON_UNQUOTE(JSON_EXTRACT(...))`의 줄임).

---

## 3. LEFT JOIN + GROUP BY — 모델별 평가 건수 (0건 포함)

```sql
SELECT mi.model_id, COUNT(e.id) AS eval_count
FROM model_info mi
LEFT JOIN evaluation e ON e.model = mi.model_id
GROUP BY mi.model_id
ORDER BY eval_count DESC;
```

| model_id | eval_count |
|---|---|
| NousResearch/Hermes-3-Llama-3.1-8B | 25 |
| Qwen/Qwen2.5-7B-Instruct-1M | 25 |
| Qwen/Qwen2.5-7B | 18 |
| … | … |
| mlx-community/Meta-Llama-3.1-8B-Instruct-bf16 | **0** |
| mlx-community/Qwen2.5-7B-Instruct-bf16 | **0** |

**포인트**
- `COUNT(*)`가 아니라 `COUNT(e.id)`를 써야 평가가 없는 모델이 0으로 나옵니다. `COUNT(*)`는 LEFT JOIN으로 생긴 빈 행도 1로 셉니다.
- 평가가 없는 모델을 찾는 데이터 커버리지 점검에도 그대로 쓸 수 있습니다.

---

## 4. 자기 참조 JOIN — 계보 트리의 부모·자식

`model_hierarchy`의 부모 컬럼은 같은 `model_info`를 다시 가리킵니다.

```sql
SELECT c.model_id          AS child,
       c.relationship_type,
       p.model_id          AS parent,
       p.model_role        AS parent_role
FROM model_hierarchy c
JOIN model_info p ON p.model_id = c.parent_model_id
ORDER BY parent, child;
```

| child | relationship_type | parent | parent_role |
|---|---|---|---|
| Qwen/Qwen2.5-7B-Instruct-1M | contextExtendedFrom | Qwen/Qwen2.5-7B | BASE |
| HPAI-BSC/Qwen2.5-7B-Instruct-Egida-DPO | preferenceOptimizedFrom | Qwen/Qwen2.5-7B-Instruct | INSTRUCT |
| mellee030/MedQwen-7B-LoRA | adapterTrainedFrom | Qwen/Qwen2.5-7B-Instruct | INSTRUCT |
| mlx-community/Qwen2.5-7B-Instruct-bf16 | convertedFrom | Qwen/Qwen2.5-7B-Instruct | INSTRUCT |
| NousResearch/Hermes-3-Llama-3.1-8B | instructionTunedFrom | meta-llama/Llama-3.1-8B | BASE |
| FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp | adapterTrainedFrom | meta-llama/Llama-3.1-8B-Instruct | INSTRUCT |
| FreedomIntelligence/HuatuoGPT-o1-8B | domainFineTunedAndReinforcementOptimizedFrom | meta-llama/Llama-3.1-8B-Instruct | INSTRUCT |
| HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge | taskFineTunedFrom | meta-llama/Llama-3.1-8B-Instruct | INSTRUCT |
| mlx-community/Meta-Llama-3.1-8B-Instruct-bf16 | convertedFrom | meta-llama/Llama-3.1-8B-Instruct | INSTRUCT |

**포인트**: 트리를 테이블 하나에 "직접 부모"만 저장하는 방식을 **인접 리스트**(adjacency list)라고 합니다. 루트 모델 4개는 부모가 NULL이라 INNER JOIN에서 빠집니다.

---

## 5. 재귀 쿼리 — 모델의 모든 조상 거슬러 올라가기

"보안 문제를 유전병처럼 backtracking"하는 쿼리입니다. 출처 테이블의 `parent` JSON 배열을 따라 계속 위로 올라갑니다.

```sql
WITH RECURSIVE ancestors AS (
  -- 시작점: 조사할 모델
  SELECT p.subject, p.relation, p.parent, 0 AS depth
  FROM provenance p
  WHERE p.subject = 'model:FreedomIntelligence/HuatuoGPT-o1-8B'

  UNION ALL

  -- 반복: 현재 행의 부모들을 찾아 한 단계 위로
  SELECT p.subject, p.relation, p.parent, a.depth + 1
  FROM ancestors a
  JOIN JSON_TABLE(a.parent, '$[*]'
         COLUMNS (parent_subject VARCHAR(600) PATH '$')) j
  JOIN provenance p ON p.subject = j.parent_subject
  WHERE a.depth < 10            -- 순환이 있어도 무한 루프에 빠지지 않게
)
SELECT depth, subject, relation
FROM ancestors
ORDER BY depth, subject;
```

| depth | subject | relation |
|---|---|---|
| 0 | model:FreedomIntelligence/HuatuoGPT-o1-8B | fine_tuned_from |
| 1 | model:meta-llama/Llama-3.1-8B-Instruct | instruction_tuned_from |
| 2 | model:meta-llama/Llama-3.1-8B | pretrained |

**포인트**
- `WITH RECURSIVE`는 **시작 쿼리 + 자기 자신을 참조하는 반복 쿼리**로 이루어집니다. 더 이상 새 행이 나오지 않으면 멈춥니다.
- 계보 깊이가 깊어져도 관계형 DB에서 추적할 수 있다는 근거입니다. "왜 그래프 DB가 아닌가"라는 질문에 대한 답이 됩니다.
- `model_hierarchy`로는 HuatuoGPT의 부모가 Instruct에서 끝나지만(Instruct가 루트), `provenance`로는 Base까지 올라갑니다. 두 계보 표현의 차이가 드러나는 예입니다(12-④ 참고).
- `parent` 배열에는 데이터셋도 들어 있습니다(`dataset:...`). 위 쿼리는 데이터셋 출처까지 함께 따라 올라갑니다. HuatuoGPT의 경우 데이터셋 출처는 `parent`가 아니라 `transformation.datasets`에 있어서 결과에 나오지 않았습니다.

---

## 6. JSON_TABLE — JSON 배열을 행으로 펼치기

변환 과정의 학습 데이터셋 목록(JSON 배열)을 일반 테이블처럼 행으로 펼칩니다.

```sql
SELECT t.output AS model_id, j.dataset, j.role
FROM transformation t
JOIN JSON_TABLE(t.datasets, '$[*]'
       COLUMNS (dataset VARCHAR(255) PATH '$.dataset',
                role    VARCHAR(50)  PATH '$.role')) j
WHERE t.output = 'FreedomIntelligence/HuatuoGPT-o1-8B';
```

| model_id | dataset | role |
|---|---|---|
| FreedomIntelligence/HuatuoGPT-o1-8B | GBaker/MedQA-USMLE-4-options | distillation |
| FreedomIntelligence/HuatuoGPT-o1-8B | openlifescienceai/medmcqa | distillation |
| FreedomIntelligence/HuatuoGPT-o1-8B | FreedomIntelligence/medical-o1-verifiable-problem | distillation |
| FreedomIntelligence/HuatuoGPT-o1-8B | FreedomIntelligence/medical-o1-reasoning-SFT | finetuning |
| FreedomIntelligence/HuatuoGPT-o1-8B | FreedomIntelligence/medical-o1-verifiable-problem | preference |

**포인트**
- `JSON_TABLE`은 JSON 배열을 **1NF 형태의 가상 테이블**로 바꿉니다. 저장은 JSON으로 했지만, 조회할 때는 정규화된 연결 테이블처럼 쓸 수 있습니다.
- "JSON 컬럼은 1NF 위반 아닌가요?"라는 질문에 "조회 시점에는 JSON_TABLE로 정규형처럼 다룰 수 있다"고 보충할 수 있습니다.

---

## 7. MEMBER OF + 다중값 인덱스 — 역방향 조회

### 7-1. 이 데이터셋으로 학습한 모델은?

```sql
SELECT output AS model_id
FROM transformation
WHERE 'FreedomIntelligence/medical-o1-reasoning-SFT'
      MEMBER OF (datasets->'$[*].dataset');
```
→ `FreedomIntelligence/HuatuoGPT-o1-8B`

### 7-2. Llama-3.1-8B-Instruct를 입력으로 쓴 모델은?

```sql
SELECT output
FROM transformation
WHERE 'meta-llama/Llama-3.1-8B-Instruct' MEMBER OF (input->'$[*].model');
```
→ SecAlign-pp, HiTZ judge, mlx bf16, HuatuoGPT-o1 (4개)

### 7-3. 인덱스를 실제로 타는지 확인 (`EXPLAIN`)

```sql
EXPLAIN
SELECT output
FROM transformation
WHERE 'meta-llama/Llama-3.1-8B-Instruct' MEMBER OF (input->'$[*].model');
```

| type | possible_keys | key | rows |
|---|---|---|---|
| **ref** | ix_transformation_input | **ix_transformation_input** | 4 |

**포인트**
- `type = ref`이고 `key`에 인덱스 이름이 나오면 **테이블 전체를 훑지 않고 인덱스로 바로 찾았다**는 뜻입니다. 인덱스를 못 타면 `type = ALL`(전체 스캔)이 나옵니다.
- 이 인덱스는 테이블 정의에서 `CAST(json_extract(input, '$[*].model') AS CHAR(255) ARRAY)`로 만든 **다중값 인덱스**입니다. JSON 배열 안의 값 하나하나가 인덱스 항목이 됩니다.
- 면접 답변: "JSON 배열을 썼지만 다중값 인덱스로 역방향 조회 성능을 확보했고, EXPLAIN으로 인덱스를 타는 것을 확인했다."

---

## 8. JSON 값 기준 집계 — 출처 공개 상태 통계

```sql
SELECT SUBSTRING_INDEX(subject, ':', 1)     AS kind,
       extensions->>'$.disclosure_status'   AS disclosure,
       COUNT(*)                             AS n
FROM provenance
GROUP BY kind, disclosure
ORDER BY kind, n DESC;
```

| kind | disclosure | n |
|---|---|---|
| dataset | disclosed | 38 |
| dataset | partially_disclosed | 5 |
| dataset | undisclosed | 4 |
| model | partially_disclosed | 10 |
| model | disclosed | 3 |

**포인트**
- 연구 결과로 바로 쓸 수 있는 숫자입니다. **모델 13개 중 10개의 출처가 "부분 공개"**입니다. 대부분의 모델이 계보나 학습 데이터를 완전히 공개하지 않는다는 근거가 됩니다.
- `SUBSTRING_INDEX(subject, ':', 1)`은 `'model:...'`에서 `model`만 잘라냅니다. 한 컬럼에 종류와 ID를 같이 넣은 다형 참조라서 이런 문자열 처리가 필요합니다. 컬럼을 나눴다면 필요 없는 작업입니다.

---

## 9. 다형 참조 조인 — 모델과 학습 데이터셋의 라이선스 비교

```sql
SELECT t.output   AS model_id,
       ml.license AS model_license,
       j.dataset,
       j.role,
       dl.license AS dataset_license
FROM transformation t
JOIN JSON_TABLE(t.datasets, '$[*]'
       COLUMNS (dataset VARCHAR(255) PATH '$.dataset',
                role    VARCHAR(50)  PATH '$.role')) j
LEFT JOIN license_policy ml ON ml.subject = CONCAT('model:',   t.output)
LEFT JOIN license_policy dl ON dl.subject = CONCAT('dataset:', j.dataset)
WHERE dl.license IS NOT NULL
  AND dl.license <> ml.license
ORDER BY model_id;
```

| model_id | model_license | dataset | role | dataset_license |
|---|---|---|---|---|
| FreedomIntelligence/HuatuoGPT-o1-8B | Apache License 2.0 | GBaker/MedQA-USMLE-4-options | distillation | cc-by-4.0 |
| FreedomIntelligence/HuatuoGPT-o1-8B | Apache License 2.0 | openlifescienceai/medmcqa | distillation | **apache-2.0** |
| HiTZ/Llama-3.1-8B-Instruct-multi-truth-judge | Llama 3.1 Community License | HiTZ/truthful_judge | finetuning | Apache-2.0 |
| NousResearch/Hermes-3-Llama-3.1-8B | Llama 3.1 Community License | NousResearch/hermes-function-calling-v1 | finetuning | apache-2.0 |
| … (총 9행) | | | | |

**포인트**
- 계보를 따라 **라이선스 상속·충돌을 점검**하는 쿼리입니다. 예: CC-BY 데이터로 증류한 모델이 Apache 2.0으로 배포되었습니다.
- 다형 참조라서 FK 대신 `CONCAT('model:', ...)`으로 조인합니다.
- **결과에 같은 라이선스가 섞여 나옵니다.** `Apache License 2.0`과 `apache-2.0`은 같은 라이선스인데 문자열이 달라서 "다르다"고 나옵니다. 아래 쿼리로 확인하면 표기가 제각각입니다.

```sql
SELECT license, extensions->>'$.spdx_id' AS spdx, COUNT(*) AS n
FROM license_policy
GROUP BY license, spdx
ORDER BY n DESC;
```

| license | spdx | n |
|---|---|---|
| apache-2.0 | NULL | 14 |
| mit | NULL | 12 |
| Apache License 2.0 | Apache-2.0 | 8 |
| Llama 3.1 Community License | NULL | 6 |
| CC-BY-4.0 | NULL | 5 |
| CC BY-SA 4.0 | NULL | 3 |
| cc-by-sa-4.0 | NULL | 1 |
| … | | |

→ 이것은 **스키마 정규화가 아니라 값(표기) 정규화** 문제입니다. 라이선스 이름을 SPDX 식별자(`Apache-2.0`, `CC-BY-4.0`)로 통일하거나, 별도 `license` 코드 테이블을 두고 FK로 참조하면 해결됩니다. 면접에서 "정규화가 부족하면 실제로 어떤 문제가 생기나요?"에 대한 좋은 실제 사례입니다.

---

## 10. 뷰 + 윈도 함수 — 벤치마크별 순위

`v_model_evaluation` 뷰는 JSON 안의 벤치마크 이름, 비교 기준 점수 등을 컬럼으로 펼쳐 줍니다.

```sql
SELECT model_id, benchmark, metric, score,
       RANK() OVER (PARTITION BY benchmark ORDER BY score DESC) AS rnk
FROM v_model_evaluation
WHERE benchmark = 'MMLU'
ORDER BY rnk;
```

| model_id | metric | score | rnk | shots (configuration) |
|---|---|---|---|---|
| Qwen/Qwen2.5-7B | acc | 74.2 | 1 | 기록 없음 |
| FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp | acc | 71.7 | 2 | 0 |
| meta-llama/Llama-3.1-8B-Instruct | macro_avg/acc | 69.4 | 3 | 5 |
| meta-llama/Llama-3.1-8B | macro_avg/acc_char | 66.7 | 4 | 5 |
| NousResearch/Hermes-3-Llama-3.1-8B | 5-shot accuracy | 64.79 | 5 | 5 |
| HPAI-BSC/Qwen2.5-7B-Instruct-Egida-DPO | acc | **0.296** | 6 | 기록 없음 |

(마지막 열은 쿼리 결과가 아니라, 같은 행의 `configuration` JSON에서 확인해 덧붙인 값입니다.)

**포인트**
- `RANK() OVER (PARTITION BY ... ORDER BY ...)`는 그룹(여기서는 벤치마크)마다 따로 순위를 매기는 **윈도 함수**입니다. GROUP BY와 달리 행을 합치지 않습니다.
- **이 순위는 그대로 믿으면 안 됩니다.** 이 결과가 오히려 연구 주장을 뒷받침합니다.
  - Egida-DPO의 0.296은 0~1 비율이고 나머지는 0~100 백분율입니다(**단위 불일치**).
  - shot 수(0-shot, 5-shot)와 metric 정의가 서로 다릅니다.
  - 그래서 설계안이 평가를 모델 속성이 아니라 **설정(configuration)을 포함한 별도 엔터티**로 둔 것입니다. 같은 벤치마크 이름이어도 평가 조건이 다르면 비교할 수 없습니다.

### 10-1. 부모 모델 대비 성능 변화 (delta)

```sql
SELECT model_id, benchmark, score, baseline_model, baseline_score, delta_vs_baseline
FROM v_model_evaluation
WHERE benchmark = 'MMLU' AND delta_vs_baseline IS NOT NULL;
```

| model_id | score | baseline_model | baseline_score | delta |
|---|---|---|---|---|
| FlorianJK/Meta-Llama-3.1-8B-SecAlign-pp | 71.7 | meta-llama/Llama-3.1-8B-Instruct | 72.0 | −0.3 |
| HPAI-BSC/Qwen2.5-7B-Instruct-Egida-DPO | 0.296 | Qwen/Qwen2.5-7B-Instruct | 0.331 | −0.035 |
| NousResearch/Hermes-3-Llama-3.1-8B | 64.79 | meta-llama/Llama-3.1-8B-Instruct | 68.05 | −3.26 |

**포인트**: 회의 노트의 "성능의 인계" 주제입니다. 보안 정렬(SecAlign) 후 일반 성능이 거의 유지된다(−0.3)는 것을 쿼리 한 줄로 보여 줄 수 있습니다. SecAlign의 공격 성공률 벤치마크(SEP, AlpacaFarm)에서는 delta가 −60~−90으로 크게 떨어지는데, 이 지표는 낮을수록 좋으므로 **metric의 방향(높을수록/낮을수록 좋음)도 함께 저장해야** 한다는 개선점이 나옵니다.

---

## 11. 뷰로 AIBOM 문서 조립하기

```sql
SELECT JSON_PRETTY(JSON_OBJECT(
         'architecture', JSON_EXTRACT(model, '$.architecture'),
         'relation',     JSON_EXTRACT(provenance, '$.relation'),
         'n_eval',       JSON_LENGTH(evaluation),
         'n_ref',        JSON_LENGTH(reference))) AS summary
FROM v_model_aibom
WHERE model_id = 'mellee030/MedQwen-7B-LoRA';
```

```json
{
  "architecture": {
    "family": "decoder-only Transformer (Qwen2.5 architecture); LoRA adapter on frozen base weights",
    "layers": 28,
    "hidden_size": 3584,
    "context_length": 32768,
    "attention_heads": 28,
    "kv_heads": 4,
    ...
  },
  "relation": "adapter_trained_from",
  "n_eval": 4,
  "n_ref": 6
}
```

**포인트**: `v_model_aibom` 한 행이 **모델 하나의 전체 AIBOM 문서**입니다. 8개 테이블에 나눠 저장된 정보를 뷰가 조립합니다. "저장은 정규화, 조회는 문서"라는 설계를 보여 주는 쿼리입니다.

---

## 12. 데이터 품질·무결성 점검

FK가 없는 곳은 DB가 무결성을 보장하지 않으므로 **점검 쿼리**로 확인합니다. 면접에서 "FK 없는 참조의 무결성은 어떻게 보장하나요?"에 구체적으로 답할 수 있는 예시입니다.

### ① 변환 입력 중 카탈로그에 없는 모델

```sql
SELECT t.output, j.model, j.role
FROM transformation t
JOIN JSON_TABLE(t.input, '$[*]'
       COLUMNS (model VARCHAR(512) PATH '$.model',
                role  VARCHAR(30)  PATH '$.role')) j
LEFT JOIN model_info mi ON mi.model_id = j.model
WHERE mi.model_id IS NULL;
```

| output | model | role |
|---|---|---|
| FreedomIntelligence/HuatuoGPT-o1-8B | GPT-4o | generator |
| FreedomIntelligence/HuatuoGPT-o1-8B | GPT-4o | verifier |

→ 2건 모두 의도된 **외부 모델**입니다(`external: true`). 이것이 `input`에 FK를 걸 수 없었던 이유입니다.

### ② 존재하지 않는 대상을 가리키는 출처 레코드 (고아 행)

```sql
SELECT p.subject
FROM provenance p
LEFT JOIN model_info mi ON p.subject = CONCAT('model:',   mi.model_id)
LEFT JOIN dataset    d  ON p.subject = CONCAT('dataset:', d.identity)
WHERE mi.model_id IS NULL AND d.identity IS NULL;
```
→ **0건**. 현재 모든 출처 레코드가 실제 모델이나 데이터셋을 가리킵니다.

### ③ 중복 저장된 값이 서로 일치하는가 (3NF 위반 지점 점검)

`model_info`에는 패밀리 정보가 모델마다 반복 저장되어 있습니다. 같은 패밀리 안에서 값이 갈라졌는지 확인합니다.

```sql
SELECT family_key,
       COUNT(*)                            AS models,
       COUNT(DISTINCT family_name)         AS names,
       COUNT(DISTINCT family_license_name) AS licenses
FROM model_info
GROUP BY family_key;
```

| family_key | models | names | licenses |
|---|---|---|---|
| llama31 | 7 | 1 | 1 |
| qwen25 | 6 | 1 | 1 |

→ 값이 1개씩이면 **갱신 이상이 아직 발생하지 않은** 상태입니다. 2 이상이 나오면 같은 패밀리에 서로 다른 이름이 저장된 것입니다. 비정규화를 했다면 이런 점검 쿼리로 대가를 관리한다고 말할 수 있습니다.

### ④ 두 계보 표현이 일치하는가

```sql
SELECT model_id, relation, parent, hierarchy_parent_model_id
FROM v_model_lineage
WHERE NOT (CONCAT('model:', hierarchy_parent_model_id) MEMBER OF (parent))
   OR (hierarchy_parent_model_id IS NULL AND JSON_LENGTH(parent) > 0);
```

| model_id | relation | provenance 부모 | hierarchy 부모 |
|---|---|---|---|
| meta-llama/Llama-3.1-8B-Instruct | instruction_tuned_from | model:meta-llama/Llama-3.1-8B | NULL |
| Qwen/Qwen2.5-7B-Instruct | instruction_tuned_from | model:Qwen/Qwen2.5-7B | NULL |

→ 출처 테이블은 Instruct 모델의 부모를 Base로 기록하지만, 카탈로그 트리는 Instruct를 루트로 둡니다. **같은 사실을 두 곳에 저장하면 생기는 불일치**의 실제 예입니다.

### ⑤ 파생값(`dataset.role`)이 원본과 일치하는가

```sql
SELECT d.identity, d.role AS stored_role,
  CONCAT_WS(',',
    IF(EXISTS (SELECT 1 FROM transformation t
               JOIN JSON_TABLE(t.datasets, '$[*]'
                      COLUMNS (ds VARCHAR(255) PATH '$.dataset',
                               r  VARCHAR(50)  PATH '$.role')) j
               WHERE j.ds = d.identity AND j.r = 'pretraining'), 'pretraining', NULL),
    IF(EXISTS (SELECT 1 FROM transformation t
               JOIN JSON_TABLE(t.datasets, '$[*]'
                      COLUMNS (ds VARCHAR(255) PATH '$.dataset',
                               r  VARCHAR(50)  PATH '$.role')) j
               WHERE j.ds = d.identity AND j.r <> 'pretraining'), 'finetuning', NULL),
    IF(EXISTS (SELECT 1 FROM evaluation e
               WHERE e.dataset = d.identity), 'evaluation', NULL)
  ) AS computed_role
FROM dataset d
HAVING NOT (stored_role <=> NULLIF(computed_role, ''));
```
→ **0건**. 저장된 역할과 다시 계산한 역할이 모두 일치합니다.

**포인트**: 파생값을 저장하면 원본과 어긋날 수 있는데, 이 쿼리처럼 **다시 계산해서 비교**하면 됩니다. 또 이 쿼리가 있다는 것은 `dataset.role`을 저장하지 않고 뷰에서 계산해도 된다는 뜻이기도 합니다(완전 정규화 방향).

---

## 13. 정규화 전후 비교 (가정 예시 — 현재 DB에는 없음)

`transformation.datasets` JSON 배열을 연결 테이블로 정규화했다고 가정합니다.

```sql
-- 정규화 버전의 연결 테이블
CREATE TABLE transformation_dataset (
  transformation_id BIGINT UNSIGNED NOT NULL,
  dataset_id        VARCHAR(255) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  role              VARCHAR(50)  NOT NULL,
  PRIMARY KEY (transformation_id, dataset_id, role),
  KEY ix_td_dataset (dataset_id),
  FOREIGN KEY (transformation_id) REFERENCES transformation (id) ON DELETE CASCADE,
  FOREIGN KEY (dataset_id)        REFERENCES dataset (identity)   ON DELETE RESTRICT
);
```

같은 질문, "이 데이터셋으로 학습한 모델은?"을 두 방식으로 쓰면:

```sql
-- 현재 (JSON + 다중값 인덱스)
SELECT output
FROM transformation
WHERE 'FreedomIntelligence/medical-o1-reasoning-SFT' MEMBER OF (datasets->'$[*].dataset');

-- 정규화 버전 (연결 테이블 + 일반 인덱스)
SELECT t.output
FROM transformation_dataset td
JOIN transformation t ON t.id = td.transformation_id
WHERE td.dataset_id = 'FreedomIntelligence/medical-o1-reasoning-SFT';
```

| 비교 | 현재 (JSON) | 정규화 버전 |
|---|---|---|
| 무결성 | 없는 데이터셋 ID가 들어가도 막지 못함 | **FK가 막아 줌** |
| 데이터셋 삭제 시 | 참조가 남음 | RESTRICT로 삭제 차단 |
| 쿼리 | 테이블 1개, MySQL 전용 문법 | JOIN 1번, 표준 SQL |
| 구조 변경 | JSON 키만 추가하면 됨 | ALTER TABLE 필요 |
| 설계 문서와 대응 | 필드 1개 = 컬럼 1개 | 필드 1개 = 테이블 1개 |

**포인트**: 면접에서 "정규화한다면 어떻게 바꾸겠습니까?"라는 질문이 나오면, 이 표를 그대로 말로 풀면 됩니다. "구조가 안정되면 FK 무결성을 얻기 위해 연결 테이블로 옮기는 게 맞다"가 결론입니다.

---

## 면접에서 쿼리 질문을 받을 때

- 쿼리를 직접 쓰라는 질문보다는 **"이런 걸 어떻게 조회하나요?"** 형태가 많습니다. 다음 세 개를 말로 설명할 수 있으면 충분합니다.
  1. **재귀 쿼리(5)**: "모델의 조상을 끝까지 거슬러 올라가 보안 문제를 역추적한다."
  2. **다중값 인덱스(7)**: "JSON 배열이지만 인덱스로 역방향 조회를 한다. EXPLAIN으로 확인했다."
  3. **점검 쿼리(12)**: "FK가 없는 곳은 점검 쿼리로 무결성을 확인한다."
- 실제 데이터에서 발견한 문제(라이선스 표기 불일치, 점수 단위 불일치, 두 계보의 불일치)는 **"그래서 정규화와 근거 기반 설계가 필요하다"**는 주장의 근거로 쓰면 좋습니다.
