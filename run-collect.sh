#!/bin/sh
# AIBOM finetune model collector (GUI) for macOS / Linux.
# Usage: ./run-collect.sh [root-model] [options]     e.g. ./run-collect.sh Qwen/Qwen2.5-7B
# Options: --sort KEY  --top N  --out DIR  --workers N  --keep-readme  --no-gui
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY=""
# The backend venv may use a Homebrew Python version without the matching
# tkinter package. The collector uses only the standard library, so it can
# safely fall back to a Tk-enabled system Python without changing the backend.
for CANDIDATE in "$ROOT/backend/.venv/bin/python" "$(command -v python3 2>/dev/null)" "$(command -v python 2>/dev/null)"; do
    if [ -n "$CANDIDATE" ] && [ -x "$CANDIDATE" ] && \
       "$CANDIDATE" -c 'import tkinter' >/dev/null 2>&1; then
        PY="$CANDIDATE"
        break
    fi
done
if [ -z "$PY" ]; then
    echo "[error] tkinter를 사용할 수 있는 Python을 찾지 못했습니다." >&2
    echo "macOS(Homebrew): 사용 중인 Python 버전에 맞는 python-tk를 설치하세요." >&2
    exit 2
fi
echo "[info] GUI Python: $PY" >&2
PYTHONPATH="$ROOT/collector${PYTHONPATH:+:$PYTHONPATH}" exec "$PY" -m aibom_collect "$@"
