"""Generate telop .mogrt files by patching the text inside a template.

Structure being patched (reverse-engineered, live-verified):
  mogrt (zip)
    definition.json                 - capsule metadata + control defaults
    project*.prgraphic (zip)        - one per locale
      <name>.prproj (gzip XML)
        Source-Text StartKeyframeValue (base64)
          8-byte LE length header + UTF-16LE JSON
            mTextParam.mStyleSheet.mText   <- the rendered text

Pitfalls handled (each one bit us during live testing):
- Premiere caches mogrt capsules by capsuleID, so a patched file keeping the
  original ID would silently render the cached original -> fresh uuid4.
- prgraphic variants are per-locale with localized parameter names, so text
  blobs are identified structurally (decoded payload contains mTextParam),
  never by name.
- ppro-made templates keep their controls under ``clientControls`` (not
  ``capsuleparams``); both keys are supported.
"""

from __future__ import annotations

import base64
import gzip
import io
import json
import re
import struct
import uuid
import zipfile

_BLOB_RE = re.compile(
    r'(<StartKeyframeValue Encoding="base64"[^>]*>)([A-Za-z0-9+/=\s]+)(<)',
    re.DOTALL,
)


def _try_patch_text_blob(b64: str, new_text: str) -> str | None:
    """Return the patched base64 if this blob is a text document, else None."""
    try:
        blob = base64.b64decode(b64.strip())
        payload = json.loads(blob[8:].decode("utf-16-le"))
    except Exception:
        return None
    if not (isinstance(payload, dict) and "mTextParam" in payload):
        return None
    payload["mTextParam"]["mStyleSheet"]["mText"] = new_text
    body = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-16-le")
    return base64.b64encode(struct.pack("<Q", len(body)) + body).decode("ascii")


def _patch_prproj_xml(xml: str, texts: list[str]) -> tuple[str, int]:
    count = 0

    def repl(match: re.Match[str]) -> str:
        nonlocal count
        text = texts[count] if count < len(texts) else texts[-1]
        patched = _try_patch_text_blob(match.group(2), text)
        if patched is None:
            return match.group(0)
        count += 1
        return match.group(1) + patched + match.group(3)

    return _BLOB_RE.sub(repl, xml), count


def _patch_prgraphic(data: bytes, texts: list[str]) -> tuple[bytes, int]:
    patched_total = 0
    src = zipfile.ZipFile(io.BytesIO(data))
    out_buf = io.BytesIO()
    with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            member = src.read(info.filename)
            if info.filename.endswith(".prproj"):
                xml = gzip.decompress(member).decode("utf-8")
                xml, n = _patch_prproj_xml(xml, texts)
                patched_total += n
                member = gzip.compress(xml.encode("utf-8"))
            out.writestr(info, member)
    return out_buf.getvalue(), patched_total


def _patch_definition(data: bytes, texts: list[str], new_name: str | None) -> bytes:
    definition = json.loads(data)
    definition["capsuleID"] = str(uuid.uuid4())
    if new_name:
        definition["capsuleName"] = new_name
        for entry in definition.get("capsuleNameLocalized", {}).get("strDB", []):
            entry["str"] = new_name
    params = definition.get("capsuleparams") or definition.get("clientControls") or []
    index = 0
    for param in params:
        if param.get("type") == 6 and "value" in param:
            text = texts[index] if index < len(texts) else texts[-1]
            for entry in param["value"].get("strDB", []):
                entry["str"] = text
            index += 1
    return json.dumps(definition, ensure_ascii=False).encode("utf-8")


def make_telop_mogrt(
    src_path: str,
    texts: list[str],
    out_path: str,
    new_name: str | None = None,
) -> int:
    """Write a text-patched copy of ``src_path`` to ``out_path``.

    ``texts[i]`` fills the template's i-th text layer; extra layers repeat the
    last entry (pass a trailing ``""`` to blank them). Returns the number of
    text blobs patched across all locale variants.
    """
    if not texts:
        raise ValueError("texts must contain at least one string")
    src = zipfile.ZipFile(src_path)
    total = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            member = src.read(info.filename)
            if info.filename == "definition.json":
                member = _patch_definition(member, texts, new_name)
            elif info.filename.endswith(".prgraphic"):
                member, n = _patch_prgraphic(member, texts)
                total += n
            out.writestr(info, member)
    return total
