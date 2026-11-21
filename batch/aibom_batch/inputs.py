"""Read a model list: one model per line, or a Markdown table of Hugging Face models."""
from __future__ import annotations

import re
from pathlib import Path

_ID = r"[A-Za-z0-9][\w.\-]*/[\w.\-]+"
_URL = re.compile(rf"huggingface\.co/({_ID})")
_CODE = re.compile(rf"`({_ID})`")
_PLAIN = re.compile(rf"(?:https?://huggingface\.co/)?({_ID})/?")
_BULLET = re.compile(r"^(?:[-*+]|\d+[.)])\s+")


def parse_model_list(text: str) -> list[str]:
    """Model names in file order, without duplicates.

    - table row (`| 1 | [`org/name`](https://huggingface.co/org/name) | ...`): the model id in it
    - plain line: the whole line is the model name (a Hugging Face URL is reduced to its id)
    - bullet line: only when it is nothing but a model id, so prose bullets are ignored
    - blank lines and `#` lines are skipped
    """
    names: list[str] = []
    for raw in text.lstrip("﻿").splitlines():
        line = raw.strip()
        if not line or line.startswith(("#", ">")):
            continue
        name = None
        if line.startswith("|"):
            match = _URL.search(line) or _CODE.search(line)
            name = match.group(1) if match else None
        else:
            bullet = bool(_BULLET.match(line))
            body = _BULLET.sub("", line).strip().strip("`").strip()
            match = _PLAIN.fullmatch(body)
            if match:
                name = match.group(1)
            elif not bullet and 2 <= len(body) <= 512:
                name = " ".join(body.split())
        if name and name not in names:
            names.append(name)
    return names


def read_model_list(path: str | Path) -> list[str]:
    return parse_model_list(Path(path).read_text(encoding="utf-8"))
