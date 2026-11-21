"""`python -m aibom_collect [루트 모델]` opens the GUI; `--no-gui` runs in the console."""
from __future__ import annotations

import argparse
import queue
import sys

from .hub import DEFAULT_SORT, SORTS, HubClient, parse_model_id
from .pipeline import DEFAULT_OUT_DIR, Collector


def main() -> int:
    parser = argparse.ArgumentParser(prog="aibom_collect",
                                     description="루트 모델의 finetune 하위 모델 수집 → README 비교 필터링 → 목록 저장")
    parser.add_argument("model", nargs="?", default="", help="루트 모델 (예: Qwen/Qwen2.5-7B, Hugging Face URL도 가능)")
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR), help="출력 폴더 (그 아래 루트 모델별 폴더가 생깁니다)")
    parser.add_argument("--sort", choices=list(SORTS), default=DEFAULT_SORT,
                        help="하위 모델 정렬 기준 (Hugging Face 목록의 Sort와 같음)")
    parser.add_argument("--top", type=int, default=0, help="필터링 후 정렬 순서대로 상위 N개만 남김 (0: 전체)")
    parser.add_argument("--downloaded-only", action="store_true",
                        help="다운로드 수가 1 이상인 모델만 남김 (상위 N개를 자르기 전에 적용)")
    parser.add_argument("--workers", type=int, default=16, help="README 동시 다운로드 수")
    parser.add_argument("--keep-readme", action="store_true", help="README 원문을 출력 폴더에 보관")
    parser.add_argument("--no-gui", action="store_true", help="창 없이 콘솔에서 실행")
    args = parser.parse_args()
    workers = max(1, min(32, args.workers))
    top = max(0, args.top)

    if not args.no_gui:
        try:
            from .gui import run_gui
        except ImportError as error:  # Homebrew / some Linux Pythons ship without tkinter
            for line in (f"tkinter를 불러올 수 없습니다 ({error}).",
                         "macOS(Homebrew): brew install python-tk  ·  Ubuntu: sudo apt install python3-tk",
                         "또는 --no-gui 로 콘솔에서 실행하세요."):
                print(line, file=sys.stderr)
            return 2
        run_gui(args.model, args.out, workers, args.keep_readme, args.sort, top, args.downloaded_only)
        return 0

    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    if not args.model:
        parser.error("--no-gui 에는 루트 모델 이름이 필요합니다.")
    try:
        model = parse_model_id(args.model)
    except ValueError as error:
        print(error, file=sys.stderr)
        return 2
    collector = Collector(model, args.out, HubClient(), workers=workers, keep_readme=args.keep_readme,
                          sort=args.sort, top=top, downloaded_only=args.downloaded_only)
    collector.start()
    try:
        while collector.running or not collector.logs.empty():
            try:
                print(collector.logs.get(timeout=0.2), flush=True)
            except queue.Empty:
                pass
    except KeyboardInterrupt:
        collector.stop()
        collector.wait()
        while not collector.logs.empty():
            print(collector.logs.get(), flush=True)
    if collector.summary is None:
        return 1 if collector.stopped else 2
    return 1 if collector.error else 0


if __name__ == "__main__":
    sys.exit(main())
