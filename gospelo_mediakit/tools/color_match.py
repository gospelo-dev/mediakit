"""``gospelo-mediakit color-match`` — match a video's colour to a reference image.

Thin CLI wrapper over ``core.color_match.color_match``.

Usage:
    gospelo-mediakit color-match GENERATED.mp4 --reference ORIGINAL.png
    gospelo-mediakit color-match clip.mp4 --reference ref.png --method offset --strength 0.8
"""

from __future__ import annotations

import argparse
import json
import sys

from ..core.color_match import color_match
from ..core.errors import MediakitError


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gospelo-mediakit color-match",
        description="Match a video's colour toward a reference image (per-channel mean match).",
    )
    parser.add_argument("video", help="Input video (the colour-shifted clip).")
    parser.add_argument(
        "--reference", required=True, help="Reference image whose colour is the target."
    )
    parser.add_argument(
        "--method",
        choices=["gain", "offset"],
        default="gain",
        help="gain (multiplicative, default) or offset (additive).",
    )
    parser.add_argument(
        "--strength", type=float, default=1.0, help="0..1 blend of the correction (default 1.0)."
    )
    parser.add_argument("--out-dir", default=None, help="Output directory (default: input's dir).")
    parser.add_argument("--prefix", default=None, help="Output basename prefix (default: stem).")
    parser.add_argument("--overwrite", action="store_true", help="Overwrite an existing output.")
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    try:
        result = color_match(
            video_path=args.video,
            reference_image=args.reference,
            method=args.method,
            strength=args.strength,
            out_dir=args.out_dir,
            prefix=args.prefix,
            overwrite=args.overwrite,
        )
    except MediakitError as exc:
        print(json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False), flush=True)
        sys.exit(1)

    print(json.dumps(result, ensure_ascii=False, default=str), flush=True)
    sys.exit(0)


if __name__ == "__main__":
    main()
