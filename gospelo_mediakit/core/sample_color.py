"""Sample the colour at a position in a frame of a video (or an image).

ffmpeg-only, deterministic: seek to the frame, convert to rgb24 FIRST (odd
crop sizes fail on subsampled yuv input otherwise), crop the requested
region, area-average it to 1x1 and read the three bytes.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

from gospelo_mediakit.core.errors import MediakitError
from gospelo_mediakit.core.ffmpeg import find_ffmpeg, probe


def sample_color(
    media_path: str | Path,
    time_seconds: float = 0.0,
    x: int = 0,
    y: int = 0,
    region: int = 1,
) -> dict:
    """Return the colour at ``(x, y)`` of the frame at ``time_seconds``.

    ``region`` samples an NxN box whose top-left corner is ``(x, y)`` and
    returns its area average (1 = the exact pixel). For still images
    ``time_seconds`` is ignored.
    """
    path = Path(media_path).expanduser().resolve()
    if not path.is_file():
        raise MediakitError(f"file not found: {path}")
    if region < 1:
        raise MediakitError("region must be >= 1")
    if x < 0 or y < 0:
        raise MediakitError("x and y must be >= 0")

    ffmpeg = find_ffmpeg()
    if not ffmpeg:
        raise MediakitError("ffmpeg not found (set GOSPELO_MEDIAKIT_FFMPEG or install ffmpeg)")

    info = probe(path)
    width = info.get("width")
    height = info.get("height")
    if width and height and (x + region > width or y + region > height):
        raise MediakitError(
            f"sample box ({x},{y})+{region}x{region} exceeds the frame ({width}x{height})"
        )

    is_video = bool(info.get("fps")) and (info.get("nb_frames") or 0) != 1
    command = [ffmpeg, "-v", "error"]
    if is_video and time_seconds > 0:
        command += ["-ss", f"{time_seconds:.6f}"]
    command += [
        "-i",
        str(path),
        "-frames:v",
        "1",
        "-vf",
        f"format=rgb24,crop={region}:{region}:{x}:{y},scale=1:1:flags=area,format=rgb24",
        "-f",
        "rawvideo",
        "-",
    ]
    result = subprocess.run(command, capture_output=True, check=False)
    if result.returncode != 0 or len(result.stdout) < 3:
        stderr = result.stderr.decode("utf-8", "replace").strip()
        raise MediakitError(f"ffmpeg sampling failed: {stderr or 'no pixel data returned'}")

    r, g, b = result.stdout[0], result.stdout[1], result.stdout[2]
    return {
        "ok": True,
        "path": str(path),
        "time_seconds": 0.0 if not is_video else time_seconds,
        "x": x,
        "y": y,
        "region": region,
        "rgb": [r, g, b],
        "hex": f"#{r:02X}{g:02X}{b:02X}",
        "frame_width": width,
        "frame_height": height,
        "command": " ".join(command),
    }
