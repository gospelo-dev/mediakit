#!/usr/bin/env python3
"""CLI wrapper around gospelo_mediakit.premiere.mogrt.make_telop_mogrt.

Usage:
    python3 scripts/make_telop_mogrt.py SRC.mogrt OUT.mogrt "line 1" ["line 2" ...]

Patches the template's text layers (layer i gets text i; extra layers repeat
the last text — pass a trailing "" to blank them) and assigns a fresh
capsuleID so Premiere does not serve a cached original.
"""

from __future__ import annotations

import sys

from gospelo_mediakit.premiere.mogrt import make_telop_mogrt


def main() -> None:
    if len(sys.argv) < 4:
        print(__doc__)
        raise SystemExit(2)
    src, out = sys.argv[1], sys.argv[2]
    texts = sys.argv[3:]
    total = make_telop_mogrt(src, texts, out, new_name="Gospelo Telop")
    print(f"[mogrt-patch] {out}: patched {total} text blob(s)")


if __name__ == "__main__":
    main()
