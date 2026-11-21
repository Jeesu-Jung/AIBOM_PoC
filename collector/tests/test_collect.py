"""Collector flow against a mock hub. Run from `collector/`: python -m unittest discover -s tests -v"""
from __future__ import annotations

import csv
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from aibom_collect.hub import HubClient, parse_model_id  # noqa: E402
from aibom_collect.pipeline import Collector, normalise_body  # noqa: E402
from mock_hub import MockHub  # noqa: E402

ROOT = "Org/Base-7B"
README = [{"rfilename": "README.md"}, {"rfilename": "config.json"}]


def entry(model_id: str, downloads: int, siblings=README) -> dict:
    return {"id": model_id, "downloads": downloads, "likes": 1, "createdAt": "2026-01-01T00:00:00.000Z",
            "gated": False, "siblings": siblings}


def card(body: str, front_matter: str = "license: apache-2.0") -> str:
    return f"---\n{front_matter}\n---\n\n{body}\n"


MODELS = [
    entry("Org/Base-7B-Instruct", 900),
    entry("user/real", 800),
    entry("user/copy-instruct", 700),
    entry("user/copy-root", 600),
    entry("user/empty", 500),
    entry("user/no-readme", 400, siblings=[{"rfilename": "config.json"}]),
    entry("user/twin-1", 300),
    entry("user/twin-2", 200),
    entry("user/broken", 100),
    entry("user/slow", 50),
    {"id": "../escape", "downloads": 1},  # not a model id: ignored
]
READMES = {
    "Org/Base-7B-Instruct": card("# Instruct\n\nOfficial instruct card."),
    "user/real": card("# Real\n\nA card written for this model."),
    "user/copy-instruct": card("# Instruct\r\n\r\n\r\nOfficial   instruct card.  ", "base_model: Org/Base-7B\ntags: [x]"),
    "user/copy-root": "# Base\n\nOfficial root card.\n",
    "user/empty": "---\nbase_model: Org/Base-7B\n---\n",
    "user/twin-1": card("# Twin\n\nSame author, same text."),
    "user/twin-2": card("# Twin\n\nSame author, same text."),
    "user/broken": card("never served"),
    "user/slow": card("# Slow\n\nServed after one 429."),
}


class ParseTests(unittest.TestCase):
    def test_ids_and_urls(self):
        self.assertEqual(parse_model_id(" Qwen/Qwen2.5-7B "), "Qwen/Qwen2.5-7B")
        self.assertEqual(parse_model_id("https://huggingface.co/Qwen/Qwen2.5-7B"), "Qwen/Qwen2.5-7B")
        self.assertEqual(parse_model_id("huggingface.co/Qwen/Qwen2.5-7B/tree/main?x=1"), "Qwen/Qwen2.5-7B")
        self.assertEqual(parse_model_id("gpt2"), "gpt2")

    def test_rejects_other_text(self):
        for text in ("", "a model name", "https://example.com/Qwen/Qwen2.5-7B", "a/b/c"):
            with self.assertRaises(ValueError):
                parse_model_id(text)

    def test_normalise_body(self):
        self.assertEqual(normalise_body(b"---\na: 1\n---\n\n# T\r\n\r\ntext   here \n"), "# T\ntext here")
        self.assertEqual(normalise_body(b"---\na: 1\n---\n"), "")
        self.assertEqual(normalise_body(b"no front matter\n---\nstill body"), "no front matter\n---\nstill body")


class CollectTests(unittest.TestCase):
    def run_collector(self, hub: MockHub, out: Path, root_input: str = ROOT, **options) -> Collector:
        client = HubClient(hub.url, attempts=2, backoff_seconds=0.01)
        collector = Collector(root_input, out / "out", client, workers=4, work_root=out / "work", **options)
        collector.run()
        return collector

    def test_collects_and_filters(self):
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n\nOfficial root card.\n", MODELS, READMES) as hub:
            hub.fail_always.add("user/broken")
            hub.rate_limit_once.add("user/slow")
            original_iter = HubClient.iter_finetunes
            HubClient.iter_finetunes = lambda self, root_id, sort, page_size=4: original_iter(self, root_id, sort, page_size)
            try:
                collector = self.run_collector(hub, Path(tmp), root_input=f"https://huggingface.co/{ROOT.lower()}")
            finally:
                HubClient.iter_finetunes = original_iter
            folder = Path(tmp) / "out" / "Org__Base-7B"
            self.assertEqual(collector.out_dir, folder)

            with (folder / "1-finetunes.csv").open(encoding="utf-8", newline="") as handle:
                collected = [row["model_id"] for row in csv.DictReader(handle)]
            self.assertEqual(collected, [model["id"] for model in MODELS[:-1]])  # every page, listing order

            kept = (folder / "Base-7B-based-model-list.md").read_text(encoding="utf-8").splitlines()
            self.assertEqual(kept, ["Org/Base-7B-Instruct", "user/real", "user/twin-1", "user/twin-2", "user/slow"])

            with (folder / "2-excluded.csv").open(encoding="utf-8", newline="") as handle:
                excluded = {row["model_id"]: (row["reason"], row["copied_from"]) for row in csv.DictReader(handle)}
            self.assertEqual(excluded, {
                "user/copy-instruct": ("official_copy", "Org/Base-7B-Instruct"),
                "user/copy-root": ("official_copy", ROOT),
                "user/empty": ("empty_body", ""),
                "user/no-readme": ("no_readme", ""),
                "user/broken": ("readme_error", ""),
            })
            summary = json.loads((folder / "summary.json").read_text(encoding="utf-8"))
            self.assertEqual((summary["root"], summary["collected"], summary["kept"]), (ROOT, 10, 5))
            self.assertTrue(collector.error)  # a failed download is reported, not hidden
            self.assertTrue((Path(tmp) / "work" / "Org__Base-7B" / "readme").exists())  # kept for the retry
            self.assertFalse(any("no-readme/resolve" in path for path in hub.requests))

            # Second run: the broken README is served now; only that one is downloaded again.
            hub.fail_always.clear()
            hub.requests.clear()
            collector = self.run_collector(hub, Path(tmp))
            self.assertEqual([path for path in hub.requests if "/resolve/" in path], ["/user/broken/resolve/main/README.md"])
            self.assertEqual(collector.error, "")
            self.assertEqual(collector.summary["kept"], 6)
            self.assertFalse((Path(tmp) / "work" / "Org__Base-7B").exists())  # cache removed after a clean run

    def test_keep_readme(self):
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", MODELS[:2], READMES) as hub:
            collector = self.run_collector(hub, Path(tmp), keep_readme=True)
            self.assertEqual(collector.summary["kept"], 2)
            saved = sorted(path.name for path in (Path(tmp) / "out" / "Org__Base-7B" / "readme").iterdir())
            self.assertEqual(saved, ["Org__Base-7B-Instruct.md", "Org__Base-7B.md", "user__real.md"])
            self.assertEqual(set(hub.auth_headers), {None})

    def test_top_n_after_filter_in_listing_order(self):
        # Listing order differs from download order, as with a trending sort that exposes no value.
        listing = [MODELS[8], MODELS[2], MODELS[6], MODELS[4], MODELS[1], MODELS[0], MODELS[7]]
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", listing, READMES) as hub:
            collector = self.run_collector(hub, Path(tmp), sort="trending", top=3)
            folder = Path(tmp) / "out" / "Org__Base-7B"
            self.assertIn("sort=trendingScore&direction=-1", hub.requests[1])
            # copy-instruct and empty are filtered out first; the first three survivors in listing order remain.
            kept = (folder / "Base-7B-based-model-list-trending-top3.md").read_text(encoding="utf-8").splitlines()
            self.assertEqual(kept, ["user/broken", "user/twin-1", "user/real"])
            with (folder / "2-excluded.csv").open(encoding="utf-8", newline="") as handle:
                excluded = [(row["rank"], row["model_id"], row["reason"]) for row in csv.DictReader(handle)]
            self.assertEqual(excluded, [("2", "user/copy-instruct", "official_copy"), ("4", "user/empty", "empty_body"),
                                        ("6", "Org/Base-7B-Instruct", "over_limit"), ("7", "user/twin-2", "over_limit")])
            self.assertEqual((collector.summary["passedFilter"], collector.summary["kept"]), (5, 3))
            self.assertFalse((folder / "Base-7B-based-model-list.md").exists())

    def test_downloaded_only_is_applied_before_the_top_n_cut(self):
        listing = [entry("user/real", 0), MODELS[2], entry("user/twin-1", 0), MODELS[7], MODELS[0], MODELS[9]]
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", listing, READMES) as hub:
            collector = self.run_collector(hub, Path(tmp), sort="trending", top=2, downloaded_only=True)
            folder = Path(tmp) / "out" / "Org__Base-7B"
            kept = (folder / "Base-7B-based-model-list-trending-top2-dl1.md").read_text(encoding="utf-8").splitlines()
            self.assertEqual(kept, ["user/twin-2", "Org/Base-7B-Instruct"])  # zero-download models do not use up the top 2
            with (folder / "2-excluded.csv").open(encoding="utf-8", newline="") as handle:
                excluded = [(row["model_id"], row["reason"]) for row in csv.DictReader(handle)]
            self.assertEqual(excluded, [("user/copy-instruct", "official_copy"), ("user/real", "no_downloads"),
                                        ("user/twin-1", "no_downloads"), ("user/slow", "over_limit")])
            summary = collector.summary
            self.assertEqual((summary["minDownloads"], summary["passedFilter"], summary["kept"]), (1, 3, 2))

            collector = self.run_collector(hub, Path(tmp), sort="trending")  # unchecked: zero downloads stay
            kept = (folder / "Base-7B-based-model-list.md").read_text(encoding="utf-8").splitlines()
            self.assertEqual(kept[0], "user/real")
            self.assertIsNone(collector.summary["minDownloads"])

    def test_rate_limit_is_waited_out_and_reported(self):
        client = HubClient("http://127.0.0.1:1")
        self.assertEqual(client._rate_limit_delay({"RateLimit": '"resolvers";r=0;t=129'}, 1), 130.0)
        self.assertEqual(client._rate_limit_delay({"Retry-After": "30", "RateLimit": '"api";r=0;t=5'}, 1), 31.0)
        self.assertEqual(client._rate_limit_delay({"RateLimit": '"api";r=0;t=99999'}, 1), 600.0)
        self.assertEqual(client._rate_limit_delay({}, 2), 8.0)

        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", MODELS[:2], READMES) as hub:
            hub.rate_limit_times["user/real"] = 4  # more 429s than `attempts`: a rate limit is not a failure
            collector = self.run_collector(hub, Path(tmp))
            self.assertEqual((collector.summary["kept"], collector.error), (2, ""))
            logs = []
            while not collector.logs.empty():
                logs.append(collector.logs.get())
            self.assertEqual(len([line for line in logs if "[대기] HTTP 429 (요청 한도 초과)" in line]), 1)
            self.assertEqual(collector.alert(), "")

    def test_wait_and_silence_are_shown(self):
        collector = Collector(ROOT, "unused", HubClient("http://127.0.0.1:1"))
        collector._on_wait("HTTP 429 (요청 한도 초과)", 120)
        self.assertRegex(collector.alert(), r"^HTTP 429 \(요청 한도 초과\) · 1[12]\d초 뒤 다시 시도$")
        collector._notice = ("", 0.0, 0.0)
        collector.client._in_flight = 1
        collector.client._last_activity -= 25
        self.assertRegex(collector.alert(), r"^Hugging Face 응답 없음 · 2\d초째 기다리는 중$")

    def test_server_errors_are_reported_before_giving_up(self):
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", MODELS[:2], READMES) as hub:
            hub.fail_always.add("user/real")
            collector = self.run_collector(hub, Path(tmp))
            logs = []
            while not collector.logs.empty():
                logs.append(collector.logs.get())
            self.assertTrue(any("[대기] HTTP 500" in line for line in logs))
            self.assertTrue(any("README 실패: user/real (HTTP 500" in line for line in logs))
            self.assertTrue(collector.error)

    def test_least_parameters_sort_and_unknown_sort(self):
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", MODELS[:2], READMES) as hub:
            self.run_collector(hub, Path(tmp), sort="least_params")
            self.assertIn("sort=num_parameters&direction=1", hub.requests[1])
            with self.assertRaises(ValueError):
                Collector(ROOT, Path(tmp), sort="bogus")

    def test_unknown_root(self):
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", MODELS, READMES) as hub:
            collector = self.run_collector(hub, Path(tmp), root_input="Org/Missing")
            self.assertIsNone(collector.summary)
            self.assertIn("찾을 수 없습니다", collector.error)
            self.assertFalse((Path(tmp) / "out").exists())

    def test_stop_keeps_no_partial_list(self):
        with tempfile.TemporaryDirectory() as tmp, MockHub(ROOT, "# Base\n", MODELS, READMES) as hub:
            client = HubClient(hub.url, attempts=2, backoff_seconds=0.01)
            collector = Collector(ROOT, Path(tmp) / "out", client, work_root=Path(tmp) / "work")
            original = client.iter_finetunes

            def stop_after_listing(root_id, sort):
                yield from original(root_id, sort)
                collector.stop()

            client.iter_finetunes = stop_after_listing
            collector.run()
            folder = Path(tmp) / "out" / "Org__Base-7B"
            self.assertTrue(collector.stopped)
            self.assertIsNone(collector.summary)
            self.assertTrue((folder / "1-finetunes.csv").exists())
            self.assertFalse((folder / "Base-7B-based-model-list.md").exists())


if __name__ == "__main__":
    unittest.main()
