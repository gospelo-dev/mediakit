"""FastMCP stdio server for gospelo-mediakit.

Exposes these tools:
  - mediakit_extract_frames
  - mediakit_change_speed
  - mediakit_color_match
  - mediakit_probe

Each tool is a **thin wrapper** (~20 lines) over a ``gospelo_mediakit.core``
function, run via ``asyncio.to_thread`` so the ffmpeg subprocess never blocks
FastMCP's event loop. All domain logic lives in the core package; this module
only validates nothing beyond what the core does and serialises the result.

Two run modes (see ``main``):
  * default      — MCP stdio server (Claude Code / Codex connect here).
  * ``cli <tool>`` — invoke one tool once and print JSON to stdout. Handy for
    smoke tests and for hosts that prefer a one-shot CLI over an MCP session.

Subprocess output is captured by the core helpers; stdout stays reserved for
the MCP protocol (stdio mode) / the JSON return value (cli mode).
"""

from __future__ import annotations

import asyncio
from typing import Any

from fastmcp import FastMCP

from pathlib import Path

from gospelo_mediakit.core.color_match import color_match
from gospelo_mediakit.core.errors import MediakitError
from gospelo_mediakit.core.ffmpeg import probe
from gospelo_mediakit.core.frames import extract_endframes
from gospelo_mediakit.core.speed import change_speed

mcp = FastMCP("gospelo-mediakit")


@mcp.tool()
async def mediakit_extract_frames(
    video_path: str,
    out_dir: str | None = None,
    prefix: str | None = None,
    fmt: str = "png",
    which: str = "both",
    overwrite: bool = False,
) -> dict[str, Any]:
    """Extract the first and/or last frame of a video as image files.

    **Always call this tool** when the user wants the first frame, the last
    frame, a thumbnail, or the "start/end image" of a clip. Do not re-implement
    ffmpeg/OpenCV frame seeking inline — the last frame in particular is
    unreliable via frame-index seeking, and this tool handles it via ffmpeg
    ``-sseof``.

    Args:
        video_path: Path to the input video (mp4, mov, … anything ffmpeg reads).
        out_dir: Output directory. Defaults to the video's own directory.
        prefix: Output basename prefix. Defaults to the video's filename stem,
            so ``clip.mp4`` produces ``clip_first.png`` / ``clip_last.png``.
        fmt: Image format/extension (``png``, ``jpg``, …). Default ``png``.
        which: ``"first"``, ``"last"``, or ``"both"`` (default).
        overwrite: Overwrite existing outputs. Default False (existing target
            is an error so nothing is clobbered).

    Returns:
        On success: ``{"ok": true, "video_path", "out_dir", "first_frame",
        "last_frame", "info": {width, height, fps, nb_frames,
        duration_seconds}}``. ``first_frame``/``last_frame`` are absolute paths
        or null when not requested.
        On failure: ``{"ok": false, "error": "<message>"}``.
    """
    try:
        return await asyncio.to_thread(
            extract_endframes,
            video_path=video_path,
            out_dir=out_dir,
            prefix=prefix,
            fmt=fmt,
            which=which,  # type: ignore[arg-type]
            overwrite=overwrite,
        )
    except MediakitError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def mediakit_change_speed(
    video_path: str,
    speed: float = 100.0,
    target_duration: float | None = None,
    fps: float | None = None,
    out_dir: str | None = None,
    prefix: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Change a video's playback speed, keeping frame rate, audio pitch and volume.

    **Call this tool** to make a clip faster or slower — e.g. an AI generator
    has a 4-second minimum but you want 1 second (speed up 4x). Do not
    re-implement ffmpeg ``setpts``/``atempo`` inline.

    Frame rate is preserved (the output keeps the source fps; frames are
    decimated to fit the shorter duration rather than inflating the fps). Audio
    pitch and volume are preserved via ``atempo`` (chained for large factors).

    Args:
        video_path: Input video (mp4, mov, …).
        speed: Speed as a percentage. 100 = original, 200 = 2x faster (half the
            length), 50 = half speed (double the length). Ignored when
            ``target_duration`` is set.
        target_duration: Desired output duration in seconds. Overrides ``speed``
            (the factor is derived from the input's measured duration) and the
            output is hard-trimmed to exactly this length.
        fps: Output frame rate. Defaults to the source fps (frame rate is
            maintained). Set explicitly to also convert the rate (e.g. 24).
        out_dir: Output directory. Defaults to the input's directory.
        prefix: Output basename prefix. Defaults to the input's stem, producing
            e.g. ``clip_4x.mp4``.
        overwrite: Overwrite an existing output. Default False.

    Returns:
        On success: ``{"ok": true, "input", "output", "speed_percent",
        "factor", "input_duration", "output_duration", "fps", "had_audio",
        "pitch_preserved": true}``.
        On failure: ``{"ok": false, "error": "<message>"}``.
    """
    try:
        return await asyncio.to_thread(
            change_speed,
            video_path=video_path,
            speed=speed,
            target_duration=target_duration,
            fps=fps,
            out_dir=out_dir,
            prefix=prefix,
            overwrite=overwrite,
        )
    except MediakitError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def mediakit_color_match(
    video_path: str,
    reference_image: str,
    method: str = "gain",
    strength: float = 1.0,
    out_dir: str | None = None,
    prefix: str | None = None,
    overwrite: bool = False,
) -> dict[str, Any]:
    """Match a video's colour toward a reference image (per-channel mean match).

    **Call this tool** when an AI-generated clip's colour drifted from the
    source frame (e.g. Seedance dropping the blue channel) and you have the
    original frame as a reference. It nudges the whole video's colour back
    toward the reference. Dependency-free (ffmpeg only).

    Args:
        video_path: The colour-shifted / generated video.
        reference_image: Image whose colour is the target (e.g. the original frame).
        method: ``"gain"`` (multiplicative, default; best for the typical blue
            drop) or ``"offset"`` (additive).
        strength: 0..1 blend of the correction with identity (1.0 = full).
        out_dir: Output directory. Defaults to the video's directory.
        prefix: Output basename prefix. Defaults to the video's stem, producing
            ``<stem>_colormatched.<ext>``.
        overwrite: Overwrite an existing output. Default False.

    Returns:
        On success: ``{"ok": true, "input", "output", "reference", "method",
        "strength", "reference_mean", "video_mean", "correction",
        "input_format", "output_format", "processing"}``. A single global
        correction matches the video's average colour to the reference's;
        per-time drift is not corrected.
        On failure: ``{"ok": false, "error": "<message>"}``.
    """
    try:
        return await asyncio.to_thread(
            color_match,
            video_path=video_path,
            reference_image=reference_image,
            method=method,  # type: ignore[arg-type]
            strength=strength,
            out_dir=out_dir,
            prefix=prefix,
            overwrite=overwrite,
        )
    except MediakitError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def mediakit_probe(video_path: str) -> dict[str, Any]:
    """Get a media file's format info: frame size, fps, duration, codecs.

    **Call this tool** whenever you need a clip's dimensions (width/height),
    frame rate, duration, or codec — e.g. to pick sequence settings, decide
    telop font size, or check whether a clip has audio. Read-only; ffprobe
    only, nothing is written.

    Args:
        video_path: Path to the media file (mp4, mov, mp3, wav, … anything
            ffprobe reads).

    Returns:
        On success: ``{"ok": true, "path", "container", "duration_seconds",
        "bit_rate", "size_bytes", "width", "height", "fps", "nb_frames",
        "video_codec", "pix_fmt", "audio_codec", "sample_rate_hz",
        "channels"}``. Video fields are null for audio-only files; audio
        fields are null when there is no audio stream.
        On failure: ``{"ok": false, "error": "<message>"}``.
    """
    import os

    path = os.path.abspath(os.path.expanduser(video_path))
    if not os.path.isfile(path):
        return {"ok": False, "error": f"file not found: {path}"}
    info = await asyncio.to_thread(probe, Path(path))
    if not info:
        return {"ok": False, "error": "ffprobe unavailable or could not read the file"}
    return {"ok": True, "path": path, **info}


def _run_cli() -> int:
    """Run a single tool from the command line (one-shot).

    Usage:
        gospelo-mediakit-mcp cli mediakit_extract_frames --json '{"video_path": "..."}'

    Prints the tool's return value as JSON to stdout. Returns 0 on
    ``ok=True``, 1 on ``ok=False``, 2 on an argument/dispatch error.
    """
    import argparse
    import json as _json
    import sys

    parser = argparse.ArgumentParser(prog="gospelo-mediakit-mcp cli")
    parser.add_argument(
        "tool",
        choices=[
            "mediakit_extract_frames",
            "mediakit_change_speed",
            "mediakit_color_match",
            "mediakit_probe",
        ],
    )
    parser.add_argument("--json", default="{}", help="JSON-encoded argument map for the tool.")
    args = parser.parse_args(sys.argv[2:])

    try:
        kwargs = _json.loads(args.json)
    except _json.JSONDecodeError as exc:
        print(_json.dumps({"ok": False, "error": f"--json is not valid JSON: {exc}"}), flush=True)
        return 2

    try:
        if args.tool == "mediakit_probe":
            import os

            path = os.path.abspath(os.path.expanduser(kwargs.get("video_path", "")))
            if not os.path.isfile(path):
                result = {"ok": False, "error": f"file not found: {path}"}
            else:
                info = probe(Path(path))
                result = (
                    {"ok": True, "path": path, **info}
                    if info
                    else {"ok": False, "error": "ffprobe unavailable or could not read the file"}
                )
        elif args.tool == "mediakit_color_match":
            result = color_match(
                video_path=kwargs.get("video_path", ""),
                reference_image=kwargs.get("reference_image", ""),
                method=kwargs.get("method", "gain"),
                strength=float(kwargs.get("strength", 1.0)),
                out_dir=kwargs.get("out_dir"),
                prefix=kwargs.get("prefix"),
                overwrite=bool(kwargs.get("overwrite", False)),
            )
        elif args.tool == "mediakit_change_speed":
            result = change_speed(
                video_path=kwargs.get("video_path", ""),
                speed=float(kwargs.get("speed", 100.0)),
                target_duration=kwargs.get("target_duration"),
                fps=kwargs.get("fps"),
                out_dir=kwargs.get("out_dir"),
                prefix=kwargs.get("prefix"),
                overwrite=bool(kwargs.get("overwrite", False)),
            )
        else:
            result = extract_endframes(
                video_path=kwargs.get("video_path", ""),
                out_dir=kwargs.get("out_dir"),
                prefix=kwargs.get("prefix"),
                fmt=kwargs.get("fmt", "png"),
                which=kwargs.get("which", "both"),
                overwrite=bool(kwargs.get("overwrite", False)),
            )
    except MediakitError as exc:
        print(_json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        return 1
    except Exception as exc:  # pragma: no cover - safety net
        print(_json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}"}), flush=True)
        return 2

    print(_json.dumps(result, ensure_ascii=False, default=str), flush=True)
    return 0 if result.get("ok") else 1


def main() -> None:
    """Entry point for the ``gospelo-mediakit-mcp`` console script.

    Default: run as an MCP stdio server. ``cli <tool>``: one-shot invocation.
    """
    import sys

    if len(sys.argv) >= 2 and sys.argv[1] == "cli":
        sys.exit(_run_cli())

    mcp.run()


if __name__ == "__main__":
    main()
