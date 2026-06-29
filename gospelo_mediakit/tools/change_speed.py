"""``gospelo-mediakit change-speed`` — re-time a video, keeping fps and pitch.

Thin CLI wrapper over ``core.speed.change_speed``: parse argv, call the core
helper, print one JSON object to stdout. Exit 0 on success, 1 on a known
(``MediakitError``) failure, 2 on a bad argument.

Usage:
    gospelo-mediakit change-speed INPUT.mp4 --speed 400        # 4x faster (4s -> 1s)
    gospelo-mediakit change-speed INPUT.mp4 --target-duration 1
    gospelo-mediakit change-speed INPUT.mp4 --speed 50         # half speed
    python -m gospelo_mediakit.tools.change_speed INPUT.mp4 --speed 200 --overwrite
"""

from __future__ import annotations

import argparse
import json
import sys

from ..core.errors import MediakitError
from ..core.speed import change_speed


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="gospelo-mediakit change-speed",
        description="Change a video's speed while keeping frame rate, audio pitch and volume.",
    )
    parser.add_argument("video", help="Path to the input video (mp4, mov, …).")
    parser.add_argument(
        "--speed",
        type=float,
        default=100.0,
        help="Speed percent: 100=original, 200=2x faster (half length), 50=half speed. "
        "Ignored if --target-duration is given.",
    )
    parser.add_argument(
        "--target-duration",
        type=float,
        default=None,
        help="Desired output duration in seconds (overrides --speed); hard-trimmed exactly.",
    )
    parser.add_argument(
        "--fps",
        type=float,
        default=None,
        help="Output frame rate (default: keep source fps). Set to also convert the rate.",
    )
    parser.add_argument("--out-dir", default=None, help="Output directory (default: input's dir).")
    parser.add_argument("--prefix", default=None, help="Output basename prefix (default: stem).")
    parser.add_argument(
        "--overwrite", action="store_true", help="Overwrite an existing output file."
    )
    return parser


def main() -> None:
    args = _build_parser().parse_args()
    try:
        result = change_speed(
            video_path=args.video,
            speed=args.speed,
            target_duration=args.target_duration,
            fps=args.fps,
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
