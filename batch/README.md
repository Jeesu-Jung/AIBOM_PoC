# AIBOM AI 조사 배치

관리 화면의 "AI로 정보 채우기"를 모델 목록 전체에 대해 자동으로 실행하는 GUI 프로그램입니다.
모델마다 Hugging Face 조사와 논문 조사를 병렬로 실행하고, 두 결과를 AI로 병합한 뒤, 세 결과를
하나의 AI 조사 실행으로 저장합니다. 저장된 실행은 관리 화면의 "AI 조사 이력"에 **검토 대기**로 나타납니다.

## 실행

기본으로 `https://aibom.jeesu.io` 백엔드를 호출합니다. 로컬 백엔드(`run-backend.bat`)를 쓰려면 `--api http://127.0.0.1:8000`을 주거나
`aibom_batch/api.py`의 `DEFAULT_API_URL` 주석을 바꾸세요. 추가로 설치할 패키지는 없습니다 (Python 표준 라이브러리만 사용).

```bat
run-batch.bat qwen2.5-7B-based-model-list.md
```

macOS / Linux:

```bash
sh run-batch.sh qwen2.5-7B-based-model-list.md
```

- Python 3.10 이상이 필요합니다. `backend/.venv`가 있으면 그 Python을, 없으면 `python3`를 씁니다.
- Homebrew Python에는 tkinter가 빠져 있습니다. `brew install python-tk`로 설치하거나 `--no-gui`로 실행하세요
  (python.org 설치본에는 포함되어 있습니다).

또는 `batch/` 폴더에서:

```bash
python -m aibom_batch ../qwen2.5-7B-based-model-list.md            # GUI
python -m aibom_batch ../qwen2.5-7B-based-model-list.md --no-gui   # 콘솔
```

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--api URL` | `https://aibom.jeesu.io` | 백엔드 주소 (`AIBOM_API_BASE_URL` 환경 변수로도 지정). 로컬 백엔드는 `http://127.0.0.1:8000` |
| `--start N` | 4 | 처음 동시 LLM 호출 수 |
| `--max N` | 10 | 최대 동시 LLM 호출 수 (GUI에서는 실행 중에도 변경 가능) |
| `--attempts N` | 4 | 일시적 오류에 대한 호출당 시도 횟수 |
| `--no-skip` | | 이미 AI 병합 결과가 있는 모델도 다시 조사 |
| `--no-gui` | | 창 없이 콘솔에서 실행 |

## 입력 파일

- 한 줄에 모델 이름 하나 (`Qwen/Qwen2.5-7B-Instruct`, Hugging Face URL도 가능)
- 또는 `qwen2.5-7B-research-target.md` 같은 마크다운 표: 표의 각 행에서 모델 ID를 읽습니다
- 빈 줄, `#` 줄, 설명 문장은 무시하고 중복은 한 번만 조사합니다

## 동작

모델 하나에 대해 관리 화면과 같은 API를 순서대로 호출합니다.

1. `POST /api/v1/admin/model-research/stream`: `huggingface`, `paper` 두 번, 병렬
2. `POST /api/v1/admin/model-research/merge/stream`: 두 결과를 AI 병합
3. `POST /api/v1/admin/model-research/results`: 세 결과를 새 실행으로 한 번에 저장 (검토 대기)

그 밖에 `GET /api/v1/health`(시작 전 확인)와 `GET /api/v1/admin/research-runs`(이미 조사된 모델 확인)만 사용합니다.
백엔드 코드는 import하지 않고 HTTP로만 통신합니다.

- **동시 호출 자동 조절**: 호출이 성공하면 동시 호출 수를 조금씩 늘리고, OpenRouter가 429를 돌려주면
  절반으로 줄인 뒤 잠시 쉬고(429가 이어지면 쉬는 시간 2배), 429가 났던 수준 바로 아래를 상한으로 둡니다.
  상한은 5분마다 1씩 회복됩니다.
- **재시도**: 시간 초과, 5xx, 검증에 실패한 응답은 간격을 늘려 가며 다시 시도합니다.
  백엔드가 내려가 있으면 실패로 처리하지 않고 다시 연결될 때까지 기다립니다.
- **즉시 중단**: API 키 미설정, 401, 402(크레딧 부족), 404(모델 설정 오류)는 계속해도 모두 실패하므로 배치를 멈춥니다.
- **이어하기**: 끝난 조사 결과는 `batch/.work/<목록 파일 이름>/`에 체크포인트로 남습니다. 중지했거나 실패한
  모델은 다시 시작하면 빠진 단계만 호출합니다. 완료된 모델과 DB에 AI 병합 결과가 있는 모델은 건너뜁니다.
- 병합까지 끝난 모델만 저장하므로, 병합 결과가 없는 실행은 만들어지지 않습니다.

## 테스트

OpenRouter를 호출하지 않는 mock 백엔드로 흐름을 검증합니다.

```bash
cd batch
python -m unittest discover -s tests -v
```
