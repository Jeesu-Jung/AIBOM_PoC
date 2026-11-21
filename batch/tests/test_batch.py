"""Batch flow against a mock backend. Run from `batch/`: python -m unittest discover -s tests -v"""
from __future__ import annotations

import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aibom_batch.api import BackendClient  # noqa: E402
from aibom_batch.inputs import parse_model_list  # noqa: E402
from aibom_batch.limiter import AdaptiveLimiter  # noqa: E402
from aibom_batch.runner import DONE, FAILED, PENDING, SKIPPED, BatchRunner, Options  # noqa: E402
from mock_backend import MockBackend  # noqa: E402

FAST = dict(backoff_seconds=0.02, cooldown_seconds=0.05)


class InputTests(unittest.TestCase):
    def test_plain_lines(self):
        self.assertEqual(parse_model_list("Qwen/Qwen2.5-7B-Instruct\nQwen/Qwen2.5-Coder-7B\n\nQwen/Qwen2.5-Coder-7B\n"),
                         ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-Coder-7B"])

    def test_markdown_table_and_prose(self):
        text = """# 조사 대상
- 루트 모델: [`Qwen/Qwen2.5-7B`](https://huggingface.co/Qwen/Qwen2.5-7B)
- 수집일: 2026-11-15

| # | 모델 ID | 다운로드(30일) |
| --- | --- | ---: |
| 1 | [`Qwen/Qwen2.5-7B-Instruct`](https://huggingface.co/Qwen/Qwen2.5-7B-Instruct) | 6517377 |
| 2 | [`sail/Sailor2-8B`](https://huggingface.co/sail/Sailor2-8B) | 952 |
"""
        self.assertEqual(parse_model_list(text), ["Qwen/Qwen2.5-7B-Instruct", "sail/Sailor2-8B"])

    def test_urls_bullets_and_names_without_org(self):
        self.assertEqual(parse_model_list("https://huggingface.co/a/b\n- c/d\n* `e/f`\nGPT-4 Turbo\n"),
                         ["a/b", "c/d", "e/f", "GPT-4 Turbo"])


class LimiterTests(unittest.TestCase):
    def test_grows_on_success_and_halves_on_rate_limit(self):
        limiter = AdaptiveLimiter(4, 10, cooldown_seconds=0.05)
        cancel = threading.Event()
        for _ in range(4):
            limiter.release(limiter.acquire(cancel), "ok")
        self.assertEqual(limiter.snapshot()["limit"], 5)
        tokens = [limiter.acquire(cancel) for _ in range(5)]
        for token in tokens:  # calls that fail together cut the limit once
            limiter.release(token, "rate_limit")
        state = limiter.snapshot()
        self.assertEqual((state["limit"], state["ceiling"], state["rateLimits"]), (2, 4, 5))
        self.assertGreater(state["cooldown"], 0)
        started = time.monotonic()
        self.assertIsNotNone(limiter.acquire(cancel))  # waits for the cool-down
        self.assertGreaterEqual(time.monotonic() - started, 0.03)

    def test_held_slot_is_not_given_to_waiting_callers(self):
        limiter = AdaptiveLimiter(1, 1)
        cancel = threading.Event()
        token = limiter.acquire(cancel)
        got = []
        waiter = threading.Thread(target=lambda: got.append(limiter.acquire(cancel)), daemon=True)
        waiter.start()
        limiter.release(token, "ok", hold=True)
        time.sleep(0.15)
        self.assertEqual(got, [])  # the slot is still the first caller's
        self.assertEqual(limiter.snapshot()["inFlight"], 1)
        limiter.release(limiter.resume_held(cancel), "ok")
        waiter.join(2)
        self.assertEqual(len(got), 1)
        limiter.release(got[0], "ok", hold=True)
        limiter.release_held()
        self.assertEqual(limiter.snapshot()["inFlight"], 0)

    def test_acquire_stops_when_cancelled(self):
        limiter = AdaptiveLimiter(1, 1)
        cancel = threading.Event()
        limiter.acquire(cancel)
        threading.Timer(0.1, cancel.set).start()
        self.assertIsNone(limiter.acquire(cancel))


class RunnerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.work = Path(self.temp.name)
        self.backend = None

    def tearDown(self):
        if self.backend:
            self.backend.close()
        self.temp.cleanup()

    def run_batch(self, names, options=None, **backend_args):
        if self.backend is None:
            self.backend = MockBackend(**backend_args)
        runner = BatchRunner(BackendClient(self.backend.url, stream_timeout=5), names, self.work,
                             options or Options(**FAST))
        runner.start()
        deadline = time.time() + 30
        while runner.running and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse(runner.running, "batch did not finish")
        return runner

    def test_saves_all_three_results_once_as_a_new_run(self):
        runner = self.run_batch(["org/a", "org/b", "org/c"])
        self.assertEqual([task.status for task in runner.tasks], [DONE] * 3)
        self.assertEqual(len(self.backend.saves), 3)
        for save in self.backend.saves:
            self.assertTrue(save["replacePrevious"])
            self.assertEqual({key for key, value in save["results"].items() if value}, {"huggingface", "paper", "merged"})
        self.assertEqual(sorted(task.run_id for task in runner.tasks), [101, 102, 103])
        self.assertAlmostEqual(runner.total_cost(), 4.5)
        self.assertEqual(list((self.work / "results").glob("*.json")), [])  # checkpoints are cleaned up

    def test_merge_starts_as_soon_as_both_research_calls_end(self):
        # Slow papers: when a model's Hugging Face call ends, its slot goes to another model's research.
        # The merge must still start the moment the paper ends, not wait behind that other research.
        names = [f"org/m{index}" for index in range(6)]
        runner = self.run_batch(names, Options(start_calls=3, max_calls=3, **FAST),
                                delays={"huggingface": 0.1, "paper": 0.3, "merged": 0.1})
        self.assertEqual([task.status for task in runner.tasks], [DONE] * 6)
        self.assertLessEqual(self.backend.peak, 3)
        self.assertEqual(runner.limiter.snapshot()["inFlight"], 0)
        for name in names:
            calls = {phase: (started, ended) for model, phase, started, ended in self.backend.timeline if model == name}
            waited = calls["merged"][0] - max(calls["huggingface"][1], calls["paper"][1])
            self.assertLess(waited, 0.08, f"{name}: merge waited {waited:.2f}s for a slot")

    def test_held_slot_is_freed_when_the_other_research_fails(self):
        runner = self.run_batch(["org/a", "org/b"], Options(start_calls=2, max_calls=2, max_attempts=1, **FAST),
                                script={("org/a", "paper"): [500]}, delays={"huggingface": 0.2, "paper": 0.02})
        self.assertEqual([task.status for task in runner.tasks], [FAILED, DONE])
        self.assertEqual(runner.limiter.snapshot()["inFlight"], 0)

    def test_rate_limit_and_temporary_errors_are_retried(self):
        runner = self.run_batch(["org/a", "org/b"], script={
            ("org/a", "huggingface"): [429], ("org/a", "merged"): [502, "invalid"], ("org/b", "paper"): ["drop"]})
        self.assertEqual([task.status for task in runner.tasks], [DONE, DONE])
        self.assertEqual(runner.limiter.snapshot()["rateLimits"], 1)
        self.assertEqual(self.backend.calls.count(("org/a", "merged")), 3)

    def test_concurrency_settles_under_the_provider_limit(self):
        names = [f"org/m{index}" for index in range(12)]
        runner = self.run_batch(names, Options(start_calls=8, max_calls=8, max_rate_limit_retries=50, **FAST),
                                max_concurrent=3, delay=0.05)
        self.assertEqual([task.status for task in runner.tasks], [DONE] * 12)
        self.assertGreater(runner.limiter.rate_limits, 0)
        self.assertLessEqual(runner.limiter.snapshot()["limit"], 8)

    def test_failed_model_keeps_finished_research_for_the_next_run(self):
        runner = self.run_batch(["org/a", "org/b"], Options(max_attempts=2, **FAST),
                                script={("org/a", "paper"): [500, 500]})
        self.assertEqual([task.status for task in runner.tasks], [FAILED, DONE])
        self.assertIn("논문 조사 실패", runner.tasks[0].message)
        self.assertEqual([save["modelName"] for save in self.backend.saves], ["org/b"])

        runner = self.run_batch(["org/a", "org/b"])  # same work dir: resumes
        self.assertEqual([task.status for task in runner.tasks], [DONE, DONE])
        self.assertEqual(self.backend.calls.count(("org/a", "huggingface")), 1)  # restored from the checkpoint
        self.assertEqual(self.backend.calls.count(("org/b", "huggingface")), 1)  # finished earlier, not repeated
        self.assertEqual(len(self.backend.saves), 2)

    def test_models_with_a_merged_run_are_skipped(self):
        existing = {"org/a": {"runId": 7, "results": {"huggingface": {}, "paper": {}, "merged": {"id": 1}}},
                    "org/b": {"runId": 8, "results": {"huggingface": {"id": 2}, "paper": None, "merged": None}}}
        runner = self.run_batch(["org/a", "org/b"], existing=existing)
        self.assertEqual([task.status for task in runner.tasks], [SKIPPED, DONE])
        self.assertEqual(runner.tasks[0].run_id, 7)
        self.assertEqual([save["modelName"] for save in self.backend.saves], ["org/b"])

    def test_no_skip_researches_again(self):
        existing = {"org/a": {"runId": 7, "results": {"merged": {"id": 1}}}}
        runner = self.run_batch(["org/a"], Options(skip_existing=False, **FAST), existing=existing)
        self.assertEqual(runner.tasks[0].status, DONE)

    def test_fatal_error_stops_the_batch(self):
        names = [f"org/m{index}" for index in range(6)]
        runner = self.run_batch(names, Options(start_calls=1, max_calls=1, **FAST),
                                script={("org/m1", "huggingface"): [402]})
        self.assertIn("402", runner.fatal)
        statuses = [task.status for task in runner.tasks]
        self.assertEqual(statuses[0], DONE)
        self.assertEqual(statuses[1], FAILED)
        self.assertEqual(statuses[2:], [PENDING] * 4)

    def test_stop_returns_running_models_to_pending(self):
        self.backend = MockBackend(delay=1.0)
        runner = BatchRunner(BackendClient(self.backend.url), ["org/a", "org/b"], self.work, Options(**FAST))
        runner.start()
        time.sleep(0.2)
        runner.stop()
        runner.wait()
        self.assertEqual([task.status for task in runner.tasks], [PENDING, PENDING])
        self.assertEqual(self.backend.saves, [])

    def test_waits_for_an_offline_backend(self):
        self.backend = MockBackend()
        url = self.backend.url
        self.backend.close()
        runner = BatchRunner(BackendClient(url), ["org/a"], self.work, Options(**FAST))
        runner.start()
        time.sleep(0.4)
        self.assertTrue(runner.running)  # holds instead of failing the model
        self.assertEqual(runner.tasks[0].status, "조사 중")
        runner.stop()
        runner.wait()
        self.backend = None


if __name__ == "__main__":
    unittest.main()
