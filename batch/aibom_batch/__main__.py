"""`python -m aibom_batch [목록 파일]` opens the GUI; `--no-gui` runs in the console."""
from __future__ import annotations

import argparse
import os
import queue
import sys
import time

from .api import DEFAULT_API_URL, ApiError, BackendClient
from .inputs import read_model_list
from .runner import FAILED, PENDING, BatchRunner, Options, work_dir_for


def main() -> int:
    parser = argparse.ArgumentParser(prog="aibom_batch", description="AIBOM AI 조사 배치 (HF · 논문 조사 → AI 병합 → 검토 대기 저장)")
    parser.add_argument("input", nargs="?", default="", help="모델 목록 파일 (한 줄에 모델 하나, 또는 마크다운 표)")
    parser.add_argument("--api", default=os.getenv("AIBOM_API_BASE_URL", DEFAULT_API_URL), help="백엔드 주소")
    parser.add_argument("--start", type=int, default=4, help="처음 동시 LLM 호출 수")
    parser.add_argument("--max", type=int, default=10, help="최대 동시 LLM 호출 수")
    parser.add_argument("--attempts", type=int, default=4, help="일시적 오류 시 호출당 시도 횟수")
    parser.add_argument("--no-skip", action="store_true", help="이미 AI 병합 결과가 있는 모델도 다시 조사")
    parser.add_argument("--no-gui", action="store_true", help="창 없이 콘솔에서 실행")
    args = parser.parse_args()
    options = Options(start_calls=max(1, min(args.start, args.max)), max_calls=max(1, args.max),
                      max_attempts=max(1, args.attempts), skip_existing=not args.no_skip)

    if not args.no_gui:
        try:
            from .gui import run_gui
        except ImportError as error:  # Homebrew / some Linux Pythons ship without tkinter
            for line in (f"tkinter를 불러올 수 없습니다 ({error}).",
                         "macOS(Homebrew): brew install python-tk  ·  Ubuntu: sudo apt install python3-tk",
                         "또는 --no-gui 로 콘솔에서 실행하세요."):
                print(line, file=sys.stderr)
            return 2
        run_gui(args.input, args.api, options)
        return 0

    if not args.input:
        parser.error("--no-gui 에는 모델 목록 파일이 필요합니다.")
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    client = BackendClient(args.api)
    try:
        client.health()
    except ApiError as error:
        print(error, file=sys.stderr)
        return 2
    runner = BatchRunner(client, read_model_list(args.input), work_dir_for(args.input), options)
    runner.start()
    try:
        while runner.running or not runner.logs.empty():
            try:
                print(runner.logs.get(timeout=0.2), flush=True)
            except queue.Empty:
                pass
    except KeyboardInterrupt:
        runner.stop()
        runner.wait()
        time.sleep(0.1)
        while not runner.logs.empty():
            print(runner.logs.get(), flush=True)
    counts = runner.counts()
    return 1 if runner.fatal or counts[FAILED] or counts[PENDING] else 0


if __name__ == "__main__":
    sys.exit(main())
