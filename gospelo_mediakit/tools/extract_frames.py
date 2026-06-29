"""``gospelo-mediakit extract-frames`` — first/last frame extraction.

Thin CLI wrapper over ``core.frames.extract_endframes``: parse argv, call the
core helper, print a single JSON object to stdout. Exit 0 on success, 1 on a
known (``MediakitError``) failure, 2 on a bad argument.

Usage:
    gospelo-mediakit extract-frames INPUT.mp4
    gospelo-mediakit extract-frames INPUT.mp4 --out-dir ./frames --which last
    python -m gospelo_mediakit.tools.extract_frames INPUT.mp4 --overwrite
"""

from __future__ import annotations

import argparse
import json
import sys

from ..core.errors import MediakitError
from ..core.frames import extract_endframes


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gospelo-mediakit extract-frames",
        description="Extract the first and/or last frame of a video as image files.",
    )
    parser.add_argument("video", help="Path to the input video (mp4, mov, …).")
    parser.add_argument(
        "--out-dir", default=None, help="Output directory (default: the video's directory)."
    )
    parser.add_argument(
        "--prefix",
        default=None,
        help="Output basename prefix (default: the video's filename stem).",
    )
    parser.add_argument("--fmt", default="png", help="Image format/extension (default: png).")
    parser.add_argument(
        "--which",
        choices=["first", "last", "both"],
        default="both",
        help="Which frame(s) to extract (default: both).",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite existing output files (default: error if they exist).",
    )
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    try:
        result = extract_endframes(
            video_path=args.video,
            out_dir=args.out_dir,
            prefix=args.prefix,
            fmt=args.fmt,
            which=args.which,
            overwrite=args.overwrite,
        )
    except MediakitError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, default=str), flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
