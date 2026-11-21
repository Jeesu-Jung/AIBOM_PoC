@echo off
setlocal
rem AIBOM finetune model collector (GUI). Collects the finetunes of a root model from Hugging Face.
rem Usage: run-collect.bat [root-model] [options]     e.g. run-collect.bat Qwen/Qwen2.5-7B
rem Options: --out DIR  --workers N  --keep-readme  --no-gui

set "PY=%~dp0backend\.venv\Scripts\python.exe"
if not exist "%PY%" set "PY=python"
set "PYTHONPATH=%~dp0collector"

"%PY%" -m aibom_collect %*
if errorlevel 2 (
    echo.
    echo [error] Collector failed. See the messages above.
    pause
)
exit /b %errorlevel%
