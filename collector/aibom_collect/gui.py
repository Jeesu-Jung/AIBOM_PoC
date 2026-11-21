"""Tkinter window for the collector: root model input, progress, log."""
from __future__ import annotations

import os
import queue
import subprocess
import sys
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

from .hub import DEFAULT_SORT, SORTS, HubClient, parse_model_id
from .pipeline import DEFAULT_OUT_DIR, OVER_LIMIT, REASON_LABELS, Collector

LOG_FONT = ("Menlo", 11) if sys.platform == "darwin" else ("Consolas", 9) if sys.platform == "win32" else ("TkFixedFont", 10)
SORT_KEYS = {label: key for key, (label, _api, _direction) in SORTS.items()}
STAGE_TEXT = {"": "루트 모델 확인 중…", "list": "1차: 하위 모델 목록 수집 중", "readme": "2차: README 받는 중", "done": "완료"}


class App:
    def __init__(self, root: tk.Tk, model: str = "", out_dir: str | Path = DEFAULT_OUT_DIR, workers: int = 16,
                 keep_readme: bool = False, sort: str = DEFAULT_SORT, top: int = 0, downloaded_only: bool = False):
        self.root = root
        self.collector: Collector | None = None
        self._was_running = False
        root.title("AIBOM 하위 모델 수집")
        root.geometry(f"{min(900, root.winfo_screenwidth() - 40)}x{min(600, root.winfo_screenheight() - 120)}")
        root.minsize(680, 420)

        self.model_var = tk.StringVar(value=model)
        self.out_var = tk.StringVar(value=str(out_dir))
        self.workers_var = tk.IntVar(value=workers)
        self.keep_var = tk.BooleanVar(value=keep_readme)
        self.sort_var = tk.StringVar(value=SORTS[sort if sort in SORTS else DEFAULT_SORT][0])
        self.top_var = tk.IntVar(value=max(0, top))
        self.downloaded_var = tk.BooleanVar(value=downloaded_only)
        self.status_var = tk.StringVar(value="루트 모델 이름을 입력하고 시작을 누르세요. 예: Qwen/Qwen2.5-7B")

        form = ttk.Frame(root, padding=(10, 10, 10, 4))
        form.pack(fill="x")
        form.columnconfigure(1, weight=1)
        ttk.Label(form, text="루트 모델").grid(row=0, column=0, sticky="w")
        self.model_entry = ttk.Entry(form, textvariable=self.model_var)
        self.model_entry.grid(row=0, column=1, sticky="ew", padx=6)
        self.model_entry.bind("<Return>", lambda _event: self.start())
        self.start_button = ttk.Button(form, text="시작", command=self.start)
        self.start_button.grid(row=0, column=2)
        self.stop_button = ttk.Button(form, text="중지", command=self.stop, state="disabled")
        self.stop_button.grid(row=0, column=3, padx=(6, 0))
        ttk.Label(form, text="출력 폴더").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.out_entry = ttk.Entry(form, textvariable=self.out_var)
        self.out_entry.grid(row=1, column=1, sticky="ew", padx=6, pady=(6, 0))
        self.browse_button = ttk.Button(form, text="찾아보기…", command=self.browse)
        self.browse_button.grid(row=1, column=2, pady=(6, 0))
        self.open_button = ttk.Button(form, text="폴더 열기", command=self.open_folder)
        self.open_button.grid(row=1, column=3, padx=(6, 0), pady=(6, 0))

        settings = ttk.Frame(root, padding=(10, 4))
        settings.pack(fill="x")
        ttk.Label(settings, text="정렬").pack(side="left")
        self.sort_combo = ttk.Combobox(settings, textvariable=self.sort_var, values=list(SORT_KEYS), state="readonly",
                                       width=17)
        self.sort_combo.pack(side="left", padx=(4, 12))
        ttk.Label(settings, text="상위").pack(side="left")
        self.top_spin = ttk.Spinbox(settings, from_=0, to=1000000, increment=100, width=8, textvariable=self.top_var)
        self.top_spin.pack(side="left", padx=4)
        ttk.Label(settings, text="개 (0 = 전체, 필터링 후 기준)").pack(side="left", padx=(0, 12))
        ttk.Label(settings, text="동시 다운로드").pack(side="left")
        self.workers_spin = ttk.Spinbox(settings, from_=1, to=32, width=4, textvariable=self.workers_var)
        self.workers_spin.pack(side="left", padx=(4, 12))

        checks = ttk.Frame(root, padding=(10, 0, 10, 4))
        checks.pack(fill="x")
        self.downloaded_check = ttk.Checkbutton(checks, text="다운로드 수 1 이상인 모델만", variable=self.downloaded_var)
        self.downloaded_check.pack(side="left", padx=(0, 12))
        self.keep_check = ttk.Checkbutton(checks, text="README 원문을 출력 폴더에 보관", variable=self.keep_var)
        self.keep_check.pack(side="left")

        status = ttk.Frame(root, padding=(10, 4))
        status.pack(fill="x")
        self.progress = ttk.Progressbar(status, mode="determinate")
        self.progress.pack(fill="x")
        ttk.Label(status, textvariable=self.status_var).pack(anchor="w", pady=(4, 0))

        self.log_box = ScrolledText(root, height=12, state="disabled", wrap="word", font=LOG_FONT)
        self.log_box.pack(fill="both", expand=True, padx=10, pady=(4, 10))

        root.protocol("WM_DELETE_WINDOW", self.close)
        self.model_entry.focus_set()
        self.root.after(200, self.tick)

    # --- actions --------------------------------------------------------------------------------
    def browse(self) -> None:
        path = filedialog.askdirectory(title="출력 폴더", initialdir=self.out_var.get() or None)
        if path:
            self.out_var.set(path)

    def open_folder(self) -> None:
        collector = self.collector
        path = collector.out_dir if collector and collector.out_dir else Path(self.out_var.get().strip() or ".")
        if not path.exists():
            messagebox.showinfo("출력 폴더", f"아직 폴더가 없습니다:\n{path}")
        elif sys.platform == "win32":
            os.startfile(path)  # noqa: S606
        else:
            subprocess.Popen(["open" if sys.platform == "darwin" else "xdg-open", str(path)])

    def start(self) -> None:
        if self.collector and self.collector.running:
            return
        try:
            model = parse_model_id(self.model_var.get())
        except ValueError as error:
            messagebox.showwarning("루트 모델", str(error))
            return
        out_dir = self.out_var.get().strip().strip('"')
        if not out_dir:
            messagebox.showwarning("출력 폴더", "출력 폴더를 지정하세요.")
            return
        try:
            workers = max(1, min(32, int(self.workers_var.get())))
        except (tk.TclError, ValueError):
            workers = 16
        self.workers_var.set(workers)
        try:
            top = max(0, int(self.top_var.get()))
        except (tk.TclError, ValueError):
            messagebox.showwarning("상위 개수", "상위 개수는 0 이상의 숫자로 입력하세요. 0이면 전체를 남깁니다.")
            return
        self.top_var.set(top)
        self.collector = Collector(model, out_dir, HubClient(), workers=workers, keep_readme=self.keep_var.get(),
                                   sort=SORT_KEYS.get(self.sort_var.get(), DEFAULT_SORT), top=top,
                                   downloaded_only=self.downloaded_var.get())
        self.collector.start()
        self._was_running = True
        self._set_running(True)

    def stop(self) -> None:
        if self.collector and self.collector.running:
            self.collector.stop()
            self.stop_button.configure(state="disabled")

    def close(self) -> None:
        if self.collector and self.collector.running:
            if not messagebox.askokcancel("종료", "수집 중입니다. 중지하고 닫을까요?\n받은 README는 다음 실행에서 이어집니다."):
                return
            self.collector.stop()
        self.root.destroy()

    def _set_running(self, running: bool) -> None:
        idle = "disabled" if running else "normal"
        for widget in (self.model_entry, self.out_entry, self.browse_button, self.workers_spin, self.keep_check,
                       self.downloaded_check, self.top_spin, self.start_button):
            widget.configure(state=idle)
        self.sort_combo.configure(state="disabled" if running else "readonly")
        self.stop_button.configure(state="normal" if running else "disabled")

    # --- display --------------------------------------------------------------------------------
    def tick(self) -> None:
        collector = self.collector
        if collector:
            lines = []
            try:
                while True:
                    lines.append(collector.logs.get_nowait())
            except queue.Empty:
                pass
            if lines:
                self.log_box.configure(state="normal")
                self.log_box.insert("end", "\n".join(lines) + "\n")
                self.log_box.see("end")
                self.log_box.configure(state="disabled")
            if collector.running:
                self._show_progress(collector)
            elif self._was_running and collector.finished_at is not None:
                self._was_running = False
                self._set_running(False)
                self._show_result(collector)
        self.root.after(200, self.tick)

    def _show_progress(self, collector: Collector) -> None:
        text = STAGE_TEXT.get(collector.stage, "")
        if collector.stage == "list":
            self.progress.configure(mode="indeterminate")
            self.progress.step(4)
            text += f"  ·  {collector.total}건"
        elif collector.stage == "readme":
            self.progress.configure(mode="determinate", maximum=max(1, collector.total), value=collector.done)
            text += f"  ·  {collector.done} / {collector.total}"
        self.status_var.set(text)

    def _show_result(self, collector: Collector) -> None:
        self.progress.configure(mode="determinate", maximum=1, value=1 if collector.summary else 0)
        summary = collector.summary
        if summary:
            excluded = "  ·  ".join(f"{REASON_LABELS[reason]} {count}" for reason, count in summary["excluded"].items()
                                    if reason != OVER_LIMIT)
            self.status_var.set(f"완료: 수집 {summary['collected']}건 → 필터 통과 {summary['passedFilter']}건"
                                + (f"  (제외: {excluded})" if excluded else "")
                                + (f" → 상위 {summary['top']}개 제한으로 {summary['kept']}건" if summary["top"] else ""))
            if collector.error:
                messagebox.showwarning("일부 실패", collector.error)
        elif collector.stopped:
            self.status_var.set("중지했습니다. 다시 시작하면 이어서 받습니다.")
        else:
            self.status_var.set("실패했습니다. 아래 로그를 확인하세요.")
            messagebox.showerror("수집 실패", collector.error or "알 수 없는 오류")


def run_gui(model: str = "", out_dir: str | Path = DEFAULT_OUT_DIR, workers: int = 16, keep_readme: bool = False,
            sort: str = DEFAULT_SORT, top: int = 0, downloaded_only: bool = False) -> None:
    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise SystemExit(f"창을 열 수 없습니다 ({error}). --no-gui 로 콘솔에서 실행할 수 있습니다.") from error
    App(root, model, out_dir, workers, keep_readme, sort, top, downloaded_only)
    root.mainloop()
