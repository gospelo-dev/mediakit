"""Match a video's colour toward a reference image (per-channel mean match).

Use case: an AI video generator (e.g. Seedance) shifts colour relative to the
source frame — commonly dropping the blue channel. Given the original frame as a
*reference*, this nudges the whole video's colour back toward it.

Method (dependency-free, ffmpeg only): compute the per-channel average RGB of the
reference image and of the video (by scaling each to 1x1 with area averaging and
reading the raw bytes), derive a per-channel correction, and apply it across the
whole video:

  * ``gain``   — multiplicative ``out = in * (ref_mean / video_mean)`` via
    ``colorchannelmixer``. Preserves ratios; best when the shift scales with
    brightness (the typical high-value blue drop).
  * ``offset`` — additive ``out = in + (ref_mean - video_mean)`` via ``lutrgb``.

``strength`` (0..1) blends the correction with the identity so you can dial it
back. A single global correction assumes the shift is roughly constant over the
clip; if it drifts (start vs end differ), this matches the average — good enough
for the common case, exact per-time matching is out of scope.
"""

from __future__ import annotations

import shlex
import subprocess
from pathlib import Path
from typing import Literal

from .errors import MediakitError
from .ffmpeg import has_audio, probe, require_ffmpeg, run_ffmpeg

Method = Literal["gain", "offset"]

# Clamp derived gains to a sane band so a bad sample can't wildly recolour.
_GAIN_MIN = 0.5
_GAIN_MAX = 2.0


def color_match(
    video_path: str,
    reference_image: str,
    method: Method = "gain",
    strength: float = 1.0,
    out_dir: str | None = None,
    prefix: str | None = None,
    overwrite: bool = False,
) -> dict:
    """Colour-match ``video_path`` toward ``reference_image``.

    Args:
        video_path: Input video (the colour-shifted / generated clip).
        reference_image: Image whose colour is the target (e.g. the original frame).
        method: ``"gain"`` (multiplicative, default) or ``"offset"`` (additive).
        strength: 0..1 blend of the correction with identity (1.0 = full).
        out_dir: Output directory (default: the video's directory).
        prefix: Output basename prefix (default: the video's stem) →
            ``<prefix>_colormatched.<ext>``.
        overwrite: Overwrite an existing output (default False = error).

    Returns:
        ``{"ok": True, "input", "output", "reference", "method", "strength",
        "reference_mean", "video_mean", "correction", "input_format",
        "output_format", "processing"}``.

    Raises:
        MediakitError: bad input/reference, ffmpeg failure, etc.
    """
    src = Path(video_path).expanduser()
    ref = Path(reference_image).expanduser()
    if not src.is_file():
        raise MediakitError(f"input video not found: {src}")
    if not ref.is_file():
        raise MediakitError(f"reference image not found: {ref}")
    if method not in ("gain", "offset"):
        raise MediakitError(f"method must be gain|offset, got {method!r}")
    if not 0.0 <= strength <= 1.0:
        raise MediakitError(f"strength must be in 0..1, got {strength}")

    ref_mean = _mean_rgb(ref, is_video=False)
    vid_mean = _mean_rgb(src, is_video=True)

    dest_dir = Path(out_dir).expanduser() if out_dir else src.parent
    dest_dir.mkdir(parents=True, exist_ok=True)
    stem = prefix if prefix else src.stem
    out = dest_dir / f"{stem}_colormatched{src.suffix}"
    if out.resolve() == src.resolve():
        raise MediakitError("output path equals input path; pass a different prefix/out_dir")
    if out.exists() and not overwrite:
        raise MediakitError(f"output already exists: {out} (pass overwrite=true to replace)")

    warnings: list[str] = []
    if method == "gain":
        correction = [_blend_gain(r, v, strength, warnings, ch)
                      for r, v, ch in zip(ref_mean, vid_mean, "RGB")]
        vfilter = "colorchannelmixer=rr={:.6g}:gg={:.6g}:bb={:.6g}".format(*correction)
        correction_desc = {"type": "gain", "r": correction[0], "g": correction[1], "b": correction[2]}
    else:
        correction = [round((r - v) * strength, 3) for r, v in zip(ref_mean, vid_mean)]
        expr = ":".join(
            f"{c}='clip(val+({off:.6g}),0,255)'" for c, off in zip("rgb", correction)
        )
        vfilter = f"lutrgb={expr}"
        correction_desc = {"type": "offset", "r": correction[0], "g": correction[1], "b": correction[2]}

    had_audio = has_audio(src)
    args = ["-y", "-i", str(src), "-map", "0:v:0", "-filter:v", vfilter]
    if had_audio:
        args += ["-map", "0:a:0", "-c:a", "copy"]
    args += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(out)]

    result = run_ffmpeg(args)
    if result.returncode != 0 or not out.exists():
        raise MediakitError(
            f"ffmpeg failed to colour-match: {result.stderr.strip() or 'no output written'}"
        )

    return {
        "ok": True,
        "input": str(src.resolve()),
        "output": str(out.resolve()),
        "reference": str(ref.resolve()),
        "method": method,
        "strength": strength,
        "reference_mean": {"r": round(ref_mean[0], 2), "g": round(ref_mean[1], 2), "b": round(ref_mean[2], 2)},
        "video_mean": {"r": round(vid_mean[0], 2), "g": round(vid_mean[1], 2), "b": round(vid_mean[2], 2)},
        "correction": correction_desc,
        "input_format": probe(src),
        "output_format": probe(out),
        "processing": {
            "summary": _summarise(method, correction_desc, ref_mean, vid_mean, strength, had_audio),
            "video_filter": vfilter,
            "warnings": warnings,
            "ffmpeg_command": "ffmpeg " + shlex.join(args),
            "note": "single global correction (matches the video's average to the "
                    "reference); per-time drift is not corrected.",
        },
    }


def _run_ffmpeg_binary(args: list[str]) -> bytes:
    """Run ffmpeg capturing raw (binary) stdout — for rawvideo pixel reads."""
    ffmpeg = require_ffmpeg()
    completed = subprocess.run(
        [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", *args],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        raise MediakitError(
            f"ffmpeg mean-sampling failed: {completed.stderr.decode(errors='replace').strip()}"
        )
    return completed.stdout


def _mean_rgb(src: Path, *, is_video: bool) -> tuple[float, float, float]:
    """Average RGB of an image, or of a whole video (per-frame 1x1, averaged)."""
    # Area-averaging downscale to 1x1 gives the per-frame mean colour.
    vf = "scale=1:1:flags=area"
    args = ["-i", str(src), "-vf", vf, "-f", "rawvideo", "-pix_fmt", "rgb24"]
    if not is_video:
        args += ["-frames:v", "1"]
    args += ["-"]
    data = _run_ffmpeg_binary(args)
    n = len(data) // 3
    if n == 0:
        raise MediakitError(f"could not sample colour from {src} (no pixels decoded)")
    sums = [0, 0, 0]
    for i in range(0, n * 3, 3):
        sums[0] += data[i]
        sums[1] += data[i + 1]
        sums[2] += data[i + 2]
    return (sums[0] / n, sums[1] / n, sums[2] / n)


def _blend_gain(ref: float, vid: float, strength: float, warnings: list[str], channel: str) -> float:
    """Per-channel gain = ref/vid, blended by strength, clamped to a sane band."""
    if vid <= 0.5:  # near-black channel — gain is meaningless, leave as-is
        return 1.0
    raw = ref / vid
    blended = 1.0 + (raw - 1.0) * strength
    clamped = max(_GAIN_MIN, min(_GAIN_MAX, blended))
    if abs(clamped - blended) > 1e-6:
        warnings.append(
            f"{channel} gain {blended:.3f} clamped to {clamped:.3f} "
            f"(band {_GAIN_MIN}-{_GAIN_MAX})"
        )
    return round(clamped, 4)


def _summarise(method, correction, ref_mean, vid_mean, strength, had_audio) -> str:
    if method == "gain":
        change = f"gain R×{correction['r']} G×{correction['g']} B×{correction['b']}"
    else:
        change = f"offset R{correction['r']:+g} G{correction['g']:+g} B{correction['b']:+g}"
    audio = "audio copied" if had_audio else "no audio"
    return (
        f"Matched video mean RGB ({vid_mean[0]:.0f},{vid_mean[1]:.0f},{vid_mean[2]:.0f}) "
        f"toward reference ({ref_mean[0]:.0f},{ref_mean[1]:.0f},{ref_mean[2]:.0f}) "
        f"via {method} at strength {strength}: {change}; {audio}."
    )
