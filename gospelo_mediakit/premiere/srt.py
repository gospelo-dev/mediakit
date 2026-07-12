"""Minimal SRT parser for the telop pipeline (no external dependencies)."""

from __future__ import annotations

import re
from dataclasses import dataclass

_TIME_RE = re.compile(
    r"(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})"
)


@dataclass(frozen=True, slots=True)
class SrtCue:
    start_seconds: float
    end_seconds: float
    text: str

    @property
    def duration_seconds(self) -> float:
        return max(0.0, self.end_seconds - self.start_seconds)


def _to_seconds(h: str, m: str, s: str, ms: str) -> float:
    return int(h) * 3600 + int(m) * 60 + int(s) + int(ms.ljust(3, "0")) / 1000.0


def parse_srt(content: str) -> list[SrtCue]:
    """Parse SRT text into cues. Tolerates BOM, CRLF, and missing indexes."""
    cues: list[SrtCue] = []
    blocks = re.split(r"\n\s*\n", content.lstrip("﻿").replace("\r\n", "\n").strip())
    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        match = None
        text_start = 0
        for i, line in enumerate(lines[:2]):
            match = _TIME_RE.search(line)
            if match:
                text_start = i + 1
                break
        if not match:
            continue
        start = _to_seconds(*match.groups()[:4])
        end = _to_seconds(*match.groups()[4:])
        text = "\n".join(lines[text_start:]).strip()
        if text:
            cues.append(SrtCue(start_seconds=start, end_seconds=end, text=text))
    return cues
