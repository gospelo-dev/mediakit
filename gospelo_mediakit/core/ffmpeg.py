"""Thin helpers around the ``ffmpeg`` / ``ffprobe`` binaries.

We shell out to ffmpeg rather than depend on a Python decoding library
(OpenCV / PyAV): ffmpeg is what video people already have, it handles every
codec/container, and seeking the *last* frame is far more reliable through
``-sseof`` than through frame-index seeking in OpenCV.

All subprocess output is captured (never streamed to stdout) so callers can
keep stdout clean for their JSON contract.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path

from .errors import MediakitError

# GUI hosts (Claude Desktop, Codex App) spawn this server WITHOUT the user's
# shell PATH, so a plain ``shutil.which("ffmpeg")`` returns None even when
# ffmpeg is installed (commonly under Homebrew's /opt/homebrew/bin). We look in
# the standard install locations and honour explicit env overrides so the tool
# works the same whether launched from a terminal or a GUI app.
_COMMON_BIN_DIRS = ("/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin")


def _find_binary(name: str, env_var: str) -> str | None:
    """Locate ``name``: explicit env override, then PATH, then common dirs."""
    override = os.environ.get(env_var, "").strip()
    if override:
        return override if Path(override).is_file() else None
    found = shutil.which(name)
    if found:
        return found
    for directory in _COMMON_BIN_DIRS:
        candidate = Path(directory) / name
        if candidate.is_file():
            return str(candidate)
    return None


def find_ffmpeg() -> str | None:
    """Best-effort ffmpeg path (env ``GOSPELO_MEDIAKIT_FFMPEG`` wins)."""
    return _find_binary("ffmpeg", "GOSPELO_MEDIAKIT_FFMPEG")


def find_ffprobe() -> str | None:
    """Best-effort ffprobe path (env ``GOSPELO_MEDIAKIT_FFPROBE`` wins)."""
    return _find_binary("ffprobe", "GOSPELO_MEDIAKIT_FFPROBE")


def require_ffmpeg() -> str:
    """Return the ffmpeg path or raise if it cannot be located."""
    path = find_ffmpeg()
    if not path:
        raise MediakitError(
            "ffmpeg not found. Install it (macOS: `brew install ffmpeg`), or set "
            "GOSPELO_MEDIAKIT_FFMPEG to its absolute path. "
            "(GUI apps like Claude Desktop / Codex App do not inherit your shell "
            "PATH; this server already checks /opt/homebrew/bin and /usr/local/bin.)"
        )
    return path


def run_ffmpeg(args: list[str]) -> subprocess.CompletedProcess[str]:
    """Run ``ffmpeg <args>`` with output captured. Does not raise on non-zero."""
    ffmpeg = require_ffmpeg()
    return subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", *args],
        capture_output=True,
        text=True,
        check=False,
    )


def probe(video_path: Path) -> dict:
    """Return container/stream format info via ffprobe, or ``{}`` if unavailable.

    Best-effort: a missing ffprobe or a probe failure is non-fatal (frame
    extraction itself does not depend on it), so we just return an empty dict.

    Keys: ``container`` (format long/short name), ``duration_seconds``,
    ``bit_rate``, ``size_bytes``, video ``width``/``height``/``fps``/
    ``nb_frames``/``video_codec``/``pix_fmt``, and audio ``audio_codec``/
    ``sample_rate_hz``/``channels`` (``None`` when there is no audio stream).
    """
    ffprobe = find_ffprobe()
    if not ffprobe:
        return {}
    result = subprocess.run(
        [ffprobe, "-v", "error", "-show_format", "-show_streams", "-of", "json", str(video_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        return {}
    try:
        data = json.loads(result.stdout)
    except json.JSONDecodeError:
        return {}

    streams = data.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), {})
    audio = next((s for s in streams if s.get("codec_type") == "audio"), {})
    fmt = data.get("format") or {}

    return {
        # Container / file-level
        "container": fmt.get("format_long_name") or fmt.get("format_name"),
        "container_short": fmt.get("format_name"),
        "duration_seconds": _to_float(fmt.get("duration") or video.get("duration")),
        "bit_rate": _to_int(fmt.get("bit_rate")),
        "size_bytes": _to_int(fmt.get("size")),
        # Video stream
        "width": _to_int(video.get("width")),
        "height": _to_int(video.get("height")),
        "fps": _parse_fraction(video.get("r_frame_rate")),
        "nb_frames": _to_int(video.get("nb_frames")),
        "video_codec": video.get("codec_name") or None,
        "pix_fmt": video.get("pix_fmt") or None,
        # Audio stream (None when absent)
        "audio_codec": audio.get("codec_name") or None,
        "sample_rate_hz": _to_int(audio.get("sample_rate")),
        "channels": _to_int(audio.get("channels")),
    }


def has_audio(video_path: Path) -> bool:
    """True if the file has at least one audio stream (best-effort via ffprobe).

    AI-generated clips frequently have no audio track; callers use this to skip
    the audio filter chain. If ffprobe is unavailable we assume *no* audio so
    the video-only path is taken (safe: never emits an audio filter that would
    fail on a silent input).
    """
    ffprobe = find_ffprobe()
    if not ffprobe:
        return False
    result = subprocess.run(
        [
            ffprobe, "-v", "error", "-select_streams", "a",
            "-show_entries", "stream=index", "-of", "csv=p=0", str(video_path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and bool(result.stdout.strip())


def _to_int(value: object) -> int | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _to_float(value: object) -> float | None:
    if not isinstance(value, (str, int, float)):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _parse_fraction(value: object) -> float | None:
    """Parse ffprobe's ``"30000/1001"`` rational frame-rate string into a float."""
    if not isinstance(value, str) or "/" not in value:
        return _to_float(value)
    num, _, den = value.partition("/")
    try:
        d = float(den)
        return float(num) / d if d else None
    except ValueError:
        return None
