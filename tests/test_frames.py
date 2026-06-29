"""Tests for core.frames.extract_endframes against a synthesised clip.

A tiny 2-second test video is generated with ffmpeg's ``testsrc`` so the suite
needs no checked-in binary fixtures. Skipped entirely if ffmpeg is absent.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from gospelo_mediakit.core.errors import MediakitError
from gospelo_mediakit.core.frames import extract_endframes

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None, reason="ffmpeg not installed"
)


def test_ffmpeg_env_override_file_and_dir(tmp_path, monkeypatch):
    """GOSPELO_MEDIAKIT_FFMPEG honours both a file path and a bin directory."""
    from gospelo_mediakit.core import ffmpeg as ff

    real = shutil.which("ffmpeg")
    # Pointing at the executable file resolves to that file.
    monkeypatch.setenv("GOSPELO_MEDIAKIT_FFMPEG", real)
    assert ff.find_ffmpeg() == real
    # Pointing at the containing directory also resolves (Windows-friendly).
    monkeypatch.setenv("GOSPELO_MEDIAKIT_FFMPEG", str(Path(real).parent))
    assert ff.find_ffmpeg() is not None
    # A bogus override resolves to nothing (no silent PATH fallback).
    monkeypatch.setenv("GOSPELO_MEDIAKIT_FFMPEG", str(tmp_path / "nope" / "ffmpeg"))
    assert ff.find_ffmpeg() is None


@pytest.fixture
def sample_video(tmp_path):
    """A 2s 320x240 test pattern clip."""
    out = tmp_path / "clip.mp4"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc=size=320x240:rate=10:duration=2",
            "-pix_fmt", "yuv420p", str(out),
        ],
        check=True,
    )
    return out


def test_extract_both(sample_video, tmp_path):
    result = extract_endframes(str(sample_video), out_dir=str(tmp_path / "frames"))
    assert result["ok"] is True
    assert result["first_frame"].endswith("clip_first.png")
    assert result["last_frame"].endswith("clip_last.png")
    from pathlib import Path

    assert Path(result["first_frame"]).stat().st_size > 0
    assert Path(result["last_frame"]).stat().st_size > 0
    # probe is best-effort but should populate dimensions when ffprobe exists.
    if shutil.which("ffprobe"):
        assert result["info"]["width"] == 320
        assert result["info"]["height"] == 240


def test_which_last_only(sample_video, tmp_path):
    result = extract_endframes(
        str(sample_video), out_dir=str(tmp_path / "f"), which="last"
    )
    assert result["first_frame"] is None
    assert result["last_frame"] is not None


def test_missing_input_raises(tmp_path):
    with pytest.raises(MediakitError, match="not found"):
        extract_endframes(str(tmp_path / "nope.mp4"))


def test_overwrite_guard(sample_video, tmp_path):
    out = tmp_path / "frames"
    extract_endframes(str(sample_video), out_dir=str(out))
    with pytest.raises(MediakitError, match="already exists"):
        extract_endframes(str(sample_video), out_dir=str(out))
    # overwrite=True succeeds.
    result = extract_endframes(str(sample_video), out_dir=str(out), overwrite=True)
    assert result["ok"] is True
