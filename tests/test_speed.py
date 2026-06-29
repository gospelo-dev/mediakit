"""Tests for core.speed.change_speed against synthesised clips.

Generates short testsrc clips with ffmpeg (no checked-in fixtures). Skipped if
ffmpeg/ffprobe are unavailable.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from gospelo_mediakit.core.errors import MediakitError
from gospelo_mediakit.core.speed import _atempo_chain_expr, change_speed

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)


def _probe_duration(path: str) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", path],
        capture_output=True, text=True, check=True,
    )
    return float(out.stdout.strip())


@pytest.fixture
def clip_4s(tmp_path):
    """A 4s 320x240 24fps clip WITH a silent audio track."""
    out = tmp_path / "clip.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc=size=320x240:rate=24:duration=4",
         "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
         "-shortest", "-pix_fmt", "yuv420p", str(out)],
        check=True,
    )
    return out


def test_target_duration_is_exact(clip_4s):
    result = change_speed(str(clip_4s), target_duration=1.0, overwrite=True)
    assert result["ok"] is True
    assert result["had_audio"] is True
    assert result["pitch_preserved"] is True
    # Hard-trim makes the output exactly 1 second.
    assert abs(_probe_duration(result["output"]) - 1.0) < 0.05
    assert result["output"].endswith("_1s.mp4")


def test_fps_is_maintained(clip_4s):
    # 4x speed of a 24fps clip stays 24fps (not inflated to 96fps).
    result = change_speed(str(clip_4s), speed=400, overwrite=True)
    assert round(result["fps"]) == 24


def test_speed_percent_naming(clip_4s):
    result = change_speed(str(clip_4s), speed=200, overwrite=True)
    assert result["output"].endswith("_2x.mp4")
    # 200% -> half the duration.
    assert abs(_probe_duration(result["output"]) - 2.0) < 0.1


def test_no_audio_clip(tmp_path):
    src = tmp_path / "silent.mp4"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", "testsrc=size=160x120:rate=24:duration=2",
         "-pix_fmt", "yuv420p", str(src)],
        check=True,
    )
    result = change_speed(str(src), speed=200, overwrite=True)
    assert result["ok"] is True
    assert result["had_audio"] is False


def test_bad_speed_raises(clip_4s):
    with pytest.raises(MediakitError, match="speed must be > 0"):
        change_speed(str(clip_4s), speed=0, overwrite=True)


def test_atempo_chain():
    # 4x -> two 2.0 steps; 0.25x -> two 0.5 steps; 1.5x -> single step.
    assert _atempo_chain_expr(4.0) == "atempo=2,atempo=2"
    assert _atempo_chain_expr(0.25) == "atempo=0.5,atempo=0.5"
    assert _atempo_chain_expr(1.5) == "atempo=1.5"
