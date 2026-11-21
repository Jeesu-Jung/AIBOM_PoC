"""Tkinter window for the research batch: settings, live progress per model, log."""
from __future__ import annotations

import queue
import sys
import time
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
from tkinter.scrolledtext import ScrolledText

from .api import DEFAULT_API_URL, ApiError, BackendClient
from .inputs import read_model_list
from .runner import ACTIVE, DONE, FAILED, PENDING, SKIPPED, BatchRunner, Options, work_dir_for

COLUMNS = (
    ("no", "#", 50, "e"), ("name", "모델", 330, "w"), ("status", "상태", 70, "center"),
    ("huggingface", "Hugging Face", 125, "w"), ("paper", "논문", 125, "w"), ("merged", "AI 병합", 125, "w"),
    ("run", "조사 #", 65, "e"), ("cost", "비용", 65, "e"), ("time", "소요", 60, "e"), ("message", "메시지", 420, "w"),
)
ROW_COLORS = {DONE: "#e7f6ec", FAILED: "#fde8e8", SKIPPED: "#f0f0f0", "active": "#e8f1fd"}
LOG_FONT = ("Menlo", 11) if sys.platform == "darwin" else ("Consolas", 9) if sys.platform == "win32" else ("TkFixedFont", 10)


def _duration(seconds: float | None) -> str:
    if seconds is None:
        return ""
    seconds = int(seconds)
    hours, rest = divmod(seconds, 3600)
    return f"{hours}:{rest // 60:02d}:{rest % 60:02d}" if hours else f"{rest // 60}:{rest % 60:02d}"


class App:
    def __init__(self, root: tk.Tk, input_path: str = "", api_url: str = DEFAULT_API_URL,
                 options: Options | None = None):
        defaults = options or Options()
        self.root = root
        self.runner: BatchRunner | None = None
        self._shown: dict[int, int] = {}
        root.title("AIBOM AI 조사 배치")
        # Fit smaller screens (e.g. a MacBook) instead of opening partly off-screen.
        root.geometry(f"{min(1500, root.winfo_screenwidth() - 40)}x{min(820, root.winfo_screenheight() - 120)}")
        root.minsize(1000, 560)

        self.input_var = tk.StringVar(value=input_path)
        self.api_var = tk.StringVar(value=api_url)
        self.start_var = tk.IntVar(value=defaults.start_calls)
        self.max_var = tk.IntVar(value=defaults.max_calls)
        self.attempts_var = tk.IntVar(value=defaults.max_attempts)
        self.skip_var = tk.BooleanVar(value=defaults.skip_existing)
        self.summary_var = tk.StringVar(value="모델 목록 파일을 선택하세요.")
        self.limiter_var = tk.StringVar()

        top = ttk.Frame(root, padding=(10, 10, 10, 4))
        top.pack(fill="x")
        top.columnconfigure(1, weight=1)
        ttk.Label(top, text="모델 목록").grid(row=0, column=0, sticky="w")
        self.input_entry = ttk.Entry(top, textvariable=self.input_var)
        self.input_entry.grid(row=0, column=1, sticky="ew", padx=6)
        self.input_entry.bind("<Return>", lambda _event: self.load_list())
        self.browse_button = ttk.Button(top, text="찾아보기…", command=self.browse)
        self.browse_button.grid(row=0, column=2)
        ttk.Label(top, text="백엔드 주소").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.api_entry = ttk.Entry(top, textvariable=self.api_var)
        self.api_entry.grid(row=1, column=1, sticky="ew", padx=6, pady=(6, 0))

        settings = ttk.Frame(root, padding=(10, 4))
        settings.pack(fill="x")
        ttk.Label(settings, text="동시 LLM 호출  시작").pack(side="left")
        self.start_spin = ttk.Spinbox(settings, from_=1, to=64, width=4, textvariable=self.start_var)
        self.start_spin.pack(side="left", padx=(4, 10))
        ttk.Label(settings, text="최대").pack(side="left")
        self.max_spin = ttk.Spinbox(settings, from_=1, to=64, width=4, textvariable=self.max_var,
                                    command=self.apply_max)
        self.max_spin.pack(side="left", padx=(4, 10))
        self.max_spin.bind("<Return>", lambda _event: self.apply_max())
        ttk.Label(settings, text="오류 시 시도 횟수").pack(side="left")
        self.attempts_spin = ttk.Spinbox(settings, from_=1, to=10, width=4, textvariable=self.attempts_var)
        self.attempts_spin.pack(side="left", padx=(4, 10))
        self.skip_check = ttk.Checkbutton(settings, text="이미 AI 병합 결과가 있는 모델은 건너뛰기", variable=self.skip_var,
                                          command=lambda: self.input_var.get().strip() and self.load_list())
        self.skip_check.pack(side="left", padx=(4, 10))
        self.stop_button = ttk.Button(settings, text="중지", command=self.stop, state="disabled")
        self.stop_button.pack(side="right")
        self.start_button = ttk.Button(settings, text="시작", command=self.start)
        self.start_button.pack(side="right", padx=6)

        status = ttk.Frame(root, padding=(10, 4))
        status.pack(fill="x")
        self.progress = ttk.Progressbar(status, mode="determinate")
        self.progress.pack(fill="x")
        ttk.Label(status, textvariable=self.summary_var).pack(anchor="w", pady=(4, 0))
        ttk.Label(status, textvariable=self.limiter_var, foreground="#555").pack(anchor="w")

        panes = ttk.Panedwindow(root, orient="vertical")
        panes.pack(fill="both", expand=True, padx=10, pady=(4, 10))
        table = ttk.Frame(panes)
        self.tree = ttk.Treeview(table, columns=[column[0] for column in COLUMNS], show="headings", selectmode="browse")
        for key, title, width, anchor in COLUMNS:
            self.tree.heading(key, text=title)
            self.tree.column(key, width=width, anchor=anchor, stretch=key == "message")
        for tag, color in ROW_COLORS.items():
            # Explicit text colour: in macOS dark mode the default is white, unreadable on these rows.
            self.tree.tag_configure(tag, background=color, foreground="#111111")
        scroll = ttk.Scrollbar(table, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=scroll.set)
        self.tree.pack(side="left", fill="both", expand=True)
        scroll.pack(side="right", fill="y")
        self.tree.bind("<Double-1>", self.show_detail)
        panes.add(table, weight=4)
        self.log_box = ScrolledText(panes, height=9, state="disabled", wrap="word", font=LOG_FONT)
        panes.add(self.log_box, weight=1)

        root.protocol("WM_DELETE_WINDOW", self.close)
        if input_path:
            self.load_list()
        self.root.after(250, self.tick)

    # --- settings -------------------------------------------------------------------------------
    def browse(self) -> None:
        path = filedialog.askopenfilename(title="모델 목록 파일", filetypes=[("목록 파일", (".md", ".txt")), ("모든 파일", "*")])
        if path:
            self.input_var.set(path)
            self.load_list()

    def _int(self, variable: tk.IntVar, fallback: int, low: int, high: int) -> int:
        try:
            value = int(variable.get())
        except (tk.TclError, ValueError):
            value = fallback
        value = max(low, min(high, value))
        variable.set(value)
        return value

    def _options(self) -> Options:
        maximum = self._int(self.max_var, 10, 1, 64)
        return Options(start_calls=min(self._int(self.start_var, 4, 1, 64), maximum), max_calls=maximum,
                       max_attempts=self._int(self.attempts_var, 4, 1, 10), skip_existing=self.skip_var.get())

    def _build_runner(self) -> BatchRunner | None:
        path = self.input_var.get().strip().strip('"')
        if not path:
            messagebox.showwarning("모델 목록", "모델 목록 파일을 선택하세요.")
            return None
        try:
            names = read_model_list(path)
            client = BackendClient(self.api_var.get().strip())
        except (OSError, UnicodeDecodeError, ValueError) as error:
            messagebox.showerror("모델 목록", f"불러오지 못했습니다: {error}")
            return None
        if not names:
            messagebox.showwarning("모델 목록", "파일에서 모델 이름을 찾지 못했습니다.")
            return None
        return BatchRunner(client, names, work_dir_for(path), self._options())

    def load_list(self) -> None:
        """Show the list (with what an earlier batch already finished) before anything runs."""
        if self.runner and self.runner.running:
            return
        runner = self._build_runner()
        if runner:
            self._show(runner)

    def _show(self, runner: BatchRunner) -> None:
        self.runner = runner
        self._shown.clear()
        self.tree.delete(*self.tree.get_children())
        for task in runner.tasks:
            self.tree.insert("", "end", iid=str(task.index))
        self.progress.configure(maximum=len(runner.tasks))
        self.refresh(force=True)

    # --- run ------------------------------------------------------------------------------------
    def start(self) -> None:
        if self.runner and self.runner.running:
            return
        runner = self._build_runner()
        if not runner:
            return
        self._show(runner)
        todo = sum(task.status not in (DONE, SKIPPED) for task in runner.tasks)
        if not todo:
            messagebox.showinfo("배치", "조사할 모델이 없습니다. 목록의 모델이 모두 완료되었습니다.")
            return
        try:
            healthy = runner.client.health()
        except ApiError as error:
            messagebox.showerror("백엔드", str(error))
            return
        if not healthy and not messagebox.askyesno("백엔드", "백엔드 상태 확인(/api/v1/health)이 정상이 아닙니다. 그래도 시작할까요?"):
            return
        if not messagebox.askokcancel("배치 시작", f"{todo}개 모델을 조사합니다.\n\n모델마다 LLM 호출 3회(Hugging Face · 논문 · AI 병합)가 "
                                              "실행되어 OpenRouter 비용이 발생하고, 결과는 “검토 대기”로 저장됩니다.\n\n시작할까요?"):
            return
        runner.start()
        self._set_running(True)

    def stop(self) -> None:
        if self.runner and self.runner.running:
            self.runner.stop()
            self.stop_button.configure(state="disabled")

    def apply_max(self) -> None:
        if self.runner and self.runner.running:
            self.runner.set_max_calls(self._int(self.max_var, 10, 1, 64))

    def _set_running(self, running: bool) -> None:
        idle = "disabled" if running else "normal"
        for widget in (self.input_entry, self.browse_button, self.api_entry, self.start_spin, self.attempts_spin,
                       self.skip_check, self.start_button):
            widget.configure(state=idle)
        self.stop_button.configure(state="normal" if running else "disabled")

    def close(self) -> None:
        if self.runner and self.runner.running:
            if not messagebox.askokcancel("종료", "배치가 실행 중입니다. 중지하고 닫을까요?\n끝난 조사는 다음 실행에서 이어집니다."):
                return
            self.runner.stop()
        self.root.destroy()

    # --- display --------------------------------------------------------------------------------
    def show_detail(self, _event=None) -> None:
        selected = self.tree.selection()
        if not selected or not self.runner:
            return
        task = self.runner.tasks[int(selected[0]) - 1]
        messagebox.showinfo(task.name, f"상태: {task.status}\n조사 #: {task.run_id or '-'}\n\n{task.message or '(메시지 없음)'}")

    def tick(self) -> None:
        runner = self.runner
        if runner:
            lines = []
            try:
                while True:
                    lines.append(runner.logs.get_nowait())
            except queue.Empty:
                pass
            if lines:
                self.log_box.configure(state="normal")
                self.log_box.insert("end", "\n".join(lines) + "\n")
                self.log_box.see("end")
                self.log_box.configure(state="disabled")
            self.refresh()
            if runner.finished_at is not None and str(self.start_button["state"]) == "disabled":
                self._set_running(False)
                if runner.fatal:
                    messagebox.showerror("배치 중단", f"계속할 수 없는 오류로 배치를 멈췄습니다.\n\n{runner.fatal}")
        self.root.after(250, self.tick)

    def refresh(self, force: bool = False) -> None:
        runner = self.runner
        if not runner:
            return
        now = time.time()
        for task in runner.tasks:
            active = task.status in ACTIVE
            if not force and not active and self._shown.get(task.index) == task.version:
                continue
            self._shown[task.index] = task.version
            elapsed = None if task.started is None else (now if active else task.finished or now) - task.started
            self.tree.item(str(task.index), tags=("active" if active else task.status,), values=(
                task.index, task.name, task.status, task.phases["huggingface"], task.phases["paper"],
                task.phases["merged"], task.run_id or "", f"${task.cost:.2f}" if task.cost else "",
                _duration(elapsed), task.message.replace("\n", " ")))
        counts = runner.counts()
        finished = counts[DONE] + counts[SKIPPED] + counts[FAILED]
        self.progress.configure(value=finished)
        end = runner.finished_at or now
        elapsed = _duration(end - runner.started_at) if runner.started_at else "-"
        eta = _duration(runner.eta_seconds()) if runner.running else ""
        self.summary_var.set(
            f"전체 {len(runner.tasks)}  ·  완료 {counts[DONE]}  ·  건너뜀 {counts[SKIPPED]}  ·  실패 {counts[FAILED]}  ·  "
            f"진행 중 {counts['active']}  ·  대기 {counts[PENDING]}      비용 ${runner.total_cost():.2f}  ·  경과 {elapsed}"
            + (f"  ·  남은 시간 약 {eta}" if eta else ""))
        state = runner.limiter.snapshot()
        cooldown = f"  ·  429 쿨다운 {state['cooldown']:.0f}초" if state["cooldown"] > 0 else ""
        self.limiter_var.set(
            f"동시 LLM 호출 {state['inFlight']} / 현재 한도 {state['limit']} (자동 조절 상한 {state['ceiling']}, 설정 최대 "
            f"{state['maximum']})  ·  429 응답 {state['rateLimits']}회{cooldown}" if runner.started_at else
            "시작하면 동시 호출 수를 자동으로 조절합니다: 성공하면 늘리고, 429가 오면 절반으로 줄인 뒤 쉬었다가 다시 올립니다.")


def run_gui(input_path: str = "", api_url: str = DEFAULT_API_URL, options: Options | None = None) -> None:
    try:
        root = tk.Tk()
    except tk.TclError as error:
        raise SystemExit(f"창을 열 수 없습니다 ({error}). --no-gui 로 콘솔에서 실행할 수 있습니다.") from error
    App(root, input_path, api_url, options)
    root.mainloop()
