"""Shared error type for core helpers.

Core functions raise ``MediakitError`` for any *expected*, user-facing failure
(missing input file, ffmpeg not installed, ffmpeg non-zero exit, etc.). Both
front-ends translate it into their own contract:

* CLI tools   -> ``{"ok": false, "error": str(exc)}`` on stdout, exit code 1.
* MCP wrapper -> ``{"ok": false, "error": str(exc)}`` return value.

Unexpected exceptions (bugs) are intentionally *not* wrapped so they surface
with a traceback during development.
"""

from __future__ import annotations


class MediakitError(RuntimeError):
    """An expected, user-facing failure in a core helper."""
