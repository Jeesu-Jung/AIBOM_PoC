"""Collect finetunes of a root model (stage 1) and filter them by README (stage 2)."""
from __future__ import annotations

import csv
import json
import queue
import re
import shutil
import threading
import time
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

from .hub import MODEL_ID, Cancelled, HubClient, HubError, parse_model_id

PACKAGE_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT_DIR = PACKAGE_ROOT.parent / "data" / "model_lists"
WORK_ROOT = PACKAGE_ROOT / ".work"

CHILDREN_FILE = "1-finetunes.csv"
EXCLUDED_FILE = "2-excluded.csv"
SUMMARY_FILE = "summary.json"

# Exclusion reasons
NO_README = "no_readme"          # the repository has no README.md
EMPTY_BODY = "empty_body"        # nothing but YAML front matter
OFFICIAL_COPY = "official_copy"  # body equals a card of the root model's organisation
README_ERROR = "readme_error"    # README.md could not be downloaded
REASON_LABELS = {OFFICIAL_COPY: "공식 카드 복사본", EMPTY_BODY: "본문 없음", NO_README: "README 없음",
                 README_ERROR: "README 다운로드 실패"}

_FRONT_MATTER = re.compile(r"\A﻿?---\s*\n.*?\n---\s*(?:\n|\Z)", re.DOTALL)


@dataclass
class Child:
    model_id: str
    downloads: int = 0
    likes: int = 0
    created_at: str = ""
    last_modified: str = ""
    gated: str = ""
    has_readme: bool | None = None  # None: the listing did not say


@dataclass
class Excluded:
    child: Child
    reason: str
    copied_from: str = ""
    detail: str = ""


def safe_name(model_id: str) -> str:
    return model_id.replace("/", "__")


def list_file_name(root_id: str) -> str:
    return f"{root_id.split('/')[-1]}-based-model-list.md"


def normalise_body(raw: bytes) -> str:
    """README text without YAML front matter, blank lines and whitespace differences."""
    text = raw.decode("utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    text = _FRONT_MATTER.sub("", text, count=1)
    lines = (re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n"))
    return "\n".join(line for line in lines if line)


def parse_child(item: dict) -> Child | None:
    model_id = item.get("id") or item.get("modelId") or ""
    if not isinstance(model_id, str) or not MODEL_ID.fullmatch(model_id):
        return None
    siblings = item.get("siblings")
    has_readme = None
    if isinstance(siblings, list):
        has_readme = any(isinstance(entry, dict) and entry.get("rfilename") == "README.md" for entry in siblings)
    gated = item.get("gated")
    return Child(model_id=model_id, downloads=int(item.get("downloads") or 0), likes=int(item.get("likes") or 0),
                 created_at=str(item.get("createdAt") or ""), last_modified=str(item.get("lastModified") or ""),
                 gated="" if gated in (None, False) else str(gated), has_readme=has_readme)


def classify(root_id: str, root_readme: bytes | None, children: list[Child],
             readmes: dict[str, bytes | HubError | None]) -> tuple[list[Child], list[Excluded]]:
    """Split children into kept and excluded. `readmes` maps id -> bytes, None (no README) or the error.

    A copy is a model outside the root's organisation whose README body equals the root's card or
    the card of a listed model in that organisation. The organisation's own models are kept.
    """
    owner = root_id.split("/")[0].lower()
    is_official = lambda model_id: model_id.split("/")[0].lower() == owner  # noqa: E731
    bodies = {child.model_id: normalise_body(raw) for child in children
              if isinstance(raw := readmes.get(child.model_id), bytes)}
    official: dict[str, str] = {}
    if root_readme and (root_body := normalise_body(root_readme)):
        official[root_body] = root_id
    for child in children:
        if is_official(child.model_id) and bodies.get(child.model_id):
            official.setdefault(bodies[child.model_id], child.model_id)

    kept: list[Child] = []
    excluded: list[Excluded] = []
    for child in children:
        readme = readmes.get(child.model_id)
        if isinstance(readme, HubError):
            excluded.append(Excluded(child, README_ERROR, detail=str(readme)))
        elif readme is None:
            excluded.append(Excluded(child, NO_README))
        elif not bodies[child.model_id]:
            excluded.append(Excluded(child, EMPTY_BODY))
        elif not is_official(child.model_id) and bodies[child.model_id] in official:
            excluded.append(Excluded(child, OFFICIAL_COPY, copied_from=official[bodies[child.model_id]]))
        else:
            kept.append(child)
    return kept, excluded


class Collector:
    """Runs both stages on a worker thread. The GUI and the console poll `logs` and the counters."""

    def __init__(self, root_input: str, out_dir: str | Path = DEFAULT_OUT_DIR, client: HubClient | None = None,
                 workers: int = 16, keep_readme: bool = False, work_root: str | Path = WORK_ROOT):
        self.root_input = root_input
        self.out_root = Path(out_dir)
        self.client = client or HubClient()
        self.workers = max(1, workers)
        self.keep_readme = keep_readme
        self.work_root = Path(work_root)
        self.logs: queue.Queue[str] = queue.Queue()
        self.stage = ""            # "", "list", "readme", "done"
        self.done = 0
        self.total = 0
        self.error = ""            # set when the run could not finish
        self.stopped = False
        self.summary: dict | None = None
        self.out_dir: Path | None = None
        self.started_at: float | None = None
        self.finished_at: float | None = None
        self._thread: threading.Thread | None = None
        self._lock = threading.Lock()

    # --- control --------------------------------------------------------------------------------
    @property
    def running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def start(self) -> None:
        self._thread = threading.Thread(target=self.run, name="collector", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self.client.stop.set()

    def wait(self) -> None:
        if self._thread:
            self._thread.join()

    def log(self, message: str) -> None:
        self.logs.put(f"{time.strftime('%H:%M:%S')}  {message}")

    def run(self) -> None:
        self.started_at = time.time()
        try:
            self._run()
        except Cancelled:
            self.stopped = True
            self.log("중지했습니다. 받은 README는 남아 있어 다시 시작하면 이어집니다.")
        except (HubError, OSError, ValueError) as error:
            self.error = str(error)
            self.log(f"[오류] {error}")
        finally:
            self.finished_at = time.time()

    # --- stages ---------------------------------------------------------------------------------
    def _run(self) -> None:
        requested = parse_model_id(self.root_input)
        try:
            info = self.client.model_info(requested)
        except HubError as error:
            if error.status in (401, 404):
                raise HubError(f"{requested} 모델을 찾을 수 없습니다 (없거나 비공개, HTTP {error.status}).") from None
            raise
        root_id = info.get("id") or requested
        if not MODEL_ID.fullmatch(root_id):
            raise HubError(f"루트 모델 ID를 확인할 수 없습니다: {root_id!r}")
        self.out_dir = self.out_root / safe_name(root_id)
        self.out_dir.mkdir(parents=True, exist_ok=True)
        self.log(f"루트 모델 확인: {root_id}")

        # Stage 1: every direct finetune, saved before any filtering.
        self.stage = "list"
        children: dict[str, Child] = {}
        for page in self.client.iter_finetunes(root_id):
            for item in page:
                child = parse_child(item) if isinstance(item, dict) else None
                if child and child.model_id != root_id:
                    children.setdefault(child.model_id, child)
            self.done = self.total = len(children)
            self.log(f"1차 수집: {len(children)}건")
        ordered = sorted(children.values(), key=lambda child: (-child.downloads, child.model_id.lower()))
        self._write_children(ordered)
        self.log(f"1차 저장: {self.out_dir / CHILDREN_FILE} ({len(ordered)}건)")
        if not ordered:
            self.log("finetune으로 등록된 하위 모델이 없습니다.")

        # Stage 2: download READMEs, then drop copies of official cards and empty cards.
        self.stage = "readme"
        cache = (self.out_dir / "readme") if self.keep_readme else (self.work_root / safe_name(root_id) / "readme")
        cache.mkdir(parents=True, exist_ok=True)
        targets = [child for child in ordered if child.has_readme is not False]
        self.done, self.total = 0, len(targets) + 1
        readmes: dict[str, bytes | HubError | None] = {child.model_id: None for child in ordered}
        root_readme = self._fetch(root_id, cache)
        if not isinstance(root_readme, bytes):
            self.log(f"[경고] 루트 모델의 README를 받지 못했습니다 ({root_readme or 'README 없음'}). 루트 카드와의 비교는 건너뜁니다.")
            root_readme = None
        with ThreadPoolExecutor(max_workers=self.workers) as pool:
            for child, result in zip(targets, pool.map(lambda child: self._fetch(child.model_id, cache), targets)):
                readmes[child.model_id] = result
        if self.client.stop.is_set():
            raise Cancelled()

        kept, excluded = classify(root_id, root_readme, ordered, readmes)
        list_path = self.out_dir / list_file_name(root_id)
        list_path.write_text("".join(f"{child.model_id}\n" for child in kept), encoding="utf-8", newline="\n")
        self._write_excluded(excluded)
        counts = Counter(item.reason for item in excluded)
        self.summary = {
            "root": root_id, "relation": "finetune", "collectedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "collected": len(ordered), "kept": len(kept), "excluded": dict(counts),
            "files": {"collected": CHILDREN_FILE, "list": list_path.name, "excluded": EXCLUDED_FILE},
        }
        (self.out_dir / SUMMARY_FILE).write_text(json.dumps(self.summary, ensure_ascii=False, indent=2) + "\n",
                                                 encoding="utf-8", newline="\n")
        detail = ", ".join(f"{REASON_LABELS[reason]} {counts[reason]}" for reason in REASON_LABELS if counts[reason])
        self.log(f"2차 저장: {list_path} ({len(kept)}건)")
        self.log(f"수집 {len(ordered)}건 → 조사 대상 {len(kept)}건" + (f" (제외: {detail})" if detail else ""))
        if counts[README_ERROR]:
            self.error = (f"README를 받지 못한 모델 {counts[README_ERROR]}건은 목록에서 빠졌습니다. "
                          "다시 시작하면 실패한 것만 다시 받습니다.")
            self.log(f"[경고] {self.error}")
        elif not self.keep_readme:
            shutil.rmtree(cache.parent, ignore_errors=True)
        self.stage = "done"

    def _fetch(self, model_id: str, cache: Path) -> bytes | HubError | None:
        """README bytes, None when the repository has none, or the error. Cached on disk."""
        path = cache / f"{safe_name(model_id)}.md"
        try:
            if path.exists():
                return path.read_bytes()
            if self.client.stop.is_set():
                return None
            data = self.client.readme(model_id)
            path.write_bytes(data)
            return data
        except Cancelled:
            return None
        except HubError as error:
            if error.status == 404:
                return None
            self.log(f"README 실패: {model_id} ({error})")
            return error
        finally:
            with self._lock:
                self.done += 1

    # --- output ---------------------------------------------------------------------------------
    def _write_children(self, children: list[Child]) -> None:
        with (self.out_dir / CHILDREN_FILE).open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["model_id", "downloads", "likes", "created_at", "last_modified", "gated", "has_readme"])
            for child in children:
                writer.writerow([child.model_id, child.downloads, child.likes, child.created_at, child.last_modified,
                                 child.gated, "" if child.has_readme is None else str(child.has_readme).lower()])

    def _write_excluded(self, excluded: list[Excluded]) -> None:
        with (self.out_dir / EXCLUDED_FILE).open("w", encoding="utf-8", newline="") as handle:
            writer = csv.writer(handle)
            writer.writerow(["model_id", "reason", "copied_from", "detail", "downloads", "likes"])
            for item in excluded:
                writer.writerow([item.child.model_id, item.reason, item.copied_from, item.detail,
                                 item.child.downloads, item.child.likes])
