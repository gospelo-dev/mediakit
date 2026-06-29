"""Deterministic core logic shared by the CLI and the MCP server.

Each public function here is plain, short-running Python (no LLM, no network).
The CLI tool wrappers (``gospelo_mediakit.tools.*``) and the MCP server
(``gospelo_mediakit.mcp_server``) are both *thin* layers over these functions:
they parse input, call a core function, and serialise the result. All
domain logic lives here so the two front-ends never diverge.
"""

from .errors import MediakitError

__all__ = ["MediakitError"]
