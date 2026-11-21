# AIBOM 하위 모델 수집

루트 모델 이름을 넣으면 Hugging Face에서 그 모델의 finetune 하위 모델을 모두 수집하고, README를 비교해
조사 대상 목록을 만드는 GUI 프로그램입니다. 결과 목록은 `run-batch.bat`의 입력으로 그대로 쓸 수 있습니다.

## 실행

추가로 설치할 패키지는 없습니다 (Python 3.10 이상, 표준 라이브러리만 사용).

macOS / Linux 실행 스크립트는 `backend/.venv`의 Python에서 `tkinter`를 사용할 수 없으면
GUI가 지원되는 시스템 Python으로 자동 전환합니다. 기존 백엔드 가상환경과 실행 중인 백엔드에는
영향을 주지 않습니다. GUI 지원 Python이 없다면 Homebrew에서는 해당 Python 버전에 맞는
`python-tk` 패키지를 설치하세요 (예: Python 3.15는 `brew install python-tk@3.15`).

```bat
run-collect.bat
run-collect.bat Qwen/Qwen2.5-7B
```

macOS / Linux:

```bash
sh run-collect.sh Qwen/Qwen2.5-7B
```

창에서 **루트 모델**에 `Qwen/Qwen2.5-7B`(또는 Hugging Face URL)를 넣고 **시작**을 누릅니다.

| 옵션 | 기본값 | 설명 |
| --- | --- | --- |
| `--out DIR` | `data/model_lists` | 출력 폴더. 그 아래 루트 모델별 폴더가 생깁니다 |
| `--sort KEY` | `downloads` | 정렬 기준: `trending`, `likes`, `downloads`, `created`, `modified`, `most_params`, `least_params` |
| `--top N` | 0 | 필터링 후 정렬 순서대로 상위 N개만 남김 (0이면 전체) |
| `--workers N` | 16 | README 동시 다운로드 수 |
| `--keep-readme` | | README 원문을 출력 폴더의 `readme/`에 보관 |
| `--no-gui` | | 창 없이 콘솔에서 실행 (루트 모델 이름 필수) |

Hugging Face 토큰은 쓰지 않습니다. 공개된 모델 목록과 README만 로그인 없이 받습니다.

## 동작

1. **루트 확인**: `GET /api/models/<루트>`로 모델이 있는지 확인합니다.
2. **1차 수집**: `base_model:finetune:<루트>` 태그가 붙은 모델(직계 finetune)을 모두 받아
   선택한 정렬 순서 그대로 저장합니다. 정렬 기준은 Hugging Face 모델 목록의 Sort와 같습니다.
   adapter · merge · quantized 관계와 finetune의 finetune은 포함하지 않습니다.
3. **2차 필터링**: 각 모델의 `README.md`를 받아 아래에 해당하면 제외합니다.
   - **공식 카드 복사본**: 루트 모델과 같은 조직이 아닌데, README 본문이 루트 모델 또는 목록 안의 같은 조직 모델과 같은 경우.
     YAML front matter와 공백 · 빈 줄 차이는 무시합니다. 루트와 같은 조직의 모델은 그대로 둡니다.
   - **본문 없음**: front matter 외에 내용이 없는 경우
   - **README 없음**: 저장소에 `README.md`가 없는 경우
4. **상위 N개**: 개수를 지정했으면 필터링을 통과한 모델 중 정렬 순서대로 앞의 N개만 남깁니다.
   하위 모델은 개수와 상관없이 항상 전부 수집하고, 자르는 것은 필터링 뒤입니다.
   Trending처럼 정렬 값이 드러나지 않는 기준도 있어서, 값으로 다시 정렬하지 않고 Hugging Face가 돌려준 순서(`rank`)를 그대로 씁니다.

## 출력

`<출력 폴더>/<조직>__<모델>/` 아래에 만들어집니다. 예: `data/model_lists/Qwen__Qwen2.5-7B/`

| 파일 | 내용 |
| --- | --- |
| `1-finetunes.csv` | 1차 수집 전체, 정렬 순서대로 (순위 `rank`, 모델 ID, 다운로드, 좋아요, 생성일, 수정일, gated, README 유무) |
| `<모델>-based-model-list.md` | 최종 조사 대상. 한 줄에 모델 하나, 정렬 순서대로 |
| `<모델>-based-model-list-<정렬>-top<N>.md` | 상위 N개를 지정했을 때의 최종 목록. 전체 목록 파일을 덮어쓰지 않습니다 |
| `2-excluded.csv` | 제외한 모델과 사유 (`official_copy`, `empty_body`, `no_readme`, `readme_error`, 상위 N개 밖은 `over_limit`), 복사 원본 |
| `summary.json` | 루트 모델, 정렬 기준, 상위 개수, 수집 시각, 건수 |

`2-excluded.csv`와 `summary.json`은 마지막 실행 기준으로 덮어씁니다.

다운로드 수와 하위 모델 목록은 계속 바뀌므로 실행할 때마다 결과가 조금씩 달라질 수 있습니다.

- **재시도**: 429, 5xx, 연결 오류는 간격을 늘려 가며 다시 시도합니다 (`Retry-After`를 따릅니다).
- **README 처리**: README는 받는 즉시 `collector/.work/<조직>__<모델>/readme/`에 파일로 저장하고, 비교를 위해 실행 중에는
  메모리에도 올려 둡니다. 모두 성공하면 이 폴더를 지웁니다 (`--keep-readme`면 출력 폴더의 `readme/`에 남깁니다).
- **이어하기**: 중지했거나 일부 다운로드가 실패했으면 받은 파일이 남아 있어, 다시 시작할 때 빠진 것만 받습니다.
- **다운로드 실패**: 끝까지 받지 못한 모델은 최종 목록에 넣지 않고 `2-excluded.csv`에 `readme_error`로 남기며, 창에 경고를 띄웁니다.

## 테스트

Hugging Face를 호출하지 않는 mock 서버로 흐름을 검증합니다.

```bash
cd collector
python -m unittest discover -s tests -v
```
