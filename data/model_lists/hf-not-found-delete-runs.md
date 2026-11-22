# Hugging Face 조사가 not_found 였던 검토 대기 실행 일괄 삭제

재조사 전에, Hugging Face 조사 결과가 `not_found` 인 검토 대기 실행을 지우는 SQL 입니다.
2026-11-22 기준 대상은 120건입니다.

- 대상: `model_research_run` 중 검토 대기(`model_id IS NULL`)이고, 그 실행의 `huggingface` 결과가 `not_found` 인 것
- `model_research_result` 는 FK 가 `ON DELETE CASCADE` 라 실행을 지우면 함께 지워집니다
- 120건 중 9건은 논문 조사와 병합 결과가 `found` 또는 `ambiguous` 입니다. 함께 지워지고 재조사에서 다시 만들어집니다
- 백업 없이 바로 지웁니다. 되돌릴 수 없습니다
- 배치 실행 **전에** 지워야 합니다. 배치는 DB 에 병합 결과가 있는 모델을 건너뜁니다

## 1. 대상 확인

120이 나와야 합니다.

```sql
SELECT COUNT(*) AS runs
FROM model_research_run r
WHERE r.model_id IS NULL
  AND EXISTS (SELECT 1 FROM model_research_result x
              WHERE x.run_id = r.id AND x.source = 'huggingface' AND x.status = 'not_found');
```

## 2. 삭제

```sql
DELETE r FROM model_research_run r
WHERE r.model_id IS NULL
  AND EXISTS (SELECT 1 FROM model_research_result x
              WHERE x.run_id = r.id AND x.source = 'huggingface' AND x.status = 'not_found');
```

## 3. 삭제 확인

0이 나와야 합니다.

```sql
SELECT COUNT(*) AS hf_not_found
FROM model_research_result
WHERE source = 'huggingface' AND status = 'not_found';
```

## 4. 재조사

백엔드에 "Hugging Face 저장소 직접 읽기" 변경이 반영된 뒤 실행합니다.
기본 대상인 `https://aibom.jeesu.io` 에 배포 전이라면 로컬 백엔드를 띄우고 `--api` 를 주세요.

```bat
run-batch.bat data\model_lists\hf-not-found-recheck-model-list.md
```
