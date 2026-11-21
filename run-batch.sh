#!/bin/sh
# AIBOM AI research batch (GUI) for macOS / Linux. The backend must be running.
# Usage: ./run-batch.sh [model-list-file] [options]     e.g. ./run-batch.sh qwen2.5-7B-based-model-list.md
# Options: --api URL  --start N  --max N  --attempts N  --no-skip  --no-gui
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY=""
# The backend venv may use a Homebrew Python version without the matching
# tkinter package. The batch client uses only the standard library, so it can
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
PYTHONPATH="$ROOT/batch${PYTHONPATH:+:$PYTHONPATH}" exec "$PY" -m aibom_batch "$@"
