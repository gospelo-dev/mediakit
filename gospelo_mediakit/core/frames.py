"""Extract the first and/or last frame of a video as image files.

The *last frame* is the part naive scripts get wrong: OpenCV's
``CAP_PROP_POS_FRAMES = total-1`` seek lands on a keyframe boundary for many
codecs and silently returns black or the wrong frame. We instead let ffmpeg
seek from the end (``-sseof``) and keep overwriting a single output file while
decoding to EOF, so the file left on disk is genuinely the final frame.
"""

from __future__ import annotations

import shlex
from pathlib import Path
from typing import Literal

from .errors import MediakitError
from .ffmpeg import probe, run_ffmpeg

Which = Literal["first", "last", "both"]

# How far before EOF to start decoding when grabbing the last frame. Large
# enough to contain at least one full GOP for typical encodes; if the file is
# shorter, ffmpeg clamps the seek to the start, so short clips still work.
_SSEOF_SECONDS = 5


def extract_endframes(
    video_path: str,
    out_dir: str | None = None,
    prefix: str | None = None,
    fmt: str = "png",
    which: Which = "both",
    overwrite: bool = False,
) -> dict:
    """Extract the first and/or last frame of ``video_path`` as image files.

    Args:
        video_path: Path to the input video (mp4, mov, … anything ffmpeg reads).
        out_dir: Directory for the output images. Defaults to the video's
            directory. Created if missing.
        prefix: Basename prefix for outputs. Defaults to the video's stem, so
            ``clip.mp4`` -> ``clip_first.png`` / ``clip_last.png``.
        fmt: Image extension/encoder (``png``, ``jpg``, …). Default ``png``.
        which: ``"first"``, ``"last"``, or ``"both"`` (default).
        overwrite: Overwrite existing output files. When False (default), an
            existing target is an error so we never clobber by accident.

    Returns:
        ``{"ok": True, "video_path", "out_dir", "first_frame", "last_frame",
        "info": {...probe...}, "processing": {"first"/"last": {method,
        ffmpeg_command}}}``. ``first_frame`` / ``last_frame`` are absolute paths,
        or ``None`` when not requested. ``processing`` records how each image was
        produced so the caller can explain / reproduce it.

    Raises:
        MediakitError: input missing, ffmpeg missing, output exists (no
            overwrite), or ffmpeg failed to write a frame.
    """
    src = Path(video_path).expanduser()
    if not src.exists():
        raise MediakitError(f"input video not found: {src}")
    if not src.is_file():
        raise MediakitError(f"input video is not a file: {src}")
    if which not in ("first", "last", "both"):
        raise MediakitError(f"which must be first|last|both, got: {which!r}")

    dest_dir = Path(out_dir).expanduser() if out_dir else src.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = prefix if prefix else src.stem
    ext = fmt.lstrip(".")

    first_out = dest_dir / f"{stem}_first.{ext}" if which in ("first", "both") else None
    last_out = dest_dir / f"{stem}_last.{ext}" if which in ("last", "both") else None

    for target in (first_out, last_out):
        if target and target.exists() and not overwrite:
            raise MediakitError(
                f"output already exists: {target} (pass overwrite=true to replace)"
            )

    # Record HOW each frame was produced so the LLM can explain / reproduce it.
    processing: dict[str, object] = {}
    if first_out is not None:
        processing["first"] = _extract_first(src, first_out)
    if last_out is not None:
        processing["last"] = _extract_last(src, last_out)

    return {
        "ok": True,
        "video_path": str(src.resolve()),
        "out_dir": str(dest_dir.resolve()),
        "first_frame": str(first_out.resolve()) if first_out else None,
        "last_frame": str(last_out.resolve()) if last_out else None,
        "info": probe(src),
        "processing": processing,
    }


def _extract_first(src: Path, out: Path) -> dict:
    """Decode the first frame and write it to ``out``. Returns how it was done."""
    args = ["-y", "-i", str(src), "-frames:v", "1", "-update", "1", str(out)]
    result = run_ffmpeg(args)
    if result.returncode != 0 or not out.exists():
        raise MediakitError(
            f"ffmpeg failed to extract the first frame: {result.stderr.strip() or 'no output written'}"
        )
    return {
        "method": "decode the first decoded frame (-frames:v 1)",
        "ffmpeg_command": "ffmpeg " + shlex.join(args),
    }


def _extract_last(src: Path, out: Path) -> dict:
    """Decode the final frame and write it to ``out``.

    Strategy 1 (fast): seek to ``_SSEOF_SECONDS`` before EOF and keep
    overwriting ``out`` until EOF, so the surviving file is the last frame.
    Strategy 2 (fallback): if the seek produced nothing (very short or
    odd-timestamp clips), decode the whole file the same way.
    """
    fast_args = ["-y", "-sseof", f"-{_SSEOF_SECONDS}", "-i", str(src), "-update", "1", str(out)]
    fast = run_ffmpeg(fast_args)
    if fast.returncode == 0 and out.exists():
        return {
            "method": f"seek {_SSEOF_SECONDS}s before EOF (-sseof) and keep the last decoded frame",
            "ffmpeg_command": "ffmpeg " + shlex.join(fast_args),
        }

    full_args = ["-y", "-i", str(src), "-update", "1", str(out)]
    full = run_ffmpeg(full_args)
    if full.returncode != 0 or not out.exists():
        raise MediakitError(
            "ffmpeg failed to extract the last frame: "
            f"{full.stderr.strip() or fast.stderr.strip() or 'no output written'}"
        )
    return {
        "method": "full decode to EOF, keeping the last frame (-sseof fallback)",
        "ffmpeg_command": "ffmpeg " + shlex.join(full_args),
    }
