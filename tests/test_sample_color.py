"""Unit tests for core sample_color() using synthesized solid-colour media."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from gospelo_mediakit.core.errors import MediakitError
from gospelo_mediakit.core.ffmpeg import find_ffmpeg
from gospelo_mediakit.core.sample_color import sample_color

pytestmark = pytest.mark.skipif(
    find_ffmpeg() is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not available",
)


def _make_solid_video(path: Path, color: str = "red", size: str = "64x48") -> None:
    subprocess.run(
        [
            find_ffmpeg(),
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:size={size}:rate=30:duration=1",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )


def test_sample_color_solid_red(tmp_path):
    video = tmp_path / "red.mp4"
    _make_solid_video(video, "red")
    result = sample_color(video, time_seconds=0.5, x=0, y=0)
    assert result["ok"] is True
    r, g, b = result["rgb"]
    # yuv420 round-trips are not bit-exact; allow small tolerance.
    assert r > 230 and g < 25 and b < 25
    assert result["hex"].startswith("#")
    assert result["frame_width"] == 64


def test_sample_color_region_average(tmp_path):
    video = tmp_path / "blue.mp4"
    _make_solid_video(video, "blue")
    result = sample_color(video, x=10, y=10, region=8)
    r, g, b = result["rgb"]
    assert b > 230 and r < 25 and g < 25
    assert result["region"] == 8


def test_sample_color_rejects_out_of_bounds(tmp_path):
    video = tmp_path / "red2.mp4"
    _make_solid_video(video, "red")
    with pytest.raises(MediakitError, match="exceeds"):
        sample_color(video, x=63, y=0, region=8)


def test_sample_color_rejects_missing_file(tmp_path):
    with pytest.raises(MediakitError, match="not found"):
        sample_color(tmp_path / "nope.mp4")
