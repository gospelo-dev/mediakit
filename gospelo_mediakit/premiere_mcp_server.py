"""MCP tools that retrieve data from a connected Adobe Premiere UXP panel."""

from __future__ import annotations

from typing import Any

from fastmcp import FastMCP

from gospelo_mediakit.premiere.bridge import BridgeConfig, PremiereBridge, PremiereBridgeError

mcp = FastMCP("gospelo-premiere")
_bridge: PremiereBridge | None = None


def _get_bridge() -> PremiereBridge:
    """Build the bridge lazily so importing the MCP server has no side effects."""
    global _bridge
    if _bridge is None:
        _bridge = PremiereBridge(BridgeConfig.from_environment())
    return _bridge


@mcp.tool()
async def premiere_list_project_assets(
    include_bins: bool = True,
    timeout_seconds: float = 20.0,
) -> dict[str, Any]:
    """List the assets in the currently active Adobe Premiere Pro project.

    Opens the local TLS bridge on first use, then asks the connected Premiere
    UXP panel to enumerate the active project's root bin recursively. This is
    read-only: it never changes the project, the timeline, or media files.

    Args:
        include_bins: Include root/bin rows as well as media and sequence rows.
        timeout_seconds: Connection and response timeout (1–60 seconds).

    Returns:
        ``{"ok": true, "project": {id, name, path}, "assets": [...]}`` on
        success. Each asset includes an ID, name, kind, parent ID, and—for
        media where Premiere exposes it—a source path. On failure returns
        ``{"ok": false, "error": "..."}``.
    """
    try:
        result = await _get_bridge().request(
            "project.assets.list",
            {"includeBins": include_bins},
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_bridge_status() -> dict[str, Any]:
    """Check whether the local Premiere UXP bridge is connected.

    This tool is read-only. It is useful while setting up the UXP panel before
    calling ``premiere_list_project_assets``.
    """
    try:
        bridge = _get_bridge()
        await bridge.start()
        return {"ok": True, "endpoint": bridge.endpoint, "connected": bridge.is_connected}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


def main() -> None:
    """Run the Premiere-specific MCP stdio server."""
    mcp.run()


if __name__ == "__main__":
    main()
