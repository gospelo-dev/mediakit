"""FastMCP server package for gospelo-mediakit.

A thin transport layer over ``gospelo_mediakit.core``. It owns no domain logic;
each tool is a ~20-line wrapper that calls a core function and returns its
result. The same binary serves Claude Code (via ``.mcp.json``) and Codex (via
``codex mcp add``) over MCP stdio.
"""

__version__ = "0.1.0"
