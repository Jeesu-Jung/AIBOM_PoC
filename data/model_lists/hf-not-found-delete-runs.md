# Hugging Face 조사가 not_found 였던 검토 대기 실행 일괄 삭제

재조사 전에, Hugging Face 조사 결과가 `not_found` 인 검토 대기 실행을 지우는 SQL 입니다.
2026-11-22 기준 대상은 120건입니다.

- 대상: `model_research_run` 중 검토 대기(`model_id IS NULL`)이고, 그 실행의 `huggingface` 결과가 `not_found` 인 것
- `model_research_result` 는 FK 가 `ON DELETE CASCADE` 라 실행을 지우면 함께 지워집니다
- 120건 중 9건은 논문 조사와 병합 결과가 `found` 또는 `ambiguous` 입니다. 함께 지워지고 재조사에서 다시 만들어집니다
- 삭제는 되돌릴 수 없습니다. 2번 백업을 먼저 실행하세요
- 배치 실행 **전에** 지워야 합니다. 배치는 DB 에 병합 결과가 있는 모델을 건너뜁니다

## 1. 대상 확인

120건이 나와야 합니다.

```sql
SELECT r.id, r.requested_model, r.created_at
FROM model_research_run r
WHERE r.model_id IS NULL
  AND EXISTS (SELECT 1 FROM model_research_result x
              WHERE x.run_id = r.id AND x.source = 'huggingface' AND x.status = 'not_found')
ORDER BY r.id;
```

건수만 볼 때:

```sql
SELECT COUNT(*) AS runs
FROM model_research_run r
WHERE r.model_id IS NULL
  AND EXISTS (SELECT 1 FROM model_research_result x
              WHERE x.run_id = r.id AND x.source = 'huggingface' AND x.status = 'not_found');
```

## 2. 백업 (권장)

지울 실행과 결과를 백업 테이블에 복사합니다.

```sql
CREATE TABLE model_research_run_bak_20261122 AS
SELECT r.*
FROM model_research_run r
WHERE r.model_id IS NULL
  AND EXISTS (SELECT 1 FROM model_research_result x
              WHERE x.run_id = r.id AND x.source = 'huggingface' AND x.status = 'not_found');

CREATE TABLE model_research_result_bak_20261122 AS
SELECT x.*
FROM model_research_result x
WHERE x.run_id IN (SELECT id FROM model_research_run_bak_20261122);
```

확인: 실행 120건, 결과 360건(실행당 huggingface, paper, merged)이어야 합니다.

```sql
SELECT (SELECT COUNT(*) FROM model_research_run_bak_20261122)    AS runs,
       (SELECT COUNT(*) FROM model_research_result_bak_20261122) AS results;
```

## 3. 삭제

2번 백업을 했다면 백업 테이블 기준으로 지웁니다. 확인한 바로 그 실행만 지워집니다.

```sql
DELETE FROM model_research_run
WHERE id IN (SELECT id FROM model_research_run_bak_20261122);
```

백업 없이 조건으로 바로 지울 때:

```sql
DELETE r FROM model_research_run r
WHERE r.model_id IS NULL
  AND EXISTS (SELECT 1 FROM model_research_result x
              WHERE x.run_id = r.id AND x.source = 'huggingface' AND x.status = 'not_found');
```

## 4. 삭제 확인

둘 다 0이어야 합니다.

```sql
SELECT (SELECT COUNT(*) FROM model_research_result
        WHERE source = 'huggingface' AND status = 'not_found')              AS hf_not_found,
       (SELECT COUNT(*) FROM model_research_result x
        WHERE NOT EXISTS (SELECT 1 FROM model_research_run r WHERE r.id = x.run_id)) AS orphan_results;
```

## 5. 재조사

백엔드에 "Hugging Face 저장소 직접 읽기" 변경이 반영된 뒤 실행합니다.
기본 대상인 `https://aibom.jeesu.io` 에 배포 전이라면 로컬 백엔드를 띄우고 `--api` 를 주세요.

```bat
run-batch.bat data\model_lists\hf-not-found-recheck-model-list.md
```

## 6. 되돌리기 (필요할 때만)

백업 테이블에서 복원합니다. 재조사로 같은 모델의 새 실행이 생긴 뒤라면 예전 실행이 검토 대기에 다시 나타납니다.

```sql
INSERT INTO model_research_run SELECT * FROM model_research_run_bak_20261122;
INSERT INTO model_research_result SELECT * FROM model_research_result_bak_20261122;
```

## 7. 백업 테이블 정리

재조사 결과를 확인한 뒤 지웁니다.

```sql
DROP TABLE model_research_result_bak_20261122;
DROP TABLE model_research_run_bak_20261122;
```
