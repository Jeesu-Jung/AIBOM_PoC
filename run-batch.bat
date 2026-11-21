@echo off
setlocal
rem AIBOM AI research batch (GUI). The backend must be running (run-backend.bat).
rem Usage: run-batch.bat [model-list-file] [options]     e.g. run-batch.bat qwen2.5-7B-based-model-list.md
rem Options: --api URL  --start N  --max N  --attempts N  --no-skip  --no-gui

set "PY=%~dp0backend\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
set "PYTHONPATH=%~dp0batch"

"%PY%" -m aibom_batch %*
if errorlevel 2 (
    echo.
    echo [error] Batch failed to start. See the messages above.
    pause
)
exit /b %errorlevel%
