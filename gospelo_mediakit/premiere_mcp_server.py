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
    solo_video_track: int | None = None,
    include_reflection: bool = False,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Export one frame of the active Premiere sequence as a still image.

    This is the visual (L2) observation: it lets an agent judge the picture
    itself (color, framing, whether the intended clip is showing). The frame
    time is passed to Premiere's exporter directly, so the playhead is never
    moved; the project and timeline are not modified. Only a still-image file
    is written.

    With ``solo_video_track`` the bridge temporarily hides every other video
    track (track-output mute), exports, and ALWAYS restores the original
    states within the same call — so you get a single track's picture without
    leaving the timeline half-toggled. ``soloRestored: true`` in the response
    confirms the restore.

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
        solo_video_track: 0-based video track index to isolate (all other
            video tracks are hidden for the export, then restored).
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
    if solo_video_track is not None:
        params["soloVideoTrack"] = solo_video_track

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
async def premiere_add_telops(
    srt_path: str,
    template_path: str | None = None,
    video_track_index: int = 2,
    time_offset_seconds: float = 0.0,
    max_cues: int | None = None,
    timeout_seconds: float = 60.0,
) -> dict[str, Any]:
    """Place editable text telops for every SRT cue on the active sequence (WRITE).

    Fully automatic pipeline: each SRT cue is baked into a text-patched copy
    of a Motion Graphics template (fresh capsuleID per cue), inserted at the
    cue's start time on the given video track, and trimmed to the cue's
    duration. The resulting telops remain editable in Premiere's Essential
    Graphics panel. This MODIFIES the timeline (each insertion is undoable).

    Args:
        srt_path: Subtitle file whose cues become telops (e.g. produced by
            mlx-whisper).
        template_path: ``.mogrt`` template to patch. Defaults to Premiere's
            bundled "Simple Broadcast Caption" (resolved via the bridge's
            installed-mogrt path).
        video_track_index: Target video track (0-based; use a track above
            the footage).
        time_offset_seconds: Shift applied to every cue (align SRT time zero
            with the audio's position on the timeline).
        max_cues: Optional cap on the number of cues placed.
        timeout_seconds: Per-request timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "placedCues": N, "totalCues": M, "results": [...]}``;
        each result carries the cue text/time and the bridge response.
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    import glob
    import os
    import tempfile

    from gospelo_mediakit.premiere.mogrt import make_telop_mogrt
    from gospelo_mediakit.premiere.srt import parse_srt

    srt_path = os.path.abspath(os.path.expanduser(srt_path))
    if not os.path.isfile(srt_path):
        return {"ok": False, "error": f"srt file not found: {srt_path}"}
    with open(srt_path, encoding="utf-8") as fh:
        cues = parse_srt(fh.read())
    if not cues:
        return {"ok": False, "error": "no cues found in the srt file"}
    if max_cues is not None:
        cues = cues[: max(0, max_cues)]

    bridge = _get_bridge()

    try:
        if template_path is None:
            recon = await bridge.request("sequence.insertMogrt", {}, timeout_seconds=timeout_seconds)
            installed = recon.get("installedMogrtPath")
            if not installed or not os.path.isdir(installed):
                return {"ok": False, "error": f"installed mogrt path not found: {installed}"}
            preferred = os.path.join(installed, "Captions and Subtitles", "Simple Broadcast Caption.mogrt")
            if os.path.isfile(preferred):
                template_path = preferred
            else:
                candidates = sorted(glob.glob(os.path.join(installed, "**", "*.mogrt"), recursive=True))
                if not candidates:
                    return {"ok": False, "error": "no bundled .mogrt templates found"}
                template_path = candidates[0]
        template_path = os.path.abspath(os.path.expanduser(template_path))
        if not os.path.isfile(template_path):
            return {"ok": False, "error": f"template not found: {template_path}"}

        work_dir = tempfile.mkdtemp(prefix="gospelo_telops_")
        results: list[dict[str, Any]] = []
        placed = 0
        for index, cue in enumerate(cues):
            # One text layer gets the cue text; a trailing "" blanks any
            # additional text layers the template may have.
            text = cue.text.replace("\n", " ").strip()
            out_path = os.path.join(work_dir, f"telop_{index:04d}.mogrt")
            make_telop_mogrt(template_path, [text, ""], out_path, new_name=f"Gospelo Telop {index + 1}")

            response = await bridge.request(
                "sequence.insertMogrt",
                {
                    "mogrtPath": out_path,
                    "timeSeconds": cue.start_seconds + time_offset_seconds,
                    "durationSeconds": cue.duration_seconds,
                    "videoTrackIndex": video_track_index,
                    "audioTrackIndex": 0,
                },
                timeout_seconds=timeout_seconds,
            )
            ok = bool(response.get("inserted"))
            placed += 1 if ok else 0
            results.append(
                {
                    "cue": index + 1,
                    "text": text,
                    "timeSeconds": cue.start_seconds + time_offset_seconds,
                    "durationSeconds": cue.duration_seconds,
                    "inserted": ok,
                    "durationSet": response.get("durationSet"),
                    "diagnostics": response.get("diagnostics", []),
                }
            )
        return {
            "ok": True,
            "placedCues": placed,
            "totalCues": len(cues),
            "template": template_path,
            "results": results,
        }
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_import_media(
    paths: list[str],
    timeout_seconds: float = 45.0,
) -> dict[str, Any]:
    """Import media files into the active Premiere project's root bin (WRITE).

    Adds the files to the project bin only — the timeline is not touched.
    Chain with ``premiere_insert_clip`` using the returned item IDs to place
    the imported media on the sequence. Source files are referenced, never
    modified or copied.

    Args:
        paths: Absolute media file paths (existence is validated here).
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "imported": true, "requestedCount": N,
        "newItems": [{"id", "name"}, ...], "diagnostics": [...]}``.
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    import os

    resolved = [os.path.abspath(os.path.expanduser(p)) for p in paths]
    missing = [p for p in resolved if not os.path.isfile(p)]
    if missing:
        return {"ok": False, "error": f"files not found: {missing}"}

    try:
        result = await _get_bridge().request(
            "project.importMedia",
            {"paths": resolved},
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_move_clip(
    item_start_seconds: float,
    new_start_seconds: float,
    track_type: str = "video",
    track_index: int = 0,
    new_track_index: int | None = None,
    tolerance_seconds: float = 0.05,
    include_reflection: bool = False,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Move an existing clip on the active sequence (WRITE).

    Identifies the clip by its track and current start time (within
    ``tolerance_seconds``). A same-track move is a single relative move
    action; a cross-track move (``new_track_index`` given) is implemented as
    clone-to-destination + remove-original in one atomic, undoable
    transaction, since Premiere's API has no direct vertical move.

    Live-verified caveat: a linked audio/video pair does NOT move together —
    move the video and audio items separately, then verify with
    ``premiere_get_sequence_state`` (act -> observe).

    Args:
        item_start_seconds: Current start time of the clip to move.
        new_start_seconds: Destination start time.
        track_type: ``"video"`` or ``"audio"``.
        track_index: 0-based source track index (V2 is video/1).
        new_track_index: Destination track index for a cross-track move.
        tolerance_seconds: Start-time matching tolerance.
        include_reflection: Attach ``_reflect`` diagnostics (cross-track only).
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "moved": true, "name", "fromSeconds", "toSeconds",
        ...}``; on a miss the error lists the clip start times found on that
        track. On failure returns ``{"ok": false, "error": "..."}``.
    """
    params: dict[str, Any] = {
        "trackType": track_type,
        "trackIndex": track_index,
        "itemStartSeconds": item_start_seconds,
        "newStartSeconds": new_start_seconds,
        "toleranceSeconds": tolerance_seconds,
        "debug": include_reflection,
    }
    if new_track_index is not None:
        params["newTrackIndex"] = new_track_index

    try:
        result = await _get_bridge().request(
            "sequence.moveClip",
            params,
            timeout_seconds=timeout_seconds,
        )
        return {"ok": True, **result}
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_set_video_track_output(
    visible: bool,
    track_index: int = 0,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Show or hide a video track on the active sequence (WRITE).

    This is the timeline's eye icon (track output): a hidden track is
    excluded from the program monitor and from ``premiere_export_frame``
    composites. Uses Premiere's ``track.setMute`` under the hood and reads
    the state back, so the response is its own act -> observe confirmation.
    Note this is visibility, not track LOCK — Premiere's UXP API has no lock
    operation yet. For one-off single-track frame exports, prefer
    ``premiere_export_frame(solo_video_track=...)`` which restores state
    automatically.

    Args:
        visible: True to show the track, False to hide it.
        track_index: 0-based video track index (V1 is 0).
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "visibleBefore": ..., "visibleAfter": ...,
        "changed": ...}``. On failure returns ``{"ok": false, "error": "..."}``.
    """
    try:
        result = await _get_bridge().request(
            "sequence.setTrackMute",
            {"trackType": "video", "trackIndex": track_index, "mute": not visible},
            timeout_seconds=timeout_seconds,
        )
        muted_before = result.pop("mutedBefore", None)
        muted_after = result.pop("mutedAfter", None)
        result.pop("requested", None)
        return {
            "ok": True,
            "visibleBefore": None if muted_before is None else not muted_before,
            "visibleAfter": None if muted_after is None else not muted_after,
            **result,
        }
    except PremiereBridgeError as exc:
        return {"ok": False, "error": str(exc)}


@mcp.tool()
async def premiere_set_audio_track_mute(
    mute: bool,
    track_index: int = 0,
    timeout_seconds: float = 30.0,
) -> dict[str, Any]:
    """Mute or unmute an audio track on the active sequence (WRITE).

    This is the timeline's M button. Uses Premiere's documented
    ``track.setMute`` setter and reads the state back, so the response is
    its own act -> observe confirmation. Note this is MUTE, not track LOCK —
    Premiere's UXP API has no lock operation yet.

    Args:
        mute: True to mute, False to unmute.
        track_index: 0-based audio track index (A1 is 0).
        timeout_seconds: Connection and response timeout (1-60 seconds).

    Returns:
        ``{"ok": true, "mutedBefore": ..., "mutedAfter": ..., "changed": ...}``.
        On failure returns ``{"ok": false, "error": "..."}``.
    """
    try:
        result = await _get_bridge().request(
            "sequence.setTrackMute",
            {"trackType": "audio", "trackIndex": track_index, "mute": mute},
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
