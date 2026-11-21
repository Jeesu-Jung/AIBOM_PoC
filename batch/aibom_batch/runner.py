"""Runs "AI로 정보 채우기" for many models: Hugging Face + paper research, AI merge, save.

Per model, the same calls the admin UI makes:
  1. research stream x2 (huggingface, paper) in parallel
  2. merge stream with both results
  3. one save of all three results as a new run -> the run shows up as "검토 대기"

The save happens once, after the merge, so a run without a merged result is never stored.
Finished research is checkpointed under the work directory, so a stopped or failed batch resumes
from the step that is missing instead of paying for the research again.
"""
from __future__ import annotations

import json
import queue
import random
import re
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

from .api import FAIL, FATAL, OFFLINE, RATE_LIMIT, ApiError, BackendClient, Cancelled
from .limiter import AdaptiveLimiter

PENDING, RESEARCHING, MERGING, SAVING = "대기", "조사 중", "병합 중", "저장 중"
DONE, FAILED, SKIPPED = "완료", "실패", "건너뜀"
ACTIVE = (RESEARCHING, MERGING, SAVING)
SOURCES = ("huggingface", "paper")
PHASES = SOURCES + ("merged",)
PHASE_LABELS = {"huggingface": "Hugging Face", "paper": "논문", "merged": "AI 병합"}
WORK_ROOT = Path(__file__).resolve().parents[1] / ".work"


def work_dir_for(input_path: str | Path) -> Path:
    """Checkpoints and progress of the batch for one list file (batch/.work/<file name>/)."""
    return WORK_ROOT / Path(input_path).stem


@dataclass
class Options:
    start_calls: int = 4            # concurrent LLM calls to begin with
    max_calls: int = 10             # never more than this
    max_attempts: int = 4           # tries per call for temporary errors
    max_rate_limit_retries: int = 10
    skip_existing: bool = True      # skip models done by an earlier batch or with a merged run in the DB
    backoff_seconds: float = 5.0
    cooldown_seconds: float = 15.0  # pause after a 429 (doubles while they continue)


@dataclass
class Task:
    index: int
    name: str
    status: str = PENDING
    phases: dict = field(default_factory=lambda: dict.fromkeys(PHASES, ""))
    run_id: int | None = None
    cost: float = 0.0
    started: float | None = None
    finished: float | None = None
    message: str = ""
    version: int = 0  # bumped on every change; the GUI redraws rows whose version moved


def _result_cost(result: dict | None) -> float:
    usage = ((result or {}).get("research") or {}).get("usage") or {}
    try:
        return float(usage.get("cost") or 0)
    except (TypeError, ValueError):
        return 0.0


class BatchRunner:
    def __init__(self, client: BackendClient, names: list[str], work_dir: Path, options: Options | None = None):
        self.client = client
        self.options = options or Options()
        self.tasks = [Task(index, name) for index, name in enumerate(names, 1)]
        self.limiter = AdaptiveLimiter(self.options.start_calls, self.options.max_calls,
                                       cooldown_seconds=self.options.cooldown_seconds)
        self.logs: queue.Queue[str] = queue.Queue()
        self.cancel = threading.Event()
        self.fatal: str | None = None
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self._session_done = 0
        self._lock = threading.RLock()
        self._queue: queue.Queue[Task] = queue.Queue()
        self._alive = 0
        self._offline_logged = False
        self._state_path = work_dir / "state.json"
        self._results_dir = work_dir / "results"
        self._state: dict[str, dict] = self._read_json(self._state_path) or {}
        if self.options.skip_existing:
            for task in self.tasks:
                saved = self._state.get(task.name) or {}
                if saved.get("status") in (DONE, SKIPPED):
                    task.status, task.run_id = saved["status"], saved.get("runId")
                    task.cost, task.message = saved.get("cost") or 0.0, saved.get("message") or ""

    # --- control --------------------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return self.started_at is not None and self.finished_at is None

    def start(self) -> None:
        self.started_at = time.time()
        todo = [task for task in self.tasks if task.status not in (DONE, SKIPPED)]
        for task in todo:
            self._queue.put(task)
        self.log(f"배치 시작: 전체 {len(self.tasks)}개 중 {len(todo)}개 조사 "
                 f"(동시 호출 {self.options.start_calls}개에서 시작, 최대 {self.options.max_calls}개)")
        with self._lock:
            if not todo:
                self._finish()
            for _ in range(min(len(todo), self.options.max_calls)):
                self._spawn()

    def stop(self) -> None:
        if self.running and not self.cancel.is_set():
            self.log("중지 요청: 진행 중인 호출을 끊습니다. 끝난 조사는 체크포인트에 남아 다음 실행에서 이어집니다.")
        self.cancel.set()
        self.client.abort()

    def set_max_calls(self, maximum: int) -> None:
        """Change the upper bound while running."""
        self.options.max_calls = maximum
        self.limiter.set_maximum(maximum)
        with self._lock:
            while self.running and self._alive < min(maximum, self._alive + self._queue.qsize()):
                self._spawn()

    def wait(self) -> None:
        while self.running:
            time.sleep(0.1)

    def _spawn(self) -> None:
        self._alive += 1
        threading.Thread(target=self._worker, daemon=True).start()

    def _finish(self) -> None:
        self.finished_at = time.time()
        counts = self.counts()
        reason = f"치명적 오류로 중단: {self.fatal}" if self.fatal else "중지됨" if self.cancel.is_set() else "배치 종료"
        self.log(f"{reason} · 완료 {counts[DONE]} · 건너뜀 {counts[SKIPPED]} · 실패 {counts[FAILED]} · "
                 f"남음 {counts[PENDING]} · 비용 ${self.total_cost():.2f}")

    # --- reporting ------------------------------------------------------------------------------
    def log(self, message: str) -> None:
        self.logs.put(f"[{time.strftime('%H:%M:%S')}] {message}")

    def counts(self) -> dict[str, int]:
        counts = dict.fromkeys((PENDING, DONE, FAILED, SKIPPED, "active"), 0)
        for task in self.tasks:
            counts["active" if task.status in ACTIVE else task.status] += 1
        return counts

    def total_cost(self) -> float:
        return sum(task.cost for task in self.tasks)

    def eta_seconds(self) -> float | None:
        """Remaining time from this session's throughput; None until a model has finished."""
        counts = self.counts()
        remaining = counts[PENDING] + counts["active"]
        if not self._session_done or not self.started_at or not remaining:
            return None
        return (time.time() - self.started_at) / self._session_done * remaining

    def _update(self, task: Task, phase: str | None = None, text: str | None = None, **changes) -> None:
        with self._lock:
            if phase is not None:
                task.phases[phase] = text or ""
            for key, value in changes.items():
                setattr(task, key, value)
            task.version += 1

    # --- persistence ----------------------------------------------------------------------------
    @staticmethod
    def _read_json(path: Path):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None

    @staticmethod
    def _write_json(path: Path, data) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(path.name + ".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        temp.replace(path)

    def _checkpoint_path(self, task: Task) -> Path:
        return self._results_dir / (re.sub(r"[^\w.\-]+", "__", task.name)[:150] + ".json")

    def _checkpoint(self, task: Task, results: dict) -> None:
        with self._lock:
            self._write_json(self._checkpoint_path(task), {"modelName": task.name, **results})

    def _record(self, task: Task) -> None:
        """Remember the outcome so the next batch on this list continues where this one ended."""
        with self._lock:
            self._state[task.name] = {"status": task.status, "runId": task.run_id, "cost": task.cost,
                                      "message": task.message}
            self._write_json(self._state_path, self._state)

    # --- work -----------------------------------------------------------------------------------
    def _worker(self) -> None:
        try:
            while not self.cancel.is_set():
                try:
                    task = self._queue.get_nowait()
                except queue.Empty:
                    break
                try:
                    self._process(task)
                except Cancelled:
                    self._back_to_pending(task)
                except Exception as error:  # noqa: BLE001 - one model must not stop the batch
                    if self.cancel.is_set() and not (isinstance(error, ApiError) and error.kind == FATAL):
                        self._back_to_pending(task)
                        continue
                    message = str(error) if isinstance(error, ApiError) else f"예상하지 못한 오류: {error!r}"
                    for phase in PHASES:
                        if not task.phases[phase].startswith("완료"):
                            self._update(task, phase, "")
                    self._update(task, status=FAILED, message=message, finished=time.time())
                    self._record(task)
                    self.log(f"✗ {task.name}: {message}")
        finally:
            with self._lock:
                self._alive -= 1
                if self._alive == 0 and self.finished_at is None:
                    self._finish()

    def _back_to_pending(self, task: Task) -> None:
        for phase in PHASES:
            if not task.phases[phase].startswith("완료"):
                self._update(task, phase, "")
        self._update(task, status=PENDING, message="중지됨 (다시 시작하면 이어서 진행)", finished=time.time())

    def _process(self, task: Task) -> None:
        self._update(task, status=RESEARCHING, started=time.time(), finished=None, message="", cost=0.0)
        results: dict[str, dict | None] = dict.fromkeys(PHASES)
        if self.options.skip_existing:
            runs = self._request(lambda: self.client.latest_runs(task.name))
            if runs and (runs[0].get("results") or {}).get("merged"):
                self._update(task, status=SKIPPED, run_id=runs[0].get("runId"), finished=time.time(),
                             message=f"AI 병합 결과가 이미 저장되어 있습니다 (AI 조사 #{runs[0].get('runId')})")
                self._record(task)
                self.log(f"– {task.name}: 이미 조사됨 (AI 조사 #{runs[0].get('runId')}), 건너뜀")
                return
            saved = self._read_json(self._checkpoint_path(task)) or {}
            if saved.get("modelName") == task.name:
                results.update({phase: saved.get(phase) or None for phase in PHASES})
        for phase in PHASES:
            self._update(task, phase, "완료 (복원)" if results[phase] else "")
        self._update(task, cost=sum(_result_cost(results[phase]) for phase in PHASES))

        errors: dict[str, BaseException] = {}

        def research(source: str) -> None:
            if results[source]:
                return
            try:
                results[source] = self._call(task, source, lambda on_event: self.client.research(
                    task.name, source, on_event, self.cancel))
                self._checkpoint(task, results)
                self._update(task, cost=sum(_result_cost(results[phase]) for phase in PHASES))
            except BaseException as error:  # noqa: BLE001 - reported by the worker below
                errors[source] = error

        paper = threading.Thread(target=research, args=("paper",), daemon=True)
        paper.start()
        research("huggingface")
        paper.join()
        if errors:
            ranked = sorted(errors.items(), key=lambda item: (
                0 if isinstance(item[1], ApiError) and item[1].kind == FATAL else
                1 if isinstance(item[1], Cancelled) else 2))
            source, error = ranked[0]
            if isinstance(error, ApiError):
                raise ApiError(f"{PHASE_LABELS[source]} 조사 실패: {error}", error.kind, error.status)
            raise error

        if not results["merged"]:
            self._update(task, status=MERGING)
            results["merged"] = self._call(task, "merged", lambda on_event: self.client.merge(
                task.name, {source: results[source] for source in SOURCES}, on_event, self.cancel))
            self._checkpoint(task, results)

        self._update(task, status=SAVING)
        saved_run = self._request(lambda: self.client.save_results(task.name, results, replace_previous=True))
        cost = sum(_result_cost(results[phase]) for phase in PHASES)
        self._update(task, status=DONE, run_id=saved_run.get("runId"), cost=cost, finished=time.time(),
                     message=f"검토 대기로 저장 · {(results['merged'].get('draft') or {}).get('modelId') or ''}".rstrip(" ·"))
        self._record(task)
        self._checkpoint_path(task).unlink(missing_ok=True)
        with self._lock:
            self._session_done += 1
        self.log(f"✓ {task.name}: AI 조사 #{task.run_id} 검토 대기로 저장 (${cost:.2f}, {task.finished - task.started:.0f}초)")

    def _call(self, task: Task, phase: str, send) -> dict:
        """One LLM call through the limiter, retried on rate limits and temporary errors."""
        def on_event(event: str, data: dict) -> None:
            if event == "content" and isinstance(data.get("characters"), int):
                self._update(task, phase, f"작성 중 {data['characters']:,}자")
            elif event == "activity" and data.get("kind") == "tool":
                self._update(task, phase, "웹 검색 중")
            elif event == "status" and data.get("stage") == "validating":
                self._update(task, phase, "검증 중")

        attempts = rate_limited = 0
        while True:
            self._update(task, phase, "순서 대기")
            token = self.limiter.acquire(self.cancel, priority=phase == "merged")
            if token is None:
                raise Cancelled()
            self._update(task, phase, "요청 중")
            outcome = "error"
            try:
                result = send(on_event)
                outcome = "ok"
            except ApiError as error:
                failure = error
                if error.kind == RATE_LIMIT:
                    outcome = RATE_LIMIT
            finally:
                self.limiter.release(token, outcome)
            if outcome == "ok":
                self._update(task, phase, "완료")
                return result

            label = f"{task.name} · {PHASE_LABELS[phase]}"
            if failure.kind == FATAL:
                self._stop_fatal(str(failure))
                raise failure
            if failure.kind == FAIL:
                raise failure
            if failure.kind == OFFLINE:
                self._wait_for_backend()
            elif failure.kind == RATE_LIMIT:
                rate_limited += 1
                if rate_limited > self.options.max_rate_limit_retries:
                    raise failure
                state = self.limiter.snapshot()
                self.log(f"429 {label}: 동시 호출을 {state['limit']}개로 줄이고 {state['cooldown']:.0f}초 쉽니다")
            else:
                attempts += 1
                if attempts >= self.options.max_attempts:
                    raise failure
                delay = self.options.backoff_seconds * 2 ** (attempts - 1) * random.uniform(0.8, 1.2)
                self.log(f"재시도 {attempts}/{self.options.max_attempts - 1} {label}: {failure} ({delay:.0f}초 뒤)")
                self._update(task, phase, f"재시도 대기 ({attempts})")
                self._sleep(delay)

    def _request(self, send):
        """A plain (non-LLM) API call with the same retry rules."""
        attempts = 0
        while True:
            if self.cancel.is_set():
                raise Cancelled()
            try:
                return send()
            except ApiError as error:
                if error.kind == OFFLINE:
                    self._wait_for_backend()
                    continue
                attempts += 1
                if error.kind in (FAIL, FATAL) or attempts >= self.options.max_attempts:
                    raise
                self._sleep(self.options.backoff_seconds * 2 ** (attempts - 1))

    def _sleep(self, seconds: float) -> None:
        if self.cancel.wait(seconds):
            raise Cancelled()

    def _wait_for_backend(self) -> None:
        """The backend is down: hold the batch (without using up retries) until it answers again."""
        with self._lock:
            if not self._offline_logged:
                self._offline_logged = True
                self.log(f"백엔드({self.client.base_url})에 연결할 수 없습니다. 다시 연결될 때까지 기다립니다.")
        delay = self.options.backoff_seconds
        while True:
            self._sleep(delay)
            try:
                self.client.health()
            except ApiError:
                delay = min(30.0, delay * 1.5)
                continue
            with self._lock:
                if self._offline_logged:
                    self._offline_logged = False
                    self.log("백엔드에 다시 연결되었습니다.")
            return

    def _stop_fatal(self, message: str) -> None:
        with self._lock:
            if self.fatal is None:
                self.fatal = message
        self.cancel.set()
        self.client.abort()
