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
async def premiere_create_project(
    path: str,
    import_paths: list[str] | None = None,
    sequence_name: str | None = None,
    include_reflection: bool = False,
    timeout_seconds: float = 45.0,
) -> dict[str, Any]:
    """Create a NEW Premiere project, optionally with media and a sequence.

    Intended for setting up disposable test projects so that timeline-writing
    operations can be exercised without touching a real editing project.
    The new project is created at ``path`` and becomes the active project in
    Premiere (the previously active project stays open but loses focus).
    Existing projects and media files are never modified.

    Args:
        path: Absolute path for the new ``.prproj`` file. Must not already
            exist.
        import_paths: Optional media file paths to import into the new
            project's root bin.
        sequence_name: If given (and media was imported), create a sequence
            with this name from the imported clips.
        include_reflection: Attach ``_reflect`` (available Project method
            names) to aid diagnosing API coverage. Off by default.
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "created": true, "project": {...}, "importedCount": N,
        "sequence": {...} | null, "diagnostics": [...]}`` on success.
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    import os

    path = os.path.abspath(os.path.expanduser(path))
    if not path.endswith(".prproj"):
        return {"ok": False, "error": "path must end with .prproj"}
    if os.path.exists(path):
        return {"ok": False, "error": f"path already exists: {path}"}
    parent = os.path.dirname(path)
    os.makedirs(parent, exist_ok=True)

    params: dict[str, Any] = {"path": path, "debug": include_reflection}
    if import_paths:
        missing = [p for p in import_paths if not os.path.isfile(os.path.expanduser(p))]
        if missing:
            return {"ok": False, "error": f"import files not found: {missing}"}
        params["importPaths"] = [os.path.abspath(os.path.expanduser(p)) for p in import_paths]
    if sequence_name:
        params["sequenceName"] = sequence_name

    try:
        result = await _get_bridge().request(
            "project.create",
            params,
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_insert_clip(
    project_item_id: str,
    time_seconds: float,
    video_track_index: int = 0,
    audio_track_index: int = 0,
    overwrite: bool = False,
    limit_shift: bool = False,
    include_reflection: bool = False,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Insert a project item into the active Premiere sequence (WRITE).

    This MODIFIES the timeline of the active sequence. The edit is committed
    as a single undoable transaction (Edit > Undo reverts it). Verify the
    result with ``premiere_get_sequence_state`` afterwards.

    Args:
        project_item_id: Asset ID from ``premiere_list_project_assets``.
        time_seconds: Timeline position to insert at.
        video_track_index / audio_track_index: Target tracks (0-based).
        overwrite: True replaces existing material at that range; False
            (default) inserts and shifts later clips.
        limit_shift: Insert mode only — limit shifting to the target tracks.
        include_reflection: Attach ``_reflect`` (SequenceEditor method names).
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "inserted": true, ...}`` on success; ``diagnostics``
        lists any failed UXP calls. On failure ``{"ok": false, "error": "..."}``.
    """
    try:
        result = await _get_bridge().request(
            "sequence.insertClip",
            {
                "projectItemId": project_item_id,
                "timeSeconds": time_seconds,
                "videoTrackIndex": video_track_index,
                "audioTrackIndex": audio_track_index,
                "overwrite": overwrite,
                "limitShift": limit_shift,
                "debug": include_reflection,
            },
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_add_marker(
    name: str,
    time_seconds: float,
    duration_seconds: float | None = None,
    comments: str | None = None,
    marker_type: str = "Comment",
    include_reflection: bool = False,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Add a marker to the active Premiere sequence (WRITE).

    This MODIFIES the active sequence's markers. The edit is committed as a
    single undoable transaction. The response includes the sequence's marker
    count read back after the edit.

    Args:
        name: Marker name.
        time_seconds: Marker position on the sequence timeline.
        duration_seconds: Optional marker duration.
        comments: Optional marker comment text.
        marker_type: Premiere marker type (default ``Comment``).
        include_reflection: Attach ``_reflect`` (Markers method names).
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "added": true, "markerCount": N, ...}`` on success;
        ``diagnostics`` lists any failed UXP calls. On failure
        ``{"ok": false, "error": "..."}``.
    """
    params: dict[str, Any] = {
        "name": name,
        "timeSeconds": time_seconds,
        "markerType": marker_type,
        "debug": include_reflection,
    }
    if duration_seconds is not None:
        params["durationSeconds"] = duration_seconds
    if comments is not None:
        params["comments"] = comments

    try:
        result = await _get_bridge().request(
            "sequence.addMarker",
            params,
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_import_captions(
    srt_path: str,
    time_seconds: float = 0.0,
    include_reflection: bool = False,
    timeout_seconds: float = 45.0,
) -> dict[str, Any]:
    """Import an SRT subtitle file into the active Premiere project (WRITE).

    This MODIFIES the project: the SRT is imported into the project bin.
    Automatic timeline placement is attempted, but Premiere's current UXP API
    silently ignores it for caption items, so expect ``placed`` to be false
    (it is judged by the observed caption-track count, not by the attempt).
    When ``placed`` is false, one manual step remains: drag the imported
    captions item from the Project panel onto the sequence — Premiere then
    creates the caption track with all cues (the response's ``note`` says the
    same).

    Args:
        srt_path: Absolute path of the ``.srt`` subtitle file.
        time_seconds: Timeline position for the captions (default 0).
        include_reflection: Attach ``_reflect`` (caption item/track method
            names) to aid diagnosing API coverage. Off by default.
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "imported": true, "placed": true|false,
        "captionTracksBefore": N, "captionTracksAfter": M, ...}``.
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    import os

    srt_path = os.path.abspath(os.path.expanduser(srt_path))
    if not os.path.isfile(srt_path):
        return {"ok": False, "error": f"srt file not found: {srt_path}"}

    try:
        result = await _get_bridge().request(
            "sequence.importCaptions",
            {"srtPath": srt_path, "timeSeconds": time_seconds, "debug": include_reflection},
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
