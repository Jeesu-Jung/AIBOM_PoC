#!/bin/sh
# AIBOM finetune model collector (GUI) for macOS / Linux.
# Usage: ./run-collect.sh [root-model] [options]     e.g. ./run-collect.sh Qwen/Qwen2.5-7B
# Options: --out DIR  --workers N  --keep-readme  --no-gui
ROOT="$(cd "$(dirname "$0")" && pwd)"
PY="$ROOT/backend/.venv/bin/python"
[ -x "$PY" ] || PY="$(command -v python3 || command -v python)"
if [ -z "$PY" ]; then
    echo "[error] python3 not found." >&2
    exit 2
fi
PYTHONPATH="$ROOT/collector${PYTHONPATH:+:$PYTHONPATH}" exec "$PY" -m aibom_collect "$@"
