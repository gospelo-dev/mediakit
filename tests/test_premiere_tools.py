"""Parameter-mapping tests for the convenience MCP tools (no live bridge)."""

import asyncio

from gospelo_mediakit import premiere_mcp_server as srv


def _fn(tool):
    return getattr(tool, "fn", None) or tool


class _FakeBridge:
    def __init__(self, result=None):
        self.calls = []
        self.result = result or {}

    async def request(self, method, params, timeout_seconds=30.0):
        self.calls.append((method, params))
        return dict(self.result)


def _with_fake_bridge(result=None):
    fake = _FakeBridge(result)
    srv._bridge = fake
    return fake


def test_fade_clip_builds_opacity_keyframes():
    fake = _with_fake_bridge()
    result = asyncio.run(
        _fn(srv.premiere_fade_clip)(
            item_start_seconds=0,
            fade_start_seconds=7.7,
            fade_end_seconds=8.375,
            track_index=1,
        )
    )
    assert result["ok"] is True
    method, params = fake.calls[0]
    assert method == "sequence.addEffect"
    assert params["existing"] is True
    assert params["matchName"] == "AE.ADBE Opacity"
    keyframes = params["setParams"][0]["keyframes"]
    assert keyframes == [
        {"timeSeconds": 7.7, "value": 100.0},
        {"timeSeconds": 8.375, "value": 0.0},
    ]


def test_fade_clip_fade_in_swaps_opacities():
    fake = _with_fake_bridge()
    asyncio.run(
        _fn(srv.premiere_fade_clip)(
            item_start_seconds=0,
            fade_start_seconds=0.0,
            fade_end_seconds=1.0,
            opacity_from=0.0,
            opacity_to=100.0,
        )
    )
    keyframes = fake.calls[0][1]["setParams"][0]["keyframes"]
    assert keyframes[0]["value"] == 0.0
    assert keyframes[1]["value"] == 100.0


def test_get_effect_params_is_a_read_only_existing_lookup():
    fake = _with_fake_bridge({"params": []})
    result = asyncio.run(
        _fn(srv.premiere_get_effect_params)(
            item_start_seconds=0,
            match_name="AE.ADBE Motion",
            track_index=1,
        )
    )
    assert result["ok"] is True
    method, params = fake.calls[0]
    assert method == "sequence.addEffect"
    assert params["existing"] is True
    assert params["matchName"] == "AE.ADBE Motion"
    # must never carry write payloads
    assert "setParams" not in params
    assert "colorHex" not in params


def test_set_clip_transform_maps_nonuniform_scale_and_crop():
    fake = _with_fake_bridge()
    asyncio.run(
        _fn(srv.premiere_set_clip_transform)(
            item_start_seconds=0,
            track_index=1,
            scale=97.84,
            scale_width=99.28,
            crop_left=5,
            crop_bottom=10,
        )
    )
    _, params = fake.calls[0]
    assert params["scale"] == 97.84
    assert params["scaleWidth"] == 99.28
    assert params["cropLeft"] == 5
    assert params["cropBottom"] == 10
    assert "cropTop" not in params
    assert "uniformScale" not in params
