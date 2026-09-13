# AIBOM API

FastAPI와 SQLAlchemy를 사용해 MySQL의 `model_info`, `model_hierarchy` 데이터를 제공합니다.

## 실행

먼저 프로젝트 루트에서 SQL을 적용합니다.

```bash
mysql -u root -p < sql/001_model_hierarchy_schema.sql
mysql -u root -p < sql/002_import_model_hierarchy.sql
```

백엔드 환경을 구성하고 실행합니다.

```bash
cd backend
python -m venv .venv
.venv/Scripts/activate
pip install -r requirements.txt
set DATABASE_URL=mysql+pymysql://USER:PASSWORD@127.0.0.1:3306/aibom?charset=utf8mb4
uvicorn app.main:app --reload
```

PowerShell에서는 환경 변수를 다음과 같이 설정합니다.

```powershell
$env:DATABASE_URL = "mysql+pymysql://USER:PASSWORD@127.0.0.1:3306/aibom?charset=utf8mb4"
```

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
