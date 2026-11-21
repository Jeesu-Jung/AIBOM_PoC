#!/bin/sh
# AIBOM AI research batch (GUI) for macOS / Linux. The backend must be running.
# Usage: ./run-batch.sh [model-list-file] [options]     e.g. ./run-batch.sh qwen2.5-7B-based-model-list.md
# Options: --api URL  --start N  --max N  --attempts N  --no-skip  --no-gui
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
    echo "[error] python3 not found." >&2
    exit 2
fi
PYTHONPATH="$ROOT/batch${PYTHONPATH:+:$PYTHONPATH}" exec "$PY" -m aibom_batch "$@"
