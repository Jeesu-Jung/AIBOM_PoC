# AIBOM API

FastAPI와 SQLAlchemy를 사용해 MySQL의 `model_info`, `model_hierarchy` 데이터를 제공합니다.

## 실행

먼저 프로젝트 루트에서 SQL을 적용합니다.

```bash
mysql -u root -p < sql/001_model_hierarchy_schema.sql
mysql -u root -p < sql/002_import_model_hierarchy.sql
```

백엔드 환경을 구성합니다. 설정은 `.env.example`을 복사한 `backend/.env.local`에 적습니다.

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
copy .env.example .env.local   # DATABASE_URL, OPENROUTER_API_KEY 등을 채웁니다
```

실행합니다. 앱이 시작할 때 `backend/.env.local`(그다음 `backend/.env`)을 자동으로 읽으므로 환경 변수를 따로 설정할 필요가 없습니다.

```bash
uvicorn app.main:app --reload
```

- 셸에 이미 설정된 환경 변수가 파일 값보다 우선합니다. 예: `$env:OPENROUTER_MODEL = "..."` (PowerShell)
- `AIBOM_SKIP_ENV_FILES=1`이면 파일을 읽지 않습니다. 테스트(`tests/conftest.py`)는 이 값을 설정해 개발자 설정과 무관하게 동작합니다.
- `/api/v1/health`가 503이면 DB 연결 정보(`DATABASE_URL`)를 확인하세요.

API 문서는 `http://127.0.0.1:8000/docs`에서 확인할 수 있습니다.

## 엔드포인트

전체 API 명세(OpenAPI 3.1)는 `backend/openapi.yaml` 에 있습니다. Swagger Editor(https://editor.swagger.io) 에 붙여 넣거나 `/docs` 와 함께 참고하세요.


- `GET /api/v1/health`
- `GET /api/v1/families` (lightweight family index and aggregate counts)
- `GET /api/v1/models`
- `GET /api/v1/models/{namespace}/{model-name}`
- `GET /api/v1/families/{family-key}/hierarchy` (selected family only)

The frontend loads the family index first, then lazily requests the selected
family hierarchy and model details.
