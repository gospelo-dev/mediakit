"""Generate a telop .mogrt by patching the text inside a bundled template.

Structure being patched:
  mogrt (zip)
    definition.json                 - capsule params (ECP display defaults)
    project*.prgraphic (zip)
      <name>.prproj (gzip XML)
        Source-Text StartKeyframeValue (base64)
          8-byte LE length header + UTF-16LE JSON
            mTextParam.mStyleSheet.mText   <- the actual rendered text
"""

from __future__ import annotations

import base64
import gzip
import io
import json
import re
import struct
import sys
import zipfile

# Match EVERY StartKeyframeValue blob; text params are then identified
# structurally (decoded payload contains mTextParam), so localized parameter
# names (e.g. "Source Text" vs ソーステキスト) do not matter.
BLOB_RE = re.compile(
    r'(<StartKeyframeValue Encoding="base64"[^>]*>)([A-Za-z0-9+/=\s]+)(<)',
    re.DOTALL,
)


def try_patch_text_blob(b64: str, new_text: str) -> str | None:
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


def patch_prproj_xml(xml: str, texts: list[str]) -> tuple[str, int]:
    count = 0

    def repl(match: re.Match) -> str:
        nonlocal count
        text = texts[count] if count < len(texts) else texts[-1]
        patched = try_patch_text_blob(match.group(2), text)
        if patched is None:
            return match.group(0)
        count += 1
        return match.group(1) + patched + match.group(3)

    return BLOB_RE.sub(repl, xml), count


def patch_prgraphic(data: bytes, texts: list[str]) -> tuple[bytes, int]:
    patched_total = 0
    src = zipfile.ZipFile(io.BytesIO(data))
    out_buf = io.BytesIO()
    with zipfile.ZipFile(out_buf, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            member = src.read(info.filename)
            if info.filename.endswith(".prproj"):
                xml = gzip.decompress(member).decode("utf-8")
                xml, n = patch_prproj_xml(xml, texts)
                patched_total += n
                member = gzip.compress(xml.encode("utf-8"))
            out.writestr(info, member)
    return out_buf.getvalue(), patched_total


def patch_definition(data: bytes, texts: list[str], new_name: str | None = None) -> bytes:
    definition = json.loads(data)
    # Premiere caches mogrt capsules by capsuleID: inserting a modified file
    # with the original ID would silently reuse the cached original. A fresh
    # UUID makes it a distinct template.
    import uuid

    definition["capsuleID"] = str(uuid.uuid4())
    if new_name:
        definition["capsuleName"] = new_name
        for entry in definition.get("capsuleNameLocalized", {}).get("strDB", []):
            entry["str"] = new_name
    index = 0
    params = definition.get("capsuleparams") or definition.get("clientControls") or []
    for param in params:
        if param.get("type") == 6 and "value" in param:
            text = texts[index] if index < len(texts) else texts[-1]
            for entry in param["value"].get("strDB", []):
                entry["str"] = text
            index += 1
    return json.dumps(definition, ensure_ascii=False).encode("utf-8")


def make_telop_mogrt(src_path: str, texts: list[str], out_path: str) -> None:
    src = zipfile.ZipFile(src_path)
    total = 0
    with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as out:
        for info in src.infolist():
            member = src.read(info.filename)
            if info.filename == "definition.json":
                member = patch_definition(member, texts)
            elif info.filename.endswith(".prgraphic"):
                member, n = patch_prgraphic(member, texts)
                total += n
            out.writestr(info, member)
    print(f"[mogrt-patch] {out_path}: patched {total} text blob(s) across prgraphic variants")


if __name__ == "__main__":
    src, out = sys.argv[1], sys.argv[2]
    texts = sys.argv[3:] or ["telop"]
    make_telop_mogrt(src, texts, out)
