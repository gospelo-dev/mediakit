"""Tests for core.color_match.color_match.

Builds a solid-colour clip and a differently-coloured reference image with
ffmpeg (no checked-in fixtures), then checks that the gain correction moves the
output's average colour toward the reference. Skipped without ffmpeg.
"""

from __future__ import annotations

import shutil
import subprocess

import pytest

from gospelo_mediakit.core.color_match import _mean_rgb, color_match
from gospelo_mediakit.core.errors import MediakitError

pytestmark = pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe not installed",
)


def _solid_clip(path, color_hex, seconds=1):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"color=c={color_hex}:size=160x120:rate=10:duration={seconds}",
         "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )


def _solid_image(path, color_hex):
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
         "-f", "lavfi", "-i", f"color=c={color_hex}:size=160x120", "-frames:v", "1", str(path)],
        check=True,
    )


def test_gain_moves_blue_toward_reference(tmp_path):
    # Video is blue-deficient; reference has more blue.
    video = tmp_path / "gen.mp4"
    ref = tmp_path / "ref.png"
    _solid_clip(video, "0x2030A0")     # B ~ 0xA0 = 160
    _solid_image(ref, "0x2030F0")      # B ~ 0xF0 = 240

    before = _mean_rgb(video, is_video=True)
    result = color_match(str(video), str(ref), out_dir=str(tmp_path / "out"))
    assert result["ok"] is True
    assert result["output"].endswith("_colormatched.mp4")
    assert result["correction"]["type"] == "gain"
    assert result["correction"]["b"] > 1.0    # blue boosted

    after = _mean_rgb(result["output"], is_video=True)
    # Output blue should be closer to the reference blue than before.
    ref_b = _mean_rgb(ref, is_video=False)[2]
    assert abs(after[2] - ref_b) < abs(before[2] - ref_b)


def test_offset_method(tmp_path):
    video = tmp_path / "g.mp4"
    ref = tmp_path / "r.png"
    _solid_clip(video, "0x203040")
    _solid_image(ref, "0x2030A0")
    result = color_match(str(video), str(ref), method="offset", out_dir=str(tmp_path / "o"))
    assert result["ok"] is True
    assert result["correction"]["type"] == "offset"
    assert result["correction"]["b"] > 0     # positive blue offset


def test_strength_scales_correction(tmp_path):
    video = tmp_path / "g.mp4"
    ref = tmp_path / "r.png"
    _solid_clip(video, "0x2030A0")
    _solid_image(ref, "0x2030F0")
    full = color_match(str(video), str(ref), strength=1.0, out_dir=str(tmp_path / "f"))
    half = color_match(str(video), str(ref), strength=0.5, out_dir=str(tmp_path / "h"))
    assert full["correction"]["b"] > half["correction"]["b"] > 1.0


def test_missing_inputs(tmp_path):
    ref = tmp_path / "r.png"
    _solid_image(ref, "0x2030F0")
    with pytest.raises(MediakitError, match="input video not found"):
        color_match(str(tmp_path / "nope.mp4"), str(ref))

    video = tmp_path / "g.mp4"
    _solid_clip(video, "0x2030A0")
    with pytest.raises(MediakitError, match="reference image not found"):
        color_match(str(video), str(tmp_path / "nope.png"))


def test_bad_strength(tmp_path):
    video = tmp_path / "g.mp4"
    ref = tmp_path / "r.png"
    _solid_clip(video, "0x2030A0")
    _solid_image(ref, "0x2030F0")
    with pytest.raises(MediakitError, match="strength"):
        color_match(str(video), str(ref), strength=2.0)
