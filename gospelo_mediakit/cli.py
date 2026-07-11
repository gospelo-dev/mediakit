"""gospelo-mediakit CLI entry point.

Dispatches subcommands to the corresponding tool modules. Each tool module is
also directly executable as ``python -m gospelo_mediakit.tools.<name>``.

Usage:
    gospelo-mediakit <subcommand> [args...]

Subcommands map 1:1 to the tools in ``gospelo_mediakit.tools``:

    extract-frames    extract_frames.py   (first/last frame -> image files)
    change-speed      change_speed.py     (re-time video; keep fps + pitch)
    color-match       color_match.py      (match colour toward a reference image)
"""

from __future__ import annotations

import sys
from typing import Callable

from . import __version__

# Subcommand name -> (module path, callable name)
_SUBCOMMANDS: dict[str, tuple[str, str]] = {
    "extract-frames": ("gospelo_mediakit.tools.extract_frames", "main"),
    "change-speed": ("gospelo_mediakit.tools.change_speed", "main"),
    "color-match": ("gospelo_mediakit.tools.color_match", "main"),
}


def _print_usage() -> None:
    print(f"gospelo-mediakit {__version__}", file=sys.stderr)
    print("", file=sys.stderr)
    print("Usage: gospelo-mediakit <subcommand> [args...]", file=sys.stderr)
    print("", file=sys.stderr)
    print("Subcommands:", file=sys.stderr)
    for name in _SUBCOMMANDS:
        print(f"  {name}", file=sys.stderr)
    print("", file=sys.stderr)
    print("Run 'gospelo-mediakit <subcommand> --help' for subcommand options.", file=sys.stderr)


def _resolve(subcommand: str) -> Callable[[], None]:
    if subcommand not in _SUBCOMMANDS:
        print(f"ERROR: unknown subcommand: {subcommand}", file=sys.stderr)
        _print_usage()
        sys.exit(2)
    module_path, attr = _SUBCOMMANDS[subcommand]
    import importlib

    module = importlib.import_module(module_path)
    return getattr(module, attr)


def main() -> None:
    """Dispatch to the requested subcommand.

    Strips the subcommand from argv so the underlying tool's argparse sees a
    normal argv (argv[0] == script name, then its own args).
    """
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        _print_usage()
        sys.exit(0 if (len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help")) else 2)

    if sys.argv[1] in ("-V", "--version"):
        print(f"gospelo-mediakit {__version__}")
        sys.exit(0)

    subcommand = sys.argv[1]
    handler = _resolve(subcommand)

    # Reshape argv: [script, subcommand, ...rest] -> [subcommand, ...rest]
    sys.argv = [f"gospelo-mediakit {subcommand}"] + sys.argv[2:]
    handler()


if __name__ == "__main__":
    main()
