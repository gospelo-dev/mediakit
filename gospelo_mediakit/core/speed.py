"""Change a video's playback speed while preserving frame rate and audio pitch.

Use case: an AI video generator (e.g. Seedance) has a 4-second minimum, but you
want a 1-second clip. Speeding the 4s clip up 4x gives 1s.

Two knobs to define "how much faster":
  * ``speed`` as a percentage — 100 = unchanged, 200 = 2x faster (half as long),
    50 = half speed (twice as long).
  * ``target_duration`` in seconds — the factor is derived from the input's
    measured duration (``speed`` is ignored when this is set).

Frame rate is *maintained*: a naive ``setpts`` keeps every frame and crams them
into the shorter duration, which inflates the fps (30fps 4s -> 120fps 1s). We
re-apply the source fps with the ``fps`` filter, so frames are decimated by
**nearest-timestamp selection** (drop/duplicate — ffmpeg does NOT blend pixels
by default) and the clip stays e.g. 30fps — just shorter.

When ``target_duration`` is given we additionally hard-trim to that exact
length (``trim=duration=N,setpts=PTS-STARTPTS`` for video, ``atrim`` for audio),
so the output is exactly N seconds rather than relying on float arithmetic.

Audio pitch and volume are preserved via ``atempo`` (a tempo change, not a
resample). ``atempo`` only accepts 0.5–2.0 per instance, so larger factors are
chained (``atempo=2.0,atempo=2.0`` for 4x).
"""

from __future__ import annotations

import shlex
from pathlib import Path

from .errors import MediakitError
from .ffmpeg import has_audio, probe, run_ffmpeg

# ffmpeg's atempo filter accepts a single factor in [0.5, 2.0]; we decompose
# anything outside that into a chain of in-range steps.
_ATEMPO_MIN = 0.5
_ATEMPO_MAX = 2.0
_EPS = 1e-9


def change_speed(
    video_path: str,
    speed: float = 100.0,
    target_duration: float | None = None,
    fps: float | None = None,
    out_dir: str | None = None,
    prefix: str | None = None,
    overwrite: bool = False,
) -> dict:
    """Re-time ``video_path`` faster/slower, keeping fps, pitch and volume.

    Args:
        video_path: Input video (mp4, mov, …).
        speed: Playback speed as a percentage. 100 = original, 200 = 2x faster
            (half the duration), 50 = half speed (double the duration). Must be
            > 0. Ignored when ``target_duration`` is given.
        target_duration: Desired output duration in seconds. When set, the speed
            factor is computed from the input's measured duration; ``speed`` is
            ignored, and the output is hard-trimmed to exactly this length.
        fps: Output frame rate. Defaults to the source fps (frame rate is
            maintained). Set explicitly to also convert the rate (e.g. 24).
        out_dir: Output directory. Defaults to the input's directory.
        prefix: Output basename prefix. Defaults to the input's filename stem,
            producing e.g. ``clip_4x.mp4`` / ``clip_0.5x.mp4``.
        overwrite: Overwrite an existing output (default False = error if it
            exists).

    Returns:
        ``{"ok": True, "input", "output", "speed_percent", "factor",
        "input_duration", "output_duration", "fps", "had_audio",
        "pitch_preserved": True, "input_format": {...}, "output_format": {...},
        "processing": {...}}``. ``input_format`` / ``output_format`` are the full
        container/codec probe of each file. ``processing`` records how the file
        was produced (summary, video/audio filter chains, frame resampling
        method, frame counts, encoder, full ffmpeg command).

    Raises:
        MediakitError: bad input, bad speed/target, ffmpeg failure, etc.
    """
    src = Path(video_path).expanduser()
    if not src.exists():
        raise MediakitError(f"input video not found: {src}")
    if not src.is_file():
        raise MediakitError(f"input video is not a file: {src}")

    info = probe(src)
    in_duration = info.get("duration_seconds")
    fps = info.get("fps")

    # Resolve the speed factor (factor = how many times faster; >1 shorter).
    if target_duration is not None:
        if target_duration <= 0:
            raise MediakitError(f"target_duration must be > 0, got {target_duration}")
        if not in_duration or in_duration <= 0:
            raise MediakitError(
                "cannot use target_duration: input duration is unknown "
                "(ffprobe missing or could not read the file). Use speed= instead."
            )
        factor = in_duration / target_duration
        speed_percent = factor * 100.0
    else:
        if speed <= 0:
            raise MediakitError(f"speed must be > 0 (percent), got {speed}")
        speed_percent = float(speed)
        factor = speed_percent / 100.0

    dest_dir = Path(out_dir).expanduser() if out_dir else src.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = prefix if prefix else src.stem
    # Name by the intent: '_1s' when a target duration was asked for, else
    # '_4x' / '_0.5x' for a speed factor.
    label = f"{_trim_num(target_duration)}s" if target_duration is not None else f"{_trim_num(factor)}x"
    out = dest_dir / f"{stem}_{label}{src.suffix}"
    if out.resolve() == src.resolve():
        raise MediakitError("output path equals input path; pass a different prefix/out_dir")
    if out.exists() and not overwrite:
        raise MediakitError(f"output already exists: {out} (pass overwrite=true to replace)")

    # Video: setpts re-times the stream; the fps filter restores a constant
    # frame rate by nearest-timestamp drop/duplicate (no pixel blending). When a
    # target duration is set, hard-trim and reset PTS so it is exactly N seconds.
    out_fps = fps if fps else info.get("fps")
    pts_mult = 1.0 / factor
    vchain = [f"setpts={pts_mult:.6g}*PTS"]
    if out_fps:
        vchain.append(f"fps={out_fps:.6g}")
    if target_duration is not None:
        vchain += [f"trim=duration={target_duration:.6g}", "setpts=PTS-STARTPTS"]
    vfilter = ",".join(vchain)

    args = ["-y", "-i", str(src), "-map", "0:v:0", "-filter:v", vfilter]

    had_audio = has_audio(src)
    afilter: str | None = None
    if had_audio:
        achain = [_atempo_chain_expr(factor)]
        if target_duration is not None:
            achain += [f"atrim=duration={target_duration:.6g}", "asetpts=PTS-STARTPTS"]
        afilter = ",".join(achain)
        args += ["-map", "0:a:0", "-filter:a", afilter]

    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
    if had_audio:
        args += ["-c:a", "aac"]
    args.append(str(out))

    result = run_ffmpeg(args)
    if result.returncode != 0 or not out.exists():
        raise MediakitError(
            f"ffmpeg failed to change speed: {result.stderr.strip() or 'no output written'}"
        )

    out_info = probe(out)
    in_frames = info.get("nb_frames")
    out_frames = out_info.get("nb_frames")
    # Describe HOW the file was produced so the LLM can explain / reproduce it.
    processing = {
        "summary": _summarise(factor, speed_percent, out_fps, target_duration, had_audio),
        "video_filter": vfilter,
        "audio_filter": afilter,
        "frame_resampling": (
            "nearest-timestamp drop/duplicate via the fps filter "
            "(no pixel blending; frames are selected, not merged)"
        ),
        "input_frames": in_frames,
        "output_frames": out_frames,
        "pitch_method": ("atempo (tempo change, not resample — pitch & volume preserved)"
                         if had_audio else None),
        "encoder": {
            "video": "libx264",
            "audio": "aac" if had_audio else None,
            "pix_fmt": "yuv420p",
            "movflags": "+faststart",
        },
        "ffmpeg_command": "ffmpeg " + shlex.join(args),
    }

    return {
        "ok": True,
        "input": str(src.resolve()),
        "output": str(out.resolve()),
        "speed_percent": round(speed_percent, 4),
        "factor": round(factor, 6),
        "input_duration": in_duration,
        "output_duration": out_info.get("duration_seconds"),
        "fps": out_info.get("fps") or out_fps,
        "had_audio": had_audio,
        "pitch_preserved": True,
        # Full container/codec format of the input and the produced output.
        "input_format": info,
        "output_format": out_info,
        "processing": processing,
    }


def _summarise(
    factor: float,
    speed_percent: float,
    out_fps: float | None,
    target_duration: float | None,
    had_audio: bool,
) -> str:
    """One-line, human/LLM-readable description of the transform applied."""
    direction = "faster" if factor > 1 else "slower" if factor < 1 else "unchanged"
    parts = [f"Re-timed to {_trim_num(factor)}x speed ({_trim_num(speed_percent)}%, {direction})"]
    if out_fps:
        parts.append(f"frame rate kept at {_trim_num(out_fps)}fps (frames decimated, not blended)")
    if target_duration is not None:
        parts.append(f"hard-trimmed to exactly {_trim_num(target_duration)}s")
    parts.append("audio tempo-shifted with pitch & volume preserved" if had_audio else "no audio track")
    return "; ".join(parts) + "."


def _trim_num(value: float) -> str:
    """Format a number for a filename: 4.0 -> '4', 0.5 -> '0.5', 1.0 -> '1'."""
    return f"{value:.4f}".rstrip("0").rstrip(".")


def _atempo_chain_expr(factor: float) -> str:
    """Build an ``atempo`` filter expression for an arbitrary tempo ``factor``.

    Each ``atempo`` instance must stay within [0.5, 2.0], so we split larger or
    smaller factors into a product of in-range steps (pitch is preserved at
    every step). Example: 4.0 -> "atempo=2,atempo=2"; 0.25 -> "atempo=0.5,atempo=0.5".
    """
    if factor <= 0:
        raise MediakitError(f"speed factor must be > 0, got {factor}")
    steps: list[float] = []
    remaining = factor
    while remaining > _ATEMPO_MAX + _EPS:
        steps.append(_ATEMPO_MAX)
        remaining /= _ATEMPO_MAX
    while remaining < _ATEMPO_MIN - _EPS:
        steps.append(_ATEMPO_MIN)
        remaining /= _ATEMPO_MIN
    steps.append(remaining)
    return ",".join(f"atempo={v:.6g}" for v in steps)
