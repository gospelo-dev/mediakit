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
async def premiere_get_sequence_state(
    include_reflection: bool = False,
    timeout_seconds: float = 20.0,
) -> dict[str, Any]:
    """Read the active Premiere sequence's structural state as JSON.

    Returns the video/audio track layout, the clips on each track (name,
    start/end/in/out in seconds, and media path where available), and the
    playhead position. This is the primary read-only observation used by an
    autonomous agent to judge whether an edit landed as intended. It never
    changes the project, the timeline, or media files.

    Args:
        include_reflection: Attach ``_reflect`` (available UXP method names on
            the sequence/track/track-item objects) to aid diagnosing API
            coverage. Off by default.
        timeout_seconds: Connection and response timeout (1–60 seconds).

    Returns:
        ``{"ok": true, "project": {...}, "sequence": {...}, "videoTracks": [...],
        "audioTracks": [...], "diagnostics": [...]}`` on success. ``diagnostics``
        lists any individual UXP calls that failed (empty when all succeeded).
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    try:
        result = await _get_bridge().request(
            "sequence.getState",
            {"debug": include_reflection},
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_export_frame(
    time_seconds: float | None = None,
    output_dir: str | None = None,
    file_name: str | None = None,
    width: int | None = None,
    height: int | None = None,
    include_reflection: bool = False,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Export one frame of the active Premiere sequence as a still image.

    This is the visual (L2) observation: it lets an agent judge the picture
    itself (color, framing, whether the intended clip is showing). The frame
    time is passed to Premiere's exporter directly, so the playhead is never
    moved; the project and timeline are not modified. Only a still-image file
    is written.

    Args:
        time_seconds: Sequence time to export. Defaults to the current
            playhead position.
        output_dir: Directory the image is written into. Defaults to the
            ``GOSPELO_PREMIERE_EXPORT_DIR`` environment variable if set
            (configure it per MCP host next to the bridge token), else a
            ``gospelo_premiere_frames`` folder under the system temp dir.
        file_name: Image file name; the extension selects the format
            (``.png`` default; Premiere also supports jpg/tif/tga/bmp/dpx/exr/gif).
        width / height: Output size. Defaults to the sequence frame size.
        include_reflection: Attach ``_reflect`` (available Exporter/TickTime
            method names) to aid diagnosing API coverage. Off by default.
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "outputFile": "...", "fileExists": true, ...}`` on
        success; ``diagnostics`` lists any individual UXP calls that failed.
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    import os
    import tempfile

    if output_dir is None:
        output_dir = os.environ.get("GOSPELO_PREMIERE_EXPORT_DIR") or os.path.join(
            tempfile.gettempdir(), "gospelo_premiere_frames"
        )
    output_dir = os.path.abspath(os.path.expanduser(output_dir))
    os.makedirs(output_dir, exist_ok=True)

    params: dict[str, Any] = {
        "outputDir": output_dir,
        "debug": include_reflection,
    }
    if time_seconds is not None:
        params["timeSeconds"] = time_seconds
    if file_name is not None:
        params["fileName"] = file_name
    if width is not None:
        params["width"] = width
    if height is not None:
        params["height"] = height

    try:
        result = await _get_bridge().request(
            "program.exportFrame",
            params,
            timeout_seconds=timeout_seconds,
        )
        output_file = os.path.join(result.get("outputDir", output_dir), result.get("fileName", "frame.png"))
        # The bridge and Premiere run on the same machine, so verify the file.
        return {
            "ok": True,
            "outputFile": output_file,
            "fileExists": os.path.isfile(output_file),
            **result,
        }
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
