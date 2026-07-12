"""Unit tests for the telop pipeline pieces (SRT parsing, mogrt patching)."""

from __future__ import annotations

import base64
import gzip
import io
import json
import struct
import zipfile

from gospelo_mediakit.premiere.mogrt import make_telop_mogrt
from gospelo_mediakit.premiere.srt import parse_srt


def test_parse_srt_basic():
    content = """1
00:00:00,000 --> 00:00:05,280
こちらはテストです

2
00:00:06,000 --> 00:00:08,500
two lines
of text
"""
    cues = parse_srt(content)
    assert len(cues) == 2
    assert cues[0].start_seconds == 0.0
    assert cues[0].end_seconds == 5.28
    assert cues[0].text == "こちらはテストです"
    assert cues[1].duration_seconds == 2.5
    assert cues[1].text == "two lines\nof text"


def test_parse_srt_tolerates_crlf_and_missing_index():
    content = "00:00:01,000 --> 00:00:02,000\r\nhello\r\n\r\n"
    cues = parse_srt(content)
    assert len(cues) == 1
    assert cues[0].text == "hello"


def _text_blob(text: str) -> str:
    payload = {"mTextParam": {"mStyleSheet": {"mText": text}}, "mVersion": "1.0"}
    body = json.dumps(payload, separators=(",", ":")).encode("utf-16-le")
    return base64.b64encode(struct.pack("<Q", len(body)) + body).decode("ascii")


def _synthetic_mogrt(path: str) -> None:
    """Build a minimal mogrt: definition.json + one prgraphic with two text blobs."""
    xml = (
        "<Project>"
        f'<StartKeyframeValue Encoding="base64" BinaryHash="x">{_text_blob("default line 1")}</StartKeyframeValue>'
        f'<StartKeyframeValue Encoding="base64" BinaryHash="y">{_text_blob("default line 2")}</StartKeyframeValue>'
        '<StartKeyframeValue Encoding="base64" BinaryHash="z">AA==</StartKeyframeValue>'
        "</Project>"
    )
    inner = io.BytesIO()
    with zipfile.ZipFile(inner, "w") as z:
        z.writestr("graphic.prproj", gzip.compress(xml.encode("utf-8")))

    definition = {
        "capsuleID": "00000000-0000-0000-0000-000000000000",
        "capsuleName": "Synthetic",
        "capsuleNameLocalized": {"strDB": [{"localeString": "en_US", "str": "Synthetic"}]},
        "clientControls": [
            {"type": 6, "value": {"strDB": [{"localeString": "en_US", "str": "default line 1"}]}},
            {"type": 6, "value": {"strDB": [{"localeString": "en_US", "str": "default line 2"}]}},
        ],
    }
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("definition.json", json.dumps(definition))
        z.writestr("project.prgraphic", inner.getvalue())


def _read_texts(mogrt_path: str) -> list[str]:
    import re

    outer = zipfile.ZipFile(mogrt_path)
    inner = zipfile.ZipFile(io.BytesIO(outer.read("project.prgraphic")))
    xml = gzip.decompress(inner.read("graphic.prproj")).decode("utf-8")
    texts = []
    for match in re.finditer(r'Encoding="base64"[^>]*>([A-Za-z0-9+/=]+)<', xml):
        blob = base64.b64decode(match.group(1))
        try:
            payload = json.loads(blob[8:].decode("utf-16-le"))
            texts.append(payload["mTextParam"]["mStyleSheet"]["mText"])
        except Exception:
            continue
    return texts


def test_make_telop_mogrt_patches_texts_and_capsule_id(tmp_path):
    src = str(tmp_path / "src.mogrt")
    out = str(tmp_path / "out.mogrt")
    _synthetic_mogrt(src)

    patched = make_telop_mogrt(src, ["テロップ一行目", ""], out, new_name="Gospelo Telop")
    assert patched == 2  # two text blobs; the non-text blob is left alone

    assert _read_texts(out) == ["テロップ一行目", ""]

    definition = json.loads(zipfile.ZipFile(out).read("definition.json"))
    assert definition["capsuleID"] != "00000000-0000-0000-0000-000000000000"
    assert definition["capsuleName"] == "Gospelo Telop"
    controls = definition["clientControls"]
    assert controls[0]["value"]["strDB"][0]["str"] == "テロップ一行目"
    assert controls[1]["value"]["strDB"][0]["str"] == ""
