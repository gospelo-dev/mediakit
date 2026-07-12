"""Unit test for core probe() using a synthesized test video."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from gospelo_mediakit.core.ffmpeg import find_ffmpeg, probe

pytestmark = pytest.mark.skipif(find_ffmpeg() is None, reason="ffmpeg not available")


def _make_test_video(path: Path, width: int = 320, height: int = 240) -> None:
    ffmpeg = find_ffmpeg()
    subprocess.run(
        [
            ffmpeg,
            "-y",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size={width}x{height}:rate=30:duration=1",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
    )


def test_probe_returns_dimensions(tmp_path):
    if shutil.which("ffprobe") is None:
        pytest.skip("ffprobe not available")
    video = tmp_path / "probe_test.mp4"
    _make_test_video(video, width=320, height=240)

    info = probe(video)
    assert info["width"] == 320
    assert info["height"] == 240
    assert info["fps"] == pytest.approx(30.0)
    assert info["video_codec"] is not None
    assert info["duration_seconds"] == pytest.approx(1.0, abs=0.2)
    # testsrc has no audio stream
    assert info["audio_codec"] is None
